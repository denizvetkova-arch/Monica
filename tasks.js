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

  // Normalizes raw Google event objects into { title, start, end, allDay }
  // for display — separate from computeFreeBlocks, which only cares about
  // busy intervals, not titles.
  function normalizeEvents(events) {
    return (events || [])
      .filter(ev => ev.status !== 'cancelled')
      .map(ev => {
        const start = ev.start || {};
        const end = ev.end || {};
        const allDay = !start.dateTime;
        return {
          title: ev.summary || '(untitled event)',
          start: start.dateTime || start.date || null,
          end: end.dateTime || end.date || null,
          allDay,
        };
      })
      .filter(ev => ev.start);
  }

  // Fetches today's events and returns { connected, availableMinutes, blocks, events }.
  // Degrades to { connected: false, availableMinutes: null, blocks: [], events: [] }
  // when not connected, offline, or the token can't be refreshed — callers should
  // treat that identically to "Calendar not integrated yet" (Stage 0 behavior).
  async function getCalendarContext() {
    let t = getGcalTokens();
    if (!t || !t.access) return { connected: false, availableMinutes: null, blocks: [], events: [] };
    if (t.expires && Date.now() > t.expires - 60000) {
      const n = await gcalRefresh(t);
      if (n) t = n; else return { connected: false, availableMinutes: null, blocks: [], events: [] };
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
      const rawEvents = (data && data.items) || [];
      const blocks = computeFreeBlocks(rawEvents, dayStart.getTime(), dayEnd.getTime(), 10);
      const availableMinutes = minutesFreeNow(blocks, Date.now());
      const events = normalizeEvents(rawEvents);
      return { connected: true, availableMinutes, blocks, events };
    } catch (e) {
      return { connected: true, availableMinutes: null, blocks: [], events: [], error: true };
    }
  }

  // ---------- Productivity level ----------
  // Blends Apple Health (via health_metrics_v1, written server-side by
  // api/health-import.js) with caffeine (already tracked locally by
  // caffeine.html — no new integration needed, just read its log) into a
  // single low/medium/high energy signal for the ranking algorithm and a
  // human-readable summary for display. Every input degrades to a neutral
  // subscore when missing, so this works with zero, partial, or full data.
  const HEALTH_METRICS_KEY = 'health_metrics_v1';
  const CAFFEINE_LOGS_KEY = 'caf:logs';
  const CAFFEINE_ACTIVE_WINDOW_MS = 5 * 3600000; // caffeine's rough effective window

  function sleepSubscore(h) {
    if (h == null) return { score: 60, note: null };
    if (h < 5) return { score: 15, note: h.toFixed(1) + 'h sleep (low)' };
    if (h < 6) return { score: 35, note: h.toFixed(1) + 'h sleep' };
    if (h < 7) return { score: 55, note: h.toFixed(1) + 'h sleep' };
    if (h < 7.5) return { score: 70, note: h.toFixed(1) + 'h sleep' };
    if (h < 9) return { score: 90, note: h.toFixed(1) + 'h sleep (good)' };
    return { score: 75, note: h.toFixed(1) + 'h sleep (long)' };
  }

  function caffeineSubscore(mg) {
    if (mg == null) return { score: 60, note: null };
    if (mg <= 0) return { score: 40, note: null };
    if (mg < 100) return { score: 65, note: Math.round(mg) + 'mg caffeine active' };
    if (mg < 250) return { score: 85, note: Math.round(mg) + 'mg caffeine active' };
    if (mg < 400) return { score: 75, note: Math.round(mg) + 'mg caffeine active' };
    return { score: 50, note: Math.round(mg) + 'mg caffeine (high)' };
  }

  function stepsSubscore(steps) {
    if (steps == null) return { score: 60, note: null };
    if (steps < 1000) return { score: 45, note: null };
    if (steps < 4000) return { score: 60, note: null };
    if (steps < 8000) return { score: 75, note: steps + ' steps today' };
    return { score: 70, note: steps + ' steps today' };
  }

  function workoutSubscore(workouts, now) {
    if (!workouts || !workouts.count) return { score: 55, note: null };
    if (workouts.lastEndedAt && now - workouts.lastEndedAt < 30 * 60000) {
      return { score: 45, note: 'just finished a workout' };
    }
    return { score: 85, note: 'worked out today (' + workouts.minutes + 'm)' };
  }

  function nutritionSubscore(kcal, now) {
    if (kcal == null) return { score: 60, note: null };
    const hour = new Date(now).getHours();
    if (hour >= 12 && kcal < 400) return { score: 40, note: 'low food intake today' };
    return { score: 70, note: null };
  }

  function sumActiveCaffeineMg(now) {
    const logs = loadJSON(CAFFEINE_LOGS_KEY, null);
    if (!Array.isArray(logs)) return null;
    let total = 0;
    logs.forEach(l => {
      if (l && typeof l.mg === 'number' && typeof l.ts === 'number' && now - l.ts < CAFFEINE_ACTIVE_WINDOW_MS && now - l.ts >= 0) {
        total += l.mg;
      }
    });
    return total;
  }

  function levelFromScore(score) {
    if (score >= 70) return 'high';
    if (score >= 45) return 'medium';
    return 'low';
  }

  // Returns { level, score, connected, factors } — connected reflects
  // whether Apple Health data has ever landed (caffeine is always "local"
  // and doesn't gate this the same way).
  function getProductivityContext() {
    const now = Date.now();
    const health = loadJSON(HEALTH_METRICS_KEY, null);
    const activeCaffeineMg = sumActiveCaffeineMg(now);

    const sleep = sleepSubscore(health && health.sleepHours);
    const caffeine = caffeineSubscore(activeCaffeineMg);
    const steps = stepsSubscore(health && health.steps);
    const workout = workoutSubscore(health && health.workoutsToday, now);
    const nutrition = nutritionSubscore(health && health.dietaryEnergyKcal, now);

    const weighted = [
      [sleep, 40], [caffeine, 20], [steps, 15], [workout, 15], [nutrition, 10],
    ];
    const totalWeight = weighted.reduce((s, [, w]) => s + w, 0);
    const score = Math.round(weighted.reduce((s, [sub, w]) => s + sub.score * w, 0) / totalWeight);

    const factors = weighted.map(([sub]) => sub.note).filter(Boolean);

    return {
      level: levelFromScore(score),
      score,
      connected: !!health,
      factors,
      updatedAt: health && health.updatedAt || null,
    };
  }

  window.Tasks = {
    CATEGORIES,
    ENERGY_LEVELS,
    getProductivityContext,
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
