// ============================================================
// POST /api/classify-task
// Body: { title: "Email professor about extension" }
// Reply: { ok: true, classification: {...} } | { ok: false, error }
//
// Infers the rich task schema (tasks.js's lifeDomain/schoolClass/
// longTermROI/urgency/difficulty/estimatedMinutes/energyLevel) from
// a bare title, so the user "should almost never classify anything
// manually." Runs server-side (ANTHROPIC_API_KEY env var) rather than
// the browser-side BYO-key pattern Nova uses — classification needs to
// work from any device without re-pasting a key into each one's
// localStorage, which would reintroduce the friction this feature
// exists to remove.
//
// Never blocks task creation: manage.html adds the task immediately
// with sensible defaults and patches in the classification when (if)
// this resolves. { ok: false } — missing key, API error, malformed
// output — is a normal, expected response, not a failure state.
//
// Env var required on Vercel:
//   ANTHROPIC_API_KEY
// ============================================================
import Anthropic from '@anthropic-ai/sdk';

const CATEGORIES = ['career', 'school', 'debate', 'glp1_research', 'finance', 'personal', 'extracurricular', 'health'];
const ENERGY_LEVELS = ['low', 'medium', 'high'];

const SCHEMA = {
  type: 'object',
  properties: {
    lifeDomain: { type: 'string', enum: CATEGORIES },
    schoolClass: { type: ['string', 'null'], description: 'Only set when lifeDomain is "school" — the specific class/course this belongs to. Null otherwise.' },
    longTermROI: { type: 'integer', description: '1-10: how much this task matters for long-term outcomes (career, health, wealth, happiness), independent of urgency.' },
    urgency: { type: 'integer', description: '1-10: how time-sensitive this inherently is, independent of any explicit deadline.' },
    difficulty: { type: 'integer', description: '1-10: cognitive/effort difficulty.' },
    estimatedMinutes: { type: 'integer', description: 'Realistic estimated time to complete, in minutes.' },
    energyLevel: { type: 'string', enum: ENERGY_LEVELS, description: 'Energy required to do this well.' },
  },
  required: ['lifeDomain', 'schoolClass', 'longTermROI', 'urgency', 'difficulty', 'estimatedMinutes', 'energyLevel'],
  additionalProperties: false,
};

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(200).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const title = ((body && body.title) || '').trim();
  if (!title) return res.status(400).json({ ok: false, error: 'title required' });

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 300,
      output_config: {
        effort: 'low', // fast, cheap classification — not a reasoning task
        format: { type: 'json_schema', schema: SCHEMA },
      },
      messages: [{
        role: 'user',
        content: 'Classify this personal task for a student/early-career engineer who also does debate coaching and GLP-1 research: "' + title + '"',
      }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const raw = JSON.parse(textBlock.text);

    const classification = {
      lifeDomain: CATEGORIES.includes(raw.lifeDomain) ? raw.lifeDomain : 'personal',
      schoolClass: raw.lifeDomain === 'school' && typeof raw.schoolClass === 'string' ? raw.schoolClass : null,
      longTermROI: clampInt(raw.longTermROI, 1, 10, 5),
      urgency: clampInt(raw.urgency, 1, 10, 5),
      difficulty: clampInt(raw.difficulty, 1, 10, 5),
      estimatedMinutes: clampInt(raw.estimatedMinutes, 1, 480, 30),
      energyLevel: ENERGY_LEVELS.includes(raw.energyLevel) ? raw.energyLevel : 'medium',
      classified: true,
    };

    return res.status(200).json({ ok: true, classification });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
}
