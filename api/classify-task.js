// ============================================================
// POST /api/classify-task
// Body: { titles: ["Email professor", "Costco"], details: ["", "..."],
//         lifeContext: "...", existingTasks: [{title, lifeDomain, longTermROI}, ...],
//         corrections: [{title, prediction, correction, outcome}, ...],
//         completions: [{title, estimatedMinutes, actualMinutes, feeling}, ...],
//         preferenceSummary: "..." }
// Reply: { ok: true, classifications: [{...}, ...] } | { ok: false, error }
// (classifications is in the same order as titles)
//
// Infers the rich task schema (tasks.js's lifeDomain/schoolClass/
// longTermROI/urgency/difficulty/estimatedMinutes/energyLevel) from
// bare titles, so the user "should almost never classify anything
// manually." Runs server-side (ANTHROPIC_API_KEY env var) rather than
// the browser-side BYO-key pattern Nova uses — classification needs to
// work from any device without re-pasting a key into each one's
// localStorage.
//
// v3 — AI Training Mode. Each classification also carries a `confidence`
// (1-100). The client (manage.html) auto-accepts >= 90 silently and only
// surfaces a review card below that. Below 90 isn't a failure — it's the
// model correctly saying "I'm not sure," which is exactly the case the
// review card exists for.
//
// v4 — Preference Model v2. `preferenceSummary` is a preformatted
// narrative string computed CLIENT-SIDE by preference-profile.js (this
// endpoint has no access to localStorage) — aggregated, named patterns
// like "Research: ROI +2 over average" or "AI, startup, coding: learned
// as Career," derived from the full history of corrections/completions,
// not just a recent sample. It's read FIRST, before the raw corrections/
// completions few-shot lists, since it's the highest-level prior. Those
// raw lists stay too — concrete recent examples still add texture under
// the aggregated summary. `details` is optional free-text per task
// (from a task's own Details field in manage.html/train.html) giving the
// model context a title alone can't — e.g. why something is harder or
// more urgent than its title implies.
//
// Never blocks task creation: manage.html adds tasks immediately with
// defaults and patches in the classification when (if) this resolves.
// { ok: false } — missing key, API error, malformed output — is a
// normal, expected response, not a failure state.
//
// Env var required on Vercel:
//   ANTHROPIC_API_KEY
// ============================================================
import Anthropic from '@anthropic-ai/sdk';

const CATEGORIES = ['career', 'school', 'debate', 'glp1_research', 'finance', 'personal', 'extracurricular', 'health'];
// 5-level — was 3 (low/medium/high). Matches tasks.js's ENERGY_LEVELS.
const ENERGY_LEVELS = ['very_low', 'low', 'medium', 'high', 'deep_focus'];
const RECURRENCE_VALUES = ['none', 'daily', 'weekly', 'monthly'];
const MAX_TITLES_PER_CALL = 40; // caller (manage.html) chunks larger batches into multiple calls
const MAX_EXISTING_TASKS = 40;
const MAX_CORRECTIONS = 25;
const MAX_COMPLETIONS = 20;
const MAX_PREFERENCE_SUMMARY_CHARS = 4000;
const DEFAULT_CONFIDENCE = 60; // missing confidence reads as "uncertain", not "trust blindly"

const BATCH_SCHEMA = {
  type: 'object',
  properties: {
    classifications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Echo the exact task title this classification is for.' },
          lifeDomain: { type: 'string', enum: CATEGORIES },
          schoolClass: { type: ['string', 'null'], description: 'Only set when lifeDomain is "school" — the specific class/course. Null otherwise.' },
          longTermROI: { type: 'integer', description: '1-10: how much this matters for long-term outcomes, grounded in the life context and Preference Profile provided. Spread scores across the range — do not default to 5-6.' },
          urgency: { type: 'integer', description: '1-10: how time-sensitive this inherently is, independent of any explicit deadline.' },
          difficulty: { type: 'integer', description: '1-10: cognitive/effort difficulty.' },
          estimatedMinutes: { type: 'integer', description: 'Realistic estimated time to complete, in minutes.' },
          energyLevel: { type: 'string', enum: ENERGY_LEVELS, description: 'Energy required to do this well — deep_focus for anything needing a long uninterrupted block, not just "hard" tasks.' },
          confidence: {
            type: 'integer',
            description: '1-100: how confident you are in THIS classification. Score lower (below 90) when the title is ambiguous, generic, or does not clearly match the life context / Preference Profile / existing tasks provided. Score higher when it clearly matches a stated priority or a previously-learned pattern. Do not default to a high number out of politeness — low confidence is the correct, useful answer when a task is genuinely unclear.',
          },
          recurrence: {
            type: 'string', enum: RECURRENCE_VALUES,
            description: 'Only "daily"/"weekly"/"monthly" if this is genuinely a recurring habit, routine chore, or regularly repeating obligation (e.g. "take vitamins", "water plants", "pay rent"). "none" for one-off tasks — this is most tasks; do not guess a recurrence just because a task sounds routine.',
          },
        },
        required: ['title', 'lifeDomain', 'schoolClass', 'longTermROI', 'urgency', 'difficulty', 'estimatedMinutes', 'energyLevel', 'confidence', 'recurrence'],
        additionalProperties: false,
      },
    },
  },
  required: ['classifications'],
  additionalProperties: false,
};

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Turns the model's raw (possibly malformed/reordered/short) classifications
// array into exactly `titles.length` validated entries, in input order.
// Exported for unit testing — this is the part most likely to see weird
// input, not the prompt string.
export function processClassificationResponse(titles, rawList) {
  const list = Array.isArray(rawList) ? rawList : [];
  return titles.map((title, i) => {
    const match = list.find((r) => r && r.title === title) || list[i] || {};
    const lifeDomain = CATEGORIES.includes(match.lifeDomain) ? match.lifeDomain : 'personal';
    return {
      lifeDomain,
      schoolClass: lifeDomain === 'school' && typeof match.schoolClass === 'string' ? match.schoolClass : null,
      longTermROI: clampInt(match.longTermROI, 1, 10, 5),
      urgency: clampInt(match.urgency, 1, 10, 5),
      difficulty: clampInt(match.difficulty, 1, 10, 5),
      estimatedMinutes: clampInt(match.estimatedMinutes, 1, 480, 30),
      energyLevel: ENERGY_LEVELS.includes(match.energyLevel) ? match.energyLevel : 'medium',
      confidence: clampInt(match.confidence, 1, 100, DEFAULT_CONFIDENCE),
      recurrence: RECURRENCE_VALUES.includes(match.recurrence) && match.recurrence !== 'none' ? match.recurrence : null,
    };
  });
}

function formatFieldsShort(f) {
  if (!f) return '(unknown)';
  return f.lifeDomain + ', ROI ' + f.longTermROI + ', urgency ' + f.urgency + ', difficulty ' + f.difficulty + ', ~' + f.estimatedMinutes + 'm, ' + f.energyLevel + ' energy';
}

// options: { titles, details, lifeContext, existingTasks, corrections,
// completions, preferenceSummary }. An options object rather than
// positional args — this grew from 3 to 7 parameters as the Preference
// Model deepened, past the point where positional args stay readable.
export function buildPrompt(options) {
  const { titles, details, lifeContext, existingTasks, corrections, completions, preferenceSummary } = options;

  const contextBlock = lifeContext && lifeContext.trim()
    ? 'Here is what this person has told you about their life, goals, and priorities — use it to judge what actually matters to them:\n"""\n' + lifeContext.trim() + '\n"""'
    : "This person hasn't written a life context yet, so use your best general judgment — but still differentiate between tasks rather than scoring them all the same.";

  // The Preference Profile — aggregated, named patterns learned from this
  // person's ENTIRE correction/completion history (not just a recent
  // sample). Placed right after Life Context since it's the highest-level
  // prior: apply it before anything else, including for new tasks whose
  // title matches a learned keyword even if it looks generically like
  // another domain (e.g. "AI coding" should read as Career if that's what
  // the profile says, not Personal just because it sounds like a hobby).
  const preferenceSummaryBlock = preferenceSummary && preferenceSummary.trim()
    ? '\n\nMonica\'s Preference Profile — patterns learned from this person over time. Apply these FIRST, ' +
      'before general judgment, even overriding what a generic guess would suggest:\n"""\n' + preferenceSummary.trim() + '\n"""'
    : '';

  const existingBlock = existingTasks && existingTasks.length
    ? '\n\nTheir other current open tasks, for calibration (use these so you don\'t score every new task the same — judge each new task relative to this real workload):\n' +
      existingTasks.map(t => '- "' + t.title + '"' + (t.lifeDomain ? ' [' + t.lifeDomain + (t.longTermROI != null ? ', ROI ' + t.longTermROI : '') + ']' : '')).join('\n')
    : '';

  // Raw few-shot corrections/completions — concrete recent examples that
  // add texture under the aggregated Preference Profile above. Not a
  // trained model (no training pipeline exists in this architecture),
  // just recent demonstrated preference the model should generalize from.
  const correctionsBlock = corrections && corrections.length
    ? '\n\nRecent examples of predictions and what the user actually confirmed or changed. ' +
      'Learn the PATTERN behind these, not these exact titles:\n' +
      corrections.map(c => {
        if (c.outcome === 'corrected' && c.correction) {
          return '- "' + c.title + '" — I predicted [' + formatFieldsShort(c.prediction) + '], but the user corrected it to [' + formatFieldsShort(c.correction) + ']';
        }
        return '- "' + c.title + '" — I predicted [' + formatFieldsShort(c.prediction) + '] and the user confirmed it was correct';
      }).join('\n')
    : '';

  // Duration calibration — same few-shot mechanism, focused specifically on
  // estimatedMinutes accuracy.
  const completionsBlock = completions && completions.length
    ? '\n\nDuration calibration — how long this user\'s tasks actually took vs. the estimate, for calibrating estimatedMinutes:\n' +
      completions.map(c => '- "' + c.title + '" — estimated ' + c.estimatedMinutes + 'm, actually took ' + c.actualMinutes + 'm' + (c.feeling ? ' (felt ' + c.feeling + ')' : '')).join('\n')
    : '';

  // Per-task free text the user attached (a task's Details field) — the
  // one thing a bare title can't convey. Only listed for tasks that have
  // any; omitted entirely (falls back to the bare numbered list) when
  // nothing has details.
  const hasDetails = Array.isArray(details) && details.some(d => d && String(d).trim());
  const newBlock = '\n\nClassify these ' + titles.length + ' new task(s), in order:\n' +
    titles.map((t, i) => {
      const d = hasDetails && details[i] ? String(details[i]).trim() : '';
      return (i + 1) + '. "' + t + '"' + (d ? ' — Details: "' + d + '"' : '');
    }).join('\n');

  return contextBlock + preferenceSummaryBlock + existingBlock + correctionsBlock + completionsBlock + newBlock + '\n\n' +
    'For each task, infer: lifeDomain, schoolClass, longTermROI, urgency, difficulty, estimatedMinutes, energyLevel, confidence, recurrence. ' +
    'IMPORTANT: spread your scores across the full 1-10 range based on real differences between these tasks and the ' +
    'life context/Preference Profile above — do not cluster everything at 5 or 6. A routine errand unrelated to any stated priority should ' +
    'score low ROI; a task tied to a stated goal, deadline, or high-stakes project should score high. Read each task\'s Details (if given) ' +
    'and let it adjust ROI/urgency/difficulty/duration — it often says something the title alone can\'t. Report confidence ' +
    'honestly — below 90 is expected and fine for anything genuinely ambiguous; it triggers a quick human check rather than ' +
    'a wrong silent guess. Echo each task\'s exact title back in your response, in the same order given.';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(200).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  let titles = Array.isArray(body && body.titles) ? body.titles.map(t => String(t || '').trim()).filter(Boolean) : [];
  if (titles.length === 0 && body && body.title) titles = [String(body.title).trim()].filter(Boolean); // back-compat: single title
  if (titles.length === 0) return res.status(400).json({ ok: false, error: 'titles required' });
  titles = titles.slice(0, MAX_TITLES_PER_CALL);

  const details = Array.isArray(body && body.details) ? body.details.slice(0, titles.length) : [];
  const lifeContext = (body && body.lifeContext) ? String(body.lifeContext).slice(0, 4000) : '';
  const existingTasks = Array.isArray(body && body.existingTasks) ? body.existingTasks.slice(0, MAX_EXISTING_TASKS) : [];
  const corrections = Array.isArray(body && body.corrections) ? body.corrections.slice(0, MAX_CORRECTIONS) : [];
  const completions = Array.isArray(body && body.completions) ? body.completions.slice(0, MAX_COMPLETIONS) : [];
  const preferenceSummary = (body && body.preferenceSummary) ? String(body.preferenceSummary).slice(0, MAX_PREFERENCE_SUMMARY_CHARS) : '';

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 350 + titles.length * 140,
      output_config: {
        effort: 'low', // fast, cheap classification — not a reasoning task
        format: { type: 'json_schema', schema: BATCH_SCHEMA },
      },
      messages: [{ role: 'user', content: buildPrompt({ titles, details, lifeContext, existingTasks, corrections, completions, preferenceSummary }) }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const raw = JSON.parse(textBlock.text);
    const classifications = processClassificationResponse(titles, raw.classifications);

    return res.status(200).json({ ok: true, classifications });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
}
