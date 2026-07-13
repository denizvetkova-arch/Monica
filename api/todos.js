// ============================================================
// GET/POST /api/todos
// Voice/API access to Monica's existing to-do list — this reads and
// writes the SAME "tasks" row in Supabase's app_state table that
// tasks.js/sync.js already mirror to/from every browser tab (today.html,
// manage.html, train.html). A todo added here shows up on the dashboard
// within ~1s via Supabase's realtime subscription, same as any other
// device; a todo added on the dashboard is visible here immediately too.
// There is no separate "voice todo" store — see the Phase 1 design note
// in api/ask.js's header for why (this app already had a complete,
// synced to-do list before this endpoint existed).
//
// Auth: Authorization: Bearer <ASSISTANT_API_TOKEN>
//
// GET  -> { ok: true, tasks: [...] }                 (full current list)
// POST body:
//   { action: 'add', title, deadline?, estimatedMinutes?, lifeDomain?,
//     longTermROI?, urgency?, difficulty?, energyLevel?, details? }
//   { action: 'complete', id }
//   { action: 'reschedule', id, deadline }   (deadline: ISO string or null)
//   { action: 'delete', id }
//   -> { ok: true, tasks: [...] }                    (full list after the mutation)
//
// Task shape matches tasks.js's addTask() exactly — anything written
// here is a normal task to the rest of the app, not a special case.
//
// Env vars required on Vercel:
//   ASSISTANT_API_TOKEN   (any secret string you choose)
//   SUPABASE_URL
//   SUPABASE_ANON_KEY
// ============================================================

const CATEGORIES = ['career', 'school', 'debate', 'glp1_research', 'finance', 'personal', 'extracurricular', 'health'];
const ENERGY_LEVELS = ['very_low', 'low', 'medium', 'high', 'deep_focus'];

function genId() {
  return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function checkAuth(req) {
  const expected = process.env.ASSISTANT_API_TOKEN;
  if (!expected) return false;
  const header = (req.headers && req.headers.authorization) || '';
  const token = header.indexOf('Bearer ') === 0 ? header.slice(7) : '';
  return token === expected;
}

async function readAppState(supabaseUrl, supabaseKey, key) {
  try {
    const r = await fetch(supabaseUrl + '/rest/v1/app_state?key=eq.' + key + '&select=data', {
      headers: { apikey: supabaseKey, Authorization: 'Bearer ' + supabaseKey },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return (rows && rows[0] && rows[0].data) || null;
  } catch (e) { return null; }
}

async function upsertAppState(supabaseUrl, supabaseKey, key, data) {
  return fetch(supabaseUrl + '/rest/v1/app_state?on_conflict=key', {
    method: 'POST',
    headers: {
      apikey: supabaseKey,
      Authorization: 'Bearer ' + supabaseKey,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ key, data, updated_at: new Date().toISOString() }),
  });
}

// Mirrors tasks.js's addTask() field-for-field so a task created here
// is indistinguishable from one created in the UI.
export function newTask(partial) {
  partial = partial || {};
  return {
    id: genId(),
    title: String(partial.title || '').trim(),
    deadline: partial.deadline || null,
    estimatedMinutes: partial.estimatedMinutes != null ? clampInt(partial.estimatedMinutes, 1, 1440, 30) : 30,
    longTermROI: partial.longTermROI != null ? clampInt(partial.longTermROI, 1, 10, 5) : 5,
    urgency: partial.urgency != null ? clampInt(partial.urgency, 1, 10, 5) : 5,
    difficulty: partial.difficulty != null ? clampInt(partial.difficulty, 1, 10, 5) : 5,
    lifeDomain: CATEGORIES.indexOf(partial.lifeDomain) !== -1 ? partial.lifeDomain : 'personal',
    schoolClass: partial.schoolClass || null,
    energyLevel: ENERGY_LEVELS.indexOf(partial.energyLevel) !== -1 ? partial.energyLevel : 'medium',
    done: false,
    createdAt: Date.now(),
    completedAt: null,
    snoozedUntil: null,
    recurrence: null,
    details: partial.details || '',
    skipCount: 0,
    userReviewed: false,
    classified: false,
    classificationVersion: 0,
  };
}

export default async function handler(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ ok: false, error: 'invalid or missing bearer token' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ ok: false, error: 'server not configured (missing SUPABASE_URL / SUPABASE_ANON_KEY)' });

  const existing = await readAppState(supabaseUrl, supabaseKey, 'tasks');
  let tasks = (existing && Array.isArray(existing.tasks_v1)) ? existing.tasks_v1 : [];

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, tasks });
  }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const action = body && body.action;

  if (action === 'add') {
    if (!body.title || !String(body.title).trim()) return res.status(400).json({ ok: false, error: 'title required' });
    tasks = tasks.concat([newTask(body)]);
  } else if (action === 'complete') {
    const idx = tasks.findIndex((t) => t.id === body.id);
    if (idx === -1) return res.status(404).json({ ok: false, error: 'task not found' });
    tasks = tasks.slice();
    tasks[idx] = Object.assign({}, tasks[idx], { done: true, completedAt: Date.now() });
  } else if (action === 'reschedule') {
    const idx = tasks.findIndex((t) => t.id === body.id);
    if (idx === -1) return res.status(404).json({ ok: false, error: 'task not found' });
    tasks = tasks.slice();
    tasks[idx] = Object.assign({}, tasks[idx], { deadline: body.deadline || null });
  } else if (action === 'delete') {
    const idx = tasks.findIndex((t) => t.id === body.id);
    if (idx === -1) return res.status(404).json({ ok: false, error: 'task not found' });
    tasks = tasks.filter((t) => t.id !== body.id);
  } else {
    return res.status(400).json({ ok: false, error: 'unknown action (expected add/complete/reschedule/delete)' });
  }

  const r = await upsertAppState(supabaseUrl, supabaseKey, 'tasks', { tasks_v1: tasks });
  if (!r.ok) {
    const text = await r.text();
    return res.status(500).json({ ok: false, error: 'supabase upsert failed: ' + text });
  }

  return res.status(200).json({ ok: true, tasks });
}
