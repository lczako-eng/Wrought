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
//   1. FORGE native  — {source, metrics: [{metric, value, unit, measured_at}], events: [...]}
//   2. Health Auto Export — {data: {metrics: [{name, units, data: [{date, qty}]}]}}
//
// Writes are idempotent. A watch WILL re-send the same night's sleep four
// times; the unique index plus ignoreDuplicates is what stops that becoming
// four nights of sleep.

import { supabase, hashToken, localDateFor, getProfile } from './lib/forge.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

// Apple, Health Auto Export and every wearable vendor name the same quantity
// differently. One vocabulary, translated at the door, so nothing downstream
// ever has to know that "HKQuantityTypeIdentifierStepCount" means steps.
const METRIC_ALIASES = {
  steps: 'steps',
  step_count: 'steps',
  hkquantitytypeidentifierstepcount: 'steps',

  heart_rate: 'heart_rate',
  hkquantitytypeidentifierheartrate: 'heart_rate',

  resting_heart_rate: 'resting_hr',
  resting_hr: 'resting_hr',
  hkquantitytypeidentifierrestingheartrate: 'resting_hr',

  heart_rate_variability: 'hrv',
  heart_rate_variability_sdnn: 'hrv',
  hrv: 'hrv',
  hkquantitytypeidentifierheartratevariabilitysdnn: 'hrv',

  sleep_analysis: 'sleep_minutes',
  sleep_minutes: 'sleep_minutes',
  asleep: 'sleep_minutes',
  time_asleep: 'sleep_minutes',

  weight_body_mass: 'weight_kg',
  body_mass: 'weight_kg',
  weight: 'weight_kg',
  weight_kg: 'weight_kg',
  hkquantitytypeidentifierbodymass: 'weight_kg',

  body_fat_percentage: 'body_fat_pct',
  body_fat_pct: 'body_fat_pct',

  active_energy: 'active_calories',
  active_energy_burned: 'active_calories',
  active_calories: 'active_calories',
  hkquantitytypeidentifieractiveenergyburned: 'active_calories',

  vo2_max: 'vo2max',
  vo2max: 'vo2max',
  blood_oxygen_saturation: 'spo2',
  oxygen_saturation: 'spo2',
  spo2: 'spo2',
};

export const canonicalMetric = name =>
  METRIC_ALIASES[String(name || '').toLowerCase().replace(/[\s-]+/g, '_')] || null;

// Units arrive in whatever the device felt like. Storage is metric and minutes,
// so conversion happens once, here, and never again.
export function normalise(metric, value, unit) {
  const u = String(unit || '').toLowerCase();
  let v = Number(value);
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
  if (metric === 'active_calories') {
    if (u === 'kj') v = v / 4.184;
    return { value: Math.round(v), unit: 'kcal' };
  }
  return { value: Math.round(v * 100) / 100, unit: unit || '' };
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

  const { data: key } = await supabase.from('forge_ingest_keys')
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

  const rows = [];
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

  let written = 0;
  if (rows.length) {
    // ignoreDuplicates is the whole idempotency story — the unique index on
    // (user_id, source, metric, measured_at) does the deduping in the database
    // rather than in a read-then-write race up here.
    const { data, error } = await supabase.from('forge_metrics')
      .upsert(rows, { onConflict: 'user_id,source,metric,measured_at', ignoreDuplicates: true })
      .select('id');
    if (error) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    }
    written = data?.length || 0;
  }

  // A device can also push discrete events (a logged workout from the watch).
  // Same door, same dedupe, via source_ref this time.
  let eventsWritten = 0;
  if (Array.isArray(body.events) && body.events.length) {
    const eventRows = body.events.slice(0, 200).map(e => {
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
    const { data, error } = await supabase.from('forge_events')
      .upsert(eventRows, { onConflict: 'user_id,source,source_ref', ignoreDuplicates: true })
      .select('id');
    if (!error) eventsWritten = data?.length || 0;
  }

  await Promise.all([
    supabase.from('forge_ingest_keys').update({ last_used_at: new Date().toISOString() }).eq('id', key.id),
    supabase.from('forge_connections').upsert(
      { user_id: userId, provider: source, mode: 'push', status: 'active', last_sync_at: new Date().toISOString() },
      { onConflict: 'user_id,provider' }),
  ]);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      received: incoming.length,
      metrics_written: written,
      events_written: eventsWritten,
      duplicates_ignored: rows.length - written,
      // Naming what was thrown away is the difference between a working
      // Shortcut and an hour of silent confusion.
      skipped_unknown: [...new Set(skipped)].slice(0, 20),
    }),
  };
};
