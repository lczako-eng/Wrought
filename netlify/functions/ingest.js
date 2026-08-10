// netlify/functions/ingest.js
// The device door.
//
// Everything a watch, ring or scale knows arrives here. It is a plain POST with
// a bearer key rather than anything OAuth-shaped, because the thing calling it
// is usually an iOS Shortcut, and a Shortcut cannot run a PKCE dance.
//
// Why push at all, for Apple: HealthKit has NO cloud API. There is no
// entitlement, no partner programme and no price at which a server can read an
// Apple Watch. The data lives on the phone and leaves only if the phone sends
// it. Every "Apple Health integration" you have ever seen is this, underneath.
//
// Accepts two body shapes, because the two realistic senders disagree:
//   1. WROUGHT native  — {source, metrics: [{metric, value, unit, measured_at}], events: [...]}
//   2. Health Auto Export — {data: {metrics: [{name, units, data: [{date, qty}]}]}}
//
// Writes are idempotent. A watch WILL re-send the same night's sleep four
// times; the unique index plus ignoreDuplicates is what stops that becoming
// four nights of sleep.

import { supabase, hashToken, localDateFor, getProfile } from './lib/wrought.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

// Apple, Health Connect, Samsung, Strava, Health Auto Export and every wearable
// vendor name the same quantity differently — and each of them is certain their
// name is the obvious one. One vocabulary, translated at the door, so nothing
// downstream ever has to know that "HKQuantityTypeIdentifierStepCount",
// "StepsRecord" and "step_count" are all just steps.
//
// This map is the actual integration work. Adding a new device is usually a few
// lines here, not a new service — because whatever the device is, it is already
// writing into Apple Health or Health Connect, and this is where those land.
const METRIC_ALIASES = {
  // steps
  steps: 'steps',
  step_count: 'steps',
  stepsrecord: 'steps',                                   // Health Connect
  hkquantitytypeidentifierstepcount: 'steps',             // Apple
  com_samsung_health_step_count: 'steps',                 // Samsung Health
  total_steps: 'steps',

  // heart
  heart_rate: 'heart_rate',
  heartraterecord: 'heart_rate',
  hkquantitytypeidentifierheartrate: 'heart_rate',

  resting_heart_rate: 'resting_hr',
  resting_hr: 'resting_hr',
  restingheartraterecord: 'resting_hr',
  hkquantitytypeidentifierrestingheartrate: 'resting_hr',

  heart_rate_variability: 'hrv',
  heart_rate_variability_sdnn: 'hrv',
  heartratevariabilityrmssdrecord: 'hrv',
  hrv: 'hrv',
  hrv_sdnn: 'hrv',
  hkquantitytypeidentifierheartratevariabilitysdnn: 'hrv',

  // sleep
  sleep_analysis: 'sleep_minutes',
  sleep_minutes: 'sleep_minutes',
  sleepsessionrecord: 'sleep_minutes',
  sleep_session: 'sleep_minutes',
  asleep: 'sleep_minutes',
  time_asleep: 'sleep_minutes',
  total_sleep: 'sleep_minutes',

  // body
  weight_body_mass: 'weight_kg',
  body_mass: 'weight_kg',
  weight: 'weight_kg',
  weight_kg: 'weight_kg',
  weightrecord: 'weight_kg',
  hkquantitytypeidentifierbodymass: 'weight_kg',

  body_fat_percentage: 'body_fat_pct',
  body_fat_pct: 'body_fat_pct',
  bodyfatrecord: 'body_fat_pct',
  hkquantitytypeidentifierbodyfatpercentage: 'body_fat_pct',

  // energy
  active_energy: 'active_calories',
  active_energy_burned: 'active_calories',
  active_calories: 'active_calories',
  activecaloriesburnedrecord: 'active_calories',
  hkquantitytypeidentifieractiveenergyburned: 'active_calories',

  total_calories: 'total_calories',
  totalcaloriesburnedrecord: 'total_calories',
  basal_energy_burned: 'total_calories',

  // movement — the metrics that matter for runners, which is most people who
  // wear a watch at all
  distance: 'distance_km',
  distance_km: 'distance_km',
  distance_walking_running: 'distance_km',
  distancerecord: 'distance_km',
  hkquantitytypeidentifierdistancewalkingrunning: 'distance_km',
  hkquantitytypeidentifierdistancecycling: 'distance_km',

  active_minutes: 'active_minutes',
  exercise_time: 'active_minutes',
  apple_exercise_time: 'active_minutes',
  exercisesessionrecord: 'active_minutes',
  moving_time: 'active_minutes',                          // Strava

  // ── Blood: the half of "how am I doing" that no fitness app touches ──────
  // A hub that holds every step you took and nothing about your blood is not a
  // hub, it is a pedometer with ambitions.
  blood_glucose: 'glucose',
  glucose: 'glucose',
  bloodglucoserecord: 'glucose',
  blood_sugar: 'glucose',
  hkquantitytypeidentifierbloodglucose: 'glucose',

  blood_pressure_systolic: 'systolic',
  systolic: 'systolic',
  bloodpressuresystolic: 'systolic',
  hkquantitytypeidentifierbloodpressuresystolic: 'systolic',

  blood_pressure_diastolic: 'diastolic',
  diastolic: 'diastolic',
  bloodpressurediastolic: 'diastolic',
  hkquantitytypeidentifierbloodpressurediastolic: 'diastolic',

  body_temperature: 'body_temp',
  body_temp: 'body_temp',
  skin_temperature: 'body_temp',
  respiratory_rate: 'respiratory_rate',
  breathing_rate: 'respiratory_rate',

  lean_body_mass: 'lean_mass_kg',
  lean_mass: 'lean_mass_kg',
  muscle_mass: 'lean_mass_kg',
  body_water: 'body_water_pct',
  bone_mass: 'bone_mass_kg',
  waist_circumference: 'waist_cm',

  // ── Bloodwork ────────────────────────────────────────────────────────────
  // Nobody aggregates these with training and food, which is exactly why the
  // combination is worth something: a ferritin result means one thing on its
  // own and another next to four months of falling resting heart rate.
  cholesterol_total: 'cholesterol_total',
  total_cholesterol: 'cholesterol_total',
  hdl: 'hdl', hdl_cholesterol: 'hdl',
  ldl: 'ldl', ldl_cholesterol: 'ldl',
  triglycerides: 'triglycerides',
  hba1c: 'hba1c', a1c: 'hba1c',
  ferritin: 'ferritin',
  vitamin_d: 'vitamin_d',
  testosterone: 'testosterone',
  tsh: 'tsh',
  crp: 'crp',
  creatinine: 'creatinine',
  alt: 'alt', ast: 'ast',

  // fitness markers
  vo2_max: 'vo2max',
  vo2max: 'vo2max',
  vo2maxrecord: 'vo2max',
  blood_oxygen_saturation: 'spo2',
  oxygen_saturation: 'spo2',
  oxygensaturationrecord: 'spo2',
  spo2: 'spo2',
};

export const canonicalMetric = name =>
  METRIC_ALIASES[String(name || '').toLowerCase().replace(/[\s-]+/g, '_')] || null;

// Units arrive in whatever the device felt like. Storage is metric and minutes,
// so conversion happens once, here, and never again.
// What an Apple Shortcut actually types. A Health Sample variable dropped into
// a Text action renders as a human string — "8,412", "331 lb", "54 count/min" —
// and a hand-built Shortcut is the single most important client this endpoint
// has. Refusing "8,412" because of the comma fails the exact person this door
// was built for, so the number is dug out of whatever wrapping it arrived in.
// The unit STILL comes from the declared unit field, never parsed out of the
// value — "331 lb" with unit "lb" converts once, not twice.
export function looseNumber(value) {
  if (typeof value === 'number') return value;
  const m = String(value ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

export function normalise(metric, value, unit) {
  const u = String(unit || '').toLowerCase();
  let v = looseNumber(value);
  if (!Number.isFinite(v)) return null;

  if (metric === 'weight_kg') {
    if (u === 'lb' || u === 'lbs' || u === 'pounds') v = v / 2.2046226;
    if (u === 'g') v = v / 1000;
    if (u === 'st' || u === 'stone') v = v * 6.35029;
    return { value: Math.round(v * 100) / 100, unit: 'kg' };
  }
  if (metric === 'sleep_minutes') {
    if (u === 'h' || u === 'hr' || u === 'hours' || u === 'hrs') v = v * 60;
    if (u === 's' || u === 'sec' || u === 'seconds') v = v / 60;
    return { value: Math.round(v), unit: 'min' };
  }
  if (metric === 'active_calories' || metric === 'total_calories') {
    if (u === 'kj') v = v / 4.184;
    if (u === 'cal') v = v / 1000;
    return { value: Math.round(v), unit: 'kcal' };
  }
  if (metric === 'distance_km') {
    // Strava sends metres, Apple sends miles or km depending on the user's
    // region, Health Connect sends metres. Getting this wrong turns a 5k into
    // a 5000km run, which is at least an obvious failure — the mile/km mix-up
    // is the quiet one that would just make everybody 60% faster.
    if (u === 'm' || u === 'metres' || u === 'meters') v = v / 1000;
    if (u === 'mi' || u === 'mile' || u === 'miles') v = v * 1.609344;
    if (u === 'ft' || u === 'feet') v = v * 0.0003048;
    return { value: Math.round(v * 100) / 100, unit: 'km' };
  }
  if (metric === 'glucose') {
    // The one conversion that must not be got wrong. mg/dL is roughly 18×
    // mmol/L, so a mix-up turns a normal 5.5 into 99 or a 99 into 1783 — the
    // first looks like a medical emergency and the second like a broken sensor.
    // Stored in mmol/L.
    if (u === 'mg/dl' || u === 'mgdl' || u === 'mg_dl') v = v / 18.016;
    return { value: Math.round(v * 100) / 100, unit: 'mmol/L' };
  }
  if (metric === 'body_temp') {
    if (u === 'f' || u === '°f' || u === 'degf' || u === 'fahrenheit') v = (v - 32) * 5 / 9;
    return { value: Math.round(v * 10) / 10, unit: '°C' };
  }
  if (metric === 'lean_mass_kg' || metric === 'bone_mass_kg') {
    if (u === 'lb' || u === 'lbs') v = v / 2.2046226;
    return { value: Math.round(v * 100) / 100, unit: 'kg' };
  }
  if (metric === 'waist_cm') {
    if (u === 'in' || u === 'inch' || u === 'inches') v = v * 2.54;
    return { value: Math.round(v * 10) / 10, unit: 'cm' };
  }
  if (metric === 'active_minutes') {
    if (u === 's' || u === 'sec' || u === 'seconds') v = v / 60;
    if (u === 'h' || u === 'hr' || u === 'hours') v = v * 60;
    return { value: Math.round(v), unit: 'min' };
  }
  return { value: Math.round(v * 100) / 100, unit: unit || '' };
}

// A run from Nike Run Club, a ride from Strava, a class from Peloton — these
// arrive as sessions, not samples, and belong in the training log next to the
// lifts rather than in the metric series. Normalised here so the brief counts
// a 10k the same way it counts a squat session.
const CARDIO_HINTS = /run|jog|walk|hik|cycl|bike|ride|swim|row|elliptical|cardio|treadmill|peloton/i;
const STRENGTH_HINTS = /strength|weight|lift|resistance|functional|crossfit/i;

export function normaliseWorkout(w) {
  const kindRaw = String(w.kind || w.type || w.activity || w.name || '').trim();
  const kind = STRENGTH_HINTS.test(kindRaw) ? 'strength'
             : CARDIO_HINTS.test(kindRaw)   ? 'cardio'
             : /yoga|stretch|mobility/i.test(kindRaw) ? 'mobility'
             : 'cardio';

  // Number(null) is 0, not NaN, so a missing duration would sail through a
  // plain Number.isFinite guard and file a zero-minute workout. Resolve the
  // raw value first and check for absence explicitly.
  const rawMinutes = w.minutes ?? w.duration_min ??
                     (w.duration_s != null ? Number(w.duration_s) / 60 : null);
  const rawDistance = w.distance_km != null ? Number(w.distance_km)
                    : w.distance_m != null ? Number(w.distance_m) / 1000 : null;

  const minutes  = rawMinutes  == null ? NaN : Number(rawMinutes);
  const distance = rawDistance == null ? NaN : Number(rawDistance);

  if (!Number.isFinite(minutes) && !Number.isFinite(distance)) return null;

  const bits = [kindRaw || kind];
  if (Number.isFinite(distance)) bits.push(`${Math.round(distance * 100) / 100} km`);
  if (Number.isFinite(minutes))  bits.push(`${Math.round(minutes)} min`);

  return {
    event_type: 'workout',
    summary: bits.join(' · '),
    detail: {
      kind,
      minutes: Number.isFinite(minutes) ? Math.round(minutes) : null,
      distance_km: Number.isFinite(distance) ? Math.round(distance * 100) / 100 : null,
      calories: Number.isFinite(Number(w.calories)) ? Math.round(Number(w.calories)) : null,
      // Cardio is whole-body as far as the training matrix is concerned. Without
      // this a runner's matrix stays empty forever and the brief tells them
      // they have not trained, which is both wrong and insulting.
      muscles: kind === 'strength' ? (w.muscles || []) : ['full body'],
      source_name: kindRaw || null,
    },
    occurred_at: w.occurred_at || w.start_date || w.startDate || null,
    source_ref: w.source_ref || w.id || null,
    estimated: false,
  };
}

// Health Auto Export nests one row per sample under a named metric. Flatten it
// into the same shape a hand-built Shortcut sends.
function flattenHealthAutoExport(body) {
  const out = [];
  const metrics = body?.data?.metrics;
  if (!Array.isArray(metrics)) return out;
  for (const m of metrics) {
    for (const point of (m.data || [])) {
      out.push({
        metric: m.name,
        unit: m.units,
        value: point.qty ?? point.Avg ?? point.value,
        measured_at: point.date || point.startDate,
      });
    }
  }
  return out;
}

// THE RUN ITSELF, not just the calories it burned. Health Auto Export puts
// workouts under data.workouts and this endpoint was reading only data.metrics
// — so a watch-recorded 5k arrived as a number in the day's active energy and
// the run vanished. The brief then said "rest day" to somebody who had just
// run, which is the kind of wrongness that ends a product's credibility in one
// sentence.
//
// HAE wraps quantities as {qty, units}; distance can arrive in km or miles and
// duration in seconds or minutes depending on the app's settings, so both are
// resolved here rather than trusted.
function flattenHealthAutoExportWorkouts(body) {
  const list = body?.data?.workouts;
  if (!Array.isArray(list)) return [];

  const qty = (v) => {
    if (v == null) return null;
    if (typeof v === 'object') return Number(v.qty ?? v.value ?? NaN);
    return Number(v);
  };
  const units = (v) => String((v && typeof v === 'object' && v.units) || '').toLowerCase();

  return list.map(w => {
    const distRaw = w.distance ?? w.totalDistance;
    let km = qty(distRaw);
    const du = units(distRaw);
    if (Number.isFinite(km)) {
      if (du.startsWith('mi')) km = km * 1.609344;
      else if (du === 'm') km = km / 1000;
    }

    // "duration" is seconds in HAE's own export and minutes in some forks.
    // Anything over three hours expressed as "minutes" is almost certainly
    // seconds, and a 7,200-minute run is a worse error than a rounding.
    let minutes = qty(w.duration ?? w.durationMinutes);
    if (Number.isFinite(minutes) && minutes > 600) minutes = minutes / 60;

    return {
      kind: w.name || w.workoutActivityType || w.type,
      minutes: Number.isFinite(minutes) ? minutes : null,
      distance_km: Number.isFinite(km) ? km : null,
      calories: qty(w.activeEnergy ?? w.activeEnergyBurned ?? w.totalEnergy),
      occurred_at: w.start || w.startDate || w.date || null,
      // The workout's own identity, so re-exporting a week never doubles it.
      source_ref: w.id || (w.start ? `hae:${w.start}` : null),
    };
  });
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };
  }
  if (!supabase) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'server_not_configured' }) };
  }

  const auth = event.headers?.authorization || event.headers?.Authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'missing_key' }) };
  }

  const { data: key } = await supabase.from('wrought_ingest_keys')
    .select('id, user_id, revoked').eq('token_hash', hashToken(auth.slice(7).trim())).maybeSingle();

  if (!key || key.revoked) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'invalid_key' }) };
  }

  let body;
  try {
    const raw = event.isBase64Encoded && event.body
      ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body || '{}');
    body = JSON.parse(raw);
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid_json' }) };
  }

  const userId  = key.user_id;
  const profile = await getProfile(userId);
  const source  = String(body.source || 'apple_health');

  const incoming = Array.isArray(body.metrics) && body.metrics.length
    ? body.metrics
    : flattenHealthAutoExport(body);

  let rows = [];
  const skipped = [];

  for (const m of incoming) {
    const metric = canonicalMetric(m.metric || m.name);
    if (!metric) { skipped.push(m.metric || m.name); continue; }

    const norm = normalise(metric, m.value ?? m.qty, m.unit ?? m.units);
    if (!norm) { skipped.push(m.metric || m.name); continue; }

    const measuredAt = m.measured_at || m.date || m.startDate;
    const when = measuredAt ? new Date(measuredAt) : new Date();
    if (Number.isNaN(when.getTime())) { skipped.push(m.metric || m.name); continue; }

    rows.push({
      user_id: userId,
      metric,
      value: norm.value,
      unit: norm.unit,
      measured_at: when.toISOString(),
      local_date: localDateFor(profile.timezone, when),
      source,
      source_ref: m.source_ref || null,
    });
  }

  // ── A DAILY TOTAL REPLACES ITS DAY; IT DOES NOT ADD TO IT ────────────────
  // Steps and active calories arrive as the running total SO FAR TODAY — that
  // is what a phone or a watch reports. But the row carries the moment it was
  // sent, and the dashboard sums a day's readings, so running the Shortcut at
  // teatime and again at eleven counted the day twice. Idempotency on
  // measured_at cannot catch it: the two sends genuinely happened at different
  // times, they just describe the same day.
  //
  // So for the cumulative metrics, the newest reading for a (source, metric,
  // day) REPLACES the older one. That is what makes "run it whenever you like"
  // safe, which matters because the Shortcut is the main door and people press
  // it to see if it worked.
  //
  // Point-in-time readings — weight, heart rate, glucose, sleep — are NOT in
  // this list. Three weigh-ins in a day are three real facts, and collapsing
  // them would throw away the record rather than repair it.
  const DAILY_TOTALS = new Set([
    'steps', 'active_calories', 'total_calories', 'distance_km', 'active_minutes',
  ]);
  const cumulative = rows.filter(r => DAILY_TOTALS.has(r.metric));
  if (cumulative.length) {
    const seen = new Set();
    for (const r of cumulative) {
      const key = `${r.source}|${r.metric}|${r.local_date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await supabase.from('wrought_metrics').delete()
        .eq('user_id', userId).eq('source', r.source)
        .eq('metric', r.metric).eq('local_date', r.local_date);
    }
    // Within ONE payload, a source that sends the same day twice means the
    // last one is the one it meant.
    const keep = new Map();
    for (const r of rows) {
      if (!DAILY_TOTALS.has(r.metric)) continue;
      keep.set(`${r.source}|${r.metric}|${r.local_date}`, r);
    }
    rows = rows.filter(r => !DAILY_TOTALS.has(r.metric)).concat([...keep.values()]);
  }

  let written = 0;
  if (rows.length) {
    // ignoreDuplicates is the whole idempotency story — the unique index on
    // (user_id, source, metric, measured_at) does the deduping in the database
    // rather than in a read-then-write race up here.
    const { data, error } = await supabase.from('wrought_metrics')
      .upsert(rows, { onConflict: 'user_id,source,metric,measured_at', ignoreDuplicates: true })
      .select('id');
    if (error) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    }
    written = data?.length || 0;
  }

  // Discrete sessions: a run from Nike Run Club, a ride from Strava, a lift the
  // watch recorded. Same door, same dedupe, via source_ref this time.
  // `workouts` is the friendly shape a Shortcut can build; `events` is the raw
  // one. Both land in the same place.
  const incomingEvents = [
    ...(Array.isArray(body.events) ? body.events : []),
    ...(Array.isArray(body.workouts) ? body.workouts.map(normaliseWorkout).filter(Boolean) : []),
    ...flattenHealthAutoExportWorkouts(body).map(normaliseWorkout).filter(Boolean),
  ];

  let eventsWritten = 0;
  if (incomingEvents.length) {
    const eventRows = incomingEvents.slice(0, 200).map(e => {
      const when = e.occurred_at ? new Date(e.occurred_at) : new Date();
      const at = Number.isNaN(when.getTime()) ? new Date() : when;
      return {
        user_id: userId,
        event_type: e.event_type || 'note',
        occurred_at: at.toISOString(),
        local_date: localDateFor(profile.timezone, at),
        summary: String(e.summary || 'device entry').slice(0, 500),
        detail: e.detail && typeof e.detail === 'object' ? e.detail : {},
        source,
        source_ref: e.source_ref || null,
        estimated: !!e.estimated,
      };
    });
    const { data, error } = await supabase.from('wrought_events')
      .upsert(eventRows, { onConflict: 'user_id,source,source_ref', ignoreDuplicates: true })
      .select('id');
    if (!error) eventsWritten = data?.length || 0;
  }

  await Promise.all([
    supabase.from('wrought_ingest_keys').update({ last_used_at: new Date().toISOString() }).eq('id', key.id),
    supabase.from('wrought_connections').upsert(
      { user_id: userId, provider: source, mode: 'push', status: 'active', last_sync_at: new Date().toISOString() },
      { onConflict: 'user_id,provider' }),
  ]);

  // Hand the day's verdict back in the response.
  //
  // This is the whole notification story, and it costs nothing. MCP cannot push
  // — the protocol is strictly request/response, so no server can ever make
  // ChatGPT surface anything. But the user's phone is ALREADY calling us every
  // night to deliver health data. So the reply carries the brief, and one extra
  // "Show Notification" action in the Shortcut they have already built puts the
  // verdict on their lock screen. No app, no push certificates, no permissions.
  const { data: brief } = await supabase.from('wrought_briefs')
    .select('verdict, local_date')
    .eq('user_id', userId).eq('local_date', localDateFor(profile.timezone))
    .order('created_at', { ascending: false }).limit(1).maybeSingle();

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      received: incoming.length,
      metrics_written: written,
      sessions_received: incomingEvents.length,
      events_written: eventsWritten,
      duplicates_ignored: rows.length - written,
      // Put this straight into a Show Notification action.
      notification: brief?.verdict || null,
      notification_title: brief?.verdict ? `Wrought — ${brief.local_date}` : null,
      // Naming what was thrown away is the difference between a working
      // Shortcut and an hour of silent confusion.
      skipped_unknown: [...new Set(skipped)].slice(0, 20),
    }),
  };
};
