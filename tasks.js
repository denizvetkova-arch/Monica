// =============================================================
// Shared task backlog for the decision engine.
// Storage: localStorage key `tasks_v1` -> flat array of tasks
// (not date-sharded, unlike goals:YYYY-MM-DD — tasks have real
// deadlines and must survive day rollovers).
//
// Exposes window.Tasks = { get, add, update, complete, skip,
// remove, rankTasks, CATEGORIES, ENERGY_LEVELS, ... }
//
// Any page that wants live updates when tasks change (in this
// tab or another) should listen for the 'tasks-changed' event.
// =============================================================
(function () {
  'use strict';

  const TASKS_KEY = 'tasks_v1';
  // Life domains, not generic "categories" — the Decision Engine reasons
  // about these explicitly (career ROI, academic performance, etc).
  // 'health' is added beyond the user's original 7-item list since
  // gym/water tracking already exists in this app and needs a home.
  const CATEGORIES = ['career', 'school', 'debate', 'glp1_research', 'finance', 'personal', 'extracurricular', 'health'];
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

  // Fills in the new schema fields on any task missing them — covers both
  // tasks created before this schema existed and tasks still awaiting
  // classify-task.js's async result. Never destructive: existing values
  // are always preserved.
  function migrateTask(t) {
    if (!t) return t;
    const m = Object.assign({}, t);
    if (m.lifeDomain == null) {
      m.lifeDomain = CATEGORIES.indexOf(m.category) !== -1 ? m.category : 'personal';
    }
    if (m.longTermROI == null) {
      m.longTermROI = m.importance != null ? Math.min(10, Math.round(m.importance * 2)) : 5;
    }
    if (m.urgency == null) m.urgency = 5;
    if (m.difficulty == null) m.difficulty = 5;
    if (m.schoolClass === undefined) m.schoolClass = null;
    if (m.energyLevel == null) m.energyLevel = 'medium';
    if (m.estimatedMinutes == null) m.estimatedMinutes = 30;
    if (m.classified === undefined) m.classified = false;
    return m;
  }

  function getTasks() {
    const raw = loadJSON(TASKS_KEY, []);
    const list = Array.isArray(raw) ? raw : [];
    const migrated = list.map(migrateTask);
    // Persist the migration once so future reads/writes don't redo it —
    // self-terminating (next call sees already-migrated data, no diff).
    if (JSON.stringify(migrated) !== JSON.stringify(list)) setTasks(migrated);
    return migrated;
  }
  function setTasks(list) { saveJSON(TASKS_KEY, list); }

  function addTask(partial) {
    const list = getTasks();
    const task = {
      id: genId(),
      title: (partial.title || '').trim(),
      deadline: partial.deadline || null,
      estimatedMinutes: partial.estimatedMinutes != null ? Number(partial.estimatedMinutes) : 30,
      longTermROI: partial.longTermROI != null ? Number(partial.longTermROI) : 5,
      urgency: partial.urgency != null ? Number(partial.urgency) : 5,
      difficulty: partial.difficulty != null ? Number(partial.difficulty) : 5,
      lifeDomain: CATEGORIES.indexOf(partial.lifeDomain) !== -1 ? partial.lifeDomain : 'personal',
      schoolClass: partial.schoolClass || null,
      energyLevel: ENERGY_LEVELS.indexOf(partial.energyLevel) !== -1 ? partial.energyLevel : 'medium',
      done: false,
      createdAt: Date.now(),
      completedAt: null,
      snoozedUntil: null,
      // True once classify-task.js has filled in the fields above from the
      // title — false means the row is still showing inferred defaults.
      classified: !!partial.classified,
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

  // ---------- Completion history ----------
  // Append-only, capped log used for the (currently neutral-until-enough-
  // data) historical-productivity signal in the Decision Engine — see
  // getStreakContext() below.
  const COMPLETIONS_KEY = 'task_completions_v1';
  const COMPLETIONS_CAP = 200;

  function logCompletion(task, now) {
    const log = loadJSON(COMPLETIONS_KEY, []);
    const list = Array.isArray(log) ? log : [];
    list.push({
      lifeDomain: task.lifeDomain,
      hour: new Date(now).getHours(),
      dayOfWeek: new Date(now).getDay(),
      completedAt: now,
    });
    while (list.length > COMPLETIONS_CAP) list.shift();
    try { localStorage.setItem(COMPLETIONS_KEY, JSON.stringify(list)); } catch (e) {}
  }

  function completeTask(id) {
    const now = Date.now();
    const task = updateTask(id, { done: true, completedAt: now });
    if (task) logCompletion(task, now);
    return task;
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

  function dayKey(now) {
    const d = new Date(now);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // Consecutive days (including today, if it already has a completion)
  // with at least one completed task. Reported as "not enough history yet"
  // until ~14 distinct days of data exist, rather than drawing conclusions
  // from a handful of days — see getStreakContext().
  function getStreakContext() {
    const log = loadJSON(COMPLETIONS_KEY, []);
    const list = Array.isArray(log) ? log : [];
    const days = new Set(list.map(e => dayKey(e.completedAt)));
    if (days.size < 14) return { days: 0, active: false, enoughData: false };
    let streak = 0;
    let cursor = Date.now();
    while (days.has(dayKey(cursor))) {
      streak += 1;
      cursor -= 86400000;
    }
    return { days: streak, active: streak > 0, enoughData: true };
  }

  // ---------- Deterministic "next best task" scorer ----------
  // Degrades gracefully: with no deadline/calendar/health data, every
  // task still gets scored via neutral defaults, so this works fully
  // standalone before Calendar/Health integrations exist.
  //
  // Urgency blends two signals: the classic deadline-proximity ramp, and
  // task.urgency — an LLM-inferred "this inherently matters regardless of
  // a deadline" signal (e.g. "reply to urgent email" has no deadline but
  // shouldn't rank like a someday-task). Deadline dominates when present;
  // stored urgency provides a floor otherwise.
  function urgencyScore(task, now) {
    let deadlineUrgency = 0.10;
    if (task.deadline) {
      const hoursLeft = (new Date(task.deadline).getTime() - now) / 3600000;
      if (hoursLeft <= 0) deadlineUrgency = 1.0;
      else if (hoursLeft >= 24 * 14) deadlineUrgency = 0.05;
      else deadlineUrgency = Math.max(0.05, 1 - hoursLeft / (24 * 14));
    }
    const storedUrgency = (task.urgency != null ? task.urgency : 5) / 10;
    return Math.max(deadlineUrgency, storedUrgency * 0.7);
  }
  // required: task's energyLevel ('low'|'medium'|'high').
  // current: the Adaptive Energy Model's 5-level label, or (for backward
  // compatibility) an old 3-level one — both map onto the same 1-3 scale.
  function energyFit(required, current) {
    if (!current) return 0.6;
    const reqLvl = { low: 1, medium: 2, high: 3 }[required] || 2;
    const curLvl = { very_low: 1, low: 1.5, moderate: 2, high: 2.5, peak: 3 }[current];
    if (curLvl == null) return 0.6;
    const diff = Math.abs(reqLvl - curLvl);
    if (diff <= 0.25) return 1.0;
    if (diff <= 1) return 0.55;
    return 0.15;
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
    return 35 * urgencyScore(task, ctx.now)
         + 35 * (task.longTermROI / 10)
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
  const CAL_LOOKAHEAD_DAYS = 3;

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

  // Fetches events from now through today's end AND a few days further out
  // in one call — the wider window answers "what's my next commitment"
  // (e.g. "engineering deadline tomorrow") while free/busy math still only
  // looks at today. Returns { connected, availableMinutes, blocks, events,
  // nextEvent }. Degrades to a fully-null/empty shape when not connected,
  // offline, or the token can't be refreshed — callers should treat that
  // identically to "Calendar not integrated yet."
  async function getCalendarContext() {
    const EMPTY = { connected: false, availableMinutes: null, blocks: [], events: [], nextEvent: null };
    let t = getGcalTokens();
    if (!t || !t.access) return EMPTY;
    if (t.expires && Date.now() > t.expires - 60000) {
      const n = await gcalRefresh(t);
      if (n) t = n; else return EMPTY;
    }
    const now = new Date();
    const dayStart = new Date(now); dayStart.setHours(CAL_DAY_START_HOUR, 0, 0, 0);
    const dayEnd = new Date(now); dayEnd.setHours(CAL_DAY_END_HOUR, 0, 0, 0);
    const lookaheadEnd = new Date(now.getTime() + CAL_LOOKAHEAD_DAYS * 86400000);
    try {
      const data = await gcalFetch('/calendars/primary/events', {
        timeMin: dayStart.toISOString(),
        timeMax: lookaheadEnd.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
      }, t);
      const rawEvents = (data && data.items) || [];
      const blocks = computeFreeBlocks(rawEvents, dayStart.getTime(), dayEnd.getTime(), 10);
      const availableMinutes = minutesFreeNow(blocks, Date.now());
      const events = normalizeEvents(rawEvents);
      const nowMs = Date.now();
      const upcoming = events.find(ev => !ev.allDay && new Date(ev.start).getTime() > nowMs);
      const nextEvent = upcoming
        ? { title: upcoming.title, start: upcoming.start, minutesUntil: Math.round((new Date(upcoming.start).getTime() - nowMs) / 60000) }
        : null;
      return { connected: true, availableMinutes, blocks, events, nextEvent };
    } catch (e) {
      return { connected: true, availableMinutes: null, blocks: [], events: [], nextEvent: null, error: true };
    }
  }

  // ---------- Adaptive Energy Model ----------
  // Blends Apple Health (via health_metrics_v1, written server-side by
  // api/health-import.js), hydration (po_water_v1, already tracked
  // locally by the water tracker), and caffeine (caf:logs, already
  // tracked locally by caffeine.html) into a 5-level energy signal for
  // the ranking algorithm and a human-readable summary for display.
  // Every input degrades to a neutral subscore when missing, so this
  // works with zero, partial, or full data.
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

  // Rough, non-personalized proxy (same spirit as the protein-pacing check
  // in decision-engine.js): compares today's logged water-tracker entries
  // against a flat assumed daily target, scaled by how much of the waking
  // day has passed. Not unit-aware (bottle vs glass vs oz) on purpose —
  // precise hydration math already lives in topbar.js/po-water.html; this
  // just needs a rough "behind or not" signal.
  function hydrationSubscore(now) {
    const water = loadJSON('po_water_v1', null);
    if (!water) return { score: 60, note: null };
    const d = new Date(now);
    const todayKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const done = (water.logs || {})[todayKey] || 0;
    const hour = d.getHours();
    const dayFraction = Math.min(1, Math.max(0.1, (hour - 7) / 15));
    const roughTarget = 6;
    const expectedByNow = roughTarget * dayFraction;
    if (done === 0 && hour >= 10) return { score: 40, note: 'low hydration today' };
    if (done < expectedByNow * 0.5) return { score: 50, note: null };
    return { score: 75, note: null };
  }

  function heartRateSubscore(restingHR) {
    if (restingHR == null) return { score: 60, note: null };
    if (restingHR <= 55) return { score: 80, note: null };
    if (restingHR <= 70) return { score: 60, note: null };
    return { score: 40, note: 'elevated resting heart rate' };
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

  function levelFromScore5(score) {
    if (score >= 82) return 'peak';
    if (score >= 68) return 'high';
    if (score >= 50) return 'moderate';
    if (score >= 32) return 'low';
    return 'very_low';
  }

  // Returns { level (5-level), score, connected, factors, updatedAt }.
  // connected reflects whether Apple Health data has ever landed
  // (caffeine/hydration are always "local" and don't gate this).
  function getEnergyContext() {
    const now = Date.now();
    const health = loadJSON(HEALTH_METRICS_KEY, null);
    const activeCaffeineMg = sumActiveCaffeineMg(now);

    const sleep = sleepSubscore(health && health.sleepHours);
    const caffeine = caffeineSubscore(activeCaffeineMg);
    const steps = stepsSubscore(health && health.steps);
    const workout = workoutSubscore(health && health.workoutsToday, now);
    const nutrition = nutritionSubscore(health && health.dietaryEnergyKcal, now);
    const hydration = hydrationSubscore(now);
    const heartRate = heartRateSubscore(health && health.restingHR);

    const weighted = [
      [sleep, 28], [caffeine, 15], [steps, 10], [workout, 12], [nutrition, 10], [hydration, 15], [heartRate, 10],
    ];
    const totalWeight = weighted.reduce((s, [, w]) => s + w, 0);
    const score = Math.round(weighted.reduce((s, [sub, w]) => s + sub.score * w, 0) / totalWeight);

    const factors = weighted.map(([sub]) => sub.note).filter(Boolean);

    return {
      level: levelFromScore5(score),
      score,
      connected: !!health,
      factors,
      updatedAt: health && health.updatedAt || null,
    };
  }
  // Kept as an alias — earlier code (and anything cached) may still call
  // the old name; same function, 5-level output now instead of 3-level.
  const getProductivityContext = getEnergyContext;

  // ---------- Nutrition ----------
  // Cal AI (and most photo-based calorie trackers) write every logged meal's
  // calories/protein/carbs/fat straight to Apple Health — confirmed via web
  // search, no separate Cal AI integration exists or is needed. Nutrition
  // therefore rides the same health_metrics_v1 pipeline as sleep/steps/etc.
  const WATER_PROFILE_KEY = 'po_water_v1';

  function getCaffeineContext() {
    return { activeMg: sumActiveCaffeineMg(Date.now()) };
  }

  // HealthKit has no concept of a calorie "target" — only consumption
  // samples — so if the user hasn't set one explicitly, estimate one from
  // the same profile fields the water tracker already collects (height/
  // weight/age/sex/activity), via Mifflin-St Jeor. This is a rough default,
  // not a substitute for Cal AI's own plan; overridable in Settings.
  function estimateCalorieTarget(profile) {
    if (!profile || !profile.weightKg || !profile.age) return null;
    const heightCm = profile.heightCm || 170;
    const bmr = 10 * profile.weightKg + 6.25 * heightCm - 5 * profile.age + (profile.sex === 'f' ? -161 : 5);
    const activityMultiplier = Math.min(1.9, 1.2 + (profile.activityHrsPerWeek || 0) * 0.03);
    return Math.round(bmr * activityMultiplier);
  }

  function getNutritionContext() {
    const health = loadJSON(HEALTH_METRICS_KEY, null);
    const water = loadJSON(WATER_PROFILE_KEY, null);
    const profile = (water && water.profile) || {};
    const target = profile.calorieTarget || estimateCalorieTarget(profile);
    const consumed = health && health.dietaryEnergyKcal != null ? health.dietaryEnergyKcal : null;
    return {
      connected: !!(health && consumed != null),
      caloriesConsumed: consumed,
      caloriesTarget: target,
      caloriesRemaining: (consumed != null && target != null) ? Math.max(0, target - consumed) : null,
      proteinG: health && health.proteinG != null ? health.proteinG : null,
      carbsG: health && health.carbsG != null ? health.carbsG : null,
      fatG: health && health.fatG != null ? health.fatG : null,
      fiberG: health && health.fiberG != null ? health.fiberG : null,
      updatedAt: health && health.updatedAt || null,
    };
  }

  window.Tasks = {
    CATEGORIES,
    ENERGY_LEVELS,
    getEnergyContext,
    getProductivityContext,
    getCaffeineContext,
    getNutritionContext,
    getStreakContext,
    estimateCalorieTarget,
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
