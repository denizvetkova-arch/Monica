// ============================================================
// POST /api/health-import?token=SECRET
// Webhook target for the "Health Auto Export" iOS app's REST API
// automation. Health Auto Export can't do interactive OAuth (it's a
// scheduled/background-delivery automation, not a browser), so auth
// is a shared secret you pick yourself and put in both places:
//   - Vercel env var HEALTH_IMPORT_TOKEN
//   - the URL you configure inside Health Auto Export
//
// This handler NORMALIZES AND DISCARDS the raw payload — it extracts
// only the aggregate numbers below and never persists the raw body
// (which can carry high-resolution samples and, for workouts, GPS
// routes). The normalized summary is written to the existing
// app_state table (server-to-server, no browser involved) under key
// "health_metrics" (as health_metrics_v1 — dashboard-facing).
//
// A SECOND record is written under key "health_diagnostics" (as
// health_diagnostics_v1 — a capped array of the last 20 imports) so
// nothing about the pipeline is invisible: which metrics were present
// in this payload, which were missing, any parse warnings, the exact
// values this import computed, a range-sanity self-check, and whether
// the health_metrics write actually read back correctly. This is what
// health-diagnostics.html reads to show the full pipeline trace —
// see that page for the "Apple Health -> imported -> stored ->
// dashboard" comparison this exists to support.
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
// SETUP.md for the full list of metrics to enable in the app.
//
// NOTE ON SLEEP: this is the metric that was wrong before. Health Auto
// Export exports sleep_analysis in one of two shapes depending on the
// automation's aggregation setting:
//   - aggregated: one entry per night — {date, asleep, sleepStart,
//     sleepEnd, sleepSource, inBed, inBedStart, inBedEnd}
//   - unaggregated: one entry per sleep STAGE segment — {startDate,
//     endDate, qty, value} where value is "Asleep"/"Core"/"REM"/"Deep"/
//     "Awake"/"In Bed"
// computeSleep() below handles both, and — critically — always looks
// for the most recently COMPLETED session rather than assuming
// "today" has one. Health Auto Export's "Today" date-range preset
// only syncs the current calendar day up to now; a session that ended
// this morning is frequently still mid-sync when the automation's
// background-delivery trigger fires, so a same-day-only query can
// legitimately come back with zero sleep entries most mornings. If
// you haven't already, switch the automation's date range to
// "Default" (previous day + today) — see SETUP.md.
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

// ---------- Sleep ----------
// Real HealthKit sleep stage values, lowercased/space-stripped for
// matching. "Asleep" with no suffix is the older/simple export; the
// Core/REM/Deep suffixes are the newer stage-tracking export.
const SLEEP_STAGE_ASLEEP = new Set(['asleep', 'asleepcore', 'core', 'asleeprem', 'rem', 'asleepdeep', 'deep', 'asleepunspecified']);
const SLEEP_STAGE_NOT_ASLEEP = new Set(['awake', 'inbed']);

function dedupeSleepSamples(samples) {
  const seen = new Set();
  return samples.filter(s => {
    const key = s.start + '|' + s.end + '|' + s.stage + '|' + s.source;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Returns { hours, sessionStart, sessionEnd, source } for the most
// recently COMPLETED sleep session — never "today's sleep" by
// assumption, never 0 for missing data. sessionStart/sessionEnd are
// absolute epoch ms (timezone-unambiguous); which CALENDAR DAY that
// falls on is deliberately left to the client, which knows the user's
// actual local timezone — the server doesn't and shouldn't guess it.
function computeSleep(entries, now, warnings) {
  const EMPTY = { hours: null, sessionStart: null, sessionEnd: null, source: null };
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
    return { hours: best.asleep, sessionStart: best.start, sessionEnd: best.end, source: best.source };
  }

  // Unaggregated: per-stage samples. Only startDate/endDate/value-shaped
  // entries are usable; anything else is silently-but-loudly skipped
  // (recorded as a warning, not just dropped).
  let unparseable = 0;
  const samples = dedupeSleepSamples(
    entries.map(e => {
      if (!e) return null;
      const start = parseDateMs(e.startDate);
      const end = parseDateMs(e.endDate);
      const stage = typeof e.value === 'string' ? e.value.toLowerCase().replace(/\s+/g, '') : null;
      if (start == null || end == null || stage == null) { unparseable++; return null; }
      return { start, end, stage, qty: typeof e.qty === 'number' ? e.qty : null, source: e.source || null };
    }).filter(Boolean)
  ).sort((a, b) => a.start - b.start);

  if (unparseable > 0) {
    warnings.push({ metric: 'sleep', message: unparseable + ' sleep_analysis entries had neither an "asleep" field nor a recognizable startDate/endDate/value shape and were skipped' });
  }
  if (samples.length === 0) {
    warnings.push({ metric: 'sleep', message: 'sleep_analysis entries present but none were parseable' });
    return EMPTY;
  }

  // Group into nights: a new night starts after a >3h gap since the
  // previous sample ended — merges contiguous/overlapping segments
  // (including short "Awake" blips mid-night) into one session without
  // conflating a nap with the following night's sleep.
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
    // Multiple sources (e.g. Watch + iPhone both logging the same
    // night) would double-count if summed — use whichever single
    // source logged the most, not the total across all of them.
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
    return EMPTY;
  }
  completedNights.sort((a, b) => b.sessionEnd - a.sessionEnd);
  const best = completedNights[0];
  return { hours: best.hours, sessionStart: best.sessionStart, sessionEnd: best.sessionEnd, source: best.source };
}

// ---------- Workouts ----------
// No GPS/route data, ever — just what's needed to reason about "did a
// workout happen and roughly how much did it take out of the day."
function summarizeWorkouts(workouts, warnings) {
  if (!Array.isArray(workouts) || workouts.length === 0) {
    return { count: 0, minutes: 0, lastEndedAt: null, recent: [] };
  }
  let unparseable = 0;
  const items = workouts.map(w => {
    if (!w) { unparseable++; return null; }
    const start = parseDateMs(w.start);
    const end = parseDateMs(w.end);
    const activeKcal = (w.activeEnergyBurned && typeof w.activeEnergyBurned.qty === 'number')
      ? w.activeEnergyBurned.qty
      : (typeof w.activeEnergy === 'number' ? w.activeEnergy : null);
    return {
      type: w.name || w.type || 'Workout',
      start, end,
      durationMin: typeof w.duration === 'number' ? w.duration / 60 : (start != null && end != null ? (end - start) / 60000 : null),
      activeKcal: activeKcal != null ? Math.round(activeKcal) : null,
    };
  }).filter(Boolean);
  if (unparseable > 0) warnings.push({ metric: 'workouts', message: unparseable + ' workout entries were missing/unparseable and were skipped' });

  items.sort((a, b) => (b.end || 0) - (a.end || 0));
  const totalMinutes = items.reduce((s, i) => s + (i.durationMin || 0), 0);
  return {
    count: items.length,
    minutes: Math.round(totalMinutes),
    lastEndedAt: items.length ? items[0].end : null,
    recent: items.slice(0, 5).map(i => ({ type: i.type, start: i.start, end: i.end, durationMin: i.durationMin != null ? Math.round(i.durationMin) : null, activeKcal: i.activeKcal })),
  };
}

// ---------- Main normalizer ----------
// Returns { summary, diagnostics: { present, missing, warnings } }.
// `now` is injectable so sleep's "is this session actually completed
// yet" logic is deterministic in tests, not tied to the real clock.
export function normalizeHealthPayload(body, now) {
  now = now != null ? now : Date.now();
  const root = (body && body.data) || body || {};
  const metrics = root.metrics || [];
  const workoutsRaw = root.workouts || [];

  const present = [];
  const missing = [];
  const warnings = [];
  const summary = {};

  function extract(key, names, extractor) {
    const data = findMetricAny(metrics, names);
    if (data == null) { missing.push(key); summary[key] = null; return; }
    present.push(key);
    let v = null;
    try { v = extractor(data); } catch (e) {
      warnings.push({ metric: key, message: 'parse error: ' + (e && e.message ? e.message : String(e)) });
    }
    if (v == null) warnings.push({ metric: key, message: 'metric present in payload but no usable numeric value found in its entries' });
    summary[key] = v;
  }

  const sleepEntries = findMetric(metrics, 'sleep_analysis');
  if (sleepEntries == null) missing.push('sleep'); else present.push('sleep');
  const sleep = computeSleep(sleepEntries, now, warnings);

  extract('steps', ['step_count'], sumQty);
  extract('restingHR', ['resting_heart_rate'], d => latestValue(d, ['Avg', 'qty', 'value']));
  extract('heartRate', ['heart_rate', 'walking_heart_rate_average'], d => latestValue(d, ['Avg', 'qty', 'value']));
  extract('activeEnergyKcal', ['active_energy'], sumQty);
  extract('basalEnergyKcal', ['basal_energy_burned'], sumQty);
  extract('dietaryEnergyKcal', ['dietary_energy', 'dietary_energy_consumed'], sumQty);
  extract('proteinG', ['protein', 'dietary_protein'], sumQty);
  extract('carbsG', ['carbohydrates', 'dietary_carbohydrates'], sumQty);
  extract('fatG', ['total_fat', 'fat_total', 'dietary_fat', 'dietary_fat_total'], sumQty);
  extract('fiberG', ['fiber', 'dietary_fiber'], sumQty);
  extract('hrv', ['heart_rate_variability'], d => latestValue(d, ['qty', 'value']));
  extract('bloodOxygenPct', ['blood_oxygen_saturation', 'oxygen_saturation'], d => {
    const v = latestValue(d, ['qty', 'value']);
    return v != null ? (v <= 1 ? v * 100 : v) : null; // some exports report a 0-1 fraction, some a 0-100 percentage
  });
  extract('respiratoryRate', ['respiratory_rate'], d => latestValue(d, ['qty', 'value']));
  extract('vo2Max', ['vo2_max'], d => latestValue(d, ['qty', 'value']));
  extract('flightsClimbed', ['flights_climbed'], sumQty);
  extract('exerciseMinutes', ['apple_exercise_time'], sumQty);
  extract('standHours', ['apple_stand_hour', 'apple_stand_time'], sumQty);
  extract('walkingDistanceKm', ['walking_running_distance', 'distance_walking_running'], sumQty);
  extract('weightKg', ['weight_body_mass'], d => latestValue(d, ['qty', 'value']));
  extract('bodyFatPct', ['body_fat_percentage'], d => {
    const v = latestValue(d, ['qty', 'value']);
    return v != null ? (v <= 1 ? v * 100 : v) : null;
  });
  extract('bmi', ['body_mass_index'], d => latestValue(d, ['qty', 'value']));
  extract('mindfulMinutes', ['mindful_session'], sumQty);

  if (Array.isArray(workoutsRaw) && workoutsRaw.length) present.push('workouts'); else missing.push('workouts');
  const workouts = summarizeWorkouts(workoutsRaw, warnings);

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
    workoutsToday: { count: workouts.count, minutes: workouts.minutes, lastEndedAt: workouts.lastEndedAt },
    recentWorkouts: workouts.recent,
    updatedAt: now,
  };

  return { summary: result, diagnostics: { present, missing, warnings } };
}

// ---------- Self-check (Phase 6, server half) ----------
// Physiologically-plausible range checks — flags anything a parsing
// bug (e.g. a unit mix-up) would likely produce, without ever
// discarding the value itself. Warnings only, never corrections.
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

// Confirms the health_metrics write actually landed — a shallow but
// real signal (updatedAt + a couple of headline fields), not a full
// deep-equality diff, since this runs on every single import.
async function verifyReadBack(supabaseUrl, supabaseKey, summary) {
  const data = await readAppState(supabaseUrl, supabaseKey, 'health_metrics');
  const stored = data && data.health_metrics_v1;
  if (!stored) return false;
  return stored.updatedAt === summary.updatedAt && stored.steps === summary.steps && stored.sleepHours === summary.sleepHours;
}

const DIAGNOSTICS_CAP = 20;
async function pushDiagnostics(supabaseUrl, supabaseKey, entry) {
  const data = await readAppState(supabaseUrl, supabaseKey, 'health_diagnostics');
  const existing = (data && Array.isArray(data.health_diagnostics_v1)) ? data.health_diagnostics_v1 : [];
  existing.push(entry);
  while (existing.length > DIAGNOSTICS_CAP) existing.shift();
  await upsertAppState(supabaseUrl, supabaseKey, 'health_diagnostics', { health_diagnostics_v1: existing });
}

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
        metricsPresent: [], metricsMissing: [],
        warnings: [{ metric: 'auth', message: 'rejected: token did not match HEALTH_IMPORT_TOKEN' }],
        parsed: null, selfCheck: null, savedOk: false,
      }).catch(() => {});
    }
    return res.status(401).json({ error: 'invalid token' });
  }

  let body = req.body;
  let bodyParseError = null;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { bodyParseError = e && e.message ? e.message : String(e); body = {}; }
  }

  const { summary, diagnostics } = normalizeHealthPayload(body, now);
  if (bodyParseError) diagnostics.warnings.unshift({ metric: 'body', message: 'request body was not valid JSON: ' + bodyParseError });
  const selfCheck = validateSummary(summary);

  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'server not configured (missing SUPABASE_URL / SUPABASE_ANON_KEY)' });

  let savedOk = false;
  try {
    const r = await upsertAppState(supabaseUrl, supabaseKey, 'health_metrics', { health_metrics_v1: summary });
    if (!r.ok) {
      const text = await r.text();
      diagnostics.warnings.push({ metric: 'storage', message: 'supabase upsert failed: ' + text });
    } else {
      savedOk = await verifyReadBack(supabaseUrl, supabaseKey, summary);
      if (!savedOk) diagnostics.warnings.push({ metric: 'storage', message: 'wrote health_metrics but the read-back did not match what was sent' });
    }
  } catch (e) {
    diagnostics.warnings.push({ metric: 'storage', message: 'fetch error writing health_metrics: ' + (e && e.message ? e.message : String(e)) });
  }

  await pushDiagnostics(supabaseUrl, supabaseKey, {
    receivedAt: now,
    parsedAt: now, // normalizeHealthPayload never throws — it degrades to nulls — so reaching here means parsing "succeeded"
    savedAt: savedOk ? now : null,
    tokenValid: true,
    metricsPresent: diagnostics.present,
    metricsMissing: diagnostics.missing,
    warnings: diagnostics.warnings,
    parsed: summary,
    selfCheck,
    savedOk,
  }).catch(() => {});

  return res.status(200).json({
    ok: true, summary,
    diagnostics: { present: diagnostics.present, missing: diagnostics.missing, warnings: diagnostics.warnings },
    selfCheck, savedOk,
  });
}
