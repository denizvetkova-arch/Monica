// =============================================================
// Decision Engine — turns Today's State (state.js) into one decision:
// "do this task, for this long, because of these reasons, then this
// is probably next." This is the single thing the main screen calls.
//
// Deliberately wraps tasks.js's rankTasks() rather than reimplementing
// it — that scorer already encodes deadline urgency (35%), long-term
// ROI (35%), energy fit (20%), and calendar time-fit (10%, which is
// also where "does this fit before my next meeting" already lives —
// availableMinutes is minutes until the next busy block), and is
// unit-tested. This module adds the dimensions rankTasks doesn't cover
// (nutrition, difficulty-vs-energy, expected reward) as adjustments on
// top, plus human-readable reasons, a confidence score, an expected-
// benefit line, and a grounded "after this" preview — it does not
// change what rankTasks means on its own, so anything still calling
// Tasks.rankTasks() directly keeps working.
//
// Requires state.js (and therefore tasks.js) loaded first.
// =============================================================
(function () {
  'use strict';

  function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  function relativeDeadline(hoursLeft) {
    if (hoursLeft <= 0) return 'now';
    if (hoursLeft < 24) return 'in ' + Math.round(hoursLeft) + 'h';
    if (hoursLeft < 48) return 'tomorrow';
    return 'in ' + Math.round(hoursLeft / 24) + 'd';
  }

  const ENERGY_RANK = { very_low: 1, low: 2, moderate: 3, high: 4, peak: 5 };

  // Rough, non-personalized protein pacing check — not a substitute for a
  // real nutrition plan, just enough to (a) occasionally deprioritize
  // demanding tasks when intake is clearly behind for the time of day, and
  // (b) surface "protein intake already sufficient" as a positive reason
  // when it's not an issue, matching the kind of thing a person would
  // actually notice about their own day.
  function nutritionAdjustment(task, nutrition, now) {
    if (!nutrition || nutrition.proteinG == null) return { delta: 0, note: null };
    const hour = new Date(now).getHours();
    const dayFraction = Math.min(1, Math.max(0.15, hour / 18));
    const roughDailyTargetG = 90;
    const expectedByNow = roughDailyTargetG * dayFraction;
    const sufficient = nutrition.proteinG >= expectedByNow * 0.7;
    if (!sufficient && (task.energyLevel === 'high' || task.energyLevel === 'deep_focus')) {
      return { delta: -8, note: 'protein intake behind for this point in the day' };
    }
    return { delta: 0, note: sufficient ? 'Protein intake already sufficient' : null };
  }

  // A hard task on a low-energy day is a bad match beyond what energyFit
  // (required vs. current *level*) already captures — this specifically
  // penalizes high cognitive difficulty when current energy is running low,
  // and gives a small demerit to trivial tasks on a peak-energy day (using
  // peak focus on busywork is its own kind of waste).
  function difficultyAdjustment(task, currentEnergyLevel) {
    if (task.difficulty == null || !currentEnergyLevel) return { delta: 0, note: null };
    const energyRank = ENERGY_RANK[currentEnergyLevel] || 3;
    if (task.difficulty >= 7 && energyRank <= 2) {
      return { delta: -6, note: 'demanding task on a low-energy stretch' };
    }
    if (task.difficulty <= 3 && energyRank >= 5) {
      return { delta: -2, note: null };
    }
    return { delta: 0, note: null };
  }

  // importance-per-minute, a simple ROI proxy: a high-ROI task that's also
  // quick scores much higher than an equally-valuable task that eats your
  // whole afternoon.
  function expectedReward(task) {
    return task.longTermROI / Math.max(task.estimatedMinutes / 30, 0.5);
  }

  function rankWithAdjustments(state) {
    const T = window.Tasks;
    const now = state.now;
    const base = T.rankTasks(state.tasks, {
      now,
      availableMinutes: state.calendar.availableMinutes,
      currentEnergy: state.productivity.level,
    });
    if (base.length === 0) return [];

    const withReward = base.map(r => ({ ...r, reward: expectedReward(r.task) }));
    const maxReward = Math.max(...withReward.map(r => r.reward));

    const adjusted = withReward.map(r => {
      const nutr = nutritionAdjustment(r.task, state.nutrition, now);
      const diff = difficultyAdjustment(r.task, state.productivity.level);
      const rewardBonus = maxReward > 0 ? (r.reward / maxReward) * 6 : 0;
      return {
        task: r.task,
        score: r.score,
        adjustedScore: r.score + nutr.delta + diff.delta + rewardBonus,
        nutritionNote: nutr.note,
        difficultyNote: diff.note,
        isTopReward: r.reward === maxReward,
      };
    });

    adjusted.sort((a, b) => b.adjustedScore - a.adjustedScore || a.task.estimatedMinutes - b.task.estimatedMinutes);
    return adjusted;
  }

  function buildReasons(winner, state) {
    const reasons = [];

    (state.productivity.factors || []).forEach(f => reasons.push(capitalize(f)));

    if (winner.task.deadline) {
      const hoursLeft = (new Date(winner.task.deadline).getTime() - state.now) / 3600000;
      if (hoursLeft <= 0) reasons.push('Overdue');
      else if (hoursLeft < 48) reasons.push('Deadline ' + relativeDeadline(hoursLeft));
    }

    if (state.calendar.connected && state.calendar.availableMinutes != null) {
      reasons.push(state.calendar.availableMinutes > 0
        ? 'No meetings for ' + state.calendar.availableMinutes + ' minutes'
        : 'Busy right now — good moment for something quick');
    }

    if (winner.nutritionNote) reasons.push(capitalize(winner.nutritionNote));
    if (winner.difficultyNote) reasons.push(capitalize(winner.difficultyNote));

    if (winner.isTopReward && winner.task.longTermROI >= 5) reasons.push('Highest ROI task');

    if (state.streaks && state.streaks.enoughData && state.streaks.active) {
      reasons.push(state.streaks.days + '-day completion streak going');
    }

    return reasons.length ? reasons : ['Best fit for right now'];
  }

  const BENEFIT_BY_DOMAIN = {
    career: 'Moves your engineering career forward',
    school: 'Improves academic performance',
    debate: 'Strengthens your debate coaching work',
    glp1_research: 'Advances your GLP-1 research',
    finance: 'Improves your financial position',
    personal: 'Takes care of something that matters to you',
    extracurricular: 'Builds your extracurricular record',
    health: 'Supports your health and fitness goals',
  };

  function buildExpectedBenefit(winner, state) {
    const task = winner.task;
    const benefits = [];
    let line = BENEFIT_BY_DOMAIN[task.lifeDomain] || 'Moves this forward';
    if (task.lifeDomain === 'school' && task.schoolClass) line += ' in ' + task.schoolClass;
    benefits.push(line);
    if (task.longTermROI >= 8) benefits.push('High long-term value task');
    if (task.deadline) {
      const hoursLeft = (new Date(task.deadline).getTime() - state.now) / 3600000;
      if (hoursLeft > 0 && hoursLeft < 48) benefits.push('Keeps this on schedule before the deadline');
    }
    return benefits;
  }

  // Grounded in real data only — the next-ranked task, or the next actual
  // calendar event, whichever is sooner. Never invents a step (like "go eat
  // lunch") that isn't an actual task or calendar entry.
  function computeAfterThis(winner, ranked, state) {
    const finishAt = state.now + winner.task.estimatedMinutes * 60000;
    const nextEvent = state.calendar.nextEvent;
    const nextTaskEntry = ranked[1];

    const eventComesFirst = nextEvent && (!nextTaskEntry || new Date(nextEvent.start).getTime() <= finishAt + 15 * 60000);

    if (eventComesFirst) {
      return { type: 'event', title: nextEvent.title, minutesUntil: nextEvent.minutesUntil };
    }
    if (nextTaskEntry) {
      return { type: 'task', title: nextTaskEntry.task.title, durationMin: nextTaskEntry.task.estimatedMinutes };
    }
    if (nextEvent) {
      return { type: 'event', title: nextEvent.title, minutesUntil: nextEvent.minutesUntil };
    }
    return null;
  }

  // Confidence is derived from the score gap between the winner and the
  // runner-up — a wide gap means picking the winner is both high-confidence
  // and low-opportunity-cost; a narrow gap means the reverse (there wasn't
  // a clearly-better choice). One computation drives both concepts.
  function computeConfidence(ranked) {
    if (ranked.length < 2) return 95;
    const gap = ranked[0].adjustedScore - ranked[1].adjustedScore;
    return Math.round(Math.min(99, Math.max(50, 55 + gap * 1.3)));
  }

  function buildNarrative(reasons) {
    if (!reasons.length) return '';
    return "I'm recommending this because: " + reasons.map(r => (r.endsWith('.') ? r : r + '.')).join(' ');
  }

  async function decide() {
    const state = await window.State.getTodaysState();
    const ranked = rankWithAdjustments(state);

    if (ranked.length === 0) {
      return { task: null, durationMin: null, reasons: [], confidence: null, expectedBenefit: [], afterThis: null, narrative: '', state };
    }

    const winner = ranked[0];
    const reasons = buildReasons(winner, state);

    return {
      task: winner.task,
      durationMin: winner.task.estimatedMinutes,
      reasons,
      confidence: computeConfidence(ranked),
      expectedBenefit: buildExpectedBenefit(winner, state),
      afterThis: computeAfterThis(winner, ranked, state),
      narrative: buildNarrative(reasons),
      state,
    };
  }

  window.DecisionEngine = { decide };
})();
