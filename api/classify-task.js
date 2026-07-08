// ============================================================
// POST /api/classify-task
// Body: { titles: ["Email professor", "Costco"], lifeContext: "...",
//         existingTasks: [{title, lifeDomain, longTermROI}, ...],
//         corrections: [{title, prediction, correction, outcome}, ...],
//         completions: [{title, estimatedMinutes, actualMinutes, feeling}, ...] }
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
// v3 — AI Training Mode. Each classification now also carries a
// `confidence` (1-100). The client (manage.html) auto-accepts >= 90
// silently and only surfaces a review card below that. Below 90 isn't
// a failure — it's the model correctly saying "I'm not sure," which is
// exactly the case the review card exists for.
//
// `corrections` and `completions` are the "Preference Model" — not a
// trained model (no training pipeline exists in this architecture),
// but a growing sample of the user's actual approve/correct history and
// completion feedback, fed into the prompt as few-shot examples so
// predictions are grounded in demonstrated preference instead of a cold
// guess every time. tasks.js's getRecentCorrections()/getRecentCompletions()
// build these arrays; this endpoint just formats them into the prompt.
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
const ENERGY_LEVELS = ['low', 'medium', 'high'];
const MAX_TITLES_PER_CALL = 40; // caller (manage.html) chunks larger batches into multiple calls
const MAX_EXISTING_TASKS = 40;
const MAX_CORRECTIONS = 25;
const MAX_COMPLETIONS = 20;
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
          longTermROI: { type: 'integer', description: '1-10: how much this matters for long-term outcomes, grounded in the life context provided. Spread scores across the range — do not default to 5-6.' },
          urgency: { type: 'integer', description: '1-10: how time-sensitive this inherently is, independent of any explicit deadline.' },
          difficulty: { type: 'integer', description: '1-10: cognitive/effort difficulty.' },
          estimatedMinutes: { type: 'integer', description: 'Realistic estimated time to complete, in minutes.' },
          energyLevel: { type: 'string', enum: ENERGY_LEVELS, description: 'Energy required to do this well.' },
          confidence: {
            type: 'integer',
            description: '1-100: how confident you are in THIS classification. Score lower (below 90) when the title is ambiguous, generic, or does not clearly match the life context / preference examples / existing tasks provided. Score higher when it clearly matches a stated priority or a previously-confirmed pattern. Do not default to a high number out of politeness — low confidence is the correct, useful answer when a task is genuinely unclear.',
          },
        },
        required: ['title', 'lifeDomain', 'schoolClass', 'longTermROI', 'urgency', 'difficulty', 'estimatedMinutes', 'energyLevel', 'confidence'],
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
    };
  });
}

function formatFieldsShort(f) {
  if (!f) return '(unknown)';
  return f.lifeDomain + ', ROI ' + f.longTermROI + ', urgency ' + f.urgency + ', difficulty ' + f.difficulty + ', ~' + f.estimatedMinutes + 'm, ' + f.energyLevel + ' energy';
}

export function buildPrompt(titles, lifeContext, existingTasks, corrections, completions) {
  const contextBlock = lifeContext && lifeContext.trim()
    ? 'Here is what this person has told you about their life, goals, and priorities — use it to judge what actually matters to them:\n"""\n' + lifeContext.trim() + '\n"""'
    : "This person hasn't written a life context yet, so use your best general judgment — but still differentiate between tasks rather than scoring them all the same.";

  const existingBlock = existingTasks && existingTasks.length
    ? '\n\nTheir other current open tasks, for calibration (use these so you don\'t score every new task the same — judge each new task relative to this real workload):\n' +
      existingTasks.map(t => '- "' + t.title + '"' + (t.lifeDomain ? ' [' + t.lifeDomain + (t.longTermROI != null ? ', ROI ' + t.longTermROI : '') + ']' : '')).join('\n')
    : '';

  // The "Preference Model" — not a trained model, a growing few-shot log of
  // what this specific user actually approved or changed. Framed explicitly
  // as pattern-learning, not memorization of these exact titles.
  const correctionsBlock = corrections && corrections.length
    ? '\n\nPreference Model — examples of past predictions and what the user actually confirmed or changed. ' +
      'Learn the PATTERN behind these (e.g. "routine errands score lower than I predicted", "school tasks near a stated exam date score higher"), not these exact titles:\n' +
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

  const newBlock = '\n\nClassify these ' + titles.length + ' new task(s), in order:\n' +
    titles.map((t, i) => (i + 1) + '. "' + t + '"').join('\n');

  return contextBlock + existingBlock + correctionsBlock + completionsBlock + newBlock + '\n\n' +
    'For each task, infer: lifeDomain, schoolClass, longTermROI, urgency, difficulty, estimatedMinutes, energyLevel, confidence. ' +
    'IMPORTANT: spread your scores across the full 1-10 range based on real differences between these tasks and the ' +
    'life context above — do not cluster everything at 5 or 6. A routine errand unrelated to any stated priority should ' +
    'score low ROI; a task tied to a stated goal, deadline, or high-stakes project should score high. Report confidence ' +
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

  const lifeContext = (body && body.lifeContext) ? String(body.lifeContext).slice(0, 4000) : '';
  const existingTasks = Array.isArray(body && body.existingTasks) ? body.existingTasks.slice(0, MAX_EXISTING_TASKS) : [];
  const corrections = Array.isArray(body && body.corrections) ? body.corrections.slice(0, MAX_CORRECTIONS) : [];
  const completions = Array.isArray(body && body.completions) ? body.completions.slice(0, MAX_COMPLETIONS) : [];

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 350 + titles.length * 140,
      output_config: {
        effort: 'low', // fast, cheap classification — not a reasoning task
        format: { type: 'json_schema', schema: BATCH_SCHEMA },
      },
      messages: [{ role: 'user', content: buildPrompt(titles, lifeContext, existingTasks, corrections, completions) }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const raw = JSON.parse(textBlock.text);
    const classifications = processClassificationResponse(titles, raw.classifications);

    return res.status(200).json({ ok: true, classifications });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
}
