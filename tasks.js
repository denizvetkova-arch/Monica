// =============================================================
// Shared task backlog for the decision engine.
// Storage: localStorage key `tasks_v1` -> flat array of tasks
// (not date-sharded, unlike goals:YYYY-MM-DD — tasks have real
// deadlines and must survive day rollovers).
//
// Exposes window.Tasks = { get, add, update, complete, skip,
// remove, rankTasks, CATEGORIES, ENERGY_LEVELS }
//
// Any page that wants live updates when tasks change (in this
// tab or another) should listen for the 'tasks-changed' event.
// =============================================================
(function () {
  'use strict';

  const TASKS_KEY = 'tasks_v1';
  const CATEGORIES = ['lab', 'school', 'debate', 'health', 'money', 'admin', 'personal'];
  const ENERGY_LEVELS = ['low', 'medium', 'high'];

  function loadJSON(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
    window.dispatchEvent(new CustomEvent('tasks-changed'));
  }

  function genId() {
    return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  function getTasks() {
    const t = loadJSON(TASKS_KEY, []);
    return Array.isArray(t) ? t : [];
  }
  function setTasks(list) { saveJSON(TASKS_KEY, list); }

  function addTask(partial) {
    const list = getTasks();
    const task = {
      id: genId(),
      title: (partial.title || '').trim(),
      deadline: partial.deadline || null,
      estimatedMinutes: partial.estimatedMinutes != null ? Number(partial.estimatedMinutes) : 30,
      importance: partial.importance != null ? Number(partial.importance) : 3,
      category: CATEGORIES.indexOf(partial.category) !== -1 ? partial.category : 'personal',
      energyLevel: ENERGY_LEVELS.indexOf(partial.energyLevel) !== -1 ? partial.energyLevel : 'medium',
      done: false,
      createdAt: Date.now(),
      completedAt: null,
      snoozedUntil: null,
    };
    list.push(task);
    setTasks(list);
    return task;
  }

  function updateTask(id, patch) {
    const list = getTasks();
    const idx = list.findIndex(t => t.id === id);
    if (idx === -1) return null;
    list[idx] = Object.assign({}, list[idx], patch);
    setTasks(list);
    return list[idx];
  }

  function completeTask(id) {
    return updateTask(id, { done: true, completedAt: Date.now() });
  }

  // Snooze a task out of ranking contention for a while — this is what
  // the Skip button does, instead of a manual "queue" flag like goals has.
  function skipTask(id, snoozeMinutes) {
    const mins = snoozeMinutes != null ? snoozeMinutes : 60;
    return updateTask(id, { snoozedUntil: Date.now() + mins * 60000 });
  }

  function removeTask(id) {
    const list = getTasks().filter(t => t.id !== id);
    setTasks(list);
  }

  // ---------- Deterministic "next best task" scorer ----------
  // Degrades gracefully: with no deadline/calendar/health data, every
  // task still gets scored via neutral defaults, so this works fully
  // standalone before Calendar/Health integrations exist.
  function urgencyScore(deadline, now) {
    if (!deadline) return 0.10;
    const hoursLeft = (new Date(deadline).getTime() - now) / 3600000;
    if (hoursLeft <= 0) return 1.0;
    if (hoursLeft >= 24 * 14) return 0.05;
    return Math.max(0.05, 1 - hoursLeft / (24 * 14));
  }
  function energyFit(required, current) {
    if (!current) return 0.6;
    const lvl = { low: 1, medium: 2, high: 3 };
    const diff = Math.abs((lvl[required] || 2) - (lvl[current] || 2));
    return diff === 0 ? 1.0 : diff === 1 ? 0.55 : 0.15;
  }
  function timeFit(estMin, availMin) {
    if (availMin == null) return 0.5;
    if (estMin <= availMin) return 1.0;
    if (estMin <= availMin * 1.25) return 0.5;
    return 0.0;
  }
  function scoreTask(task, ctx) {
    if (task.done) return -Infinity;
    if (task.snoozedUntil && ctx.now < task.snoozedUntil) return -Infinity;
    return 35 * urgencyScore(task.deadline, ctx.now)
         + 35 * (task.importance / 5)
         + 20 * energyFit(task.energyLevel, ctx.currentEnergy)
         + 10 * timeFit(task.estimatedMinutes, ctx.availableMinutes);
  }
  function rankTasks(tasks, ctx) {
    const c = Object.assign({ now: Date.now(), currentEnergy: null, availableMinutes: null }, ctx || {});
    return tasks
      .map(t => ({ task: t, score: scoreTask(t, c) }))
      .filter(x => x.score > -Infinity)
      .sort((a, b) => b.score - a.score || a.task.estimatedMinutes - b.task.estimatedMinutes);
  }

  // ---------- Google Calendar ----------
  // Tokens live in localStorage only, per-device, NEVER synced via
  // Supabase — same exclusion as whoop_tokens_v1 in health.html, since
  // the app_state table is anon-writable (public anon key ships in the
  // JS bundle) and OAuth refresh tokens shouldn't sit in a shared row.
  const GCAL_KEY = 'gcal_tokens_v1';
  // "Working day" window for free/busy — matches main.html's day ring
  // (WAKE_HOUR=8, SLEEP_HOUR=24) so "today" means the same thing app-wide.
  const CAL_DAY_START_HOUR = 8;
  const CAL_DAY_END_HOUR = 24;

  function getGcalTokens() { return loadJSON(GCAL_KEY, null); }
  function setGcalTokens(t) { try { localStorage.setItem(GCAL_KEY, JSON.stringify(t)); } catch (e) {} }
  function clearGcalTokens() { try { localStorage.removeItem(GCAL_KEY); } catch (e) {} }
  function isGcalConnected() { const t = getGcalTokens(); return !!(t && t.access); }

  async function gcalRefresh(t) {
    if (!t || !t.refresh) return null;
    try {
      const r = await fetch('/api/google-refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: t.refresh }),
      });
      const j = await r.json();
      if (j.access_token) {
        const next = { access: j.access_token, refresh: t.refresh, expires: Date.now() + (j.expires_in || 3500) * 1000 };
        setGcalTokens(next);
        return next;
      }
    } catch (e) {}
    return null;
  }

  async function gcalFetch(path, params, t) {
    const p = new URLSearchParams(params || {});
    p.set('path', path);
    const r = await fetch('/api/google-calendar?' + p.toString(), {
      headers: { 'Authorization': 'Bearer ' + t.access, 'Accept': 'application/json' },
    });
    if (r.status === 401) {
      const n = await gcalRefresh(t);
      if (n) return gcalFetch(path, params, n);
      throw new Error('unauthorized');
    }
    if (!r.ok) throw new Error('gcal ' + r.status);
    return r.json();
  }

  // Turns a list of Google Calendar events into the gaps between them,
  // clipped to [dayStartMs, dayEndMs). All-day events and events marked
  // transparent ("Free") don't block time.
  function computeFreeBlocks(events, dayStartMs, dayEndMs, minBlockMin) {
    const busy = [];
    (events || []).forEach(ev => {
      if (ev.transparency === 'transparent') return;
      const start = ev.start || {};
      const end = ev.end || {};
      if (!start.dateTime || !end.dateTime) return; // skip all-day events
      const s = new Date(start.dateTime).getTime();
      const e = new Date(end.dateTime).getTime();
      if (e > s) busy.push([Math.max(s, dayStartMs), Math.min(e, dayEndMs)]);
    });
    busy.sort((a, b) => a[0] - b[0]);
    const merged = [];
    busy.forEach(([s, e]) => {
      if (s >= e) return;
      if (merged.length && s <= merged[merged.length - 1][1]) {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
      } else {
        merged.push([s, e]);
      }
    });
    const free = [];
    let cursor = dayStartMs;
    merged.forEach(([s, e]) => {
      if (s > cursor) free.push([cursor, s]);
      cursor = Math.max(cursor, e);
    });
    if (cursor < dayEndMs) free.push([cursor, dayEndMs]);
    const min = minBlockMin || 0;
    return free
      .filter(([s, e]) => e > s)
      .map(([s, e]) => ({ start: new Date(s).toISOString(), end: new Date(e).toISOString(), minutes: Math.round((e - s) / 60000) }))
      .filter(b => b.minutes >= min);
  }

  function minutesFreeNow(blocks, nowMs) {
    for (const b of blocks) {
      const s = new Date(b.start).getTime();
      const e = new Date(b.end).getTime();
      if (nowMs >= s && nowMs < e) return Math.round((e - nowMs) / 60000);
    }
    return 0; // currently in a busy stretch
  }

  // Fetches today's events and returns { connected, availableMinutes, blocks }.
  // Degrades to { connected: false, availableMinutes: null, blocks: [] } when
  // not connected, offline, or the token can't be refreshed — callers should
  // treat that identically to "Calendar not integrated yet" (Stage 0 behavior).
  async function getCalendarContext() {
    let t = getGcalTokens();
    if (!t || !t.access) return { connected: false, availableMinutes: null, blocks: [] };
    if (t.expires && Date.now() > t.expires - 60000) {
      const n = await gcalRefresh(t);
      if (n) t = n; else return { connected: false, availableMinutes: null, blocks: [] };
    }
    const now = new Date();
    const dayStart = new Date(now); dayStart.setHours(CAL_DAY_START_HOUR, 0, 0, 0);
    const dayEnd = new Date(now); dayEnd.setHours(CAL_DAY_END_HOUR, 0, 0, 0);
    try {
      const data = await gcalFetch('/calendars/primary/events', {
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
      }, t);
      const events = (data && data.items) || [];
      const blocks = computeFreeBlocks(events, dayStart.getTime(), dayEnd.getTime(), 10);
      const availableMinutes = minutesFreeNow(blocks, Date.now());
      return { connected: true, availableMinutes, blocks };
    } catch (e) {
      return { connected: true, availableMinutes: null, blocks: [], error: true };
    }
  }

  window.Tasks = {
    CATEGORIES,
    ENERGY_LEVELS,
    getTasks,
    setTasks,
    addTask,
    updateTask,
    completeTask,
    skipTask,
    removeTask,
    rankTasks,
    getGcalTokens,
    setGcalTokens,
    clearGcalTokens,
    isGcalConnected,
    computeFreeBlocks,
    getCalendarContext,
  };
})();
