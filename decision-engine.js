// =============================================================
// Decision Engine — turns Today's State (state.js) into one decision:
// "do this task, for this long, because of these reasons, then this
// is probably next." This is the single thing the main screen calls.
//
// Deliberately wraps tasks.js's rankTasks() rather than reimplementing
// it — that scorer already encodes deadline urgency (35%), importance
// (35%), energy fit (20%), and calendar time-fit (10%), and is
// unit-tested. This module adds the two dimensions rankTasks doesn't
// cover (nutrition, expected reward) as adjustments on top, plus
// human-readable reasons for whichever factors actually decided the
// winner — it does not change what rankTasks means on its own, so
// anything still calling Tasks.rankTasks() directly keeps working.
//
// Requires state.js (and therefore tasks.js) loaded first.
// =============================================================
(function () {
  'use strict';

  function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  function relativeDeadline(hoursLeft) {
    if (hoursLeft <= 0) return 'now';
    if (hoursLeft < 24) return 'in ' + Math.round(hoursLeft) + 'h';
    if (hoursLeft < 48) return 'tomorrow';
    return 'in ' + Math.round(hoursLeft / 24) + 'd';
  }

  // Rough, non-personalized protein pacing check — not a substitute for a
  // real nutrition plan, just enough to (a) occasionally deprioritize
  // demanding tasks when intake is clearly behind for the time of day, and
  // (b) surface "protein intake already sufficient" as a positive reason
  // when it's not an issue, matching the kind of thing a person would
  // actually notice about their own day.
  function nutritionAdjustment(task, nutrition, now) {
    if (!nutrition || nutrition.proteinG == null) return { delta: 0, note: null };
    const hour = new Date(now).getHours();
    const dayFraction = Math.min(1, Math.max(0.15, hour / 18));
    const roughDailyTargetG = 90;
    const expectedByNow = roughDailyTargetG * dayFraction;
    const sufficient = nutrition.proteinG >= expectedByNow * 0.7;
    if (!sufficient && task.energyLevel === 'high') {
      return { delta: -8, note: 'protein intake behind for this point in the day' };
    }
    return { delta: 0, note: sufficient ? 'Protein intake already sufficient' : null };
  }

  // importance-per-minute, a simple ROI proxy: a high-importance task that's
  // also quick scores much higher than an equally-important task that eats
  // your whole afternoon.
  function expectedReward(task) {
    return task.importance / Math.max(task.estimatedMinutes / 30, 0.5);
  }

  function rankWithAdjustments(state) {
    const T = window.Tasks;
    const now = state.now;
    const base = T.rankTasks(state.tasks, {
      now,
      availableMinutes: state.calendar.availableMinutes,
      currentEnergy: state.productivity.level,
    });
    if (base.length === 0) return [];

    const withReward = base.map(r => ({ ...r, reward: expectedReward(r.task) }));
    const maxReward = Math.max(...withReward.map(r => r.reward));

    const adjusted = withReward.map(r => {
      const nutr = nutritionAdjustment(r.task, state.nutrition, now);
      const rewardBonus = maxReward > 0 ? (r.reward / maxReward) * 6 : 0;
      return {
        task: r.task,
        score: r.score,
        adjustedScore: r.score + nutr.delta + rewardBonus,
        nutritionNote: nutr.note,
        isTopReward: r.reward === maxReward,
      };
    });

    adjusted.sort((a, b) => b.adjustedScore - a.adjustedScore || a.task.estimatedMinutes - b.task.estimatedMinutes);
    return adjusted;
  }

  function buildReasons(winner, state) {
    const reasons = [];

    (state.productivity.factors || []).forEach(f => reasons.push(capitalize(f)));

    if (winner.task.deadline) {
      const hoursLeft = (new Date(winner.task.deadline).getTime() - state.now) / 3600000;
      if (hoursLeft <= 0) reasons.push('Overdue');
      else if (hoursLeft < 48) reasons.push('Deadline ' + relativeDeadline(hoursLeft));
    }

    if (state.calendar.connected && state.calendar.availableMinutes != null) {
      reasons.push(state.calendar.availableMinutes > 0
        ? 'No meetings for ' + state.calendar.availableMinutes + ' minutes'
        : 'Busy right now — good moment for something quick');
    }

    if (winner.nutritionNote) reasons.push(capitalize(winner.nutritionNote));

    if (winner.isTopReward && winner.task.importance >= 3) reasons.push('Highest ROI task');

    return reasons.length ? reasons : ['Best fit for right now'];
  }

  async function decide() {
    const state = await window.State.getTodaysState();
    const ranked = rankWithAdjustments(state);

    if (ranked.length === 0) {
      return { task: null, durationMin: null, reasons: [], nextPreview: null, state };
    }

    const winner = ranked[0];
    const reasons = buildReasons(winner, state);
    const next = ranked[1]
      ? { title: ranked[1].task.title, durationMin: ranked[1].task.estimatedMinutes }
      : null;

    return {
      task: winner.task,
      durationMin: winner.task.estimatedMinutes,
      reasons,
      nextPreview: next,
      state,
    };
  }

  window.DecisionEngine = { decide };
})();
