// =============================================================
// Today's State — the single aggregated snapshot every AI feature
// (Decision Engine now, anything else later) reads from instead of
// each pulling its own integrations directly.
//
// EXTENSION CONTRACT: to plug in a new source later (Apple Watch,
// email, finance, location, weather, reminders, Notion, ...):
//   1. Write one getXContext() function wherever makes sense
//      (tasks.js for data-layer sources, or its own <name>.js file).
//   2. Add exactly one line inside buildTodaysState() below to call
//      it and attach the result under a new key.
// Nothing else needs to change shape-wise — decision-engine.js and
// the UI both read whatever keys exist on the returned object, and
// every existing getXContext() already degrades to nulls/neutral
// defaults when its source isn't connected, so a half-wired
// integration can't break the rest of the snapshot.
//
// Requires tasks.js to be loaded first (uses window.Tasks.*).
// =============================================================
(function () {
  'use strict';

  function loadJSON(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }

  function computeTimeOfDay(now) {
    const h = new Date(now).getHours();
    if (h < 6) return 'night';
    if (h < 12) return 'morning';
    if (h < 17) return 'midday';
    if (h < 21) return 'afternoon';
    return 'evening';
  }

  async function getTodaysState() {
    const now = Date.now();
    const T = window.Tasks || {};

    const tasks = T.getTasks ? T.getTasks() : [];
    let calendar = { connected: false, availableMinutes: null, blocks: [], events: [] };
    try { if (T.getCalendarContext) calendar = await T.getCalendarContext(); } catch (e) {}

    const productivity = T.getProductivityContext
      ? T.getProductivityContext()
      : { level: 'medium', score: 60, connected: false, factors: [] };
    const nutrition = T.getNutritionContext
      ? T.getNutritionContext()
      : { connected: false, caloriesConsumed: null, caloriesTarget: null, caloriesRemaining: null, proteinG: null, carbsG: null, fatG: null, fiberG: null };
    const caffeine = T.getCaffeineContext ? T.getCaffeineContext() : { activeMg: null };
    const health = loadJSON('health_metrics_v1', null);

    return {
      now,
      timeOfDay: computeTimeOfDay(now),
      tasks,
      calendar,
      health,
      nutrition,
      productivity,
      caffeine,
      // Reserved for future integrations — see extension contract above.
      location: null,
      weather: null,
    };
  }

  window.State = { getTodaysState };
})();
