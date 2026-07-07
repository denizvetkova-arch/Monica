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
// (which can carry high-resolution samples and, for workouts,
// GPS routes). The normalized summary is written directly to the
// existing app_state table (server-to-server, no browser involved)
// under key "health_metrics", the same table goals/stack/tasks use.
//
// Env vars required on Vercel:
//   HEALTH_IMPORT_TOKEN   (any secret string you choose)
//   SUPABASE_URL
//   SUPABASE_ANON_KEY
//
// NOTE ON FIELD NAMES: Health Auto Export's exact metric names/shapes
// have shifted across versions (particularly sleep_analysis, whose
// data points sometimes carry `asleep`, sometimes `value`/`qty`).
// normalizeHealthPayload() below tries the documented common shapes
// defensively and falls back to null for anything it can't find —
// verify against a real export from Settings > Automations > (your
// automation) > "Preview Data" in the app and adjust the field-name
// candidates if a metric isn't landing.
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

function sumSleepHours(entries) {
  if (!Array.isArray(entries)) return null;
  let total = 0, found = false;
  for (const e of entries) {
    if (!e) continue;
    // Newer exports: minutes in `asleep`/`core`+`deep`+`rem` style breakdowns.
    // Older/simple exports: a single `qty` or `value` already in hours.
    if (typeof e.asleep === 'number') { total += e.asleep; found = true; }
    else if (typeof e.qty === 'number') { total += e.qty; found = true; }
    else if (typeof e.value === 'number') { total += e.value; found = true; }
  }
  return found ? total : null;
}

function findMetric(metrics, name) {
  if (!Array.isArray(metrics)) return null;
  const m = metrics.find(x => x && x.name === name);
  return m ? m.data : null;
}

// Nutrition metric names in particular vary across Health Auto Export versions
// (e.g. `carbohydrates` vs `dietary_carbohydrates`) — try each candidate in
// order and use the first one that's actually present in this payload.
function findMetricAny(metrics, names) {
  for (const name of names) {
    const data = findMetric(metrics, name);
    if (data) return data;
  }
  return null;
}

export function normalizeHealthPayload(body) {
  const root = (body && body.data) || body || {};
  const metrics = root.metrics || [];
  const workouts = root.workouts || [];

  const sleepHours = sumSleepHours(findMetric(metrics, 'sleep_analysis'));
  const steps = sumQty(findMetric(metrics, 'step_count'));
  const restingHR = latestValue(findMetric(metrics, 'resting_heart_rate'), ['Avg', 'qty', 'value']);
  const activeEnergyKcal = sumQty(findMetric(metrics, 'active_energy'));
  const dietaryEnergyKcal = sumQty(findMetricAny(metrics, ['dietary_energy', 'dietary_energy_consumed']));
  const proteinG = sumQty(findMetricAny(metrics, ['protein', 'dietary_protein']));
  const carbsG = sumQty(findMetricAny(metrics, ['carbohydrates', 'dietary_carbohydrates']));
  const fatG = sumQty(findMetricAny(metrics, ['total_fat', 'fat_total', 'dietary_fat', 'dietary_fat_total']));
  const fiberG = sumQty(findMetricAny(metrics, ['fiber', 'dietary_fiber']));

  let workoutCount = 0, workoutMinutes = 0, lastWorkoutEndedAt = null;
  if (Array.isArray(workouts)) {
    workoutCount = workouts.length;
    workouts.forEach(w => {
      if (!w) return;
      if (typeof w.duration === 'number') workoutMinutes += w.duration / 60;
      const end = w.end ? new Date(w.end).getTime() : null;
      if (end && (!lastWorkoutEndedAt || end > lastWorkoutEndedAt)) lastWorkoutEndedAt = end;
    });
  }

  return {
    sleepHours: sleepHours != null ? Math.round(sleepHours * 10) / 10 : null,
    steps: steps != null ? Math.round(steps) : null,
    restingHR: restingHR != null ? Math.round(restingHR) : null,
    activeEnergyKcal: activeEnergyKcal != null ? Math.round(activeEnergyKcal) : null,
    dietaryEnergyKcal: dietaryEnergyKcal != null ? Math.round(dietaryEnergyKcal) : null,
    proteinG: proteinG != null ? Math.round(proteinG) : null,
    carbsG: carbsG != null ? Math.round(carbsG) : null,
    fatG: fatG != null ? Math.round(fatG) : null,
    fiberG: fiberG != null ? Math.round(fiberG) : null,
    workoutsToday: { count: workoutCount, minutes: Math.round(workoutMinutes), lastEndedAt: lastWorkoutEndedAt },
    updatedAt: Date.now(),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const token = (req.query && req.query.token) || '';
  const expected = process.env.HEALTH_IMPORT_TOKEN;
  if (!expected) return res.status(500).json({ error: 'server not configured (missing HEALTH_IMPORT_TOKEN)' });
  if (token !== expected) return res.status(401).json({ error: 'invalid token' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const summary = normalizeHealthPayload(body);

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'server not configured (missing SUPABASE_URL / SUPABASE_ANON_KEY)' });

  try {
    const r = await fetch(supabaseUrl + '/rest/v1/app_state?on_conflict=key', {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': 'Bearer ' + supabaseKey,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        key: 'health_metrics',
        data: { health_metrics_v1: summary },
        updated_at: new Date().toISOString(),
      }),
    });
    if (!r.ok) {
      const text = await r.text();
      return res.status(500).json({ error: 'supabase upsert failed: ' + text });
    }
  } catch (e) {
    return res.status(500).json({ error: 'fetch error: ' + (e && e.message ? e.message : String(e)) });
  }

  return res.status(200).json({ ok: true, summary });
}
