// ============================================================
// POST /api/ask
// Body: { message: string, voice?: boolean }
// Reply: { ok: true, reply: string } | { ok: false, error }
//
// voice: true tells Claude the reply will be spoken aloud (TTS) rather
// than read as text — short, conversational, no markdown. Omit/false
// for the normal chat-window style (still concise, but not TTS-tuned).
//
// Phase 1 of the voice-driven-assistant work: a chat entry point for
// Monica. The system prompt is built from the SAME data the dashboard
// already shows — current to-dos (Supabase's "tasks" app_state row,
// identical to what today.html/manage.html render) and the "Life
// Context" profile (the "life_context" row, written once in today.html's
// Settings — see SETUP.md §5). There is no separate voice-only data
// store: this was a deliberate choice over a fresh Vercel KV store,
// because a second to-do list would silently diverge from the one the
// dashboard shows — see api/todos.js for the read/write helpers this
// file shares the same Supabase row shape with.
//
// Claude can add/complete/reschedule to-dos via tool use — each tool
// call mutates the SAME tasks_v1 array and is written back to Supabase
// before the response returns, so anything the assistant does here is
// visible on the dashboard within ~1s (Supabase realtime), same as any
// other device.
//
// Auth: Authorization: Bearer <ASSISTANT_API_TOKEN>
//
// Env vars required on Vercel:
//   ANTHROPIC_API_KEY
//   ASSISTANT_API_TOKEN   (any secret string you choose — same one as api/todos.js)
//   SUPABASE_URL
//   SUPABASE_ANON_KEY
// ============================================================
import Anthropic from '@anthropic-ai/sdk';

const CATEGORIES = ['career', 'school', 'debate', 'glp1_research', 'finance', 'personal', 'extracurricular', 'health'];
const ENERGY_LEVELS = ['very_low', 'low', 'medium', 'high', 'deep_focus'];
const MAX_TOOL_ITERATIONS = 5; // guards against a runaway tool-call loop within one request

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

// Mirrors tasks.js's addTask() field-for-field — same shape as
// api/todos.js's newTask(), duplicated rather than shared per this
// codebase's existing convention of self-contained api/*.js files.
export function newTask(partial) {
  partial = partial || {};
  return {
    id: genId(),
    title: String(partial.title || '').trim(),
    deadline: partial.deadline || null,
    estimatedMinutes: partial.estimatedMinutes != null ? clampInt(partial.estimatedMinutes, 1, 1440, 30) : 30,
    longTermROI: partial.longTermROI != null ? clampInt(partial.longTermROI, 1, 10, 5) : 5,
    urgency: partial.urgency != null ? clampInt(partial.urgency, 1, 10, 5) : 5,
    difficulty: 5,
    lifeDomain: CATEGORIES.indexOf(partial.lifeDomain) !== -1 ? partial.lifeDomain : 'personal',
    schoolClass: null,
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

const TOOLS = [
  {
    name: 'add_todo',
    description: 'Add a new to-do item to the list.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title.' },
        deadline: { type: ['string', 'null'], description: 'ISO 8601 datetime, or null/omit if there is no deadline.' },
        estimatedMinutes: { type: 'integer', description: 'Realistic estimated minutes to complete.' },
        lifeDomain: { type: 'string', enum: CATEGORIES },
        longTermROI: { type: 'integer', description: '1-10: how important this is.' },
        urgency: { type: 'integer', description: '1-10: how time-sensitive this is.' },
        details: { type: 'string', description: 'Optional free-text notes.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'complete_todo',
    description: 'Mark an existing to-do as complete, by its id.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The exact id shown in brackets in the current to-do list.' } },
      required: ['id'],
    },
  },
  {
    name: 'reschedule_todo',
    description: 'Change an existing to-do\'s deadline, by its id.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The exact id shown in brackets in the current to-do list.' },
        deadline: { type: ['string', 'null'], description: 'New ISO 8601 datetime, or null to clear the deadline entirely.' },
      },
      required: ['id', 'deadline'],
    },
  },
];

export function buildSystemPrompt(tasks, lifeContext, voice) {
  const open = tasks.filter((t) => !t.done);
  const list = open.length
    ? open.map((t) => '- [' + t.id + '] ' + t.title +
        (t.deadline ? ' (due ' + t.deadline + ')' : '') +
        ' — ' + t.lifeDomain + ', importance ' + t.longTermROI + '/10, ~' + t.estimatedMinutes + 'min').join('\n')
    : '(no open to-dos)';
  const lines = [
    'You are Monica, Deni\'s personal AI executive assistant, talking with them directly (this may be read aloud or shown in a small chat window — be concise and direct, not verbose).',
    '',
    'Current open to-dos:',
    list,
    '',
    'Life Context — Deni\'s own summary of their current goals and priorities:',
    lifeContext ? lifeContext : '(not set yet)',
    '',
    'Use the add_todo / complete_todo / reschedule_todo tools for any change Deni asks for — never just claim you made a change without calling the tool. Use the exact id shown in brackets above when completing or rescheduling an existing to-do. If a to-do Deni refers to isn\'t in the list above, ask for clarification instead of guessing an id.',
  ];
  if (voice) {
    lines.push(
      '',
      'This reply will be spoken aloud through text-to-speech, not read as text. Reply in short, conversational plain text: no markdown (no headers, bullet points, asterisks, or code blocks), no numbered lists — say things the way you\'d say them out loud. Aim for 2-4 sentences; only go longer if the answer genuinely needs it (e.g. listing several to-dos by name).',
    );
  }
  return lines.join('\n');
}

// Executes one tool call against the in-memory task list and returns
// { tasks, result } — result is plain text fed back to Claude as the
// tool_result content, tasks is the (possibly unchanged) array.
export function runTool(tasks, name, input) {
  input = input || {};
  if (name === 'add_todo') {
    if (!input.title || !String(input.title).trim()) return { tasks, result: 'error: title is required' };
    const task = newTask(input);
    return { tasks: tasks.concat([task]), result: 'added "' + task.title + '" (id ' + task.id + ')' };
  }
  if (name === 'complete_todo') {
    const idx = tasks.findIndex((t) => t.id === input.id);
    if (idx === -1) return { tasks, result: 'error: no to-do with id "' + input.id + '"' };
    const updated = tasks.slice();
    updated[idx] = Object.assign({}, updated[idx], { done: true, completedAt: Date.now() });
    return { tasks: updated, result: 'completed "' + updated[idx].title + '"' };
  }
  if (name === 'reschedule_todo') {
    const idx = tasks.findIndex((t) => t.id === input.id);
    if (idx === -1) return { tasks, result: 'error: no to-do with id "' + input.id + '"' };
    const updated = tasks.slice();
    updated[idx] = Object.assign({}, updated[idx], { deadline: input.deadline || null });
    return { tasks: updated, result: 'rescheduled "' + updated[idx].title + '" to ' + (updated[idx].deadline || '(no deadline)') };
  }
  return { tasks, result: 'error: unknown tool "' + name + '"' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });
  if (!checkAuth(req)) return res.status(401).json({ ok: false, error: 'invalid or missing bearer token' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' });
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ ok: false, error: 'server not configured (missing SUPABASE_URL / SUPABASE_ANON_KEY)' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const message = body && typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return res.status(400).json({ ok: false, error: 'message required' });
  const voice = !!(body && body.voice);

  const [tasksState, lifeContextState] = await Promise.all([
    readAppState(supabaseUrl, supabaseKey, 'tasks'),
    readAppState(supabaseUrl, supabaseKey, 'life_context'),
  ]);
  let tasks = (tasksState && Array.isArray(tasksState.tasks_v1)) ? tasksState.tasks_v1 : [];
  const lifeContext = (lifeContextState && typeof lifeContextState.life_context_v1 === 'string') ? lifeContextState.life_context_v1 : '';

  const client = new Anthropic({ apiKey });
  const messages = [{ role: 'user', content: message }];
  let tasksChanged = false;

  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response = await client.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 1024,
        system: buildSystemPrompt(tasks, lifeContext, voice),
        tools: TOOLS,
        messages,
      });

      messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason !== 'tool_use') {
        const reply = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (tasksChanged) {
          const r = await upsertAppState(supabaseUrl, supabaseKey, 'tasks', { tasks_v1: tasks });
          if (!r.ok) {
            const text = await r.text();
            return res.status(200).json({ ok: true, reply: reply || '(no reply text)', warning: 'reply generated but saving to-do changes failed: ' + text });
          }
        }
        return res.status(200).json({ ok: true, reply: reply || '(no reply text)' });
      }

      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
      const toolResults = [];
      for (const block of toolUseBlocks) {
        const { tasks: updated, result } = runTool(tasks, block.name, block.input);
        if (updated !== tasks) { tasks = updated; tasksChanged = true; }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    // Hit MAX_TOOL_ITERATIONS — save whatever changes were made and say so honestly
    // rather than silently dropping them or looping forever.
    if (tasksChanged) await upsertAppState(supabaseUrl, supabaseKey, 'tasks', { tasks_v1: tasks });
    return res.status(200).json({ ok: true, reply: '(stopped after several tool calls in one request — any to-do changes made so far were saved; ask again if there\'s more to do)' });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
}
