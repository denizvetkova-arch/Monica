// ============================================================
// POST /api/classify-task
// Body: { titles: ["Email professor", "Costco"], lifeContext: "...",
//         existingTasks: [{title, lifeDomain, longTermROI}, ...] }
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
// v2: classifying tasks one-at-a-time with no context produced
// near-identical scores for almost everything (ROI/urgency/difficulty
// all clustering around 5-6) — there was nothing to differentiate
// against. Two fixes: (1) the caller sends the user's own free-text
// "Life Context" (goals/projects/priorities, written once in Settings,
// not per task) so scores are grounded in what actually matters to
// them; (2) classification is now BATCHED — all new tasks, plus a
// sample of their other current open tasks, go into one call, so the
// model differentiates relative to a real workload instead of scoring
// each title in an isolated vacuum.
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
        },
        required: ['title', 'lifeDomain', 'schoolClass', 'longTermROI', 'urgency', 'difficulty', 'estimatedMinutes', 'energyLevel'],
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
      classified: true,
    };
  });
}

export function buildPrompt(titles, lifeContext, existingTasks) {
  const contextBlock = lifeContext && lifeContext.trim()
    ? 'Here is what this person has told you about their life, goals, and priorities — use it to judge what actually matters to them:\n"""\n' + lifeContext.trim() + '\n"""'
    : "This person hasn't written a life context yet, so use your best general judgment — but still differentiate between tasks rather than scoring them all the same.";

  const existingBlock = existingTasks.length
    ? '\n\nTheir other current open tasks, for calibration (use these so you don\'t score every new task the same — judge each new task relative to this real workload):\n' +
      existingTasks.map(t => '- "' + t.title + '"' + (t.lifeDomain ? ' [' + t.lifeDomain + (t.longTermROI != null ? ', ROI ' + t.longTermROI : '') + ']' : '')).join('\n')
    : '';

  const newBlock = '\n\nClassify these ' + titles.length + ' new task(s), in order:\n' +
    titles.map((t, i) => (i + 1) + '. "' + t + '"').join('\n');

  return contextBlock + existingBlock + newBlock + '\n\n' +
    'For each task, infer: lifeDomain, schoolClass, longTermROI, urgency, difficulty, estimatedMinutes, energyLevel. ' +
    'IMPORTANT: spread your scores across the full 1-10 range based on real differences between these tasks and the ' +
    'life context above — do not cluster everything at 5 or 6. A routine errand unrelated to any stated priority should ' +
    'score low ROI; a task tied to a stated goal, deadline, or high-stakes project should score high. Echo each task\'s ' +
    'exact title back in your response, in the same order given.';
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

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 300 + titles.length * 120,
      output_config: {
        effort: 'low', // fast, cheap classification — not a reasoning task
        format: { type: 'json_schema', schema: BATCH_SCHEMA },
      },
      messages: [{ role: 'user', content: buildPrompt(titles, lifeContext, existingTasks) }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const raw = JSON.parse(textBlock.text);
    const classifications = processClassificationResponse(titles, raw.classifications);

    return res.status(200).json({ ok: true, classifications });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
}
