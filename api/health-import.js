// ============================================================
// POST /api/health-import?token=SECRET
// Webhook target for the "Health Auto Export" iOS app's REST API
// automation.
//
// v3 — MERGE, not overwrite. A single request used to be trusted as a
// complete, current snapshot and would overwrite health_metrics_v1
// wholesale. That broke the moment any request had less data than a
// prior one — including the confirmed production failure this version
// fixes: 413 FUNCTION_PAYLOAD_TOO_LARGE on a wide manual date range.
// Vercel's 4.5MB request body limit is a hard platform constraint with
// no server-side workaround (confirmed against Vercel's own docs) — the
// only real fix is Health Auto Export's "Batch Requests" setting,
// which splits one export into several smaller HTTP requests with NO
// sequencing metadata (no batch-number header/field is documented or
// sent). That means this server can never assume a request is complete
// or arrives in order, so every metric is now merged independently:
//   - a request that doesn't mention a metric leaves the stored value
//     alone (partial imports — sleep in one request, steps in another
//     — combine correctly instead of one erasing the other)
//   - a request with OLDER data than what's already stored for a
//     metric is rejected for that metric only, not just accepted
//     because it arrived later (out-of-order-safe)
//   - workouts merge into a deduplicated pool instead of trusting one
//     request's list, so the same HealthKit workout appearing in two
//     overlapping exports is never double-counted
// See mergeHealthState()/mergeWorkouts() below and health-diagnostics.html
// for the resulting per-metric merged/preserved/rejected-stale trail.
//
// This handler still NORMALIZES AND DISCARDS the raw payload — it
// extracts only the aggregate numbers below and never persists the raw
// body (which can carry high-resolution samples and, for workouts, GPS
// routes). Written to the existing app_state table under key
// "health_metrics" (as health_metrics_v1 — dashboard-facing) and a
// second diagnostics record under key "health_diagnostics" (as
// health_diagnostics_v1 — a capped trace of the last 20 requests) —
// see health-diagnostics.html.
//
// Env vars required on Vercel:
//   HEALTH_IMPORT_TOKEN   (any secret string you choose)
//   SUPABASE_URL
//   SUPABASE_ANON_KEY
//
// NOTE ON FIELD NAMES: Health Auto Export's exact metric names/shapes
// have shifted across versions. Every extractor below tries multiple
// documented candidate names and degrades to null (never a guessed or
// substituted value) when nothing matches — see health-diagnostics.html
// for which metrics actually landed in your last real export, and
// SETUP.md for the full list of metrics to enable in the app, plus
// the required Batch Requests setting.
//
// NOTE ON SLEEP: Health Auto Export exports sleep_analysis in one of
// two shapes depending on the automation's aggregation setting:
//   - aggregated: one entry per night — {date, asleep, sleepStart,
//     sleepEnd, sleepSource, inBed, inBedStart, inBedEnd}
//   - unaggregated: one entry per sleep STAGE segment — {startDate,
//     endDate, qty, value} where value is "Asleep"/"Core"/"REM"/"Deep"/
//     "Awake"/"In Bed"
// computeSleep() below handles both, and always looks for the most
// recently COMPLETED session rather than assuming "today" has one.
//
// NOTE ON MULTI-DAY PAYLOADS: earlier versions summed every entry in a
// metric's data array — correct for a single day, silently wrong for
// any wider range (a 6-day export would add 6 days of steps together
// and call it "today"). Cumulative metrics now group entries by day
// and use only the latest day present; latest-value metrics (heart
// rate, weight, etc.) sort by date instead of trusting array order.
// This is also what makes merge comparisons meaningful — "is this
// candidate newer than what's stored" is unanswerable without knowing
// which day each candidate actually represents.
// ============================================================

function sumQty(entries) {
  if (!Array.isArray(entries)) return null;
  let total = 0, found = false;
  for (const e of entries) {
    const v = e && (e.qty ?? e.value);
    if (typeof v === 'number') { total += v; found = true; }
  }
  return found ? total : null;
}

function latestValue(entries, fields) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const last = entries[entries.length - 1];
  for (const f of fields) {
    if (typeof last[f] === 'number') return last[f];
  }
  return null;
}

function findMetric(metrics, name) {
  if (!Array.isArray(metrics)) return null;
  const m = metrics.find(x => x && x.name === name);
  return m ? m.data : null;
}

// Metric names in particular vary across Health Auto Export versions
// (e.g. `carbohydrates` vs `dietary_carbohydrates`) — try each candidate
// in order and use the first one that's actually present in this payload.
function findMetricAny(metrics, names) {
  for (const name of names) {
    const data = findMetric(metrics, name);
    if (data) return data;
  }
  return null;
}

function round(v, decimals) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}

function parseDateMs(s) {
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
}

// ---------- Day-aware extraction ----------
// Groups entries by their own `date` field (plain yyyy-MM-dd string —
// compared lexicographically, deliberately never parsed to epoch-ms/
// UTC, which would risk off-by-one-day errors for no benefit: ISO date
// strings already sort correctly as strings).
function groupByDayKey(entries) {
  const groups = {};
  let anyDated = false;
  for (const e of entries) {
    if (!e) continue;
    const dayKey = typeof e.date === 'string' ? e.date.slice(0, 10) : null;
    if (dayKey) anyDated = true;
    const key = dayKey || '__nodate__';
    (groups[key] = groups[key] || []).push(e);
  }
  return { groups, anyDated };
}

// Sums qty within the LATEST dated day present — not across the whole
// payload — so a multi-day export's "steps" means the most recent
// day's steps, not several days added together. Falls back to a flat
// sum (old behavior) only when NO entry anywhere has a usable date; the
// caller logs that as a degraded-parse warning.
function latestDaySum(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return { value: null, dayKey: null, degraded: false };
  const { groups, anyDated } = groupByDayKey(entries);
  if (!anyDated) return { value: sumQty(entries), dayKey: null, degraded: true };
  const dayKeys = Object.keys(groups).filter(k => k !== '__nodate__').sort();
  if (dayKeys.length === 0) return { value: null, dayKey: null, degraded: false };
  const latestKey = dayKeys[dayKeys.length - 1];
  return { value: sumQty(groups[latestKey]), dayKey: latestKey, degraded: false };
}

// Sorts by date before taking the latest entry's value — was: trust
// array order, which a multi-request/multi-day payload can't guarantee.
function latestValueWithDate(entries, fields) {
  if (!Array.isArray(entries) || entries.length === 0) return { value: null, dayKey: null, degraded: false };
  const dated = entries.filter(e => e && typeof e.date === 'string');
  if (dated.length === 0) return { value: latestValue(entries, fields), dayKey: null, degraded: true };
  const sorted = dated.slice().sort((a, b) => a.date.localeCompare(b.date));
  const last = sorted[sorted.length - 1];
  const dayKey = last.date.slice(0, 10);
  for (const f of fields) {
    if (typeof last[f] === 'number') return { value: last[f], dayKey, degraded: false };
  }
  return { value: null, dayKey, degraded: false };
}

// ---------- Sleep ----------
const SLEEP_STAGE_ASLEEP = new Set(['asleep', 'asleepcore', 'core', 'asleeprem', 'rem', 'asleepdeep', 'deep', 'asleepunspecified']);
const SLEEP_STAGE_NOT_ASLEEP = new Set(['awake', 'inbed']);

function dedupeSleepSamples(samples) {
  const seen = new Set();
  let removedCount = 0;
  const kept = samples.filter(s => {
    const key = s.start + '|' + s.end + '|' + s.stage + '|' + s.source;
    if (seen.has(key)) { removedCount++; return false; }
    seen.add(key);
    return true;
  });
  return { kept, removedCount };
}

// Returns { hours, sessionStart, sessionEnd, source, dedupedCount } for
// the most recently COMPLETED sleep session — never "today's sleep" by
// assumption, never 0 for missing data. sessionEnd (absolute epoch ms)
// doubles as this metric's merge-comparison reference — a candidate
// only replaces stored sleep data if its session ended at the same
// time or later.
function computeSleep(entries, now, warnings) {
  const EMPTY = { hours: null, sessionStart: null, sessionEnd: null, source: null, dedupedCount: 0 };
  if (!Array.isArray(entries) || entries.length === 0) {
    warnings.push({
      metric: 'sleep',
      message: 'no sleep_analysis entries in payload — likely the automation\'s date range excluded last night\'s session (still mid-sync from Watch, or bucketed under a different day). Try "Default" range instead of "Today" in Health Auto Export.',
    });
    return EMPTY;
  }

  const aggregated = entries.filter(e => e && typeof e.asleep === 'number');
  if (aggregated.length > 0) {
    const completed = aggregated
      .map(e => ({ asleep: e.asleep, start: parseDateMs(e.sleepStart), end: parseDateMs(e.sleepEnd), source: e.sleepSource || null }))
      .filter(e => e.end != null && e.end <= now);
    if (completed.length === 0) {
      warnings.push({ metric: 'sleep', message: 'aggregated sleep entries found but none have a completed sleepEnd in the past (still in progress)' });
      return EMPTY;
    }
    completed.sort((a, b) => b.end - a.end);
    const best = completed[0];
    return { hours: best.asleep, sessionStart: best.start, sessionEnd: best.end, source: best.source, dedupedCount: 0 };
  }

  let unparseable = 0;
  const rawSamples = entries.map(e => {
    if (!e) return null;
    const start = parseDateMs(e.startDate);
    const end = parseDateMs(e.endDate);
    const stage = typeof e.value === 'string' ? e.value.toLowerCase().replace(/\s+/g, '') : null;
    if (start == null || end == null || stage == null) { unparseable++; return null; }
    return { start, end, stage, qty: typeof e.qty === 'number' ? e.qty : null, source: e.source || null };
  }).filter(Boolean);
  const { kept: samples0, removedCount } = dedupeSleepSamples(rawSamples);
  const samples = samples0.sort((a, b) => a.start - b.start);

  if (unparseable > 0) {
    warnings.push({ metric: 'sleep', message: unparseable + ' sleep_analysis entries had neither an "asleep" field nor a recognizable startDate/endDate/value shape and were skipped' });
  }
  if (samples.length === 0) {
    warnings.push({ metric: 'sleep', message: 'sleep_analysis entries present but none were parseable' });
    return Object.assign({}, EMPTY, { dedupedCount: removedCount });
  }

  const NIGHT_GAP_MS = 3 * 3600000;
  const nights = [];
  let current = [samples[0]];
  for (let i = 1; i < samples.length; i++) {
    const gap = samples[i].start - current[current.length - 1].end;
    if (gap > NIGHT_GAP_MS) { nights.push(current); current = [samples[i]]; }
    else current.push(samples[i]);
  }
  nights.push(current);

  const nightSummaries = nights.map(night => {
    const bySource = {};
    let sessionStart = Infinity, sessionEnd = -Infinity;
    let anyAsleep = false, anyNotAsleep = false;
    night.forEach(s => {
      sessionStart = Math.min(sessionStart, s.start);
      sessionEnd = Math.max(sessionEnd, s.end);
      if (SLEEP_STAGE_ASLEEP.has(s.stage)) {
        anyAsleep = true;
        const hours = s.qty != null ? s.qty : (s.end - s.start) / 3600000;
        const key = s.source || 'unknown';
        bySource[key] = (bySource[key] || 0) + hours;
      } else if (SLEEP_STAGE_NOT_ASLEEP.has(s.stage)) {
        anyNotAsleep = true;
      }
    });
    const sourceTotals = Object.entries(bySource).sort((a, b) => b[1] - a[1]);
    return {
      sessionStart, sessionEnd,
      hours: sourceTotals.length ? sourceTotals[0][1] : null,
      source: sourceTotals.length ? sourceTotals[0][0] : null,
      onlyNonAsleep: anyNotAsleep && !anyAsleep,
    };
  });

  const completedNights = nightSummaries.filter(n => n.sessionEnd <= now && n.hours != null);
  if (completedNights.length === 0) {
    const allOnlyNonAsleep = nightSummaries.length > 0 && nightSummaries.every(n => n.onlyNonAsleep);
    warnings.push({
      metric: 'sleep',
      message: allOnlyNonAsleep
        ? nightSummaries.length + ' sleep_analysis group(s) found but all were Awake/InBed — no Asleep-stage segments to count'
        : 'sleep_analysis entries found but none formed a completed (already-ended) night',
    });
    return Object.assign({}, EMPTY, { dedupedCount: removedCount });
  }
  completedNights.sort((a, b) => b.sessionEnd - a.sessionEnd);
  const best = completedNights[0];
  return { hours: best.hours, sessionStart: best.sessionStart, sessionEnd: best.sessionEnd, source: best.source, dedupedCount: removedCount };
}

// ---------- Workouts ----------
// No GPS/route data, ever. Parses THIS request's workout entries only —
// pooling/dedup/derivation across requests happens in mergeWorkouts().
function parseWorkouts(workouts, warnings) {
  if (!Array.isArray(workouts) || workouts.length === 0) return [];
  let unparseable = 0;
  const items = workouts.map(w => {
    if (!w) { unparseable++; return null; }
    const start = parseDateMs(w.start);
    const end = parseDateMs(w.end);
    const activeKcal = (w.activeEnergyBurned && typeof w.activeEnergyBurned.qty === 'number')
      ? w.activeEnergyBurned.qty
      : (typeof w.activeEnergy === 'number' ? w.activeEnergy : null);
    if (start == null || end == null) { unparseable++; return null; }
    return {
      type: w.name || w.type || 'Workout',
      start, end,
      durationMin: typeof w.duration === 'number' ? Math.round(w.duration / 60) : Math.round((end - start) / 60000),
      activeKcal: activeKcal != null ? Math.round(activeKcal) : null,
    };
  }).filter(Boolean);
  if (unparseable > 0) warnings.push({ metric: 'workouts', message: unparseable + ' workout entries were missing/unparseable and were skipped' });
  return items;
}

// Merges this request's parsed workouts into the stored pool, deduping
// by (type, start, end) so the same HealthKit workout appearing in two
// overlapping exports/batches is counted once. workoutsToday/
// recentWorkouts are re-derived from the deduped pool every time —
// never trusted from a single request. workoutsToday deliberately uses
// a rolling 24h window from `now` rather than calendar-day matching —
// day-labeling needs the user's local timezone, which this server
// doesn't know (same reasoning as sleep leaving day-labeling to the
// client) — a documented simplification, not an oversight.
function mergeWorkouts(storedPool, candidateWorkouts, now) {
  const pool = Array.isArray(storedPool) ? storedPool.slice() : [];
  const seen = new Set(pool.map(w => w.type + '|' + w.start + '|' + w.end));
  let duplicatesRemoved = 0;
  candidateWorkouts.forEach(w => {
    const key = w.type + '|' + w.start + '|' + w.end;
    if (seen.has(key)) { duplicatesRemoved++; return; }
    seen.add(key);
    pool.push(w);
  });
  pool.sort((a, b) => (b.end || 0) - (a.end || 0));
  const capped = pool.slice(0, 30);
  const cutoff = now - 24 * 3600000;
  const today = capped.filter(w => w.end != null && w.end >= cutoff && w.end <= now);
  return {
    allWorkoutsPool: capped,
    workoutsToday: {
      count: today.length,
      minutes: Math.round(today.reduce((s, w) => s + (w.durationMin || 0), 0)),
      lastEndedAt: today.length ? today[0].end : null,
    },
    recentWorkouts: capped.slice(0, 5),
    duplicatesRemoved,
  };
}

// ---------- Main normalizer ----------
// Returns { summary, dayKeys, parsedWorkouts, diagnostics }. `summary`
// is THIS REQUEST's candidate values (not yet merged with anything
// stored) — mergeHealthState() below does the merge. `dayKeys` is the
// per-metric freshness reference each candidate represents, used for
// that merge decision.
export function normalizeHealthPayload(body, now) {
  now = now != null ? now : Date.now();
  const root = (body && body.data) || body || {};
  const metrics = root.metrics || [];
  const workoutsRaw = root.workouts || [];

  const present = [];
  const missing = [];
  const warnings = [];
  const summary = {};
  const dayKeys = {};

  function extract(key, names, extractor) {
    const data = findMetricAny(metrics, names);
    if (data == null) { missing.push(key); summary[key] = null; dayKeys[key] = null; return; }
    present.push(key);
    let result = { value: null, dayKey: null, degraded: false };
    try { result = extractor(data); } catch (e) {
      warnings.push({ metric: key, message: 'parse error: ' + (e && e.message ? e.message : String(e)) });
    }
    if (result.value == null) warnings.push({ metric: key, message: 'metric present in payload but no usable numeric value found in its entries' });
    if (result.degraded) warnings.push({ metric: key, message: 'entries had no "date" field — parsed without day-awareness (degraded mode); if this metric spans multiple days the value may be less precise than usual' });
    summary[key] = result.value;
    dayKeys[key] = result.dayKey;
  }

  const sleepEntries = findMetric(metrics, 'sleep_analysis');
  if (sleepEntries == null) missing.push('sleep'); else present.push('sleep');
  const sleep = computeSleep(sleepEntries, now, warnings);

  extract('steps', ['step_count'], latestDaySum);
  extract('restingHR', ['resting_heart_rate'], d => latestValueWithDate(d, ['Avg', 'qty', 'value']));
  extract('heartRate', ['heart_rate', 'walking_heart_rate_average'], d => latestValueWithDate(d, ['Avg', 'qty', 'value']));
  extract('activeEnergyKcal', ['active_energy'], latestDaySum);
  extract('basalEnergyKcal', ['basal_energy_burned'], latestDaySum);
  extract('dietaryEnergyKcal', ['dietary_energy', 'dietary_energy_consumed'], latestDaySum);
  extract('proteinG', ['protein', 'dietary_protein'], latestDaySum);
  extract('carbsG', ['carbohydrates', 'dietary_carbohydrates'], latestDaySum);
  extract('fatG', ['total_fat', 'fat_total', 'dietary_fat', 'dietary_fat_total'], latestDaySum);
  extract('fiberG', ['fiber', 'dietary_fiber'], latestDaySum);
  extract('hrv', ['heart_rate_variability'], d => latestValueWithDate(d, ['qty', 'value']));
  extract('bloodOxygenPct', ['blood_oxygen_saturation', 'oxygen_saturation'], d => {
    const r = latestValueWithDate(d, ['qty', 'value']);
    return { value: r.value != null ? (r.value <= 1 ? r.value * 100 : r.value) : null, dayKey: r.dayKey, degraded: r.degraded };
  });
  extract('respiratoryRate', ['respiratory_rate'], d => latestValueWithDate(d, ['qty', 'value']));
  extract('vo2Max', ['vo2_max'], d => latestValueWithDate(d, ['qty', 'value']));
  extract('flightsClimbed', ['flights_climbed'], latestDaySum);
  extract('exerciseMinutes', ['apple_exercise_time'], latestDaySum);
  extract('standHours', ['apple_stand_hour', 'apple_stand_time'], latestDaySum);
  extract('walkingDistanceKm', ['walking_running_distance', 'distance_walking_running'], latestDaySum);
  extract('weightKg', ['weight_body_mass'], d => latestValueWithDate(d, ['qty', 'value']));
  extract('bodyFatPct', ['body_fat_percentage'], d => {
    const r = latestValueWithDate(d, ['qty', 'value']);
    return { value: r.value != null ? (r.value <= 1 ? r.value * 100 : r.value) : null, dayKey: r.dayKey, degraded: r.degraded };
  });
  extract('bmi', ['body_mass_index'], d => latestValueWithDate(d, ['qty', 'value']));
  extract('mindfulMinutes', ['mindful_session'], latestDaySum);

  if (Array.isArray(workoutsRaw) && workoutsRaw.length) present.push('workouts'); else missing.push('workouts');
  const parsedWorkouts = parseWorkouts(workoutsRaw, warnings);

  const result = {
    sleepHours: round(sleep.hours, 1),
    sleepSessionStart: sleep.sessionStart,
    sleepSessionEnd: sleep.sessionEnd,
    sleepSource: sleep.source,
    steps: round(summary.steps, 0),
    restingHR: round(summary.restingHR, 0),
    heartRate: round(summary.heartRate, 0),
    activeEnergyKcal: round(summary.activeEnergyKcal, 0),
    basalEnergyKcal: round(summary.basalEnergyKcal, 0),
    dietaryEnergyKcal: round(summary.dietaryEnergyKcal, 0),
    proteinG: round(summary.proteinG, 0),
    carbsG: round(summary.carbsG, 0),
    fatG: round(summary.fatG, 0),
    fiberG: round(summary.fiberG, 0),
    hrv: round(summary.hrv, 0),
    bloodOxygenPct: round(summary.bloodOxygenPct, 1),
    respiratoryRate: round(summary.respiratoryRate, 1),
    vo2Max: round(summary.vo2Max, 1),
    flightsClimbed: round(summary.flightsClimbed, 0),
    exerciseMinutes: round(summary.exerciseMinutes, 0),
    standHours: round(summary.standHours, 0),
    walkingDistanceKm: round(summary.walkingDistanceKm, 2),
    weightKg: round(summary.weightKg, 1),
    bodyFatPct: round(summary.bodyFatPct, 1),
    bmi: round(summary.bmi, 1),
    mindfulMinutes: round(summary.mindfulMinutes, 0),
  };

  return { summary: result, dayKeys, parsedWorkouts, sleepDedupedCount: sleep.dedupedCount, diagnostics: { present, missing, warnings } };
}

// ---------- Merge ----------
// Every scalar health metric merges independently: a candidate only
// overwrites the stored value if this metric is actually present in
// the new payload AND its freshness reference (day-string for daily
// metrics, sessionEnd epoch-ms for sleep) is >= what's already stored.
// Anything else — absent from this payload, or present but older than
// what's stored — leaves the existing value untouched. This is what
// makes partial imports, out-of-order requests, and Batch Requests
// splitting one export across several HTTP calls all safe by
// construction, without needing any sequencing info from the sender
// (Health Auto Export sends none).
const MERGEABLE_KEYS = [
  'sleepHours', 'steps', 'restingHR', 'heartRate', 'activeEnergyKcal', 'basalEnergyKcal',
  'dietaryEnergyKcal', 'proteinG', 'carbsG', 'fatG', 'fiberG', 'hrv', 'bloodOxygenPct',
  'respiratoryRate', 'vo2Max', 'flightsClimbed', 'exerciseMinutes', 'standHours',
  'walkingDistanceKm', 'weightKg', 'bodyFatPct', 'bmi', 'mindfulMinutes',
];
const SLEEP_COMPANION_KEYS = ['sleepSessionStart', 'sleepSessionEnd', 'sleepSource'];

export function mergeHealthState(stored, candidate, dayKeys, now) {
  stored = stored || {};
  const storedMetricAsOf = stored.metricAsOf || {};
  const merged = Object.assign({}, stored);
  const metricAsOf = Object.assign({}, storedMetricAsOf);
  const metricUpdatedAt = Object.assign({}, stored.metricUpdatedAt || {});

  const mergedKeys = [], preservedKeys = [], rejectedStaleKeys = [];

  MERGEABLE_KEYS.forEach(key => {
    const candidateValue = candidate[key];
    const candidateRef = key === 'sleepHours' ? candidate.sleepSessionEnd : dayKeys[key];
    if (candidateValue == null || candidateRef == null) {
      preservedKeys.push(key);
      return; // nothing usable from this request for this metric
    }
    const storedRef = storedMetricAsOf[key];
    const accept = storedRef == null || candidateRef >= storedRef;
    if (accept) {
      merged[key] = candidateValue;
      if (key === 'sleepHours') SLEEP_COMPANION_KEYS.forEach(k => { merged[k] = candidate[k]; });
      metricAsOf[key] = candidateRef;
      metricUpdatedAt[key] = now;
      mergedKeys.push(key);
    } else {
      preservedKeys.push(key);
      rejectedStaleKeys.push(key);
    }
  });

  merged.metricAsOf = metricAsOf;
  merged.metricUpdatedAt = metricUpdatedAt;
  const allTimes = Object.keys(metricUpdatedAt).map(k => metricUpdatedAt[k]).filter(t => t != null);
  merged.updatedAt = allTimes.length ? Math.max.apply(null, allTimes) : (stored.updatedAt || now);

  return { merged, mergedKeys, preservedKeys, rejectedStaleKeys };
}

// ---------- Self-check (range sanity) ----------
// Physiologically-plausible range checks — flags anything a parsing
// bug (e.g. a unit mix-up) would likely produce, without ever
// discarding the value itself. Runs against the MERGED state (what's
// actually stored), not just this request's candidate.
const RANGE_CHECKS = {
  sleepHours: [0, 16], steps: [0, 100000], restingHR: [25, 220], heartRate: [25, 220],
  activeEnergyKcal: [0, 10000], basalEnergyKcal: [0, 5000], dietaryEnergyKcal: [0, 10000],
  hrv: [0, 300], bloodOxygenPct: [50, 100], respiratoryRate: [4, 60], vo2Max: [10, 90],
  weightKg: [20, 300], bodyFatPct: [2, 70], bmi: [10, 80], flightsClimbed: [0, 500],
  exerciseMinutes: [0, 1440], standHours: [0, 24], walkingDistanceKm: [0, 200],
};

export function validateSummary(summary) {
  const issues = [];
  Object.keys(RANGE_CHECKS).forEach(key => {
    const v = summary[key];
    if (v == null) return;
    const [min, max] = RANGE_CHECKS[key];
    if (v < min || v > max) issues.push(key + ' = ' + v + ' is outside the expected range [' + min + ', ' + max + ']');
  });
  return { pass: issues.length === 0, issues };
}

// ---------- Supabase helpers ----------
async function upsertAppState(supabaseUrl, supabaseKey, key, data) {
  return fetch(supabaseUrl + '/rest/v1/app_state?on_conflict=key', {
    method: 'POST',
    headers: {
      'apikey': supabaseKey,
      'Authorization': 'Bearer ' + supabaseKey,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ key, data, updated_at: new Date().toISOString() }),
  });
}

async function readAppState(supabaseUrl, supabaseKey, key) {
  try {
    const r = await fetch(supabaseUrl + '/rest/v1/app_state?key=eq.' + key + '&select=data', {
      headers: { 'apikey': supabaseKey, 'Authorization': 'Bearer ' + supabaseKey },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return (rows && rows[0] && rows[0].data) || null;
  } catch (e) { return null; }
}

// Confirms the health_metrics write actually landed.
async function verifyReadBack(supabaseUrl, supabaseKey, merged) {
  const data = await readAppState(supabaseUrl, supabaseKey, 'health_metrics');
  const stored = data && data.health_metrics_v1;
  if (!stored) return false;
  return stored.updatedAt === merged.updatedAt && stored.steps === merged.steps && stored.sleepHours === merged.sleepHours;
}

const DIAGNOSTICS_CAP = 20;
// requestSeq is Monica's OWN arrival-order counter — Health Auto Export
// does not send a batch/sequence identifier of its own (confirmed: not
// documented anywhere), so this reflects "the Nth request this server
// has received," not HAE's internal batch numbering. Persisted
// separately from the capped array so it keeps counting even once the
// array itself starts dropping old entries.
async function pushDiagnostics(supabaseUrl, supabaseKey, entry) {
  const data = await readAppState(supabaseUrl, supabaseKey, 'health_diagnostics');
  const existingList = (data && Array.isArray(data.health_diagnostics_v1)) ? data.health_diagnostics_v1 : [];
  const priorCount = (data && Number.isFinite(data.totalRequestCount)) ? data.totalRequestCount : existingList.length;
  const requestSeq = priorCount + 1;
  entry.requestSeq = requestSeq;
  existingList.push(entry);
  while (existingList.length > DIAGNOSTICS_CAP) existingList.shift();
  await upsertAppState(supabaseUrl, supabaseKey, 'health_diagnostics', { health_diagnostics_v1: existingList, totalRequestCount: requestSeq });
  return requestSeq;
}

function measurePayloadSize(req) {
  const cl = req.headers && req.headers['content-length'];
  if (cl != null) {
    const n = parseInt(cl, 10);
    if (Number.isFinite(n)) return n;
  }
  try { return Buffer.byteLength(JSON.stringify(req.body || {})); } catch (e) { return null; }
}

// Partial mitigation only: a request that fully exceeds Vercel's
// 4.5MB HARD limit never reaches this function at all (Vercel's proxy
// rejects it first — that's the confirmed 413), so nothing here can
// catch that case or log it. This guard only helps requests that
// squeak under 4.5MB but are still large enough to be worth a clear,
// diagnosable response instead of silently attempting to process them.
const SIZE_GUARD_BYTES = 4 * 1024 * 1024;

export default async function handler(req, res) {
  const now = Date.now();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  const expected = process.env.HEALTH_IMPORT_TOKEN;
  if (!expected) return res.status(500).json({ error: 'server not configured (missing HEALTH_IMPORT_TOKEN)' });

  const token = (req.query && req.query.token) || '';
  if (token !== expected) {
    if (supabaseUrl && supabaseKey) {
      pushDiagnostics(supabaseUrl, supabaseKey, {
        receivedAt: now, parsedAt: null, savedAt: null, tokenValid: false,
        payloadSizeBytes: measurePayloadSize(req),
        metricsPresent: [], metricsMissing: [], metricsMerged: [], metricsPreserved: [], metricsRejectedStale: [],
        duplicatesRemoved: 0,
        warnings: [{ metric: 'auth', message: 'rejected: token did not match HEALTH_IMPORT_TOKEN' }],
        parsed: null, selfCheck: null, savedOk: false,
      }).catch(() => {});
    }
    return res.status(401).json({ error: 'invalid token' });
  }

  const payloadSizeBytes = measurePayloadSize(req);

  if (payloadSizeBytes != null && payloadSizeBytes > SIZE_GUARD_BYTES) {
    if (supabaseUrl && supabaseKey) {
      pushDiagnostics(supabaseUrl, supabaseKey, {
        receivedAt: now, parsedAt: null, savedAt: null, tokenValid: true,
        payloadSizeBytes,
        metricsPresent: [], metricsMissing: [], metricsMerged: [], metricsPreserved: [], metricsRejectedStale: [],
        duplicatesRemoved: 0,
        warnings: [{ metric: 'payload', message: 'request body (' + Math.round(payloadSizeBytes / 1024 / 1024 * 10) / 10 + 'MB) exceeded the ' + Math.round(SIZE_GUARD_BYTES / 1024 / 1024) + 'MB internal guard — enable Batch Requests in Health Auto Export to split this into smaller requests. Note: a request over Vercel\'s hard 4.5MB limit never reaches this server at all and won\'t appear here — check Health Auto Export\'s own Activity Log for a 413 if a sync seems to have vanished entirely.' }],
        parsed: null, selfCheck: null, savedOk: false,
      }).catch(() => {});
    }
    return res.status(200).json({ ok: false, error: 'payload too large', payloadSizeBytes, suggestion: 'enable Batch Requests in Health Auto Export' });
  }

  let body = req.body;
  let bodyParseError = null;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { bodyParseError = e && e.message ? e.message : String(e); body = {}; }
  }

  const { summary: candidate, dayKeys, parsedWorkouts, sleepDedupedCount, diagnostics } = normalizeHealthPayload(body, now);
  if (bodyParseError) diagnostics.warnings.unshift({ metric: 'body', message: 'request body was not valid JSON: ' + bodyParseError });

  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'server not configured (missing SUPABASE_URL / SUPABASE_ANON_KEY)' });

  let savedOk = false;
  let mergedKeys = [], preservedKeys = [], rejectedStaleKeys = [];
  let merged = null;
  let selfCheck = { pass: true, issues: [] };
  let duplicatesRemoved = sleepDedupedCount || 0;

  try {
    const existingData = await readAppState(supabaseUrl, supabaseKey, 'health_metrics');
    const stored = (existingData && existingData.health_metrics_v1) || null;

    const mergeResult = mergeHealthState(stored, candidate, dayKeys, now);
    merged = mergeResult.merged;
    mergedKeys = mergeResult.mergedKeys;
    preservedKeys = mergeResult.preservedKeys;
    rejectedStaleKeys = mergeResult.rejectedStaleKeys;

    const workoutMerge = mergeWorkouts((stored && stored.allWorkoutsPool) || [], parsedWorkouts, now);
    merged.allWorkoutsPool = workoutMerge.allWorkoutsPool;
    merged.workoutsToday = workoutMerge.workoutsToday;
    merged.recentWorkouts = workoutMerge.recentWorkouts;
    duplicatesRemoved += workoutMerge.duplicatesRemoved;

    selfCheck = validateSummary(merged);

    const r = await upsertAppState(supabaseUrl, supabaseKey, 'health_metrics', { health_metrics_v1: merged });
    if (!r.ok) {
      const text = await r.text();
      diagnostics.warnings.push({ metric: 'storage', message: 'supabase upsert failed: ' + text });
    } else {
      savedOk = await verifyReadBack(supabaseUrl, supabaseKey, merged);
      if (!savedOk) diagnostics.warnings.push({ metric: 'storage', message: 'wrote health_metrics but the read-back did not match what was sent' });
    }
  } catch (e) {
    diagnostics.warnings.push({ metric: 'storage', message: 'fetch error during merge/write: ' + (e && e.message ? e.message : String(e)) });
  }

  await pushDiagnostics(supabaseUrl, supabaseKey, {
    receivedAt: now,
    parsedAt: now, // normalizeHealthPayload never throws — it degrades to nulls — so reaching here means parsing "succeeded"
    savedAt: savedOk ? now : null,
    tokenValid: true,
    payloadSizeBytes,
    metricsPresent: diagnostics.present,
    metricsMissing: diagnostics.missing,
    metricsMerged: mergedKeys,
    metricsPreserved: preservedKeys,
    metricsRejectedStale: rejectedStaleKeys,
    duplicatesRemoved,
    parsedWorkoutsCount: parsedWorkouts.length,
    warnings: diagnostics.warnings,
    parsed: candidate,
    selfCheck,
    savedOk,
  }).catch(() => {});

  return res.status(200).json({
    ok: true, summary: merged,
    diagnostics: {
      present: diagnostics.present, missing: diagnostics.missing,
      merged: mergedKeys, preserved: preservedKeys, rejectedStale: rejectedStaleKeys,
      duplicatesRemoved, warnings: diagnostics.warnings,
    },
    selfCheck, savedOk,
  });
}
