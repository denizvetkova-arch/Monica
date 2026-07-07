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
  };
})();
