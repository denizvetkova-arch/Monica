// =============================================================
// Preference Profile — aggregates task_corrections_v1 (every AI
// prediction vs. what the user actually confirmed or changed — now
// including plain manual edits, not just review-card "Fix"es) and
// task_completions_v1 (actual time spent, skip counts, completion
// timing) into a per-domain and per-keyword model of how this specific
// person actually thinks. Read by classify-task.js BEFORE every future
// classification (see summaryText()) and displayed back to the user in
// manage.html's "Preference Profile" card.
//
// This is NOT a trained model — there's no training pipeline in this
// architecture (static site + Vercel functions, no build step). It's
// plain aggregation (averages, ratios, word-frequency tallies) over
// real logged data, recomputed on demand every time — the logs are
// already capped (300/200 entries in tasks.js), so this is cheap. No
// new storage key exists or is needed for the profile itself.
//
// Exposes window.PreferenceProfile = { computeProfile, summaryText,
// confidencePct }.
// =============================================================
(function () {
  'use strict';

  const CORRECTIONS_KEY = 'task_corrections_v1';
  const COMPLETIONS_KEY = 'task_completions_v1';
  // Below this many data points for a given domain/keyword/dimension, a
  // bias or rate is "not enough data yet" rather than noise dressed up
  // as a pattern.
  const MIN_SAMPLE = 3;
  const FOLLOWUP_WINDOW_MS = 45 * 60000;
  // Short (2-letter) filler words need to be explicitly excluded since the
  // tokenizer's minimum length is 2, not 3 — deliberately low so real
  // 2-letter acronyms like "ai", "ml", "ux", "qa", "pr", "hr" survive
  // tokenizing instead of being silently dropped as "too short."
  const STOPWORDS = new Set([
    'the', 'a', 'an', 'to', 'for', 'of', 'and', 'or', 'in', 'on', 'at', 'with',
    'my', 'me', 'is', 'are', 'be', 'do', 'it', 'this', 'that', 'from', 'about',
    'up', 'out', 'get', 'go', 'into', 'onto', 'as', 'by', 'not', 'was', 'has',
    'am', 'no', 'if', 'so', 'us', 'we', 'he', 'she', 'him', 'her', 'its',
    'im', 'ok', 'ill', 'id', 'ive', 'youre', 'youll',
  ]);
  const DOMAIN_LABELS = {
    career: 'Career', school: 'School', debate: 'Debate',
    glp1_research: 'GLP-1 Research', finance: 'Finance', personal: 'Personal',
    extracurricular: 'Extracurricular', health: 'Health',
  };

  function loadJSON(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }

  // The "ground truth" of a logged entry: what the user actually
  // confirmed, whether that came from a correction or an as-predicted
  // approval/auto-accept.
  function finalFields(entry) {
    return entry.correction || entry.prediction || {};
  }

  function mean(nums) {
    if (!nums.length) return null;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  }

  function tokenize(title) {
    return (title || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2 && !STOPWORDS.has(w));
  }

  // Laplace-style heuristic, not a statistical confidence interval:
  // 1 sample -> 25%, 3 -> 50%, 9 -> 75%, asymptotic toward 100%. Used to
  // give the user a rough, honestly-labeled sense of "how much has
  // Monica actually seen of this," not a claim of measured accuracy.
  function confidencePct(sampleSize) {
    const n = sampleSize || 0;
    return Math.round(100 * n / (n + 3));
  }

  function computeDomainStats(corrections, completions) {
    const byDomain = {}; // domain -> { count, roi[], urgency[], difficulty[], recurringYes, recurringTotal, energyVotes{} }
    const globalROI = [], globalUrgency = [], globalDifficulty = [];

    corrections.forEach(entry => {
      const f = finalFields(entry);
      const domain = f.lifeDomain;
      if (!domain) return;
      if (!byDomain[domain]) {
        byDomain[domain] = { count: 0, roi: [], urgency: [], difficulty: [], recurringYes: 0, recurringTotal: 0, energyVotes: {} };
      }
      const d = byDomain[domain];
      d.count += 1;
      if (f.longTermROI != null) { d.roi.push(f.longTermROI); globalROI.push(f.longTermROI); }
      if (f.urgency != null) { d.urgency.push(f.urgency); globalUrgency.push(f.urgency); }
      if (f.difficulty != null) { d.difficulty.push(f.difficulty); globalDifficulty.push(f.difficulty); }
      if ('recurrence' in f) { d.recurringTotal += 1; if (f.recurrence) d.recurringYes += 1; }
      if (f.energyLevel) d.energyVotes[f.energyLevel] = (d.energyVotes[f.energyLevel] || 0) + 1;
    });

    const byDomainCompletions = {};
    completions.forEach(c => {
      if (!c.lifeDomain) return;
      (byDomainCompletions[c.lifeDomain] = byDomainCompletions[c.lifeDomain] || []).push(c);
    });

    const globalSkip = completions.map(c => c.skipCountAtCompletion || 0);
    const globalSkipMean = mean(globalSkip);

    // Follow-up chaining: sort ALL completions chronologically, then for
    // each one check whether the NEXT completion (any domain) landed
    // within FOLLOWUP_WINDOW_MS — a rough "finishing this leads straight
    // into more work" signal.
    const sortedCompletions = completions.slice().sort((a, b) => a.completedAt - b.completedAt);
    const followupHits = {};
    sortedCompletions.forEach((c, i) => {
      if (!c.lifeDomain) return;
      const fu = (followupHits[c.lifeDomain] = followupHits[c.lifeDomain] || { hits: 0, total: 0 });
      fu.total += 1;
      const next = sortedCompletions[i + 1];
      if (next && (next.completedAt - c.completedAt) <= FOLLOWUP_WINDOW_MS) fu.hits += 1;
    });

    const globalROIMean = mean(globalROI);
    const globalUrgencyMean = mean(globalUrgency);
    const globalDifficultyMean = mean(globalDifficulty);

    const domains = {};
    const allDomainNames = new Set([...Object.keys(byDomain), ...Object.keys(byDomainCompletions)]);
    allDomainNames.forEach(domain => {
      const d = byDomain[domain] || { count: 0, roi: [], urgency: [], difficulty: [], recurringYes: 0, recurringTotal: 0, energyVotes: {} };
      const domainCompletions = byDomainCompletions[domain] || [];

      const completionRatios = domainCompletions
        .filter(c => c.actualMinutes != null && c.estimatedMinutes)
        .map(c => c.actualMinutes / c.estimatedMinutes);
      // Fallback duration signal when there isn't enough completion
      // feedback yet: how much the user corrected the estimate itself.
      const correctedRatios = [];
      corrections.forEach(entry => {
        const f = finalFields(entry);
        if (f.lifeDomain !== domain) return;
        if (entry.correction && entry.correction.estimatedMinutes != null && entry.prediction && entry.prediction.estimatedMinutes) {
          correctedRatios.push(entry.correction.estimatedMinutes / entry.prediction.estimatedMinutes);
        }
      });
      const durationMultiplier = completionRatios.length >= MIN_SAMPLE
        ? mean(completionRatios)
        : (correctedRatios.length >= MIN_SAMPLE ? mean(correctedRatios) : null);

      const skipCounts = domainCompletions.map(c => c.skipCountAtCompletion || 0);
      const procrastinationScore = (skipCounts.length >= MIN_SAMPLE && globalSkipMean != null)
        ? mean(skipCounts) - globalSkipMean
        : null;

      const fu = followupHits[domain];
      const unlocksFollowupRate = (fu && fu.total >= MIN_SAMPLE) ? fu.hits / fu.total : null;

      const energyVoteKeys = Object.keys(d.energyVotes);
      const energyMode = energyVoteKeys.length
        ? energyVoteKeys.reduce((a, b) => (d.energyVotes[a] >= d.energyVotes[b] ? a : b))
        : null;

      domains[domain] = {
        sampleSize: d.count,
        roiBias: (d.roi.length >= MIN_SAMPLE && globalROIMean != null) ? mean(d.roi) - globalROIMean : null,
        urgencyBias: (d.urgency.length >= MIN_SAMPLE && globalUrgencyMean != null) ? mean(d.urgency) - globalUrgencyMean : null,
        difficultyBias: (d.difficulty.length >= MIN_SAMPLE && globalDifficultyMean != null) ? mean(d.difficulty) - globalDifficultyMean : null,
        durationMultiplier,
        energyMode,
        recurringRate: d.recurringTotal >= MIN_SAMPLE ? d.recurringYes / d.recurringTotal : null,
        procrastinationScore,
        unlocksFollowupRate,
      };
    });

    return domains;
  }

  // Word -> domain association learning. A word "qualifies" once seen in
  // >=MIN_SAMPLE corrected-task titles. domainShift flags words that have
  // been explicitly MOVED between domains often enough — i.e. an entry's
  // own prediction.lifeDomain differs from its correction.lifeDomain (the
  // AI guessed one domain, the user moved it to another) — rather than
  // just "which domain does this word usually end up in," which would be
  // true even for a word that was always correctly classified from the
  // start. This is what surfaces "AI, startup, coding: learned as Career"
  // once >=MIN_SAMPLE corrections have moved that exact pattern.
  function computeKeywordStats(corrections) {
    const wordDomainCounts = {};
    const wordShiftCounts = {}; // word -> {targetDomain: count of entries that moved INTO it}
    const wordUrgency = {};
    const wordROI = {};

    const allUrgency = [], allROI = [];
    corrections.forEach(entry => {
      const f = finalFields(entry);
      if (!f.lifeDomain) return;
      if (f.urgency != null) allUrgency.push(f.urgency);
      if (f.longTermROI != null) allROI.push(f.longTermROI);
      const words = tokenize(entry.title);
      const predDomain = entry.prediction && entry.prediction.lifeDomain;
      const corrDomain = entry.correction && entry.correction.lifeDomain;
      const isShift = predDomain && corrDomain && predDomain !== corrDomain;
      words.forEach(w => {
        wordDomainCounts[w] = wordDomainCounts[w] || {};
        wordDomainCounts[w][f.lifeDomain] = (wordDomainCounts[w][f.lifeDomain] || 0) + 1;
        if (isShift) {
          wordShiftCounts[w] = wordShiftCounts[w] || {};
          wordShiftCounts[w][corrDomain] = (wordShiftCounts[w][corrDomain] || 0) + 1;
        }
        if (f.urgency != null) (wordUrgency[w] = wordUrgency[w] || []).push(f.urgency);
        if (f.longTermROI != null) (wordROI[w] = wordROI[w] || []).push(f.longTermROI);
      });
    });

    const globalUrgencyMean = mean(allUrgency);
    const globalROIMean = mean(allROI);

    const keywords = {};
    Object.keys(wordDomainCounts).forEach(word => {
      const counts = wordDomainCounts[word];
      const total = Object.keys(counts).reduce((s, k) => s + counts[k], 0);
      if (total < MIN_SAMPLE) return;
      const dominantDomain = Object.keys(counts).reduce((a, b) => (counts[a] >= counts[b] ? a : b));
      const shiftsToDominant = (wordShiftCounts[word] && wordShiftCounts[word][dominantDomain]) || 0;
      keywords[word] = {
        dominantDomain,
        domainShift: shiftsToDominant >= MIN_SAMPLE,
        sampleSize: total,
        urgencyBias: (wordUrgency[word] && wordUrgency[word].length >= MIN_SAMPLE && globalUrgencyMean != null)
          ? mean(wordUrgency[word]) - globalUrgencyMean : null,
        roiBias: (wordROI[word] && wordROI[word].length >= MIN_SAMPLE && globalROIMean != null)
          ? mean(wordROI[word]) - globalROIMean : null,
      };
    });
    return keywords;
  }

  function computeProfile() {
    const corrections = loadJSON(CORRECTIONS_KEY, []);
    const completions = loadJSON(COMPLETIONS_KEY, []);
    const correctionsList = Array.isArray(corrections) ? corrections : [];
    const completionsList = Array.isArray(completions) ? completions : [];
    return {
      domains: computeDomainStats(correctionsList, completionsList),
      keywords: computeKeywordStats(correctionsList),
      totals: {
        corrections: correctionsList.length,
        completionsWithFeedback: completionsList.filter(c => c.actualMinutes != null).length,
      },
    };
  }

  function domainLabel(domain) { return DOMAIN_LABELS[domain] || domain; }

  function durationLine(multiplier) {
    if (multiplier == null) return null;
    if (Math.abs(multiplier - 1) < 0.15) return null;
    const rounded = Math.round(multiplier * 10) / 10;
    return multiplier > 1
      ? 'Takes about ' + rounded + '× as long as estimated'
      : 'Usually finishes in about ' + rounded + '× the estimate (faster than expected)';
  }

  function urgencyLine(bias) {
    if (bias == null || Math.abs(bias) < 0.75) return null;
    if (bias >= 1.5) return 'Usually high urgency';
    if (bias <= -1.5) return 'Usually low urgency';
    return (bias > 0 ? '+' : '') + bias.toFixed(1) + ' urgency vs. average';
  }

  function roiLine(bias) {
    if (bias == null || Math.abs(bias) < 0.75) return null;
    return 'ROI ' + (bias > 0 ? '+' : '') + bias.toFixed(1) + ' over average';
  }

  function difficultyLine(bias) {
    if (bias == null || Math.abs(bias) < 1.5) return null;
    return bias > 0 ? 'Typically harder than it looks' : 'Typically easier than it looks';
  }

  function procrastinationLine(score) {
    if (score == null) return null;
    if (score >= 0.75) return 'Tends to get put off';
    if (score <= -0.75) return 'Rarely gets put off';
    return null;
  }

  function followupLine(rate) {
    if (rate == null || rate < 0.5) return null;
    return 'Finishing these often leads straight into more work';
  }

  function recurringLine(rate) {
    if (rate == null || rate < 0.5) return null;
    return 'Often a recurring habit';
  }

  // Narrative block matching the format the user described — only
  // includes lines that clear their own sample-size/magnitude threshold;
  // never fabricates a pattern from too little data.
  function summaryText(profile) {
    if (!profile || (profile.totals.corrections === 0 && profile.totals.completionsWithFeedback === 0)) {
      return "Monica hasn't learned any personal patterns yet — corrections and completions will build this over time.";
    }

    const blocks = [];

    Object.keys(profile.domains)
      .filter(domain => profile.domains[domain].sampleSize >= MIN_SAMPLE)
      .sort((a, b) => profile.domains[b].sampleSize - profile.domains[a].sampleSize)
      .forEach(domain => {
        const d = profile.domains[domain];
        const lines = [roiLine(d.roiBias), urgencyLine(d.urgencyBias), difficultyLine(d.difficultyBias),
          durationLine(d.durationMultiplier), recurringLine(d.recurringRate),
          procrastinationLine(d.procrastinationScore), followupLine(d.unlocksFollowupRate)]
          .filter(Boolean);
        if (lines.length) blocks.push(domainLabel(domain) + ':\n' + lines.join('\n'));
      });

    // Domain-shift keyword groups: words that have moved to a different
    // domain than they started with, grouped by where they landed — this
    // is what produces "AI, startup, coding: learned as Career."
    const shiftedByDomain = {};
    Object.keys(profile.keywords).forEach(word => {
      const k = profile.keywords[word];
      if (!k.domainShift) return;
      (shiftedByDomain[k.dominantDomain] = shiftedByDomain[k.dominantDomain] || []).push({ word, sampleSize: k.sampleSize });
    });
    Object.keys(shiftedByDomain).forEach(domain => {
      const words = shiftedByDomain[domain].sort((a, b) => b.sampleSize - a.sampleSize).slice(0, 5);
      const totalSamples = words.reduce((s, w) => s + w.sampleSize, 0);
      blocks.push(words.map(w => w.word).join(', ') + ':\nLearned as ' + domainLabel(domain) +
        ' (' + totalSamples + (totalSamples === 1 ? ' example' : ' examples') + ')');
    });

    // A few notable individual keyword insights that aren't domain
    // shifts (e.g. "shopping: usually low urgency" within Personal).
    const nonShiftInsights = Object.keys(profile.keywords)
      .map(word => ({ word, k: profile.keywords[word] }))
      .filter(({ k }) => !k.domainShift && (Math.abs(k.urgencyBias || 0) >= 1.5 || Math.abs(k.roiBias || 0) >= 1.5))
      .sort((a, b) => (Math.abs(b.k.urgencyBias || 0) + Math.abs(b.k.roiBias || 0)) - (Math.abs(a.k.urgencyBias || 0) + Math.abs(a.k.roiBias || 0)))
      .slice(0, 4);
    nonShiftInsights.forEach(({ word, k }) => {
      const line = urgencyLine(k.urgencyBias) || roiLine(k.roiBias);
      if (line) blocks.push(word + ':\n' + line);
    });

    if (!blocks.length) {
      return "Monica has " + profile.totals.corrections + " correction(s) logged, but not enough yet in any single domain or keyword to state a confident pattern.";
    }
    return blocks.join('\n\n');
  }

  window.PreferenceProfile = {
    computeProfile,
    summaryText,
    confidencePct,
  };
})();
