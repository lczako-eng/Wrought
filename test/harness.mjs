// test/harness.mjs
// Local protocol + arithmetic harness. `npm test`.
//
// Runs with no environment set, which is the point: with no SUPABASE_URL and
// no OPENAI_API_KEY, lib/wrought.js builds no clients, so nothing here touches a
// network or a database. What gets tested is the two halves that break
// silently in production — the JSON-RPC envelope, which fails as an
// uninformative "could not connect" inside ChatGPT, and the arithmetic, which
// fails as a confidently wrong number in somebody's nightly verdict.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { handler, TOOLS, handleRpc, SERVER_INSTRUCTIONS } from '../netlify/functions/mcp.js';
import { canonicalMetric, normalise, normaliseWorkout, looseNumber } from '../netlify/functions/ingest.js';
import { PROVIDERS, LIVE_PROVIDERS, providerSummary, recommendRoute } from '../netlify/functions/lib/providers.js';
import { nutritionTotals, composition, macroMatrix, yearOverYear } from '../netlify/functions/lib/nutrition.js';
import { MOVEMENTS, PROGRAMMES, PATTERNS, movementsFor, pickProgramme, buildProgramme } from '../netlify/functions/lib/library.js';
import {
  exerciseKey, loadStep, progressionCall, TIERS,
  restingBurn, energyBalance, planFromRoutine, sessionTotals, earnedRoom,
  orderPlan, orderInsight, deviceMatrix, weekdayPattern, ACTIVITY, focusCall,
} from '../netlify/functions/lib/training.js';
import {
  localDateFor, addDays, daysBetween, clockString, humanDuration,
  kgToLb, lbToKg, cmToIn, inToCm, sayWeight,
  windowStatus, weightTrend, trainingMatrix, summariseRange, careFlags, scoreGoals,
  eventsFromClient, fastLength, fastingSummary, needsMacros, matchEntries, setupNeeded,
} from '../netlify/functions/lib/wrought.js';

let passed = 0, failed = 0;
const results = [];

async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok   ${name}`); }
  catch (err) { failed++; results.push(`  FAIL ${name}\n         ${err.message}`); }
}

const group = name => results.push(`\n${name}`);
const post = body => handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) });
const rpc  = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

// ── Protocol ────────────────────────────────────────────────────────────────

group('JSON-RPC envelope');

await test('initialize returns serverInfo and the doctrines', async () => {
  const res = await post(rpc('initialize', { protocolVersion: '2025-06-18' }));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.result.serverInfo.name, 'wrought');
  assert.ok(body.result.instructions.length > 2000, 'instructions should carry the doctrines');
  assert.ok(body.result.capabilities.tools);
});

await test('ping answers empty', async () => {
  const body = JSON.parse((await post(rpc('ping'))).body);
  assert.deepEqual(body.result, {});
});

await test('tools/list returns every tool with a usable schema', async () => {
  const body = JSON.parse((await post(rpc('tools/list'))).body);
  const tools = body.result.tools;
  assert.ok(tools.length >= 15, `expected the full toolset, got ${tools.length}`);
  for (const t of tools) {
    assert.ok(t.name, 'tool needs a name');
    assert.ok(t.description?.length > 40, `${t.name} needs a description a model can act on`);
    assert.equal(t.inputSchema.type, 'object', `${t.name} schema must be an object`);
    for (const req of (t.inputSchema.required || [])) {
      assert.ok(t.inputSchema.properties?.[req], `${t.name} requires "${req}" but does not define it`);
    }
  }
});

await test('unknown method is -32601', async () => {
  const body = JSON.parse((await post(rpc('nope/nope'))).body);
  assert.equal(body.error.code, -32601);
});

await test('unknown tool is -32602', async () => {
  const body = JSON.parse((await post(rpc('tools/call', { name: 'not_a_tool', arguments: {} }))).body);
  assert.equal(body.error.code, -32602);
});

await test('anonymous tools/call gets the 401 challenge that triggers sign-in', async () => {
  const res = await post(rpc('tools/call', { name: 'brief', arguments: {} }));
  assert.equal(res.statusCode, 401);
  assert.match(res.headers['WWW-Authenticate'], /resource_metadata=/,
    'without this header no MCP client knows where to send the user to sign in');
});

await test('notifications are accepted with no body', async () => {
  const res = await handler({ httpMethod: 'POST', headers: {},
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(res.statusCode, 202);
});

await test('malformed JSON is a parse error, not a crash', async () => {
  const res = await handler({ httpMethod: 'POST', headers: {}, body: '{oh no' });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error.code, -32700);
});

await test('GET is refused — this server is stateless', async () => {
  assert.equal((await handler({ httpMethod: 'GET', headers: {} })).statusCode, 405);
});

await test('CORS preflight passes', async () => {
  const res = await handler({ httpMethod: 'OPTIONS', headers: {} });
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
});

await test('every advertised tool has an implementation behind it', async () => {
  // A tool that lists but does not dispatch is the worst failure mode there is:
  // the model confidently calls it and the user gets an error they cannot parse.
  for (const t of TOOLS) {
    const body = await handleRpc(rpc('tools/call', { name: t.name, arguments: {} }), null);
    assert.ok(body.__unauthorized, `${t.name} listed but does not dispatch`);
  }
});

// ── Time ────────────────────────────────────────────────────────────────────

group('Days, in the user\'s own timezone');

await test('a day is the day where the user is standing', () => {
  // 03:30 UTC on the 9th is still the 8th in Toronto. Grouping on UTC would
  // file a late-night snack under tomorrow and quietly corrupt every brief.
  const t = new Date('2026-08-09T03:30:00Z');
  assert.equal(localDateFor('America/Toronto', t), '2026-08-08');
  assert.equal(localDateFor('UTC', t), '2026-08-09');
  assert.equal(localDateFor('Australia/Sydney', t), '2026-08-09');
});

await test('a bad timezone falls back to UTC instead of throwing', () => {
  assert.equal(localDateFor('Not/AZone', new Date('2026-08-09T03:30:00Z')), '2026-08-09');
});

await test('date arithmetic crosses month and year boundaries', () => {
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(daysBetween('2026-08-01', '2026-08-31'), 30);
});

await test('clock and duration formatting', () => {
  assert.equal(clockString(9 * 60 + 5), '09:05');
  assert.equal(clockString(23 * 60 + 59), '23:59');
  assert.equal(humanDuration(402), '6h 42m');
  assert.equal(humanDuration(45), '45m');
});

// ── Units ───────────────────────────────────────────────────────────────────

group('Units');

await test('weight converts and comes back', () => {
  assert.equal(kgToLb(82.6), 182.1);
  assert.ok(Math.abs(lbToKg(182) - 82.55) < 0.02);
  assert.ok(Math.abs(kgToLb(lbToKg(180)) - 180) < 0.1);
});

await test('lengths convert', () => {
  assert.equal(cmToIn(86.4), 34);
  assert.equal(inToCm(34), 86.4);
});

await test('weight is spoken in the user\'s own units', () => {
  assert.equal(sayWeight(82.6, 'metric'), '82.6 kg');
  assert.equal(sayWeight(82.6, 'imperial'), '182.1 lb');
  assert.equal(sayWeight(null, 'metric'), null);
});

// ── The eating window ───────────────────────────────────────────────────────

group('Eating window');

const win = (o, c, extra = {}) => ({ opens_at: o, closes_at: c, active: true, strictness: 'soft', ...extra });

await test('open window counts down to close', () => {
  const s = windowStatus(win('11:00', '19:00'), 'UTC', new Date('2026-08-08T14:30:00Z'));
  assert.equal(s.open, true);
  assert.equal(s.minutes_left, 270);
  assert.match(s.say, /until 19:00/);
});

await test('shut window counts up to open', () => {
  const s = windowStatus(win('11:00', '19:00'), 'UTC', new Date('2026-08-08T22:10:00Z'));
  assert.equal(s.open, false);
  assert.equal(s.minutes_until_open, 12 * 60 + 50);   // to 11:00 tomorrow
});

await test('a window that crosses midnight still works', () => {
  // Night-shift workers exist, and an off-by-one here tells someone their
  // window is shut while they are in the middle of it.
  const w = win('18:00', '02:00');
  assert.equal(windowStatus(w, 'UTC', new Date('2026-08-08T23:00:00Z')).open, true);
  assert.equal(windowStatus(w, 'UTC', new Date('2026-08-09T01:00:00Z')).open, true);
  assert.equal(windowStatus(w, 'UTC', new Date('2026-08-09T03:00:00Z')).open, false);
});

await test('no window set means no window status', () => {
  assert.equal(windowStatus(null, 'UTC'), null);
  assert.equal(windowStatus(win('11:00', '19:00', { active: false }), 'UTC'), null);
});

// ── Trends ──────────────────────────────────────────────────────────────────

group('Trends and the matrix');

const mkDays = (n, fn) => Array.from({ length: n }, (_, i) => ({
  date: addDays('2026-07-01', i), logged: true,
  calories: null, protein_g: null, carbs_g: null, fat_g: null, meals: 0,
  sessions: 0, minutes: 0, volume_kg: null, weight_kg: null, steps: null,
  sleep_minutes: null, muscles: [], ...fn(i),
}));

await test('one weigh-in is not a trend', () => {
  const t = weightTrend(mkDays(7, i => ({ weight_kg: i === 0 ? 83 : null })), 'metric');
  assert.equal(t.direction, 'unknown');
  assert.match(t.say, /not enough/);
});

await test('a real loss reads as a per-week rate, not a daily jitter', () => {
  const days = mkDays(28, i => ({ weight_kg: 84 - i * 0.06 }));
  const t = weightTrend(days, 'metric');
  assert.equal(t.direction, 'down');
  assert.ok(t.per_week_kg < -0.3 && t.per_week_kg > -0.6, `got ${t.per_week_kg}`);
});

await test('noise around a stable weight reads as flat', () => {
  const days = mkDays(28, i => ({ weight_kg: 82 + (i % 2 ? 0.7 : -0.7) }));
  assert.equal(weightTrend(days, 'metric').direction, 'flat');
});

await test('the matrix names what has not been trained', () => {
  const days = mkDays(28, i => (i % 3 === 0
    ? { sessions: 1, muscles: i < 14 ? ['legs', 'chest'] : ['chest', 'back'] }
    : {}));
  const m = trainingMatrix(days);
  assert.ok(m.muscles.includes('legs'));
  assert.ok(m.neglected.includes('legs'), 'legs went untouched in the last two weeks and should be flagged');
  assert.ok(!m.neglected.includes('chest'));
});

await test('adherence and streaks count correctly', () => {
  const days = mkDays(10, i => ({ logged: i >= 3 }));
  const s = summariseRange({ days }, { units: 'metric' });
  assert.equal(s.days_logged, 7);
  assert.equal(s.adherence_pct, 70);
  assert.equal(s.current_streak, 7);
});

await test('a broken streak resets but the best is remembered', () => {
  const days = mkDays(10, i => ({ logged: i !== 5 }));
  const s = summariseRange({ days }, { units: 'metric' });
  assert.equal(s.longest_streak, 5);
  assert.equal(s.current_streak, 4);
});

// ── Care flags ──────────────────────────────────────────────────────────────

group('Care flags — the part that must never silently stop working');

await test('sustained very low intake raises a flag', () => {
  const days = mkDays(7, () => ({ calories: 900 }));
  const flags = careFlags({ days }, { units: 'metric' });
  const f = flags.find(x => x.flag === 'very_low_intake');
  assert.ok(f, 'three or more days under 1200 kcal must flag');
  assert.match(f.guidance, /Do not suggest a further deficit/);
});

await test('normal intake raises nothing', () => {
  const days = mkDays(7, () => ({ calories: 2200 }));
  assert.equal(careFlags({ days }, { units: 'metric' }).length, 0);
});

await test('dangerously fast weight loss raises a flag', () => {
  const days = mkDays(14, i => ({ weight_kg: 90 - i * 0.25, calories: 2000 }));
  const flags = careFlags({ days }, { units: 'metric' });
  assert.ok(flags.find(x => x.flag === 'rapid_loss'), 'losing >1.2kg/week must flag');
});

await test('training every single day raises a rest flag', () => {
  const days = mkDays(14, () => ({ sessions: 1, minutes: 60 }));
  assert.ok(careFlags({ days }, { units: 'metric' }).find(x => x.flag === 'no_rest'));
});

// ── Goals ───────────────────────────────────────────────────────────────────

group('Goal scoring');

const day = { food: { protein_g: 152, calories: 2100 }, device: { steps: 9000 }, body: { weight_kg: 82 } };

await test('an at_least goal scores hit and miss', () => {
  const [hit] = scoreGoals([{ goal: '150g protein', metric: 'protein_g', target_value: 150,
    direction: 'at_least', cadence: 'daily', target_unit: 'g' }], day, {}, {});
  assert.equal(hit.hit, true);

  const [miss] = scoreGoals([{ goal: '180g protein', metric: 'protein_g', target_value: 180,
    direction: 'at_least', cadence: 'daily', target_unit: 'g' }], day, {}, {});
  assert.equal(miss.hit, false);
  assert.match(miss.say, /missed by 28/);
});

await test('an at_most goal inverts correctly', () => {
  const [g] = scoreGoals([{ goal: 'under 2000 kcal', metric: 'calories', target_value: 2000,
    direction: 'at_most', cadence: 'daily' }], day, {}, {});
  assert.equal(g.hit, false);
});

await test('a goal with nothing logged says so instead of scoring zero', () => {
  const [g] = scoreGoals([{ goal: 'sleep 8h', metric: 'sleep_minutes', target_value: 480,
    direction: 'at_least', cadence: 'daily' }], { food: {}, device: {} }, {}, {});
  assert.equal(g.scored, false);
});

// ── Device ingest ───────────────────────────────────────────────────────────

group('Wearable ingest');

await test('every vendor\'s name for the same thing lands on one metric', () => {
  for (const alias of ['steps', 'Step Count', 'HKQuantityTypeIdentifierStepCount', 'step_count']) {
    assert.equal(canonicalMetric(alias), 'steps', `${alias} should map to steps`);
  }
  assert.equal(canonicalMetric('Resting Heart Rate'), 'resting_hr');
  assert.equal(canonicalMetric('body_mass'), 'weight_kg');
  assert.equal(canonicalMetric('Active Energy'), 'active_calories');
});

await test('an unrecognised metric is rejected rather than guessed at', () => {
  assert.equal(canonicalMetric('mood_ring_colour'), null);
  assert.equal(canonicalMetric(''), null);
});

await test('units normalise to metric and minutes on arrival', () => {
  assert.equal(normalise('weight_kg', 182, 'lb').value, 82.55);
  assert.equal(normalise('weight_kg', 82.6, 'kg').value, 82.6);
  assert.equal(normalise('sleep_minutes', 6.7, 'hours').value, 402);
  assert.equal(normalise('active_calories', 2000, 'kJ').value, 478);
});

await test('blood and lab markers come in through the same door', () => {
  // A hub holding every step you took and nothing about your blood is a
  // pedometer with ambitions.
  assert.equal(canonicalMetric('Blood Glucose'), 'glucose');
  assert.equal(canonicalMetric('HKQuantityTypeIdentifierBloodPressureSystolic'), 'systolic');
  assert.equal(canonicalMetric('HbA1c'), 'hba1c');
  assert.equal(canonicalMetric('ferritin'), 'ferritin');
  assert.equal(canonicalMetric('LDL cholesterol'), 'ldl');
});

await test('glucose converts mg/dL to mmol/L — the one that must not be wrong', () => {
  // Roughly 18x apart, so a mix-up turns a normal 5.5 into 99, or a 99 into
  // 1783. One looks like a medical emergency, the other like a dead sensor.
  assert.equal(normalise('glucose', 99, 'mg/dL').value, 5.5);
  assert.equal(normalise('glucose', 5.5, 'mmol/L').value, 5.5);
});

await test('body temperature converts from Fahrenheit', () => {
  assert.equal(normalise('body_temp', 98.6, 'F').value, 37);
  assert.equal(normalise('body_temp', 37, 'C').value, 37);
});

await test('a non-numeric sample is dropped, not stored as NaN', () => {
  assert.equal(normalise('steps', 'lots', 'count'), null);
});

await test('Health Connect and Samsung naming lands on the same metrics as Apple', () => {
  // Adding a device is meant to be a few lines in the alias map rather than a
  // new service. That only holds if the map actually covers each platform's
  // spelling of the same quantity.
  assert.equal(canonicalMetric('StepsRecord'), 'steps');                    // Health Connect
  assert.equal(canonicalMetric('com_samsung_health_step_count'), 'steps');  // Samsung
  assert.equal(canonicalMetric('SleepSessionRecord'), 'sleep_minutes');
  assert.equal(canonicalMetric('HeartRateVariabilityRmssdRecord'), 'hrv');
  assert.equal(canonicalMetric('WeightRecord'), 'weight_kg');
  assert.equal(canonicalMetric('ActiveCaloriesBurnedRecord'), 'active_calories');
});

await test('distance normalises from every unit a vendor might send', () => {
  // Strava sends metres, Health Connect sends metres, Apple sends miles or km
  // depending on region. The mile/km mix-up is the quiet one — it would make
  // everybody silently 60% faster rather than failing visibly.
  assert.equal(normalise('distance_km', 5000, 'm').value, 5);
  assert.equal(normalise('distance_km', 5, 'km').value, 5);
  assert.equal(normalise('distance_km', 3.10686, 'mi').value, 5);
});

await test('moving time normalises to minutes whatever the unit', () => {
  assert.equal(normalise('active_minutes', 1800, 's').value, 30);
  assert.equal(normalise('active_minutes', 1.5, 'hours').value, 90);
  assert.equal(normalise('active_minutes', 45, 'min').value, 45);
});

group('Sessions from running and cycling apps');

await test('a Nike Run Club run becomes a logged workout', () => {
  const w = normaliseWorkout({ kind: 'Run', minutes: 32, distance_km: 5.4, occurred_at: '2026-08-08T18:00:00Z' });
  assert.equal(w.event_type, 'workout');
  assert.equal(w.detail.kind, 'cardio');
  assert.equal(w.detail.distance_km, 5.4);
  assert.match(w.summary, /5.4 km/);
});

await test('cardio counts as full body so a runner\'s matrix is not empty', () => {
  // Without this a runner logs six sessions a week and the brief tells them
  // they have not trained — wrong, and insulting.
  assert.deepEqual(normaliseWorkout({ kind: 'Run', minutes: 30 }).detail.muscles, ['full body']);
  assert.deepEqual(normaliseWorkout({ kind: 'Outdoor Cycle', minutes: 60 }).detail.muscles, ['full body']);
});

await test('a strength session keeps its own muscle groups', () => {
  const w = normaliseWorkout({ kind: 'Strength training', minutes: 45, muscles: ['chest', 'arms'] });
  assert.equal(w.detail.kind, 'strength');
  assert.deepEqual(w.detail.muscles, ['chest', 'arms']);
});

await test('Strava seconds and metres convert on the way in', () => {
  const w = normaliseWorkout({ type: 'Ride', duration_s: 3600, distance_m: 32000 });
  assert.equal(w.detail.minutes, 60);
  assert.equal(w.detail.distance_km, 32);
});

await test('a session with neither duration nor distance is dropped', () => {
  assert.equal(normaliseWorkout({ kind: 'Run' }), null);
});

group('Provider registry — the one-door thesis');

await test('both aggregator doors are live', () => {
  // These two are the whole one-door thesis. If either ever stops being live,
  // the setup story collapses into fifteen integrations again.
  assert.ok(LIVE_PROVIDERS.includes('apple_health'));
  assert.ok(LIVE_PROVIDERS.includes('health_connect'));
});

await test('anything live either IS a door or needs no third party at all', () => {
  // Bloodwork is live without being an aggregator: there is nobody to
  // integrate with, you just send the numbers off the sheet. Anything else
  // claiming live status would be overstating what actually works today.
  const doors = ['apple_health', 'health_connect'];
  for (const key of LIVE_PROVIDERS) {
    if (doors.includes(key)) continue;
    assert.ok(!PROVIDERS[key].aggregated_via,
      `${key} claims to work today but routes through another provider — that is not live`);
  }
});

await test('every provider is honest about its status and route', () => {
  for (const [key, p] of Object.entries(PROVIDERS)) {
    assert.ok(['live', 'aggregated', 'planned'].includes(p.status), `${key} has a bogus status`);
    assert.ok(providerSummary(key).say.length > 30, `${key} needs a plain-English explanation`);
    if (p.status !== 'live') {
      assert.ok(PROVIDERS[p.aggregated_via],
        `${key} is not connectable directly, so it must name a door that works today`);
    }
  }
});

await test('the apps with no public API route through the phone', () => {
  // Nike closed its API in 2018 and Samsung's is partner-gated. There is no
  // direct route for anybody, so the registry must not pretend one is coming.
  assert.equal(PROVIDERS.nike_run_club.status, 'aggregated');
  assert.equal(PROVIDERS.nike_run_club.aggregated_via, 'apple_health');
  assert.equal(PROVIDERS.samsung_health.aggregated_via, 'health_connect');
});

await test('the recommended door follows the phone, not the wearable', () => {
  assert.equal(recommendRoute(['Apple Watch', 'Oura ring']).door, 'apple_health');
  assert.equal(recommendRoute(['Samsung Galaxy Watch']).door, 'health_connect');
  assert.equal(recommendRoute([]).door, 'apple_health');
});

await test('an unknown provider returns nothing rather than inventing a story', () => {
  assert.equal(providerSummary('mood_ring'), null);
});

group('Matching an exercise across time');

await test('the same lift under different names collapses to one key', () => {
  // If these do not match, last week's number is invisible, progression
  // silently stops, and nobody notices for a month because the app still
  // looks like it is working.
  for (const n of ['Bench', 'bench press', 'Barbell Bench Press', 'Incline DB bench press', 'benching']) {
    assert.equal(exerciseKey(n), 'bench press', `"${n}" should key to bench press`);
  }
  assert.equal(exerciseKey('Back Squat'), 'squat');
  assert.equal(exerciseKey('Smith machine squat'), 'squat');
  assert.equal(exerciseKey('RDL'), 'romanian deadlift');
  assert.equal(exerciseKey('Seated cable row'), 'row');
});

await test('genuinely different lifts stay different', () => {
  assert.notEqual(exerciseKey('squat'), exerciseKey('deadlift'));
  assert.notEqual(exerciseKey('curl'), exerciseKey('row'));
});

await test('lower body takes bigger jumps than upper', () => {
  assert.ok(loadStep('squat', 'intermediate') > loadStep('bench press', 'intermediate'),
    '2.5kg on a bench is a real step; on a squat it is rounding error');
  assert.ok(loadStep('squat', 'advanced') < loadStep('squat', 'beginner'),
    'a beginner adds weight faster than someone near their ceiling');
});

group('Progression — the rule that must never guess');

await test('hit the reps with something left → add load', () => {
  const c = progressionCall({ last: { top_weight_kg: 80, top_reps: 8, rpe: 7, date: '2026-08-01' },
    targetReps: 8, tier: 'intermediate', key: 'bench press' });
  assert.equal(c.verdict, 'add_load');
  assert.equal(c.weight_kg, 82.5);
});

await test('hit the reps but nearly failed → hold, do not add', () => {
  const c = progressionCall({ last: { top_weight_kg: 80, top_reps: 8, rpe: 9.5, date: '2026-08-01' },
    targetReps: 8, tier: 'intermediate', key: 'bench press' });
  assert.equal(c.verdict, 'hold');
  assert.equal(c.weight_kg, 80, 'adding load to a grinder is how people get hurt');
});

await test('just short → repeat the same weight', () => {
  const c = progressionCall({ last: { top_weight_kg: 100, top_reps: 6, rpe: 9, date: '2026-08-01' },
    targetReps: 8, tier: 'intermediate', key: 'squat' });
  assert.equal(c.verdict, 'repeat');
  assert.equal(c.weight_kg, 100);
});

await test('badly short → deload 10%', () => {
  const c = progressionCall({ last: { top_weight_kg: 100, top_reps: 4, rpe: 10, date: '2026-08-01' },
    targetReps: 8, tier: 'intermediate', key: 'squat' });
  assert.equal(c.verdict, 'deload');
  assert.equal(c.weight_kg, 90);
});

await test('no history → prescribe effort, never invent a number', () => {
  // Guessing a stranger's working weight is the fastest way this product
  // injures somebody. It must decline, every time.
  for (const tier of ['beginner', 'intermediate', 'advanced']) {
    const c = progressionCall({ last: null, targetReps: 8, tier, key: 'squat' });
    assert.equal(c.verdict, 'find_working_weight');
    assert.equal(c.weight_kg, null, `${tier}: must not invent a load`);
  }
});

await test('every tier carries coaching doctrine, not just numbers', () => {
  for (const t of ['beginner', 'intermediate', 'advanced']) {
    assert.ok(TIERS[t].doctrine.length > 80, `${t} needs real guidance on how to talk, not just volume`);
  }
  assert.match(TIERS.beginner.doctrine, /explain/i);
});

group('Calories in versus calories out');

const lifter = { height_cm: 180, birth_year: 1990, sex: 'male' };

await test('resting burn follows Mifflin-St Jeor', () => {
  // 10(82) + 6.25(180) - 5(36) + 5 = 1770
  assert.equal(restingBurn(lifter, 82).kcal, 1770);
});

await test('missing facts are named, never guessed around', () => {
  const r = restingBurn({ height_cm: null, birth_year: 1990 }, 82);
  assert.equal(r.kcal, null);
  assert.ok(r.missing.includes('height'));
});

await test('unstated sex uses a midpoint and says so', () => {
  const r = restingBurn({ height_cm: 180, birth_year: 1990 }, 82);
  assert.ok(r.kcal > 0);
  assert.equal(r.approximate, true, 'silently assuming a sex is worse than flagging the estimate');
});

await test('a deficit reads as a deficit, with the week projected', () => {
  const b = energyBalance({ profile: lifter, weightKg: 82, caloriesIn: 2000, activeCalories: 600 });
  assert.equal(b.known, true);
  assert.equal(b.calories_out, 2370);
  assert.equal(b.net, -370);
  assert.equal(b.direction, 'deficit');
  assert.ok(b.projected_kg_per_week < 0);
});

await test('level days are called level, not spun', () => {
  const b = energyBalance({ profile: lifter, weightKg: 82, caloriesIn: 2400, activeCalories: 600 });
  assert.equal(b.direction, 'maintenance');
});

await test('the balance always admits it is an estimate', () => {
  const b = energyBalance({ profile: lifter, weightKg: 82, caloriesIn: 2000, activeCalories: 500 });
  assert.equal(b.approximate, true);
  assert.match(b.caveat, /estimate/i);
  assert.match(b.say, /[Rr]oughly|about/);
});

await test('without the basics it says what it needs instead of inventing one', () => {
  const b = energyBalance({ profile: { height_cm: null }, weightKg: null, caloriesIn: 2000 });
  assert.equal(b.known, false);
  assert.ok(b.missing.length);
});

group('Nutrition — the big picture, honestly counted');

const meal = (date, detail, estimated = true) =>
  ({ event_type: 'food', local_date: date, detail, estimated });

const week1 = ['2026-08-03','2026-08-04','2026-08-05','2026-08-06','2026-08-07'];
const feed = week1.flatMap(d => [
  meal(d, { calories: 700, protein_g: 45, carbs_g: 70, sugar_g: 12, fibre_g: 8, fat_g: 22, categories: ['meat','grain','vegetable'] }),
  meal(d, { calories: 600, protein_g: 40, carbs_g: 55, sugar_g: 30, fibre_g: 4, fat_g: 20, categories: ['dairy','sweets'] }),
]);

await test('totals roll up at every altitude', () => {
  const t = nutritionTotals(feed, { today: '2026-08-07' });
  assert.equal(t.today.meals, 2);
  assert.equal(t.today.calories, 1300);
  assert.equal(t.this_week.meals, 10);
  assert.equal(t.this_week.days_logged, 5);
  assert.equal(t.this_week.calories_per_day, 1300, 'per-day must divide by days logged, not days elapsed');
});

await test('estimates stay flagged all the way up', () => {
  const t = nutritionTotals(feed, { today: '2026-08-07' });
  assert.equal(t.this_year.estimated, true);
  assert.match(t.note, /estimated/i);
});

await test('composition is counted in meals, never grams', () => {
  const c = composition(feed);
  const meatRow = c.rows.find(r => r.category === 'meat');
  assert.equal(meatRow.meals, 5);
  assert.equal(meatRow.share_pct, 50, 'meat was in half the logged meals');
  assert.match(c.note, /not weights/i);
  assert.doesNotMatch(JSON.stringify(c), /\bkg\b|grams/i, 'never imply a weight of food eaten');
});

await test('a category never eaten simply is not listed', () => {
  const c = composition(feed);
  assert.equal(c.rows.find(r => r.category === 'alcohol'), undefined);
});

await test('sugar is tracked as its own row and shaded as lower-is-better', () => {
  const g = macroMatrix(feed, { weeks: 12, today: '2026-08-07' });
  const sugar = g.rows.find(r => r.key === 'sugar_g');
  assert.ok(sugar, 'sugar must have its own row — it is the one people stare at');
  assert.equal(sugar.better, 'low');
  const cals = g.rows.find(r => r.key === 'calories');
  assert.equal(cals.better, 'mid', 'calories are not good or bad in themselves and must not be moralised');
});

await test('year over year stays quiet until a second year exists', () => {
  const y = yearOverYear(feed, { today: '2026-08-07' });
  assert.equal(y.comparison, null);
  assert.match(y.note, /second year/i);
});

await test('year over year compares once both years are properly logged', () => {
  const many = (year, cals) => Array.from({ length: 40 }, (_, i) =>
    meal(`${year}-0${1 + Math.floor(i / 20)}-${String((i % 20) + 1).padStart(2, '0')}`,
      { calories: cals, protein_g: 140, carbs_g: 200, sugar_g: 40, fibre_g: 20, fat_g: 70, categories: ['grain'] }));
  const y = yearOverYear([...many(2025, 2400), ...many(2026, 2100)], { today: '2026-08-07' });
  assert.ok(y.comparison, 'two properly logged years must produce a comparison');
  assert.equal(y.comparison.calories_per_day_change, -300);
  assert.match(y.comparison.say, /below last year/);
});

await test('an empty log says nothing rather than reporting zeroes', () => {
  const c = composition([]);
  assert.equal(c.meals, 0);
  assert.equal(c.rows.length, 0);
});

group('Device matrices — two scales, because there are two meanings');

const devDays = (n, fn) => Array.from({ length: n }, (_, i) => ({
  date: addDays('2026-07-01', i), logged: true, sessions: 0, muscles: [],
  sleep_minutes: null, steps: null, resting_hr: null, hrv: null,
  calories: null, volume_kg: null, active_calories: null, ...fn(i),
}));

await test('recovery metrics are cool, effort metrics are hot', () => {
  // Using one scale for both would be a lie — a red-hot resting heart rate row
  // would read as a good week when it means the opposite.
  const m = deviceMatrix(devDays(14, i => ({
    sleep_minutes: 400 + i * 5, resting_hr: 60 - i, steps: 6000 + i * 300,
  })));
  assert.equal(m.rows.find(r => r.metric === 'sleep_minutes').scale, 'recovery');
  assert.equal(m.rows.find(r => r.metric === 'resting_hr').scale, 'recovery');
  assert.equal(m.rows.find(r => r.metric === 'steps').scale, 'effort');
});

await test('resting heart rate is inverted, because lower is better', () => {
  const m = deviceMatrix(devDays(10, i => ({ resting_hr: 70 - i * 2 })));
  const row = m.rows.find(r => r.metric === 'resting_hr');
  assert.equal(row.better, 'low');
  assert.equal(row.cells[0].band, 0, 'the highest resting HR must read as the worst');
  assert.equal(row.cells[9].band, 4, 'the lowest resting HR must read as the best');
});

await test('more sleep reads as better recovered', () => {
  const m = deviceMatrix(devDays(10, i => ({ sleep_minutes: 300 + i * 20 })));
  const row = m.rows.find(r => r.metric === 'sleep_minutes');
  assert.equal(row.cells[0].band, 0);
  assert.equal(row.cells[9].band, 4);
});

await test('bands are against the person\'s own range, not a population', () => {
  // Somebody who sleeps 7-8h and somebody who sleeps 5-6h should both see
  // their own best nights at the top of their own scale.
  const a = deviceMatrix(devDays(10, i => ({ sleep_minutes: 420 + i * 6 })));
  const b = deviceMatrix(devDays(10, i => ({ sleep_minutes: 300 + i * 6 })));
  const top = m => m.rows.find(r => r.metric === 'sleep_minutes').cells[9].band;
  assert.equal(top(a), 4);
  assert.equal(top(b), 4);
});

await test('a flat metric shows no invented contrast', () => {
  const m = deviceMatrix(devDays(10, () => ({ hrv: 55 })));
  const row = m.rows.find(r => r.metric === 'hrv');
  assert.ok(row.cells.every(c => c.band === 2), 'a flat line must not be dramatised into a gradient');
});

await test('missing days stay missing rather than becoming zero', () => {
  const m = deviceMatrix(devDays(10, i => ({ steps: i % 2 ? 8000 + i * 100 : null })));
  const row = m.rows.find(r => r.metric === 'steps');
  assert.equal(row.cells[0].band, null);
  assert.ok(row.coverage < 100);
});

await test('a metric with almost no data is left out entirely', () => {
  const m = deviceMatrix(devDays(10, i => ({ hrv: i === 0 ? 50 : null })));
  assert.equal(m.rows.find(r => r.metric === 'hrv'), undefined);
});

group('The shape of a week');

await test('the worst night of the week gets named', () => {
  // Averages hide the shape of a life. "You sleep 6h48m" is useless.
  const m = weekdayPattern(devDays(28, i => {
    const dow = (new Date(addDays('2026-07-01', i) + 'T00:00:00Z').getUTCDay() + 6) % 7;
    return { sleep_minutes: dow === 6 ? 320 : 430 };   // Sunday is the bad one
  }));
  assert.equal(m.enough, true);
  const sleep = m.findings.find(f => f.kind === 'sleep');
  assert.ok(sleep, 'a 110-minute gap between best and worst night must surface');
  assert.match(sleep.say, /Sun/);
});

await test('days never trained are named', () => {
  const m = weekdayPattern(devDays(28, i => {
    const dow = (new Date(addDays('2026-07-01', i) + 'T00:00:00Z').getUTCDay() + 6) % 7;
    return { sessions: dow === 4 ? 0 : 1 };            // never Friday
  }));
  assert.ok(m.findings.find(f => f.kind === 'training')?.say.includes('Fri'));
});

await test('it stays quiet until there are enough weeks to mean it', () => {
  const m = weekdayPattern(devDays(7, () => ({ sleep_minutes: 400 })));
  assert.equal(m.enough, false);
  assert.equal(m.findings.length, 0);
  assert.match(m.say, /few more weeks/);
});

await test('an even week is reported as even, not forced into a finding', () => {
  const m = weekdayPattern(devDays(28, () => ({ sleep_minutes: 420, sessions: 1, calories: 2200 })));
  assert.equal(m.enough, true);
  assert.equal(m.findings.length, 0);
});

group('Exercise order — the question only stored positions can answer');

const setAt = (exercise, position, weight_kg, session_id) =>
  ({ exercise, exercise_key: exerciseKey(exercise), position, weight_kg, session_id, local_date: '2026-08-01' });

await test('a lift that suffers when it goes late gets named, with the cost', () => {
  const sets = [
    setAt('Bench Press', 1, 100, 's1'), setAt('Bench Press', 1, 102, 's2'),
    setAt('Bench Press', 4, 92,  's3'), setAt('Bench Press', 4, 90,  's4'),
  ];
  const o = orderInsight(sets);
  assert.equal(o.findings.length, 1);
  assert.equal(o.findings[0].exercise, 'Bench Press');
  assert.ok(o.findings[0].cost_kg > 8, `expected a real cost, got ${o.findings[0].cost_kg}`);
  assert.match(o.say, /move it up/);
});

await test('a difference inside daily noise is not reported', () => {
  // Under 3% is sleep, salt and the day itself. Claiming it is a finding
  // sends somebody rebuilding a programme around nothing.
  const sets = [
    setAt('Squat', 1, 100, 's1'), setAt('Squat', 1, 100, 's2'),
    setAt('Squat', 4, 98,  's3'), setAt('Squat', 4, 99,  's4'),
  ];
  assert.equal(orderInsight(sets).findings.length, 0);
});

await test('one session at a position proves nothing and says nothing', () => {
  const sets = [setAt('Squat', 1, 120, 's1'), setAt('Squat', 4, 90, 's2')];
  assert.equal(orderInsight(sets).findings.length, 0);
  assert.match(orderInsight(sets).say, /[Nn]ot enough/);
});

await test('only the top set of each session counts as that day\'s strength', () => {
  const sets = [
    setAt('Squat', 1, 100, 's1'), setAt('Squat', 1, 60, 's1'),   // warm-up must not drag it down
    setAt('Squat', 1, 100, 's2'), setAt('Squat', 1, 60, 's2'),
    setAt('Squat', 4, 85,  's3'), setAt('Squat', 4, 85, 's4'),
  ];
  const o = orderInsight(sets);
  assert.equal(o.findings[0].early_avg_kg, 100, 'warm-up sets must not pull the average down');
});

await test('bodyweight work is skipped rather than counted as zero', () => {
  const sets = [
    setAt('Pull-up', 1, null, 's1'), setAt('Pull-up', 1, null, 's2'),
    setAt('Pull-up', 4, null, 's3'), setAt('Pull-up', 4, null, 's4'),
  ];
  assert.equal(orderInsight(sets).findings.length, 0);
});

await test('compounds are ordered before isolation', () => {
  const ordered = orderPlan([
    { name: 'Bicep Curl', key: 'curl' },
    { name: 'Back Squat', key: 'squat' },
    { name: 'Lateral Raise', key: 'raise' },
    { name: 'Bench Press', key: 'bench press' },
  ]);
  assert.equal(ordered[0].name, 'Back Squat');
  assert.equal(ordered[1].name, 'Bench Press');
  assert.ok(['Bicep Curl', 'Lateral Raise'].includes(ordered[3].name));
  assert.deepEqual(ordered.map(e => e.index), [0, 1, 2, 3], 'indexes must be renumbered after sorting');
});

await test('deliberate order within the compounds survives', () => {
  // Stable sort: someone who put deadlift before squat meant it.
  const ordered = orderPlan([
    { name: 'Deadlift', key: 'deadlift' },
    { name: 'Back Squat', key: 'squat' },
  ]);
  assert.equal(ordered[0].name, 'Deadlift');
});

group('Earned room — the reward that must never invert');

const week = (cals) => cals.map((c, i) => ({
  date: addDays('2026-08-01', i), logged: true, calories: c, sessions: 0, minutes: 0,
  weight_kg: null, steps: null, sleep_minutes: null, muscles: [], protein_g: null,
}));

await test('a genuinely under week hands back a number and says spend it', () => {
  const r = earnedRoom({ days: week([1800, 1750, 1900, 1850, 1800, 1900, 1750]), dailyTarget: 2200 });
  assert.equal(r.available, true);
  assert.ok(r.room_kcal > 2000, `expected real room, got ${r.room_kcal}`);
  assert.match(r.say, /earned it/);
});

await test('being over is stated once and never turned into a punishment', () => {
  // The moment "earned" has an opposite it is a punishment schedule, and that
  // is precisely what turns a food log into a disorder.
  const r = earnedRoom({ days: week([2800, 2900, 3100, 2700, 2850, 3000, 2900]), dailyTarget: 2200 });
  assert.equal(r.available, false);
  assert.ok(r.over_by > 0);
  assert.doesNotMatch(r.say, /eat less|cut back|make up|skip|deficit|tomorrow/i,
    'reporting an overshoot must not carry an instruction');
  assert.match(r.guidance, /Do NOT prescribe eating less/);
});

await test('a care flag switches the whole frame off', () => {
  // Dangling food as a reward for having eaten little is textbook, and someone
  // in that pattern is the last person who should be handed a scoreboard.
  const r = earnedRoom({
    days: week([900, 850, 950, 900, 880, 920, 870]),
    dailyTarget: 2200,
    flags: [{ flag: 'very_low_intake', detail: 'x', guidance: 'y' }],
  });
  assert.equal(r.available, false);
  assert.equal(r.blocked, 'care');
  // What actually matters is that nothing readable aloud carries a scoreboard
  // or makes permission conditional. A number here would tell someone already
  // under-eating exactly how much further under they are.
  assert.doesNotMatch(r.say, /\d/, 'no calorie figure may be quoted in this state');
  assert.doesNotMatch(r.say, /\bearn(ed|s)? it\b|deserve|balance (it )?out|make up for/i,
    'permission must not be conditional');
  assert.match(r.say, /^Yes/, 'the answer is permission, granted first and without preamble');
  assert.match(r.guidance, /reward/i, 'the model must be told not to use the reward frame');
});

await test('rapid loss blocks it too, not just low intake', () => {
  const r = earnedRoom({ days: week([1900,1900,1900,1900,1900,1900,1900]), dailyTarget: 2200,
    flags: [{ flag: 'rapid_loss', detail: 'x', guidance: 'y' }] });
  assert.equal(r.blocked, 'care');
});

await test('too little data says so instead of inventing a reward', () => {
  const days = week([2000, 2100]).concat(
    [3,4,5,6,7].map(i => ({ date: addDays('2026-08-01', i), logged: false, calories: null, sessions: 0, minutes: 0, muscles: [] })));
  const r = earnedRoom({ days, dailyTarget: 2200 });
  assert.equal(r.available, false);
  assert.equal(r.blocked, 'not_enough_data');
});

await test('no target means no claim about room', () => {
  const r = earnedRoom({ days: week([1800,1800,1800,1800,1800,1800,1800]), dailyTarget: null });
  assert.equal(r.available, false);
  assert.equal(r.blocked, 'no_target');
});

await test('the reward is never hedged', () => {
  const r = earnedRoom({ days: week([1600,1700,1650,1700,1600,1650,1700]), dailyTarget: 2200 });
  assert.doesNotMatch(r.say, /but |careful|moderation|make sure|try not/i,
    'a hedged reward is not a reward');
  assert.match(r.guidance, /without conditions/i);
});

group('Session assembly');

await test('a routine becomes an ordered plan with keys and rest', () => {
  const plan = planFromRoutine({ tier: 'intermediate', exercises: [
    { name: 'Back Squat', sets: 4, reps: 6, muscles: ['legs'] },
    { name: 'Bench', sets: 3, reps: 8 },
  ]});
  assert.equal(plan.length, 2);
  assert.equal(plan[0].key, 'squat');
  assert.equal(plan[1].key, 'bench press');
  assert.equal(plan[0].index, 0);
  assert.ok(plan[0].rest_s > 0, 'rest must default rather than come back undefined mid-session');
});

await test('totals add up volume and surface the top set per lift', () => {
  const t = sessionTotals([
    { exercise: 'Squat', reps: 6, weight_kg: 100 },
    { exercise: 'Squat', reps: 6, weight_kg: 105 },
    { exercise: 'Bench', reps: 8, weight_kg: 80 },
  ]);
  assert.equal(t.sets, 3);
  assert.equal(t.reps, 20);
  assert.equal(t.volume_kg, 100 * 6 + 105 * 6 + 80 * 8);
  assert.equal(t.top_sets.find(s => s.exercise === 'Squat').weight_kg, 105);
});

await test('bodyweight work does not poison the volume total', () => {
  const t = sessionTotals([{ exercise: 'Pull-up', reps: 10, weight_kg: null }]);
  assert.equal(t.volume_kg, 0);
  assert.equal(t.reps, 10);
});

// ── The client does the reading ─────────────────────────────────────────────
// Structuring moved to the connected model, which has already read the sentence
// and seen the photograph this server never will. That makes the tool schema an
// instruction surface rather than documentation: if the "never invent a number"
// rule falls out of it during some future tidy-up, nothing fails loudly — the
// weekly totals just quietly fill with guesses. Hence these.

group('Structuring, done by the model that read the words');

await test('a client-supplied reading is used as given', () => {
  const events = eventsFromClient([
    { event_type: 'food', summary: 'two eggs and black coffee', detail: { calories: 220 }, estimated: true },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'food');
  assert.equal(events[0].estimated, true);
});

await test('nothing usable falls back rather than logging an empty entry', () => {
  assert.equal(eventsFromClient(null), null);
  assert.equal(eventsFromClient([]), null);
  assert.equal(eventsFromClient('food'), null);
  assert.equal(eventsFromClient([null, 'x', 42]), null);
  assert.equal(eventsFromClient([{ note: 'no type, no summary' }]), null);
});

await test('a usable entry survives junk beside it', () => {
  const events = eventsFromClient([null, { event_type: 'workout', summary: '10 push-ups' }, 'rubbish']);
  assert.equal(events.length, 1);
  assert.equal(events[0].summary, '10 push-ups');
});

await test('log accepts a structured reading alongside the verbatim words', () => {
  const log = TOOLS.find(t => t.name === 'log');
  const events = log.inputSchema.properties.events;
  assert.equal(events.type, 'array');
  assert.deepEqual(events.items.required, ['event_type', 'summary']);
  assert.ok(events.items.properties.event_type.enum.includes('food'));
  assert.ok(events.items.properties.event_type.enum.includes('workout'));
  assert.ok(events.items.properties.estimated, 'estimated must stay in the contract');
  assert.deepEqual(log.inputSchema.required, ['text', 'events'],
    'both are required: the words so nothing is lost, the reading so it counts for something');
});

await test('the schema still forbids inventing a number', () => {
  const events = TOOLS.find(t => t.name === 'log').inputSchema.properties.events;
  assert.match(events.description, /never a guessed 500/i);
  assert.match(events.description, /null/i);
  assert.match(events.items.properties.estimated.description, /inferred rather than stated/i);
});

await test('a named food logged blank gets chased, an unnamed one does not', () => {
  const row = (id, summary, event_type = 'food') => ({ id, summary, event_type });

  // Named, no calories → ask for them.
  assert.equal(needsMacros(
    [row(1, 'two pepperettes')],
    [{ detail: { items: ['pepperettes'] } }],
  ).length, 1);

  // Unnamed → never chase. Inventing the food is the worse failure.
  assert.equal(needsMacros(
    [row(2, 'had lunch')],
    [{ detail: { items: ['lunch'] } }],
  ).length, 0);
  assert.equal(needsMacros(
    [row(3, 'grabbed some food')],
    [{ detail: { items: ['food'] } }],
  ).length, 0);

  // Already counted → nothing to chase.
  assert.equal(needsMacros(
    [row(4, 'chicken burrito bowl')],
    [{ detail: { items: ['burrito'], calories: 620 } }],
  ).length, 0);

  // Not food at all.
  assert.equal(needsMacros(
    [row(5, '40 minutes upper body', 'workout')],
    [{ detail: {} }],
  ).length, 0);

  // No items listed, but the summary itself names something.
  assert.equal(needsMacros(
    [row(6, 'a flat white')],
    [{ detail: {} }],
  ).length, 1);
});

await test('a named food is estimated, an unnamed one is not', () => {
  // Both halves are load-bearing and they pull opposite ways. Drop the first
  // and every named meal logs blank, which is what "0 calories" on a day
  // somebody ate came from. Drop the second and the model invents lunches.
  const events = TOOLS.find(t => t.name === 'log').inputSchema.properties.events;
  assert.match(events.description, /named the food/i);
  assert.match(events.description, /had lunch/i);
  const instructions = SERVER_INSTRUCTIONS;
  assert.match(instructions, /THE LINE IS THE FOOD, NOT THE NUMBERS/);
  assert.match(instructions, /barely worth logging/i);
});

await test('amend_last takes a merged entry, and still only needs the words', () => {
  const amend = TOOLS.find(t => t.name === 'amend_last');
  assert.ok(amend.inputSchema.properties.event, 'amend_last needs the merged-entry contract');
  assert.match(amend.inputSchema.properties.event.description, /[Mm]erge rather than replace/);
  assert.deepEqual(amend.inputSchema.required, ['text']);
});

await test('the doctrine reaches the model that has to follow it', async () => {
  const body = JSON.parse((await post(rpc('initialize', { protocolVersion: '2025-06-18' }))).body);
  assert.match(body.result.instructions, /YOU STRUCTURE THE LOG/);
  assert.match(body.result.instructions, /inventing the food itself/i);
  assert.match(body.result.instructions, /poisons a weekly total/i);
});

// ── Fasting ─────────────────────────────────────────────────────────────────
// A fast is a record of something that happened, and the arithmetic between two
// clock times is the whole of it. The midnight crossing is the case that matters
// — almost every real fast runs from dinner to the next day — and getting it
// wrong turns a 16-hour fast into a negative number without anything failing.

group('Fasting — the record, not the plan');

await test('a fast across midnight is measured forwards', () => {
  assert.equal(fastLength('20:00', '12:00'), 16);
  assert.equal(fastLength('21:30', '13:00'), 15.5);
});

await test('a fast inside one day still counts', () => {
  assert.equal(fastLength('08:00', '16:00'), 8);
});

await test('same time both ends is a full day, not zero', () => {
  assert.equal(fastLength('20:00', '20:00'), 24);
});

await test('an unfinished fast has no length yet', () => {
  assert.equal(fastLength('20:00', null), null);
  assert.equal(fastLength(null, '12:00'), null);
});

await test('history averages only the fasts that finished', () => {
  const s = fastingSummary([
    { detail: { hours: 16 } },
    { detail: { hours: 18 } },
    { detail: { hours: null, open: true } },
    { detail: {} },
  ]);
  assert.equal(s.count, 2);
  assert.equal(s.average_hours, 17);
  assert.equal(s.longest_hours, 18);
});

await test('nothing logged says so rather than dividing by zero', () => {
  const s = fastingSummary([]);
  assert.equal(s.count, 0);
  assert.equal(s.average_hours, null);
  assert.match(s.say, /No fasts/);
});

await test('the fast is never graded', () => {
  const say = fastingSummary([{ detail: { hours: 22 } }, { detail: { hours: 13 } }]).say;
  assert.doesNotMatch(say, /good|great|well done|only|just|short|impressive/i,
    'a graded fast becomes a reason to skip breakfast to keep a number alive');
  const tool = TOOLS.find(t => t.name === 'log_fast');
  assert.ok(tool, 'log_fast must be in the toolset');
  assert.deepEqual(tool.inputSchema.required, ['from']);
});

// ── How people actually ask ─────────────────────────────────────────────────
// Nobody says "call the brief tool". If the phrasebook falls out of the
// instructions, nothing errors — the connector just gets steadily less useful
// as the model stops recognising ordinary English, which is the hardest kind of
// regression to notice.

group('Movement that nothing measured');

await test('with no device and no activity level, the burn says it is resting only', () => {
  const b = energyBalance({
    profile: { height_cm: 190, birth_year: 1990, sex: 'male' },
    weightKg: 150, caloriesIn: 1125, activeCalories: 0,
  });
  assert.equal(b.active_burn, 0);
  assert.equal(b.active_source, 'none');
  // Silence here is the dangerous option: it reads as a bigger deficit than the
  // day had, and the advice that follows says eat less.
  assert.match(b.say, /resting burn only/i);
  assert.match(b.say, /deficit smaller than it looks/i);
});

await test('an activity level counts the day when no watch does', () => {
  const p = { height_cm: 190, birth_year: 1990, sex: 'male', activity_level: 'active' };
  const rest = restingBurn(p, 150).kcal;
  const b = energyBalance({ profile: p, weightKg: 150, caloriesIn: 1125, activeCalories: 0 });
  assert.equal(b.active_source, 'activity_level');
  assert.equal(b.active_burn, Math.round(rest * 0.725));
  assert.equal(b.calories_out, rest + b.active_burn);
  assert.doesNotMatch(b.say, /resting burn only/i);
});

await test('a measurement always beats a multiplier', () => {
  const p = { height_cm: 190, birth_year: 1990, sex: 'male', activity_level: 'very_active' };
  const b = energyBalance({ profile: p, weightKg: 150, caloriesIn: 1125, activeCalories: 640 });
  assert.equal(b.active_source, 'device');
  assert.equal(b.active_burn, 640);
});

await test('the multipliers are the standard ones and rise in order', () => {
  const order = ['sedentary', 'light', 'moderate', 'active', 'very_active'];
  const mults = order.map(k => ACTIVITY[k].mult);
  assert.deepEqual(mults, [...mults].sort((a, b) => a - b));
  assert.equal(ACTIVITY.sedentary.mult, 1.2);
  assert.equal(ACTIVITY.very_active.mult, 1.9);
});

await test('the five facts are asked once, together, and never as an opener', () => {
  assert.match(SERVER_INSTRUCTIONS, /THE FIVE FACTS, ASKED ONCE/);
  assert.match(SERVER_INSTRUCTIONS, /ONE short message/);
  assert.match(SERVER_INSTRUCTIONS, /never ask one at a time/i);
  assert.match(SERVER_INSTRUCTIONS, /never open a conversation with it/i);
});

group('Missing numbers are asked for, never invented');

await test('an incomplete profile comes back with exactly what is missing', () => {
  const s = setupNeeded({ height_cm: 190 }, { hasWeight: false, hasCalorieGoal: false });
  assert.ok(s.missing.includes('the year they were born'));
  assert.ok(s.missing.includes('a current weight'));
  assert.ok(s.missing.includes('how much they are on their feet in a normal day'));
  assert.ok(!s.missing.includes('height'), 'already on file, must not be re-asked');
  assert.match(s.note, /ONE short message/);
  assert.match(s.note, /Do NOT invent/);
});

await test('a complete profile with no target still flags the target', () => {
  const full = { height_cm: 190, birth_year: 1990, sex: 'male', activity_level: 'active' };
  const s = setupNeeded(full, { hasWeight: true, hasCalorieGoal: false });
  assert.equal(s.missing.length, 0);
  // The exact failure seen in the wild: "if we use 2,500 as your budget".
  assert.match(s.note, /do NOT say "if we use 2,500"/);
});

await test('nothing missing and a target set means silence', () => {
  const full = { height_cm: 190, birth_year: 1990, sex: 'male', activity_level: 'active' };
  assert.equal(setupNeeded(full, { hasWeight: true, hasCalorieGoal: true }), null);
});

await test('the instructions forbid the plausible substitute', () => {
  assert.match(SERVER_INSTRUCTIONS, /NEVER SUBSTITUTE A PLAUSIBLE NUMBER/);
  assert.match(SERVER_INSTRUCTIONS, /wearing the clothes of a real one/);
});

group('What to train next');

const trainedOn = (date, muscles) => ({ date, muscles, logged: true });

await test('the longest neglected group is what gets recommended', () => {
  const f = focusCall([
    trainedOn('2026-06-01', ['legs']),
    trainedOn('2026-07-26', ['chest', 'arms']),
    trainedOn('2026-07-31', ['chest', 'arms']),
    trainedOn('2026-08-03', ['chest', 'arms']),
  ], { today: '2026-08-05' });

  assert.equal(f.known, true);
  assert.equal(f.target[0], 'legs', 'legs went cold in June and must lead');
  assert.ok(f.strong.includes('chest'), 'chest has three sessions in the fortnight');
  assert.match(f.say, /legs/);
});

await test('a group never trained at all outranks one merely stale', () => {
  // Filtering to recent days would hide it entirely, which is the opposite of
  // what somebody needs to be told.
  const f = focusCall([trainedOn('2026-08-01', ['chest'])], { today: '2026-08-05' });
  assert.ok(f.target.length, 'something should be recommended');
  assert.ok(!f.target.includes('chest'), 'chest was trained four days ago');
  assert.ok(f.groups.some(g => g.state === 'never'));
});

await test('nothing trained is not a scolding', () => {
  const f = focusCall([], { today: '2026-08-05' });
  assert.equal(f.known, false);
  assert.equal(f.target.length, 0);
  assert.doesNotMatch(f.say, /should|behind|failed|need to/i,
    'day one is not a deficit to be lectured about');
});

await test('everything covered says so rather than inventing a gap', () => {
  const all = ['chest', 'back', 'shoulders', 'arms', 'legs', 'glutes', 'core'];
  const f = focusCall([
    trainedOn('2026-08-03', all), trainedOn('2026-08-04', all), trainedOn('2026-08-05', all),
  ], { today: '2026-08-05' });
  assert.equal(f.target.length, 0);
  assert.match(f.say, /Nothing is behind/i);
});

group('Retracting something that did not happen');

const LOGGED = [
  { id: 1, summary: 'large pepperoni pizza', raw_input: 'I ordered a large pepperoni pizza' },
  { id: 2, summary: '182 lb', raw_input: '182 on the scale' },
  { id: 3, summary: '40 minutes upper body', raw_input: 'pushed 40 minutes upper body' },
  { id: 4, summary: 'two slices of pizza', raw_input: 'had two slices of pizza' },
];

await test('naming a thing finds that entry, not the newest', () => {
  const hits = matchEntries(LOGGED, 'the upper body session');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 3);
});

await test('the filler in "I didn\'t actually eat the pizza" is ignored', () => {
  const hits = matchEntries(LOGGED, "I didn't actually eat the pizza");
  // Both pizza entries match, which is correct — two things really do match.
  assert.equal(hits.length, 2);
});

await test('ambiguity returns everything rather than picking one', () => {
  assert.equal(matchEntries(LOGGED, 'pizza').length, 2);
  assert.equal(matchEntries(LOGGED, 'pepperoni pizza').length, 1);
});

await test('no match is no match — never a silent fallback to the newest', () => {
  assert.equal(matchEntries(LOGGED, 'the curry').length, 0);
  assert.equal(matchEntries(LOGGED, 'take that off').length, 0,
    'all-filler input must match nothing rather than everything');
  assert.equal(matchEntries(LOGGED, '').length, 0);
});

await test('the tool refuses to guess, and says why', () => {
  const t = TOOLS.find(x => x.name === 'undo_last');
  assert.ok(t.inputSchema.properties.match, 'undo_last needs targeted retraction');
  assert.equal(t.annotations.destructiveHint, true);
  assert.match(t.inputSchema.properties.match.description, /nothing is deleted/i);
});

await test('retraction phrasings are in the phrasebook', () => {
  for (const phrase of ['scratch that', "I didn't actually eat it", 'that never happened', 'I was testing']) {
    assert.ok(SERVER_INSTRUCTIONS.toLowerCase().includes(phrase.toLowerCase()), phrase);
  }
});

group('The phrasebook');

await test('sideways ways of asking still reach the brief', () => {
  for (const phrase of ['gym bro', 'jim bro', "what's the damage", 'roast me', 'hit me', 'morning']) {
    assert.ok(SERVER_INSTRUCTIONS.toLowerCase().includes(phrase.toLowerCase()),
      `"${phrase}" should be recognised as asking for the brief`);
  }
});

await test('the fridge-at-11pm phrasings reach whats_next', () => {
  for (const phrase of ["I'm hungry", 'can I have a snack', 'talk me out of it']) {
    assert.ok(SERVER_INSTRUCTIONS.toLowerCase().includes(phrase.toLowerCase()), phrase);
  }
});

await test('mid-set phrasings reach log_set', () => {
  for (const phrase of ['got 8', 'failed at 5', "one more in the tank"]) {
    assert.ok(SERVER_INSTRUCTIONS.toLowerCase().includes(phrase.toLowerCase()), phrase);
  }
});

await test('a greeting is a request, not an opener to be chatted back at', () => {
  // The observed failure: "hey jim bro" got "hey bro, what's up?" and no tool
  // call. Listing the phrases was never enough — the instruction has to say
  // what to DO when one arrives.
  assert.match(SERVER_INSTRUCTIONS, /A GREETING IN THAT REGISTER IS A REQUEST/);
  assert.match(SERVER_INSTRUCTIONS, /CALL THE TOOL FIRST/);
  assert.match(SERVER_INSTRUCTIONS, /what's up\?" and wait/i);
});

await test('the gym-bro voice cannot outrank the safety rules', () => {
  // A persona that can override the care flags is the one way this feature
  // turns a good idea into the thing the flags exist to prevent.
  assert.match(SERVER_INSTRUCTIONS, /REGISTER, NOT A LICENCE/);
  assert.match(SERVER_INSTRUCTIONS, /care flag silences the whole register/i);
  assert.match(SERVER_INSTRUCTIONS, /nothing about their body is ever mentioned/i);
});

// ── The library ─────────────────────────────────────────────────────────────
// A curated list is only safe if it stays curated. The two things that would
// quietly ruin it: a weight appearing anywhere in it, and a beginner being
// handed advanced movements. Neither would throw — a novice would just find
// themselves under a front squat with a number beside it.

group('Programme library — curated, and never a weight');

await test('no movement and no built session carries a load', () => {
  for (const m of MOVEMENTS) {
    assert.ok(!('load_kg' in m) && !('weight' in m), `${m.name} must not carry a weight`);
  }
  for (const p of PROGRAMMES) {
    const built = buildProgramme(p, { tier: 'advanced' });
    for (const s of built.sessions) {
      for (const e of s.exercises) {
        assert.equal(e.load_kg, null, `${e.name} in ${p.id} must not prescribe a weight`);
      }
    }
  }
});

await test('a beginner is never offered an advanced movement', () => {
  for (const pattern of PATTERNS) {
    for (const m of movementsFor(pattern, { tier: 'beginner' })) {
      assert.equal(m.tier, 'beginner', `${m.name} is ${m.tier} and must not reach a beginner`);
    }
  }
});

await test('a programme never demands more days than they have', () => {
  for (const days of [2, 3, 4, 5, 6]) {
    const p = pickProgramme({ days, tier: 'advanced' });
    assert.ok(p, `nothing matched for ${days} days`);
    assert.ok(p.days <= days, `${p.id} wants ${p.days} days but they have ${days}`);
  }
});

await test('two days available does not return a six-day split', () => {
  assert.equal(pickProgramme({ days: 2, tier: 'advanced' }).days, 2);
});

await test('equipment filters what gets programmed', () => {
  const built = buildProgramme(PROGRAMMES[0], { tier: 'intermediate', equipment: ['dumbbell', 'bench'] });
  const names = built.sessions.flatMap(s => s.exercises.map(e => e.name));
  assert.ok(names.length, 'a dumbbell-only session should still fill');
  for (const n of names) {
    const m = MOVEMENTS.find(x => x.name === n);
    assert.ok(m.equipment.some(r => ['dumbbell', 'bench', 'bodyweight'].some(o => r.includes(o) || o.includes(r))),
      `${n} needs kit they do not have`);
  }
});

await test('a beginner gets the movement explained, an advanced lifter does not', () => {
  const novice = buildProgramme(PROGRAMMES[0], { tier: 'beginner' });
  const expert = buildProgramme(PROGRAMMES[0], { tier: 'advanced' });
  assert.ok(novice.sessions[0].exercises.every(e => e.cue), 'beginners get told why');
  assert.ok(expert.sessions[0].exercises.every(e => e.cue === null), 'advanced lifters get left alone');
});

await test('what they train FOR picks the programme', () => {
  // Strength and size are different training. Handing somebody the wrong one is
  // how they decide the whole thing does not work.
  assert.equal(pickProgramme({ goal: 'strength', tier: 'advanced', days: 5 }).goal, 'strength');
  assert.equal(pickProgramme({ goal: 'tactical', tier: 'advanced', days: 5 }).goal, 'tactical');
  assert.equal(pickProgramme({ goal: 'endurance', tier: 'advanced', days: 5 }).goal, 'endurance');
  assert.equal(pickProgramme({ goal: 'hypertrophy', tier: 'advanced', days: 6 }).goal, 'hypertrophy');
});

await test('days still outrank the goal', () => {
  // Wanting the military programme does not conjure two extra days in the week.
  const p = pickProgramme({ goal: 'tactical', tier: 'advanced', days: 3 });
  assert.ok(p.days <= 3, `${p.id} wants ${p.days} days against 3 available`);
});

await test('a programme keeps its own rep scheme', () => {
  const strength = PROGRAMMES.find(p => p.id === 'strength-4');
  const size = PROGRAMMES.find(p => p.id === 'size-5');
  const s = buildProgramme(strength, { tier: 'advanced' });
  const h = buildProgramme(size, { tier: 'advanced' });

  const reps = pl => pl.sessions[0].exercises[0].reps;
  const rest = pl => pl.sessions[0].exercises[0].rest_s;
  assert.equal(reps(s), 4, 'five heavy triples is not four sets of ten');
  assert.equal(reps(h), 10);
  assert.ok(rest(s) > rest(h), 'heavy work rests longer, or it is not heavy work');
});

await test('bodyweight stays bodyweight even in a full gym', () => {
  const bw = PROGRAMMES.find(p => p.id === 'bodyweight-4');
  const built = buildProgramme(bw, { tier: 'intermediate', equipment: ['full gym', 'barbell'] });
  const names = built.sessions.flatMap(s => s.exercises.map(e => e.name));
  for (const n of names) {
    const m = MOVEMENTS.find(x => x.name === n);
    assert.ok(m.equipment.some(r => ['bodyweight', 'bars'].includes(r)),
      `${n} needs kit — that is the whole promise of a bodyweight programme`);
  }
});

await test('every programme still carries no weight and states a goal', () => {
  for (const p of PROGRAMMES) {
    assert.ok(p.goal, `${p.id} needs a goal`);
    const built = buildProgramme(p, { tier: 'advanced' });
    for (const s of built.sessions) {
      for (const e of s.exercises) assert.equal(e.load_kg, null, `${e.name} in ${p.id}`);
    }
  }
});

await test('the tool says out loud that it prescribes no weight', () => {
  const t = TOOLS.find(x => x.name === 'programmes');
  assert.ok(t, 'programmes must be in the toolset');
  assert.match(t.description, /NO WEIGHTS/);
});

// ── The operator's door ─────────────────────────────────────────────────────
// Two failure modes, both quiet. An admin list that matches nobody locks the
// founder out of his own product; one that matches too easily hands the
// operator's view to a stranger. Neither throws.

group('Administrator');

await test('nobody is an administrator until the env var names them', async () => {
  const { isAdmin } = await import('../netlify/functions/api-admin.js');
  delete process.env.WROUGHT_ADMIN_EMAILS;
  assert.equal(isAdmin('anyone@example.com'), false);
  assert.equal(isAdmin(''), false);
  assert.equal(isAdmin(null), false);
});

await test('the named address matches however it is typed', async () => {
  const { isAdmin } = await import('../netlify/functions/api-admin.js');
  process.env.WROUGHT_ADMIN_EMAILS = ' Boss@Example.com , second@example.com ';
  assert.equal(isAdmin('boss@example.com'), true, 'case must not matter');
  assert.equal(isAdmin('  BOSS@EXAMPLE.COM '), true, 'nor should stray whitespace');
  assert.equal(isAdmin('second@example.com'), true);
  assert.equal(isAdmin('boss@example.com.evil.net'), false, 'no partial matches');
  assert.equal(isAdmin('bos@example.com'), false);
  delete process.env.WROUGHT_ADMIN_EMAILS;
});

await test('the endpoint loads and refuses anonymous callers', async () => {
  const { handler: admin } = await import('../netlify/functions/api-admin.js');
  const res = await admin({ httpMethod: 'GET', headers: {} });
  // No database configured in the harness, so it stops before auth — the point
  // is that the module resolves and answers rather than throwing on import.
  assert.equal(res.statusCode, 500);
  assert.equal(JSON.parse(res.body).error, 'server_not_configured');
});

// ── The rack screen ─────────────────────────────────────────────────────────
// This endpoint is imported by nothing else, so a bad import inside it would
// stay invisible until somebody standing at a squat rack got a 500. Loading it
// here at least proves the module resolves and the handler answers.

group('Trainer endpoint');

await test('api-session loads and answers without a database', async () => {
  const { handler: session } = await import('../netlify/functions/api-session.js');
  const res = await session({ httpMethod: 'GET', headers: {} });
  assert.equal(res.statusCode, 500);
  assert.equal(JSON.parse(res.body).error, 'server_not_configured');
});

await test('api-session passes CORS preflight', async () => {
  const { handler: session } = await import('../netlify/functions/api-session.js');
  const res = await session({ httpMethod: 'OPTIONS', headers: {} });
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
});

group('Sign-in — a password, not a link');

// The founder's instruction was flat: "I don't wanna send a link anymore. It
// needs to be a login takes people info logged in." A magic link is fewer moving
// parts to build and puts an inbox between somebody and their own data every
// single time — on a phone, in a gym, that is the difference between opening it
// and not bothering. These tests exist because the OTP call is a one-line
// revert that nothing else would notice.

const page = f => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const AUTH_PAGES = ['app.html', 'authorize.html', 'connect.html'];

await test('no page falls back to emailing a sign-in link', () => {
  for (const f of AUTH_PAGES) {
    assert.ok(!/signInWithOtp/.test(page(f)), `${f} still sends a magic link`);
    assert.ok(/signInWithPassword/.test(page(f)), `${f} has no password sign-in`);
  }
});

await test('every sign-in form actually has a password field', () => {
  for (const f of AUTH_PAGES) {
    assert.ok(/id="pass"[^>]*type="password"/.test(page(f)), `${f} has no password input`);
  }
});

await test('the dashboard and the connect screen can both make an account', () => {
  // connect.html deliberately cannot — it hands out device keys for an account
  // that already exists, and a second copy of the signup flow is a second thing
  // to drift. It has to point somewhere, though.
  for (const f of ['app.html', 'authorize.html']) {
    assert.ok(/signUp\(/.test(page(f)), `${f} cannot create an account`);
  }
  assert.ok(!/signUp\(/.test(page('connect.html')));
  assert.match(page('connect.html'), /app\.html/);
});

await test('a wrong password and an unknown address read the same', () => {
  // Supabase answers "Invalid login credentials" to both. Telling them apart
  // would let a stranger test whether somebody has an account on a health
  // product, so every page has to flatten it back out.
  for (const f of AUTH_PAGES) {
    const src = page(f);
    assert.match(src, /invalid login/i, `${f} does not flatten the credential error`);
    const shown = src.replace(/^\s*\/\/.*$/gm, '');   // the comments explain why
    assert.ok(!/no account with that email|never registered|not found/i.test(shown),
      `${f} leaks whether an address is registered`);
  }
});

await test('nothing still promises there is no password', () => {
  for (const f of [...AUTH_PAGES, 'index.html']) {
    // Comments may discuss it — only what a person actually reads is asserted on.
    const prose = page(f).replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(!/no password|passwordless|tap the link/i.test(prose),
      `${f} still promises a passwordless sign-in`);
  }
});

await test('reset still goes by email, because it has to', () => {
  for (const f of ['app.html', 'authorize.html']) {
    assert.match(page(f), /resetPasswordForEmail/, `${f} strands anyone who forgets`);
  }
});

group('Many doors, one account');

// The founder: "even though your GTP might have a different email. You're gonna
// have to link it to." A person is one training history, not one email address.
// When that stops being true the log forks — and a forked log does not look
// broken, it looks like you did nothing for three weeks, which is the single
// most damaging thing this product could show somebody.

await test('Apple and Google are offered on every sign-in surface', () => {
  for (const f of AUTH_PAGES) {
    const src = page(f);
    assert.match(src, /data-provider="apple"/, `${f} offers no Apple sign-in`);
    assert.match(src, /data-provider="google"/, `${f} offers no Google sign-in`);
    assert.match(src, /signInWithOAuth/, `${f} has no provider handler`);
  }
});

await test('the provider marks are drawn, never fetched', () => {
  // A logo loaded from Apple or Google is a third party watching a health
  // product's sign-in page, and it is a blank square when the network is slow.
  for (const f of AUTH_PAGES) {
    const svgs = page(f).match(/<svg[\s\S]*?<\/svg>/g) || [];
    assert.ok(svgs.length >= 2, `${f} is missing the provider marks`);
    assert.ok(!/<img[^>]+(apple|google)/i.test(page(f)), `${f} fetches a provider logo`);
  }
});

await test('the dashboard can link a second door without making a second account', () => {
  const src = page('app.html');
  assert.match(src, /linkIdentity/);
  assert.match(src, /getUserIdentities/);
  assert.match(src, /unlinkIdentity/);
});

await test('unlinking can never take the last way in', () => {
  // Removing somebody's only sign-in is not a setting. It is locking them out of
  // years of their own history with nothing to fall back on.
  const src = page('app.html');
  assert.match(src, /ids \|\| \[\]\)\.length <= 1/);
  assert.match(src, /only way in/i);
});

await test('merging demands proof of BOTH accounts', async () => {
  const { handler: merge } = await import('../netlify/functions/api-merge.js');
  const src = readFileSync(new URL('../netlify/functions/api-merge.js', import.meta.url), 'utf8');
  // An email address is guessable and a user id is printed inside every JWT.
  // Either one alone would turn this into a way to read a stranger's record.
  assert.ok(!/body\.(other_)?(email|user_id)\b/.test(src),
    'the merge accepts something other than a verified token');
  assert.match(src, /other_token/);

  const res = await merge({ httpMethod: 'POST', headers: {}, body: '{}' });
  assert.equal(res.statusCode, 500);   // no database configured offline
  assert.equal(JSON.parse(res.body).error, 'server_not_configured');
});

await test('the merge refuses anything but POST, and passes preflight', async () => {
  const { handler: merge } = await import('../netlify/functions/api-merge.js');
  assert.equal((await merge({ httpMethod: 'OPTIONS', headers: {} })).statusCode, 204);
  assert.equal((await merge({ httpMethod: 'GET', headers: {} })).statusCode, 405);
});

await test('the merge moves every table, and the connector follows', () => {
  const sql = readFileSync(new URL('../schema/006_wrought_identity.sql', import.meta.url), 'utf8');
  // Miss one and that slice of somebody's life stays orphaned under an account
  // that is about to be deleted.
  for (const t of ['wrought_events', 'wrought_metrics', 'wrought_sets', 'wrought_sessions',
                   'wrought_routines', 'wrought_goals', 'wrought_memory', 'wrought_briefs',
                   'wrought_connections', 'wrought_ingest_keys', 'wrought_profile',
                   'wrought_eating_window']) {
    assert.ok(new RegExp(`update ${t}\\s+set user_id = keep`).test(sql), `${t} is left behind`);
  }
  // The line that means ChatGPT keeps working and starts writing to the account
  // that survived, with nothing to reconnect.
  assert.match(sql, /update wrought_oauth_tokens\s+set user_id = keep/);
});

await test('the merge function is unreachable from a browser', () => {
  // It is SECURITY DEFINER, so it runs straight past row level security. That
  // makes who may call it the entire safety story.
  const sql = readFileSync(new URL('../schema/006_wrought_identity.sql', import.meta.url), 'utf8');
  assert.match(sql, /security definer/);
  assert.match(sql, /revoke all on function public\.wrought_merge_accounts\(uuid, uuid\) from authenticated/);
  assert.match(sql, /revoke all on function public\.wrought_merge_accounts\(uuid, uuid\) from anon/);
  assert.match(sql, /grant execute on function public\.wrought_merge_accounts\(uuid, uuid\) to service_role/);
});

await test('an account cannot absorb itself', () => {
  const sql = readFileSync(new URL('../schema/006_wrought_identity.sql', import.meta.url), 'utf8');
  assert.match(sql, /if keep = absorb then/);
});

await test('the assistant is told which account it is attached to', () => {
  const src = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  assert.match(src, /account: \{\s*\n\s*email: user\.email/);
  assert.match(src, /fork_check/);
});

await test('an empty account is never answered by asking them to log it again', () => {
  // Re-logging a week somebody already logged is how they stop trusting a
  // memory product, and it looks exactly like working software.
  assert.match(SERVER_INSTRUCTIONS, /ONE PERSON, ONE ACCOUNT, SEVERAL DOORS/);
  assert.match(SERVER_INSTRUCTIONS, /never respond to an empty account by asking them to start logging again/i);
  assert.match(SERVER_INSTRUCTIONS, /wrought\.fit/);
});

group('Two-factor, and the ways round it');

// A second factor the browser checks and the server does not is decoration: the
// password alone still produces a valid session and every endpoint here would
// take it. These tests are about the gates, not the prompt.

const lib = readFileSync(new URL('../netlify/functions/lib/wrought.js', import.meta.url), 'utf8');
const MFA_PAGES = ['app.html', 'authorize.html', 'connect.html'];

await test('a token that already cleared the second factor needs no lookup', async () => {
  const { mfaSatisfied } = await import('../netlify/functions/lib/wrought.js');
  const jwt = ['x', Buffer.from(JSON.stringify({ aal: 'aal2' })).toString('base64url'), 'y'].join('.');
  assert.equal(await mfaSatisfied({ id: 'u1' }, jwt), true);
});

await test('a malformed token is never mistaken for a cleared one', async () => {
  const { mfaSatisfied } = await import('../netlify/functions/lib/wrought.js');
  // Garbage must fall through to the factor check, not sail past it.
  for (const junk of ['', 'not.a.jwt', 'aal2', 'a.b']) {
    const out = await mfaSatisfied({ id: 'u1' }, junk);
    assert.equal(typeof out, 'boolean');
  }
  const aal1 = ['x', Buffer.from(JSON.stringify({ aal: 'aal1' })).toString('base64url'), 'y'].join('.');
  assert.equal(typeof await mfaSatisfied({ id: 'u1' }, aal1), 'boolean');
});

await test('the session-JWT path is gated and the connector path deliberately is not', () => {
  // ChatGPT holds a token minted after the code was already given, and there is
  // no way to ask it for a fresh one mid-conversation. Re-checking that path
  // would break every connector; skipping the JWT path would make 2FA a lie.
  assert.match(lib, /if \(!\(await mfaSatisfied\(data\.user, token\)\)\) return null;/);
  const oauthArm = lib.slice(lib.indexOf('wrought_oauth_tokens'), lib.indexOf('fall through to JWT'));
  assert.ok(!/mfaSatisfied/.test(oauthArm), 'the connector path re-asks for a code it can never get');
});

await test('connecting an assistant cannot be used to skip the second factor', async () => {
  const src = readFileSync(new URL('../netlify/functions/oauth-authorize-complete.js', import.meta.url), 'utf8');
  // The token minted here outlives the browser session. If a password alone
  // reached it, "connect your assistant" would be a permanent bypass.
  assert.match(src, /mfaSatisfied/);
  assert.match(src, /mfa_required/);
  assert.ok(src.indexOf('mfaSatisfied') < src.indexOf('wrought_oauth_codes'),
    'the code is minted before the factor is checked');
});

await test('an outage never silently switches somebody\'s second factor off', () => {
  // Prefer the last answer actually received, even expired, over assuming there
  // is no factor because a lookup failed.
  assert.match(lib, /return hit \? hit\.has : false;/);
});

await test('every sign-in surface can ask for the code', () => {
  for (const f of MFA_PAGES) {
    const src = page(f);
    assert.match(src, /getAuthenticatorAssuranceLevel/, `${f} never checks the assurance level`);
    assert.match(src, /mfa\.verify/, `${f} cannot verify a code`);
    assert.match(src, /id="mfacode"/, `${f} has no code field`);
  }
});

await test('only the dashboard can turn two-factor on or off', () => {
  // Enrolling belongs on the account screen. A connect flow that offers to set
  // up 2FA mid-authorization is how somebody ends up half-enrolled.
  assert.match(page('app.html'), /mfa\.enroll/);
  for (const f of ['authorize.html', 'connect.html']) {
    assert.ok(!/mfa\.enroll/.test(page(f)), `${f} should not enrol a factor`);
  }
});

await test('the hidden attribute beats the stylesheet', () => {
  // .oauth is display:flex, which outranks [hidden] and left the provider
  // buttons on screen underneath the two-factor prompt.
  for (const f of MFA_PAGES) {
    assert.match(page(f), /\[hidden\]\s*\{\s*display:\s*none\s*!important/,
      `${f} can show elements it has hidden`);
  }
});

group('Offline, and the page you land on');

await test('a failed navigation is never answered with a different page', () => {
  const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  // Tapping the home screen icon and landing on the marketing homepage reads as
  // having been signed out — the one thing a memory product must never fake.
  assert.ok(!/caches\.match\('\/index\.html'\)/.test(sw),
    'the worker still falls back to the homepage');
  assert.match(sw, /request\.mode === 'navigate'/);
  assert.match(sw, /status: 503/);
});

await test('a query string is not a different page', () => {
  const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  // /app.html?merge=1 is /app.html. Without ignoreSearch every link carrying a
  // query string missed the cache and fell through to the fallback.
  assert.match(sw, /ignoreSearch: true/);
});

await test('the installed app opens the app, not the sales page', () => {
  const manifest = JSON.parse(readFileSync(new URL('../public/site.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.start_url, '/app.html');
});

await test('the wordmark is clickable, and does not throw you out of your record', () => {
  // From inside the dashboard it goes to the dashboard. Being dumped on a sales
  // pitch from your own log is the complaint, not the fix.
  // On the dashboard it goes to the Record view, not to /app.html — pointing it
  // at the same URL reloaded the page and looked like nothing happened.
  assert.match(page('app.html'), /<a class="mark" href="#record"/);
  for (const f of ['authorize.html', 'connect.html']) {
    assert.match(page(f), /<a class="mark" href="\/"/, `${f} has no way home`);
  }
});

group('Last night — the screen you open the morning after');

const { lastSession } = await import('../netlify/functions/lib/training.js');

const SESS = [{ id: 's2', name: 'Push', kind: 'strength', local_date: '2026-08-08',
                started_at: '2026-08-08T18:00:00Z', ended_at: '2026-08-08T18:52:00Z', status: 'done' },
              { id: 's1', name: 'Push', kind: 'strength', local_date: '2026-08-04',
                started_at: '2026-08-04T18:00:00Z', ended_at: '2026-08-04T18:48:00Z', status: 'done' }];
const SETS = [
  { session_id: 's2', exercise: 'Bench Press', exercise_key: 'bench_press', set_number: 1, position: 1, reps: 6, weight_kg: 92.5, local_date: '2026-08-08', muscles: ['chest'] },
  { session_id: 's2', exercise: 'Press-up',    exercise_key: 'press_up',    set_number: 1, position: 2, reps: 20, weight_kg: null, local_date: '2026-08-08', muscles: ['chest'] },
  { session_id: 's1', exercise: 'Bench Press', exercise_key: 'bench_press', set_number: 1, position: 1, reps: 6, weight_kg: 90,   local_date: '2026-08-04', muscles: ['chest'] },
];

await test('it reads back the session, not an average of the week', () => {
  const out = lastSession(SESS, SETS, { today: '2026-08-09' });
  assert.equal(out.known, true);
  assert.equal(out.when, 'Last night');
  assert.equal(out.totals.sets, 2);
  assert.equal(out.totals.reps, 26);
  assert.equal(out.minutes, 52);
});

await test('every lift is set against the last time it was done', () => {
  // A number with nothing beside it is trivia. "92.5 for 6" means nothing;
  // "92.5 for 6, up from 90 for 6" is the whole reason to keep a log.
  const out = lastSession(SESS, SETS, { today: '2026-08-09' });
  const bench = out.exercises.find(e => e.key === 'bench_press');
  assert.equal(bench.verdict, 'up');
  assert.equal(bench.last_time.weight, 90);
  assert.equal(bench.last_time.days_ago, 4);
});

await test('same weight for more reps is progress, not "no change"', () => {
  const sets = [
    { session_id: 's2', exercise: 'Bench Press', exercise_key: 'bench_press', set_number: 1, position: 1, reps: 8, weight_kg: 90, local_date: '2026-08-08' },
    { session_id: 's1', exercise: 'Bench Press', exercise_key: 'bench_press', set_number: 1, position: 1, reps: 6, weight_kg: 90, local_date: '2026-08-04' },
  ];
  assert.equal(lastSession(SESS, sets, { today: '2026-08-09' }).exercises[0].verdict, 'up');
});

await test('bodyweight work is never reported as zero', () => {
  // The Lifts panel dropped these once already by filtering on weight.
  const out = lastSession(SESS, SETS, { today: '2026-08-09' });
  const push = out.exercises.find(e => e.key === 'press_up');
  assert.ok(push, 'bodyweight exercise dropped from the session');
  assert.equal(push.loaded, false);
  assert.equal(push.top_set.weight, null);
  assert.equal(push.sets[0].reps, 20);
});

await test('exercises come back in the order they were actually done', () => {
  const out = lastSession(SESS, SETS, { today: '2026-08-09' });
  assert.deepEqual(out.exercises.map(e => e.position), [1, 2]);
});

await test('no session yet says so instead of inventing one', () => {
  const out = lastSession([], [], { today: '2026-08-09' });
  assert.equal(out.known, false);
  assert.match(out.say, /no finished session/i);
});

group('Multi-week blocks');

const { buildBlock, blockPosition, BLOCK_LENGTHS } = await import('../netlify/functions/lib/library.js');
const BASE = PROGRAMMES.find(p => p.days === 3);

await test('a block schedules the deload before anybody feels they need one', () => {
  // The most skipped thing in training. Anybody who waits until they feel like
  // they need one takes it a fortnight late, as an injury or a month off.
  for (const weeks of BLOCK_LENGTHS) {
    const b = buildBlock(BASE, { tier: 'beginner', weeks });
    assert.ok(b.deload_weeks.length >= 1, `${weeks}-week block has no deload`);
    assert.ok(b.deload_weeks.includes(weeks), `${weeks}-week block does not end easy`);
  }
});

await test('a deload is lighter but is still the same session', () => {
  const b = buildBlock(BASE, { tier: 'beginner', weeks: 8 });
  const build = b.schedule[2].sessions[0].exercises;
  const deload = b.schedule[3].sessions[0].exercises;
  assert.equal(deload.length, build.length, 'the deload dropped exercises');
  assert.ok(deload[0].sets < build[0].sets, 'the deload is not lighter');
  assert.equal(deload[0].reps, build[0].reps, 'cutting reps makes it a different session');
  assert.ok(deload.every(e => e.sets >= 1), 'an exercise was rounded away to nothing');
  assert.equal(deload[0].rpe_cap, 6);
});

await test('a block still prescribes no weight anywhere', () => {
  // The one place an invented working weight would look most authoritative.
  const b = buildBlock(BASE, { tier: 'intermediate', weeks: 12 });
  const json = JSON.stringify(b);
  assert.ok(!/"load_kg":\s*[0-9]/.test(json), 'a block prescribed a load');
  assert.ok(!/"weight[^"]*":\s*[0-9]/.test(json), 'a block prescribed a weight');
});

await test('weeks are a ceiling, like days', () => {
  assert.equal(buildBlock(BASE, { weeks: 4 }).weeks, 4);
  assert.equal(buildBlock(BASE, { weeks: 999 }).weeks, 12);
});

await test('missing a week does not skip a week', () => {
  // Position counts sessions finished, never the calendar. Advancing by date
  // would punish a chest infection by deleting the training, and the block
  // would read as finished having never happened.
  const b = buildBlock(BASE, { weeks: 8 });
  assert.equal(blockPosition(b, 0).week, 1);
  assert.equal(blockPosition(b, 3).week, 2);
  assert.equal(blockPosition(b, 3).day, 1);
  assert.equal(blockPosition(b, 7).week, 3);
});

await test('finishing is said out loud', () => {
  // "Week 8 of 8, done" is the reason somebody showed up on the days they did
  // not want to. Swallowing it wastes the only reward the structure had.
  const b = buildBlock(BASE, { weeks: 8 });
  const end = blockPosition(b, b.total_sessions);
  assert.equal(end.complete, true);
  assert.equal(end.pct, 100);
  assert.match(end.say, /finished/i);
});

await test('the block tools are declared and the phrasebook knows them', () => {
  for (const name of ['start_block', 'block_status', 'end_block']) {
    assert.ok(TOOLS.some(t => t.name === name), `${name} is not declared`);
  }
  assert.match(SERVER_INSTRUCTIONS, /A PLAN WITH AN END/);
  assert.match(SERVER_INSTRUCTIONS, /what should I be running/);
});

group('Web push — checked against the spec, not against a library');

const { encryptPayload, vapidHeader } = await import('../netlify/functions/lib/push.js');

await test('payload encryption matches RFC 8291 byte for byte', () => {
  // The published test vector. This is why there is no dependency here: the
  // algorithm can be checked against the specification itself, offline.
  const out = encryptPayload({
    payload: 'When I grow up, I want to be a watermelon',
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    senderKeys: {
      publicKey: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
      privateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    },
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  });
  assert.equal(out.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

await test('two sends of the same words are never the same bytes', () => {
  // A reused salt or key pair leaks the plaintext of every message sent under
  // it. Real sends must generate both fresh.
  const args = { payload: 'same words', p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
  assert.notEqual(encryptPayload(args).toString('base64'), encryptPayload(args).toString('base64'));
});

await test('the VAPID signature is raw r||s, not DER', () => {
  // Every push service rejects a DER signature with a 401 that says nothing.
  const { publicKey, privateKey } = (() => {
    const c = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pub = c.publicKey.export({ format: 'jwk' });
    return {
      publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]).toString('base64url'),
      privateKey: c.privateKey.export({ format: 'jwk' }).d,
    };
  })();
  const h = vapidHeader({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', publicKey, privateKey, subject: 'mailto:a@b.com' });
  const jwt = h.Authorization.match(/t=([^,]+)/)[1];
  const [head, body, sig] = jwt.split('.');
  assert.equal(Buffer.from(sig, 'base64url').length, 64);
  assert.equal(JSON.parse(Buffer.from(head, 'base64url').toString()).alg, 'ES256');
  // The audience is the push service's ORIGIN, never the full endpoint.
  assert.equal(JSON.parse(Buffer.from(body, 'base64url').toString()).aud, 'https://fcm.googleapis.com');
});

await test('the Apple secret is a signed token, not the key file', async () => {
  // Supabase's Apple provider has two boxes and no field for a team ID or a key
  // ID, so everybody pastes the .p8 into "Secret Key (for OAuth)" and gets an
  // unreadable failure. That box wants a short-lived ES256 JWT SIGNED with the
  // .p8 — which is why the page says the secret expires every six months, a
  // thing a private key never does. scripts/apple-secret.mjs builds it.
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-'));
  const file = path.join(dir, 'AuthKey_ABCDE12345.p8');
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  fs.writeFileSync(file, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));

  const out = execFileSync(process.execPath, [
    new URL('../scripts/apple-secret.mjs', import.meta.url).pathname,
    '--team', 'A1B2C3D4E5', '--services', 'fit.wrought.signin', '--p8', file,
  ], { encoding: 'utf8' });

  const jwt = out.split('\n').find(l => l.split('.').length === 3 && l.length > 100);
  assert.ok(jwt, 'no token printed');
  const [head, body, sig] = jwt.split('.');

  const header = JSON.parse(Buffer.from(head, 'base64url').toString());
  assert.equal(header.alg, 'ES256');
  // The key ID rides in the header, read out of the filename Apple ships, so
  // nobody has to copy ten random characters off a screen.
  assert.equal(header.kid, 'ABCDE12345');

  const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  assert.equal(claims.iss, 'A1B2C3D4E5');          // team ID issues it
  assert.equal(claims.sub, 'fit.wrought.signin');   // Services ID, never the App ID
  assert.equal(claims.aud, 'https://appleid.apple.com');
  assert.ok(claims.exp - claims.iat <= 15777000, 'Apple caps the lifetime at six months');

  // Raw r||s, not DER. Node signs DER by default and Apple answers
  // "invalid_client" with nothing else to go on.
  assert.equal(Buffer.from(sig, 'base64url').length, 64);
  assert.ok(crypto.createVerify('SHA256').update(`${head}.${body}`)
    .verify({ key: pair.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')),
    'Apple would reject this signature');

  fs.rmSync(dir, { recursive: true, force: true });
});

await test('nothing is sent when the keys are not set', async () => {
  const { sendPush } = await import('../netlify/functions/lib/push.js');
  const out = await sendPush({ endpoint: 'https://x/y', p256dh: 'a', auth: 'b' }, { title: 'x' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'vapid_not_configured');
});

await test('the notification never writes its own words', () => {
  // The server sends what it already computed, so a notification can never
  // disagree with the brief it came from.
  const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  const nightly = readFileSync(new URL('../netlify/functions/brief-nightly.js', import.meta.url), 'utf8');
  assert.match(sw, /data\.body \|\|/);
  assert.match(nightly, /firstSentence\(out\.verdict\)/);
});

await test('the send hour is the user\'s own, not ours', () => {
  const nightly = readFileSync(new URL('../netlify/functions/brief-nightly.js', import.meta.url), 'utf8');
  assert.match(nightly, /profile\.brief_hour/);
  assert.match(nightly, /localMinutesFor\(profile\.timezone/);
});

group('Progress photos — the one place this could be cruel');

await test('nothing anywhere estimates anything from a photograph', () => {
  // A number invented from a picture of somebody's torso would break the
  // estimates-are-labelled doctrine exactly where it does the most harm.
  const api = readFileSync(new URL('../netlify/functions/api-photos.js', import.meta.url), 'utf8');
  const sql = readFileSync(new URL('../schema/009_wrought_photos.sql', import.meta.url), 'utf8');
  // The promise is in the copy; this checks the code cannot break it. Nothing
  // is sent to a model, nothing derives a body figure, nothing scores a pose.
  for (const tell of ['openai', 'vision', 'classify', 'body_fat', 'bodyfat', 'pose_score', 'detect']) {
    assert.ok(!new RegExp(tell, 'i').test(api), `api-photos reaches for ${tell}`);
  }
  assert.match(api, /body composition is estimated from a photograph/);
  assert.match(sql, /public, file_size_limit/);
});

await test('the bucket is private and namespaced by user', () => {
  const sql = readFileSync(new URL('../schema/009_wrought_photos.sql', import.meta.url), 'utf8');
  // A public bucket means every object is one guessed path from the open web.
  assert.match(sql, /'wrought-photos', false/);
  assert.match(sql, /set public = false/);
  assert.match(sql, /storage\.foldername\(name\)\)\[1\] = auth\.uid\(\)::text/);
});

await test('links to a photograph expire', async () => {
  const api = readFileSync(new URL('../netlify/functions/api-photos.js', import.meta.url), 'utf8');
  assert.match(api, /createSignedUrls/);
  assert.ok(!/getPublicUrl/.test(api), 'a permanent public URL is handed out');
  const { handler: photos } = await import('../netlify/functions/api-photos.js');
  assert.equal((await photos({ httpMethod: 'OPTIONS', headers: {} })).statusCode, 204);
  assert.equal(JSON.parse((await photos({ httpMethod: 'GET', headers: {} })).body).error, 'server_not_configured');
});

group('Direct device APIs — the fidelity upgrade');

const { PULL, PULL_PROVIDERS, connectUrl, credentialsFor } = await import('../netlify/functions/lib/pull.js');

await test('Withings comes first, because a scale reports the number people stop logging', () => {
  assert.equal(PULL_PROVIDERS[0], 'withings');
  assert.equal(PULL_PROVIDERS[1], 'strava');
});

await test('an unregistered provider says which variable is missing', () => {
  // "Connect Oura" that leads to somebody else's error page is worse than a
  // greyed-out button with a reason on it.
  for (const id of PULL_PROVIDERS) {
    assert.equal(credentialsFor(id), null);
    const out = connectUrl(id, { site: 'https://wrought.fit', state: 'x' });
    assert.equal(out.error, 'not_configured');
    assert.match(out.message, new RegExp(PULL[id].idEnv));
  }
});

await test('the callback state is signed and expires', async () => {
  // Unsigned, anybody could craft a callback attaching their provider account
  // to somebody else's record — which reads as an integration bug and is
  // actually a way to write into a stranger's health log.
  const src = readFileSync(new URL('../netlify/functions/api-device.js', import.meta.url), 'utf8');
  assert.match(src, /createHmac\('sha256'/);
  assert.match(src, /timingSafeEqual/);
  assert.match(src, /10 \* 60 \* 1000/);
});

await test('a pulled reading cannot double a day', () => {
  // Straight into the same table the Shortcut writes to, with source_ref set,
  // so the existing unique index deduplicates.
  const src = readFileSync(new URL('../netlify/functions/api-device.js', import.meta.url), 'utf8');
  assert.match(src, /onConflict: 'user_id,source,metric,measured_at'/);
  assert.match(src, /ignoreDuplicates: true/);
});

await test('Withings scaling is applied, or a 71kg person weighs seventy-one thousand', () => {
  const src = readFileSync(new URL('../netlify/functions/lib/pull.js', import.meta.url), 'utf8');
  assert.match(src, /Math\.pow\(10, Number\(m\.unit\)\)/);
});

await test('a rotating refresh token is kept when none comes back', () => {
  // The difference between a connection that lasts and one that dies quietly.
  const src = readFileSync(new URL('../netlify/functions/api-device.js', import.meta.url), 'utf8');
  assert.match(src, /t\.refresh_token \|\| conn\.refresh_token/);
});

group('The profile — a place to look, not a form');

await test('the profile endpoint refuses anonymous callers and passes preflight', async () => {
  const { handler: prof } = await import('../netlify/functions/api-profile.js');
  assert.equal((await prof({ httpMethod: 'OPTIONS', headers: {} })).statusCode, 204);
  assert.equal(JSON.parse((await prof({ httpMethod: 'GET', headers: {} })).body).error, 'server_not_configured');
});

await test('a bad timezone is rejected rather than stored', () => {
  // It would file every late-night snack under the wrong day and quietly
  // corrupt every brief from then on.
  const src = readFileSync(new URL('../netlify/functions/api-profile.js', import.meta.url), 'utf8');
  assert.match(src, /new Intl\.DateTimeFormat\('en', \{ timeZone: tz \}\)/);
  assert.match(src, /bad\.push\('timezone'\)/);
});

await test('bluntness and units only accept what the schema allows', () => {
  const src = readFileSync(new URL('../netlify/functions/api-profile.js', import.meta.url), 'utf8');
  assert.match(src, /\['gentle', 'honest', 'brutal'\]\.includes/);
  assert.match(src, /\['metric', 'imperial'\]\.includes/);
});

await test('administrator is read from the environment, never from the row', () => {
  // Never a column somebody could set on themselves, never a flag in a token.
  const src = readFileSync(new URL('../netlify/functions/api-profile.js', import.meta.url), 'utf8');
  assert.match(src, /WROUGHT_ADMIN_EMAILS/);
  assert.ok(!/is_admin|profile\.admin/.test(src), 'admin is read off the profile row');
});

await test('the avatar is private and nothing reads it', () => {
  const sql = readFileSync(new URL('../schema/010_wrought_profile_web.sql', import.meta.url), 'utf8');
  const src = readFileSync(new URL('../netlify/functions/api-profile.js', import.meta.url), 'utf8');
  assert.match(sql, /'wrought-avatars', false/);
  assert.match(sql, /storage\.foldername\(name\)\)\[1\] = auth\.uid\(\)::text/);
  assert.match(src, /createSignedUrl/);
  assert.ok(!/getPublicUrl/.test(src), 'a permanent public avatar URL is handed out');
  for (const tell of ['openai', 'vision', 'classify', 'body_fat', 'detect']) {
    assert.ok(!new RegExp(tell, 'i').test(src), `api-profile reaches for ${tell}`);
  }
});

await test('a replaced picture does not leave the old file behind', () => {
  const src = readFileSync(new URL('../netlify/functions/api-profile.js', import.meta.url), 'utf8');
  // And the delete happens AFTER the new path is recorded — the other order
  // leaves a profile pointing at nothing if the write fails.
  const record = src.indexOf("avatar_path: path");
  const remove = src.indexOf("remove([previous])");
  assert.ok(record > 0 && remove > record, 'the old avatar is removed before the new one is recorded');
});

await test('avatars and progress photos are separate buckets', () => {
  // Deleting every progress photo must not take somebody's profile picture with
  // it, and a bulk operation on one must never reach the other.
  const a = readFileSync(new URL('../netlify/functions/api-profile.js', import.meta.url), 'utf8');
  const b = readFileSync(new URL('../netlify/functions/api-photos.js', import.meta.url), 'utf8');
  assert.match(a, /BUCKET = 'wrought-avatars'/);
  assert.match(b, /BUCKET = 'wrought-photos'/);
});

group('Setting a phone up without flying blind');

await test('the key endpoint answers "did anything arrive"', () => {
  // The question somebody actually has at eleven at night with a half-built
  // Shortcut. Setting it up blind and finding out tomorrow is how people give
  // up on it tonight.
  const src = readFileSync(new URL('../netlify/functions/api-key.js', import.meta.url), 'utf8');
  assert.match(src, /wrought_metrics/);
  assert.match(src, /minutes_ago/);
  assert.match(src, /Nothing has arrived yet/);
});

await test('a plaintext key is still never recoverable', () => {
  // The status additions must not have turned the list into a way to read a key
  // back. It exists exactly once, on the screen it was minted on.
  const src = readFileSync(new URL('../netlify/functions/api-key.js', import.meta.url), 'utf8');
  const listArm = src.slice(src.indexOf("httpMethod === 'GET'"), src.indexOf("httpMethod === 'POST'"));
  assert.ok(!/token_hash|token\b/.test(listArm), 'the key list leaks a token');
  assert.match(src, /select\('id, label, last_used_at, revoked, created_at'\)/);
});

await test('the setup page polls only while somebody is watching', () => {
  // A tab left open for a week must not hit the server every ten seconds
  // forever.
  const page = readFileSync(new URL('../public/connect.html', import.meta.url), 'utf8');
  assert.match(page, /visibilitychange/);
  assert.match(page, /clearInterval\(watchTimer\)/);
  assert.ok(!/setInterval\(checkArrived, 10000\);\s*\n\s*(?!\})/.test(page.replace(/if \(e\.target\.checked\)[^\n]*/g, '')),
    'polling starts without being asked for');
});

group('The setup page — one look instead of a tour of broken screens');

await test('it answers without a database rather than falling over', async () => {
  const { handler: status } = await import('../netlify/functions/api-status.js');
  const res = await status({ httpMethod: 'GET', headers: {} });
  assert.equal(res.statusCode, 200);
  const b = JSON.parse(res.body);
  assert.equal(b.ready, false);
  // One thing to do next, not a list of eleven. A checklist that long is one
  // nobody starts.
  assert.ok(b.next && b.next.length > 10);
});

await test('it never prints a value, only whether one is set', async () => {
  const { handler: status } = await import('../netlify/functions/api-status.js');
  process.env.WROUGHT_ADMIN_EMAILS = 'someone@example.com';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'super-secret-service-role-key';
  try {
    for (const accept of [undefined, 'text/html']) {
      const res = await status({ httpMethod: 'GET', headers: accept ? { accept } : {} });
      assert.ok(!res.body.includes('someone@example.com'), 'the status page leaked an admin address');
      assert.ok(!res.body.includes('super-secret-service-role-key'), 'the status page leaked a key');
    }
  } finally {
    delete process.env.WROUGHT_ADMIN_EMAILS;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
});

await test('a check that could not run is not reported as a missing migration', () => {
  // Treating every error as "not run" sends somebody back to the SQL editor to
  // fix something that is not broken — and PostgREST says the same thing for
  // "you never ran this" and "I have not reloaded since you did".
  const src = readFileSync(new URL('../netlify/functions/api-status.js', import.meta.url), 'utf8');
  assert.match(src, /schema cache/);
  assert.match(src, /'stale'/);
  assert.match(src, /m\.run === false/);
  // Only a definite false counts toward the "still to run" list.
  assert.match(src, /migrations\.filter\(m => m\.run === false\)/);
  // And the page renders three states, not two.
  assert.match(src, /li\.q::before/);
});

await test('the trailing slash is caught by name', async () => {
  // It answers "Invalid path specified in request URL" and nothing anywhere
  // explains why. It has already cost this project an evening.
  const { handler: status } = await import('../netlify/functions/api-status.js');
  process.env.SUPABASE_URL = 'https://abc.supabase.co/';
  try {
    const b = JSON.parse((await status({ httpMethod: 'GET', headers: {} })).body);
    assert.equal(b.database.trailing_slash_on_url, true);
    assert.match(b.say, /trailing slash/i);
    assert.match(b.next, /trailing slash/i);
  } finally { delete process.env.SUPABASE_URL; }
});

await test('every migration in the repo is on the checklist', async () => {
  // A migration that ships without being checked here is one somebody forgets
  // to run and then hunts for through a broken screen.
  const { readdirSync } = await import('node:fs');
  // Numbered migrations only — ALL.sql is the generated concatenation of them,
  // not a migration in its own right.
  const files = readdirSync(new URL('../schema/', import.meta.url)).filter(f => /^\d{3}_.*\.sql$/.test(f));
  const src = readFileSync(new URL('../netlify/functions/api-status.js', import.meta.url), 'utf8');
  for (const f of files) assert.ok(src.includes(f), `${f} is missing from the setup checklist`);
});

await test('it asks search engines not to index it', () => {
  const src = readFileSync(new URL('../netlify/functions/api-status.js', import.meta.url), 'utf8');
  assert.match(src, /name="robots" content="noindex"/);
});

group('Connected assistants — a promise the consent screen makes');

await test('the consent screen promise is now something that exists', () => {
  // authorize.html has always said "revoke it any time from the dashboard".
  const consent = page('authorize.html');
  assert.match(consent, /Revoke it any time from the dashboard/i);
  assert.match(page('app.html'), /api-connections/);
  assert.match(page('app.html'), /Connected assistants/);
});

await test('revoking kills the refresh token too', async () => {
  // Access alone and the assistant mints a new one on its next call, so the
  // revoke looks like it silently failed.
  const src = readFileSync(new URL('../netlify/functions/api-connections.js', import.meta.url), 'utf8');
  assert.match(src, /wrought_oauth_tokens/);
  assert.match(src, /wrought_oauth_refresh/);
  assert.match(src, /wrought_oauth_codes/);
});

await test('a guessed client id cannot cut off somebody else', () => {
  const src = readFileSync(new URL('../netlify/functions/api-connections.js', import.meta.url), 'utf8');
  // Every delete arm is scoped to the caller before anything from the body is
  // applied.
  assert.match(src, /\.delete\(\)\.eq\('user_id', user\.id\)/);
});

await test('it never hands back a token, only that one exists', () => {
  const src = readFileSync(new URL('../netlify/functions/api-connections.js', import.meta.url), 'utf8');
  assert.match(src, /select\('client_id, scope, expires_at, created_at'\)/);
  assert.ok(!/token_hash/.test(src.slice(src.indexOf("httpMethod === 'GET'"))),
    'the connections list exposes a token hash');
});

await test('a client is named from its redirect, not its self-report', async () => {
  // client_name is registered by the client and can say anything at all.
  const src = readFileSync(new URL('../netlify/functions/api-connections.js', import.meta.url), 'utf8');
  const named = src.indexOf('openai|chatgpt');
  const selfReport = src.indexOf('client.client_name');
  assert.ok(named > 0 && named < selfReport, 'the self-reported name wins over the redirect');
});

await test('using a tool still requires a verified user', () => {
  // The handshake answers without auth so a client can discover the toolset —
  // that 401 is what makes "Sign in with Wrought" appear. Actually CALLING one
  // must not.
  const src = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const call = src.slice(src.indexOf("case 'tools/call'"), src.indexOf("case 'tools/call'") + 1600);
  assert.match(call, /if \(!authUser\) return \{ __unauthorized: true, id \};/);
  // And the check comes before anything is executed.
  assert.ok(call.indexOf('__unauthorized') < call.indexOf('await impl('));
});

group('Memberships, trials and codes');

const { membershipFor, allowed, makeCode, planSummary, ALWAYS_ALLOWED } =
  await import('../netlify/functions/lib/membership.js');

await test('no membership row means free and working', async () => {
  // The failure mode here is locking somebody out of their own health record,
  // so a missing row, a failed lookup and an un-migrated table all let the
  // request through.
  const m = await membershipFor('nobody');
  assert.equal(m.plan, 'free');
  assert.equal(m.status, 'active');
  const gate = await allowed('nobody', 'mcp');
  assert.equal(gate.ok, true);
});

await test('export works even for a suspended account', () => {
  // A hub you cannot leave is a trap, and that has to hold on the worst day of
  // the relationship rather than only the good ones.
  assert.ok(ALWAYS_ALLOWED.includes('api-export'));
  const src = readFileSync(new URL('../netlify/functions/lib/membership.js', import.meta.url), 'utf8');
  assert.match(src, /if \(ALWAYS_ALLOWED\.includes\(surface\)\) return \{ ok: true \};/);
  // And the message a suspended person sees says so.
  assert.match(src, /still export all of it/i);
});

await test('an expired trial drops to free rather than blocking', () => {
  // Ending a trial by taking away access to a year of somebody's own training
  // is not a business model.
  const src = readFileSync(new URL('../netlify/functions/lib/membership.js', import.meta.url), 'utf8');
  assert.match(src, /plan: lapsed \? 'free'/);
  assert.match(src, /if \(m\.status !== 'revoked'\) return \{ ok: true/);
  assert.match(planSummary({ plan: 'free', was: 'trial', lapsed: true, status: 'active' }), /nothing was lost/i);
});

await test('codes can be read down a phone', () => {
  // No 0/O and no 1/I. A code that cannot be dictated is a support ticket.
  for (let i = 0; i < 200; i++) {
    const c = makeCode('WROUGHT');
    assert.ok(!/[O0I1]/.test(c.replace(/^WROUGHT/, '')), `ambiguous character in ${c}`);
  }
});

await test('redeeming is one transaction, so a last use cannot be spent twice', () => {
  const sql = readFileSync(new URL('../schema/011_wrought_membership.sql', import.meta.url), 'utf8');
  assert.match(sql, /for update/);
  assert.match(sql, /used_count >= c\.max_uses/);
  assert.match(sql, /already_redeemed/);
  // And stacking two codes extends rather than shortens.
  assert.match(sql, /greatest\(coalesce\(wrought_memberships\.expires_on/);
});

await test('nobody can set their own plan', () => {
  const sql = readFileSync(new URL('../schema/011_wrought_membership.sql', import.meta.url), 'utf8');
  // Read-only for the member; writes are service-role only.
  assert.match(sql, /for select using \(auth\.uid\(\) = user_id\)/);
  assert.ok(!/for all using \(auth\.uid\(\) = user_id\)[\s\S]*wrought_memberships/.test(sql));
  assert.match(sql, /grant execute on function public\.wrought_redeem_code\(text, uuid\) to service_role/);
});

await test('the operator cannot lock themselves out', async () => {
  const src = readFileSync(new URL('../netlify/functions/api-admin.js', import.meta.url), 'utf8');
  assert.match(src, /cannot_revoke_yourself/);
});

group('The operator sees who, never what');

await test('the people list cannot return anything anybody logged', () => {
  const src = readFileSync(new URL('../netlify/functions/api-admin.js', import.meta.url), 'utf8');
  const peopleArm = src.slice(src.indexOf('async function people()'), src.indexOf('async function codes()'));
  // It reads wrought_events for COUNTS only — user_id and a date, never detail.
  assert.match(peopleArm, /select\('user_id, local_date'\)/);
  for (const leak of ['detail', 'weight_kg', 'calories', 'protein', 'exercise', 'wrought_sets', 'wrought_photos', 'wrought_memory']) {
    assert.ok(!new RegExp(leak).test(peopleArm), `the people list reaches for ${leak}`);
  }
});

await test('the privacy line is stated on the response, not just in a comment', async () => {
  const src = readFileSync(new URL('../netlify/functions/api-admin.js', import.meta.url), 'utf8');
  assert.match(src, /Never what they logged/i);
  const { handler: admin } = await import('../netlify/functions/api-admin.js');
  // Still refuses anonymous callers with everything new bolted on.
  assert.equal(JSON.parse((await admin({ httpMethod: 'GET', headers: {} })).body).error, 'server_not_configured');
});

await test('suspension is relayed as words, not a broken connector', () => {
  // A protocol error shows up in ChatGPT as "the connector is not working",
  // which is both wrong and unhelpful to somebody who has just been cut off.
  const src = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  assert.match(src, /const gate = await allowed\(authUser\.id, 'mcp'\);/);
  assert.match(src, /isError: true/);
});

group('One paste, not eleven');

await test('schema/ALL.sql is current', async () => {
  // A stale ALL.sql missing the newest migration is worse than not having one:
  // somebody runs it, believes they are set up, and finds out through a broken
  // screen a week later.
  const { readdirSync } = await import('node:fs');
  const dir = new URL('../schema/', import.meta.url);
  const files = readdirSync(dir).filter(f => /^\d{3}_.*\.sql$/.test(f)).sort();
  const all = readFileSync(new URL('ALL.sql', dir), 'utf8');

  for (const f of files) {
    assert.ok(all.includes(f), `${f} is not in ALL.sql — run node scripts/build-all-sql.mjs`);
    // Not just named in the header — the actual contents have to be there.
    const body = readFileSync(new URL(f, dir), 'utf8').trim();
    const firstStatement = body.split('\n').find(l => l.trim() && !l.trim().startsWith('--'));
    assert.ok(all.includes(firstStatement.trim()),
      `${f} is listed in ALL.sql but its SQL is missing — run node scripts/build-all-sql.mjs`);
  }
  // And in order, so a table lands before the thing referencing it.
  let at = -1;
  for (const f of files) {
    const i = all.indexOf(`── ${f} ──`);
    assert.ok(i > at, `${f} is out of order in ALL.sql`);
    at = i;
  }
});

group('The browser gets its keys without a manual step');

await test('config.js serves both public values from the environment', async () => {
  const { handler: config } = await import('../netlify/functions/config.js');
  process.env.SUPABASE_URL = 'https://abc.supabase.co/';
  process.env.SUPABASE_ANON_KEY = 'anon-publishable-key';
  try {
    const res = await config();
    assert.equal(res.headers['Content-Type'], 'application/javascript; charset=utf-8');
    // The trailing slash is stripped here too, or Supabase answers "Invalid
    // path specified in request URL" from the browser this time.
    assert.match(res.body, /window\.WROUGHT_SUPABASE_URL = "https:\/\/abc\.supabase\.co"/);
    assert.match(res.body, /window\.WROUGHT_SUPABASE_ANON = "anon-publishable-key"/);
  } finally {
    delete process.env.SUPABASE_URL; delete process.env.SUPABASE_ANON_KEY;
  }
});

await test('the service role key never reaches the browser', async () => {
  const { handler: config } = await import('../netlify/functions/config.js');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-must-never-ship';
  try {
    const res = await config();
    assert.ok(!res.body.includes('service-role-must-never-ship'));
    const src = readFileSync(new URL('../netlify/functions/config.js', import.meta.url), 'utf8');
    assert.ok(!/SERVICE_ROLE/.test(src.replace(/^\s*\/\/.*$/gm, '')), 'config.js touches the service role key');
  } finally { delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

await test('it says which variable is missing rather than failing silently', async () => {
  const { handler: config } = await import('../netlify/functions/config.js');
  const res = await config();
  assert.match(res.body, /console\.warn/);
  assert.match(res.body, /SUPABASE_URL|SUPABASE_ANON_KEY/);
});

await test('every sign-in page loads it before its module', () => {
  // Order matters: the module reads these off window as its first statements.
  for (const f of ['app.html', 'authorize.html', 'connect.html']) {
    const src = page(f);
    assert.ok(src.indexOf('/config.js') > 0, `${f} never loads config.js`);
    assert.ok(src.indexOf('/config.js') < src.indexOf('<script type="module">'),
      `${f} loads config.js after the module that needs it`);
  }
});

group('A door that does not open is not offered');

await test('provider buttons are hidden when Supabase has them off', () => {
  // signInWithOAuth NAVIGATES, so a disabled provider answers with raw JSON on
  // Supabase's own domain — "Unsupported provider: provider is not enabled" —
  // and no error handling on our page ever runs. The only fix is the button
  // not being there.
  for (const f of AUTH_PAGES) {
    const src = page(f);
    assert.match(src, /auth\/v1\/settings/, `${f} never asks which providers are on`);
    assert.match(src, /external\[b\.dataset\.provider\] === false/, `${f} does not hide dead providers`);
  }
});

await test('an unreachable settings call leaves the buttons showing', () => {
  // Hiding a working door locks somebody out, which is the worse of the two
  // mistakes — so the failure direction is deliberate.
  const src = page('app.html');
  assert.match(src, /if \(!external\) return;/);
  assert.match(src, /hiding a working door locks somebody out/i);
});

group('A new account looks like the product, not like it failed');

await test('a first run gets its own screen, not nine empty panels', () => {
  // Nine panels all saying "not enough data yet" reads as broken software
  // rather than an empty log — on the one screen somebody judges the product by.
  const src = page('app.html');
  assert.match(src, /function isFirstRun\(d\)/);
  assert.match(src, /if \(isFirstRun\(d\)\) \{/);
  // And it is only the first run: any logging, training or device data at all
  // and the real dashboard renders.
  assert.match(src, /return !logged && !trained && !device;/);
});

await test('the dashboard carries the mark like every other page', () => {
  assert.match(page('app.html'), /<a class="mark" href="#record"[^>]*>\s*<img src="\/icon\.svg"/);
});

await test('you can sign out and switch accounts', () => {
  // There was no way to sign out at all, which is why it felt like being
  // auto-signed-in with no say in it.
  const src = page('app.html');
  assert.match(src, /id="signout"/);
  assert.match(src, /id="switch"/);
  assert.match(src, /sb\.auth\.signOut\(\)/);
  // Switching lands on the sign-in screen, not the marketing homepage.
  assert.match(src, /location\.href = '\/app\.html';/);
});

await test('signing out does not pretend to disconnect the assistant', () => {
  // They are separate sessions, and saying otherwise sends somebody hunting
  // for a connector that is still working perfectly.
  assert.match(page('app.html'), /does not disconnect your AI/i);
});

group('Height in whatever unit you actually think in');

await test('the height control follows the unit setting', () => {
  // It was hard-labelled "Height (cm)" whatever units somebody picked, so an
  // imperial user got a box that meant something other than it said. It is a
  // slider now, and the RANGE is what carries the unit.
  const src = page('app.html');
  assert.match(src, /min="\$\{imp \? 54 : 137\}"/);
  assert.match(src, /fromCm\(isImp \? Number\(el\.value\) \* 2\.54 : Number\(el\.value\), isImp\)/);
  assert.match(src, /\$\('f-units'\)\.addEventListener\('change'/);
});

await test('feet and inches parse the way people write them', () => {
  const src = page('app.html');
  const fns = src.match(/function fromCm[\s\S]*?\n}\n/)[0] + src.match(/function toCm[\s\S]*?\n}\n/)[0];
  const { toCm, fromCm } = new Function(`${fns};return {toCm,fromCm};`)();

  for (const written of ["5'11", '5 11', '5-11', '71', "5'11\"", '5’11']) {
    assert.equal(Math.round(toCm(written, true) * 10) / 10, 180.3, `${written} did not parse`);
  }
  assert.equal(Math.round(toCm('6', true) * 10) / 10, 182.9);      // bare, under 9 → feet
  assert.equal(toCm('180', false), 180);                            // metric stays metric
  assert.equal(toCm('', true), null);
  assert.ok(Number.isNaN(toCm('nonsense', true)));
});

await test('the record stays metric whatever the display says', () => {
  // Display is a preference; storage is not. Otherwise somebody who switches
  // units mid-year ends up with a height series in two scales.
  const src = page('app.html');
  assert.match(src, /Storage is always centimetres/);
  const { fromCm } = new Function(`${src.match(/function fromCm[\s\S]*?\n}\n/)[0]};return {fromCm};`)();
  assert.equal(fromCm(180, false), '180');
  assert.equal(fromCm(180, true), "5'11");
  assert.equal(fromCm(182.9, true), "6'0");   // must not render 5'12"
  assert.equal(fromCm(null, true), '');
});

group('The run itself, not just the calories it burned');

await test('Health Auto Export workouts are read, not thrown away', async () => {
  // HAE puts workouts under data.workouts and this endpoint read only
  // data.metrics — so a watch-recorded 5k arrived as a number in the day's
  // active energy and the run vanished. The brief then said "rest day" to
  // somebody who had just run.
  const src = readFileSync(new URL('../netlify/functions/ingest.js', import.meta.url), 'utf8');
  assert.match(src, /function flattenHealthAutoExportWorkouts/);
  assert.match(src, /flattenHealthAutoExportWorkouts\(body\)\.map\(normaliseWorkout\)/);
});

await test('a watch run keeps its distance, its minutes and its identity', () => {
  const w = normaliseWorkout({ kind: 'Running', minutes: 32, distance_km: 5.2, calories: 410 });
  assert.equal(w.event_type, 'workout');
  assert.match(w.summary, /Running/);
  assert.match(w.summary, /5\.2 km/);
  assert.match(w.summary, /32 min/);
  assert.equal(w.detail.distance_km, 5.2);
  // Cardio counts as whole-body in the matrix, or a runner's brief tells them
  // they have not trained — wrong and insulting at the same time.
  assert.deepEqual(w.detail.muscles, ['full body']);
});

await test('miles convert, and seconds are not filed as minutes', () => {
  const src = readFileSync(new URL('../netlify/functions/ingest.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function flattenHealthAutoExportWorkouts'), src.indexOf('export const handler'));
  // HAE ships distance in km or miles depending on the phone's settings.
  assert.match(fn, /1\.609344/);
  // "duration" is seconds in HAE's own export and minutes in some forks. A
  // 7,200-minute run is a worse error than a rounding.
  assert.match(fn, /minutes > 600/);
  // The workout's own identity, so re-exporting a week never doubles it.
  assert.match(fn, /source_ref: w\.id/);
});

group('A daily total replaces its day, it does not add to it');

await test('the cumulative metrics are named, and the point-in-time ones are not', () => {
  // Steps and active calories arrive as the running total SO FAR TODAY, and
  // the row carries the moment it was SENT — so running the Shortcut at
  // teatime and again at eleven counted the day twice, and idempotency on
  // measured_at could never catch it because both sends genuinely happened.
  const src = readFileSync(new URL('../netlify/functions/ingest.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('const DAILY_TOTALS'), src.indexOf('let written = 0;'));
  for (const m of ['steps', 'active_calories', 'total_calories', 'distance_km', 'active_minutes']) {
    assert.ok(block.includes(`'${m}'`), `${m} is not treated as a daily total`);
  }
  // Three weigh-ins in a day are three real facts. Collapsing point-in-time
  // readings would throw the record away rather than repair it.
  for (const m of ['weight_kg', 'resting_hr', 'glucose', 'sleep_minutes', 'hrv']) {
    assert.ok(!block.includes(`'${m}'`), `${m} must not be collapsed to one a day`);
  }
  // The older reading for that source/metric/day is removed before the new one
  // lands, scoped to the user.
  assert.match(block, /\.delete\(\)/);
  assert.match(block, /\.eq\('user_id', userId\)/);
  assert.match(block, /\.eq\('local_date', r\.local_date\)/);
  // And within one payload, the last reading for a day is the one it meant.
  assert.match(block, /keep\.set\(/);
});

group('What an Apple Shortcut actually types');

await test('the number is dug out of whatever wrapping it arrived in', () => {
  // A Health Sample dropped into a Text action renders human: "8,412",
  // "331 lb", "54 count/min". Refusing the comma fails the exact person the
  // /ingest door was built for — somebody hand-assembling a Shortcut at
  // midnight. The unit still comes from the declared field, never parsed out
  // of the value, so "331 lb" with unit lb converts once and not twice.
  assert.equal(looseNumber('8,412'), 8412);
  assert.equal(looseNumber('331 lb'), 331);
  assert.equal(looseNumber('54 count/min'), 54);
  assert.equal(looseNumber(82.6), 82.6);
  assert.ok(Number.isNaN(looseNumber('')));
  assert.ok(Number.isNaN(looseNumber('no numbers here')));

  assert.deepEqual(normalise('steps', '8,412', 'count'), { value: 8412, unit: 'count' });
  assert.equal(normalise('weight_kg', '331 lb', 'lb').value, 150.14);
  assert.equal(normalise('resting_hr', '54 count/min', 'bpm').value, 54);
  assert.equal(normalise('steps', 'nothing', 'count'), null);
});

group('The device key, without the ceremony');

await test('the first key mints itself and copies in one tap', () => {
  // "Too many steps." Sign-in used to lead to a Generate button, then a copy,
  // then a paste — two of those were ceremony. A first key now appears the
  // moment somebody arrives signed in, with a Copy button. Existing keys keep
  // the explicit button, because hashed keys can never be re-shown.
  const src = page('connect.html');
  assert.match(src, /async function autoKey\(\)/);
  assert.match(src, /if \(\(state\.keys \|\| \[\]\)\.length\) return;/);
  assert.match(src, /navigator\.clipboard\.writeText\(key\)/);
  // One rendering of a fresh key — the manual button reuses it. (The existing-
  // keys list also uses the keybox style, which is fine: it never holds a raw key.)
  assert.equal([...src.matchAll(/id="keyval"/g)].length, 1, 'the fresh key is rendered in two places');
});

await test('the one-tap Shortcut panel is honest until the link exists', () => {
  // Apple mints share links on-device only, so the pre-built Shortcut is the
  // one artefact the repo cannot generate. Until the founder shares it once
  // and pastes the URL, the panel says so — never a dead button.
  const src = page('connect.html');
  assert.match(src, /The easy way — three taps/);
  assert.match(src, /const SHORTCUT_URL = ''/);
  assert.match(src, /not published yet/);
  // And the automation limit is stated as Apple's rule, not our laziness.
  assert.match(src, /Apple's rule/);
});

group('The mark, everywhere a client might look for it');

await test('the handshake carries the icon and the site', async () => {
  // A client that has just completed a handshake should not have to fetch a
  // second document to find out what the thing it is talking to looks like.
  const res = await handleRpc({ id: 1, method: 'initialize', params: {} }, null);
  const info = res.result.serverInfo;
  assert.equal(info.websiteUrl, 'https://wrought.fit');
  assert.ok(Array.isArray(info.icons) && info.icons.length >= 2);
  for (const i of info.icons) {
    // Absolute, or a client resolving it against its own origin gets nothing.
    assert.match(i.src, /^https:\/\/wrought\.fit\//);
    assert.ok(i.mimeType);
  }
  // PNG FIRST. Clients routinely refuse remote SVG (it can carry script), take
  // the first usable entry, and fall back to a grey monogram — which is
  // exactly the unprofessional tile the founder kept seeing.
  assert.equal(info.icons[0].mimeType, 'image/png');
  assert.equal(info.icons[info.icons.length - 1].mimeType, 'image/svg+xml');
});

await test('the negotiated version is one that carries icons', async () => {
  // icons on serverInfo entered the spec after 2025-06-18. A client offering
  // the newer revision must get it echoed, or it may discard the icons as
  // unknown fields — and an unknown FUTURE version must not be blindly
  // mirrored, because that claims support for a spec nobody has read.
  const newer = await handleRpc({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }, null);
  assert.equal(newer.result.protocolVersion, '2025-11-25');
  const unknown = await handleRpc({ id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } }, null);
  assert.equal(unknown.result.protocolVersion, '2025-06-18');
});

await test('the OAuth metadata and the manifest agree with it', async () => {
  const { handler: meta } = await import('../netlify/functions/oauth-metadata.js');
  const res = await meta({ httpMethod: 'GET', headers: {}, path: '/.well-known/oauth-authorization-server' });
  const body = JSON.parse(res.body);
  assert.match(body.logo_uri || '', /icon-192\.png$/);

  const manifest = JSON.parse(readFileSync(new URL('../public/.well-known/mcp.json', import.meta.url), 'utf8'));
  assert.ok(manifest.icons?.length);
  // Same mark in both, PNG first for the same reason as the handshake.
  assert.equal(manifest.icons[0].src, 'https://wrought.fit/icon-512.png');
});

await test('the icon is served cross-origin or a listing renders nothing', () => {
  // Directories and clients fetch it from their own domain.
  const toml = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
  const iconBlock = toml.slice(toml.indexOf('for = "/icon.svg"'), toml.indexOf('for = "/llms.txt"'));
  assert.match(iconBlock, /Access-Control-Allow-Origin = "\*"/);
});

group('Addressed by name means the question is for WROUGHT');

await test('the nicknames are all mapped, not just some of them', () => {
  // "Hey Jim bro, what account am I on?" got answered about the ChatGPT
  // account — confidently, uselessly wrong, and indistinguishable from right.
  // "gym bro" is the real phrase; "jim bro" is only ever voice-to-text mangling
  // it, and both have to land in the same place.
  for (const name of ['gym bro', 'hey gym bro', 'jim bro', 'broski', 'broheim', 'coach', 'trainer']) {
    assert.ok(SERVER_INSTRUCTIONS.toLowerCase().includes(name), `"${name}" is not in the phrasebook`);
  }
});

await test('a nickname forbids answering from the model\'s own context', () => {
  assert.match(SERVER_INSTRUCTIONS, /BEING ADDRESSED BY NAME MEANS THE QUESTION IS FOR WROUGHT/);
  assert.match(SERVER_INSTRUCTIONS, /MUST BE ANSWERED FROM A TOOL/);
  assert.match(SERVER_INSTRUCTIONS, /Never answer it from what you already know/i);
  // And a fallback, so an unmapped question still reaches a tool.
  assert.match(SERVER_INSTRUCTIONS, /call get_profile and answer from that/i);
});

await test('asking which account is a mapped question', () => {
  for (const phrase of ['what account am I on', 'who am I', 'is this connected', 'plugged in']) {
    assert.ok(SERVER_INSTRUCTIONS.includes(phrase), `"${phrase}" maps to nothing`);
  }
});

group('The phone screen actually fits');

await test('the tab row is in the header and nothing is pinned', () => {
  // It was a fixed bottom bar, and it was wrong twice over: the founder wanted
  // the tabs at the top, and backdrop-filter on the header made the header the
  // containing block for anything fixed inside it, so the bar hung off the top
  // of the screen with the first and last tabs clipped.
  const src = page('app.html');
  const phone = src.slice(src.indexOf('@media (max-width: 700px)'));
  assert.ok(!/position: fixed/.test(phone), 'something in the phone layout is still pinned');
  assert.match(phone, /overflow-x: auto/);
  // Tabs do not shrink; the row scrolls instead.
  assert.match(phone, /flex: 0 0 auto/);
});

await test('switching accounts is reachable from every view', () => {
  // It was buried at the bottom of one tab. Somebody juggling two accounts
  // should not have to find a tab to get out.
  const src = page('app.html');
  assert.match(src, /id="whoami"/);
  assert.match(src, /id="whoami-switch"/);
  assert.match(src, /id="whoami-out"/);
  // Outside <main>, so it survives every re-render of the content area.
  assert.ok(src.indexOf('id="whoami"') > src.indexOf('id="content"'));
});

group('Two accounts, one person — without a password or an email');

await test('the assistant can mint proof of the account it is on', () => {
  assert.ok(TOOLS.some(t => t.name === 'link_account'), 'link_account is not declared');
  const tool = TOOLS.find(t => t.name === 'link_account');
  // It must not read as destructive: minting a code moves nothing.
  assert.equal(tool.annotations.destructiveHint, false);
  assert.match(tool.description, /paste it into wrought\.fit/i);
  assert.match(tool.description, /KEEPS WORKING/);
});

await test('the code is a proof, not a password reset', () => {
  const sql = readFileSync(new URL('../schema/012_wrought_link_codes.sql', import.meta.url), 'utf8');
  // Single use, short lived, and claimed under a lock so two requests arriving
  // together cannot both spend it.
  assert.match(sql, /for update/);
  assert.match(sql, /used_at is not null/);
  assert.match(sql, /expires_at < now\(\)/);
  // Unreachable from a browser.
  assert.match(sql, /revoke all on function public\.wrought_claim_link_code\(text\) from authenticated/);
  assert.match(sql, /grant execute on function public\.wrought_claim_link_code\(text\) to service_role/);
});

await test('the merge still refuses to take an email or an id', () => {
  const src = readFileSync(new URL('../netlify/functions/api-merge.js', import.meta.url), 'utf8');
  assert.ok(!/body\.(other_)?(email|user_id)\b/.test(src), 'the merge accepts something guessable');
  // Both proofs, and both resolve to a verified user rather than a claim.
  assert.match(src, /body\.code/);
  assert.match(src, /body\.other_token/);
  assert.match(src, /wrought_claim_link_code/);
  assert.match(src, /auth\.admin\.getUserById\(claimedId\)/);
});

await test('a bad code says which of the three things it was', () => {
  const src = readFileSync(new URL('../netlify/functions/api-merge.js', import.meta.url), 'utf8');
  assert.match(src, /wrong, already used, or older than ten minutes/);
});

await test('the dashboard offers the code route first', () => {
  // It is the one that works for somebody who cannot get into the other
  // account at all, which is exactly who needs this.
  const src = page('app.html');
  assert.match(src, /id="mo-code"/);
  assert.ok(src.indexOf('id="mo-code"') < src.indexOf('id="mo-email"'),
    'the password route is offered before the code route');
  assert.match(src, /link my accounts/i);
});

await test('connecting never happens without being asked which account', () => {
  // The one moment a split account is created. This screen used to see a live
  // browser session and finish on the spot, so whichever address the phone
  // happened to be signed in as became the account the assistant wrote to,
  // forever, without ever being shown. Reconnecting to CHANGE account was
  // therefore impossible — it silently reconnected the same one.
  const src = page('authorize.html');
  assert.match(src, /id="already"/);
  assert.match(src, /id="already-email"/);
  assert.match(src, /Use a different account/);

  // A session on its own is never enough. Both the load path and the auth
  // listener demand a recorded choice.
  assert.match(src, /if \(sessionStorage\.getItem\(CHOSE\) === '1'\) return complete/);
  assert.match(src, /session && req && sessionStorage\.getItem\(CHOSE\) === '1'/);

  // A fresh authorization request asks again rather than reusing the last
  // answer, and the answer does not outlive the connection it was given for.
  const fresh = src.match(/if \(params\.client_id\) \{([\s\S]*?)\n\}/)[1];
  assert.match(fresh, /removeItem\(CHOSE\)/);
  assert.match(src, /removeItem\(STASH\);\s*\n\s*sessionStorage\.removeItem\(CHOSE\)/);

  // Switching out signs this browser out only — they asked to change account
  // here, not to be logged out on every device they own.
  assert.match(src, /signOut\(\{ scope: 'local' \}\)/);
});

await test('the phrasebook knows what a split account sounds like', () => {
  assert.match(SERVER_INSTRUCTIONS, /TWO ACCOUNTS, ONE PERSON/);
  assert.match(SERVER_INSTRUCTIONS, /An email address is not a person/);
  for (const phrase of ['I have two accounts', 'my dashboard is empty', 'link my accounts']) {
    assert.ok(SERVER_INSTRUCTIONS.includes(phrase), `"${phrase}" maps to nothing`);
  }
});

await test('"link my accounts" is never answered with a menu of services', () => {
  // What actually happened: "link my accounts" came back as "which account —
  // Wrought, Gmail, Google Calendar, or something else?" The assistant read it
  // as a question about ITS connectors. Asked of this server there is only one
  // thing the word can mean.
  assert.match(SERVER_INSTRUCTIONS, /NOT A QUESTION ABOUT WHICH SERVICE/);
  assert.match(SERVER_INSTRUCTIONS, /do not offer a list/i);
  for (const phrase of ['hook up my two emails', 'link my emails', 'two emails', 'give me a link code']) {
    assert.ok(SERVER_INSTRUCTIONS.includes(phrase), `"${phrase}" maps to nothing`);
  }
});

await test('a working connector is never mistaken for joined accounts', () => {
  // The second half of the same failure: told "Wrought", the assistant replied
  // "Wrought is linked and working, your account is <address>" — true, and the
  // exact state somebody is in when the two accounts are still separate. The
  // connector works perfectly, against the wrong one.
  assert.match(SERVER_INSTRUCTIONS, /THE CONNECTOR IS WORKING" IS NOT AN ANSWER/);
  assert.match(SERVER_INSTRUCTIONS, /never treat the account\.email on get_profile as confirmation/i);
});

await test('get_profile carries the linking pointer even when the account is full', () => {
  // fork_check only fires on an empty account, and the split the founder hit
  // was the other way round: the connector had a meal on it and the WEBSITE
  // account was bare. So the pointer travels on every profile, not just an
  // empty one, because this side can never see the other.
  const src = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('fork_check:'), src.indexOf('fork_check:') + 1600);
  assert.match(body, /linking:/, 'get_profile does not carry a linking note');
  assert.match(body, /call link_account/);
  assert.ok(!/linking:\s*\(count/.test(body), 'the linking note is conditional on the count again');
});

group('A number they remember is a claim, not a load');

const { baselineFromClaim } = await import('../netlify/functions/lib/training.js');

await test('a claim is always discounted before it touches a bar', () => {
  // A remembered number is the most flattering version of a lift — best day,
  // bounciest bar, rounded up, often years old. Programming it as fact is how
  // a product hands somebody a weight that hurts them.
  const c = baselineFromClaim({ claimed_kg: 84, claimed_reps: 8, target_reps: 8 });
  assert.equal(c.verdict, 'calibration');
  assert.ok(c.weight_kg < 84, 'the claim was programmed as-is');
  assert.equal(c.weight_kg, 75);           // 10% back, floored to a real plate
  assert.match(c.say, /calibration/);
  assert.match(c.note, /claim never enters the log/i);
});

await test('a claimed max is the least trustworthy number in any gym', () => {
  // Deeper discount, and Epley converts it to the target rep range rather than
  // anyone attempting it.
  const c = baselineFromClaim({ claimed_kg: 140, kind: 'max', target_reps: 8 });
  assert.equal(c.discount_pct, 15);
  assert.equal(c.weight_kg, 92.5);
  const working = baselineFromClaim({ claimed_kg: 140, claimed_reps: 8, target_reps: 8 });
  assert.ok(c.weight_kg < working.weight_kg, 'a max claim was trusted as much as a working claim');
});

await test('a beginner claim gets held back further, and nonsense is refused', () => {
  const b = baselineFromClaim({ claimed_kg: 60, claimed_reps: 8, target_reps: 8, tier: 'beginner' });
  const i = baselineFromClaim({ claimed_kg: 60, claimed_reps: 8, target_reps: 8 });
  assert.ok(b.weight_kg < i.weight_kg);
  assert.equal(baselineFromClaim({ claimed_kg: 'lots' }).verdict, 'refuse');
  assert.equal(baselineFromClaim({ claimed_kg: 2, claimed_reps: 8 }).verdict, 'refuse');
});

await test('the record always beats the memory', () => {
  // calibrate_lift refuses to let a claim override logged history — a
  // remembered 100 must never outrank a performed 85.
  const src = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function calibrateLift('), src.indexOf('async function endSession('));
  assert.match(fn, /history_wins/);
  assert.match(fn, /the record beats the memory/i);
  // The claim is kept as a memory, never inserted as a set.
  assert.match(fn, /rememberFact/);
  assert.ok(!/wrought_sets['"\)]*\.insert|from\('wrought_sets'\)\s*\.insert/.test(fn), 'the claim is being written into set history');
});

await test('the instructions forbid the dangerous versions outright', () => {
  assert.match(SERVER_INSTRUCTIONS, /A NUMBER THEY REMEMBER IS A CLAIM, NOT A LOAD/);
  assert.match(SERVER_INSTRUCTIONS, /never suggest testing a max/i);
  assert.match(SERVER_INSTRUCTIONS, /ask ONCE/);
  assert.match(SERVER_INSTRUCTIONS, /rounding a stranger's memory upward/i);
  for (const phrase of ['I usually bench 185', 'my max is 315', 'I can do 80 for 8']) {
    assert.ok(SERVER_INSTRUCTIONS.includes(phrase), `"${phrase}" maps to nothing`);
  }
});

group('The about page, and the tutorial that lives in the conversation');

await test('the about page says the name, the manual, and the way out', () => {
  const src = page('about.html');
  // The name explained — wrought as worked iron — because "what does wrought
  // mean" is the first question the brand invites.
  assert.match(src, /past tense of/);
  assert.match(src, /wrought iron/i);
  // The manual is example sentences, not feature lists — talking IS the manual.
  assert.match(src, /Talk normally/);
  assert.match(src, /machine's taken/);
  // The refusals are on the page — the honesty is the differentiator and it is
  // said before anybody connects, not discovered after.
  assert.match(src, /It will not flatter you/);
  assert.match(src, /not a medical device/i);
  // And the export promise, because "give us your record" is only a fair ask
  // next to "and here is the door".
  assert.match(src, /JSON or CSV/);
  assert.match(src, /even if you stop paying/i);
  // Linked from the marketing footer.
  assert.match(page('index.html'), /<a href="\/about\.html">About<\/a>/);
});

await test('the tutorial is a tool, not the model\'s memory of a README', () => {
  const g = TOOLS.find(t => t.name === 'guide');
  assert.ok(g, 'no guide tool');
  assert.ok(g.annotations.readOnlyHint);
  for (const phrase of ['how do I use this', 'what does wrought mean', 'what can you do', 'tutorial']) {
    assert.ok(SERVER_INSTRUCTIONS.includes(phrase), `"${phrase}" maps to nothing`);
  }
  const src = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function guide('), src.indexOf('async function setProfile('));
  assert.match(fn, /past tense of/);
  assert.match(fn, /what_it_refuses/);
  assert.match(fn, /do not recite the whole manual/i);
});

await test('a photo of the gym becomes an equipment list — and never reaches us', () => {
  // Same architecture as the dinner plate: the connected model reads the
  // image, only the extraction arrives here. Multiple gyms are normal and
  // named; the plan is built from what the photos actually showed.
  assert.match(SERVER_INSTRUCTIONS, /A PHOTOGRAPH OF A GYM IS AN EQUIPMENT LIST/);
  assert.match(SERVER_INSTRUCTIONS, /this server never sees images/);
  assert.match(SERVER_INSTRUCTIONS, /category "gym"/);
  assert.match(SERVER_INSTRUCTIONS, /More than one gym is normal/);
  assert.match(SERVER_INSTRUCTIONS, /Never build a plan around a machine their photos did not show/);
});

group('A body goal becomes numbers, computed — never guessed');

const { goalCall } = await import('../netlify/functions/lib/training.js');
const GOAL_P = { height_cm: 183, birth_year: 1982, sex: 'male', activity_level: 'moderate' };

await test('loss is paced to the body it is for, and the deficit is clamped', () => {
  // A model asked for a cutting target says 1,500 to a 150kg man and a 60kg
  // woman alike. The server paces at 0.5% of bodyweight a week, deficit
  // clamped 300..750 — so the heavy man is not starved and the light woman is
  // not handed a rounding-error deficit that does nothing.
  const heavy = goalCall({ profile: GOAL_P, weightKg: 150, intent: 'lose' });
  assert.equal(heavy.maintenance - heavy.calorie_target, 750, 'the deficit cap did not bind');
  const light = goalCall({ profile: { height_cm: 160, birth_year: 1998, sex: 'female', activity_level: 'sedentary' }, weightKg: 50, intent: 'lose' });
  assert.equal(light.maintenance - light.calorie_target, 300, 'the deficit floor did not bind');
});

await test('the intake target never lands below the care floor', () => {
  // The product must not prescribe the thing careFlags() warns about.
  const tiny = goalCall({ profile: { height_cm: 150, birth_year: 2000, sex: 'female' }, weightKg: 42, intent: 'lose' });
  assert.ok(tiny.calorie_target >= 1200, `target ${tiny.calorie_target} is under the care floor`);
});

await test('gaining is a small surplus, and protein is capped', () => {
  const g = goalCall({ profile: GOAL_P, weightKg: 150, intent: 'gain' });
  assert.equal(g.calorie_target - g.maintenance, 250, 'the surplus is not small');
  // 1.6 g/kg at 150kg would be 240g; the cap holds it to what a body can use.
  assert.equal(g.protein_target_g, 220);
});

await test('recomp is what "lose weight AND get more muscular" means', () => {
  const r = goalCall({ profile: GOAL_P, weightKg: 150, intent: 'recomp' });
  assert.equal(r.maintenance - r.calorie_target, 300);
  assert.match(r.say, /recomposition/);
});

await test('without the five facts it refuses, and everything is an estimate', () => {
  const missing = goalCall({ profile: {}, weightKg: null, intent: 'lose' });
  assert.equal(missing.known, false);
  assert.ok(missing.missing.length);
  const ok = goalCall({ profile: GOAL_P, weightKg: 100, intent: 'lose' });
  assert.equal(ok.approximate, true);
  assert.match(ok.caveat, /weigh-in trend is the truth/);
});

await test('set_goal computes body-goal numbers server-side, in one call', () => {
  const src = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function setGoal('), src.indexOf('async function setEatingWindow('));
  assert.match(fn, /goalCall\(\{ profile, weightKg, intent: args\.intent \}\)/);
  // The calorie and protein daily goals are set in the same call, so the brief
  // scores the plan the moment it exists.
  assert.match(fn, /metric: 'calories'/);
  assert.match(fn, /metric: 'protein_g'/);
  // And the schema tells the model outright never to invent those numbers.
  const tool = TOOLS.find(t => t.name === 'set_goal');
  assert.match(tool.inputSchema.properties.intent.description, /NEVER invent those numbers/);
  for (const phrase of ['I wanna lose weight', 'get more muscular', 'bulk up', 'lose fat and gain muscle']) {
    assert.ok(SERVER_INSTRUCTIONS.includes(phrase), `"${phrase}" maps to nothing`);
  }
});

group('At the rack — the checklist, the swap, and the next workout');

await test('the machine being taken has a tool, and the phrasebook knows the sound of it', () => {
  const swap = TOOLS.find(t => t.name === 'swap_exercise');
  assert.ok(swap, 'swap_exercise is not a tool');
  for (const phrase of ["machine's taken", "someone's on it", "bench is busy", "rack's full"]) {
    assert.ok(SERVER_INSTRUCTIONS.includes(phrase), `"${phrase}" maps to nothing`);
  }
  assert.match(SERVER_INSTRUCTIONS, /swap_exercise, immediately/);
});

await test('a swap never carries the old weight onto the new movement', () => {
  // 80kg from a bench press landing on a machine press is how somebody gets
  // hurt by an interruption. The replacement is loaded from its OWN history —
  // and with none, progressionCall refuses a number and prescribes RPE.
  const src = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function swapExercise('), src.indexOf('async function endSession('));
  assert.match(fn, /loadCallFor\(user\.id, \{ \.\.\.swapped, load_kg: null \}/);
  assert.match(fn, /never carry the old weight across/i);
  // Same pattern through different kit — that is what a substitute IS.
  assert.match(fn, /movementsFor\(inLib\.pattern/);
  // Sets already done count toward the slot: a swap after two sets leaves
  // three, not five.
  assert.match(fn, /current\.sets \|\| 1\) - \(doneHere \|\| 0\)/);
});

await test('every set answer carries the checklist, owned by the server', () => {
  const src = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  assert.match(src, /function planChecklist\(/);
  assert.match(src, /checklist: planChecklist\(plan, 0, 0\)/, 'start_session carries no checklist');
  assert.match(src, /checklist: planChecklist\(plan, cursor/, 'log_set carries no checklist');
  assert.match(SERVER_INSTRUCTIONS, /answered from the LATEST checklist, never from memory/);
  // One question per rest gap — a form at the rack is how logging dies.
  assert.match(SERVER_INSTRUCTIONS, /ONE short question per rest gap/);
});

await test('the end of one workout names the next one', () => {
  // The server can never speak first, so the close of this session is the only
  // place the next one can be planted.
  const src = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function endSession('), src.indexOf('async function previousBest('));
  assert.match(fn, /next_workout: nextWorkout/);
  assert.match(fn, /training_week: week/);
  // A finished block is said out loud — the only reward the structure had.
  assert.match(fn, /block_complete/);
  // No block → the longest-rested routine, so rotation still has a pointer.
  assert.match(fn, /ascending: true, nullsFirst: true/);
  assert.match(SERVER_INSTRUCTIONS, /WHEN THE SESSION ENDS, NAME THE NEXT ONE/);
});

group('The week against the expectation');

const { weekSoFar } = await import('../netlify/functions/lib/training.js');

await test('the week starts on Monday and last Sunday does not count', () => {
  // 2026-08-10 is a Monday. A session on Sunday the 9th belongs to LAST week —
  // counting it would let one weekend session satisfy two weeks' expectations.
  const days = [{ date: '2026-08-09', sessions: 1 }, { date: '2026-08-10', sessions: 1 }];
  const w = weekSoFar(days, { today: '2026-08-12', target: 3 });
  assert.equal(w.week_start, '2026-08-10');
  assert.equal(w.done, 1);
  assert.equal(w.met, false);
  assert.match(w.say, /1 of 3/);
});

await test('a target met says so and pushes nothing', () => {
  const days = [{ date: '2026-08-10', sessions: 2 }, { date: '2026-08-11', sessions: 1 }];
  const w = weekSoFar(days, { today: '2026-08-11', target: 3 });
  assert.equal(w.met, true);
  assert.match(w.say, /target is met/);
});

await test('an impossible week finishes short, and is never a debt', () => {
  // 0 of 3 with one day left cannot fit. A countdown to an impossible number is
  // a guilt machine; the week ends and the next one starts at zero. Sessions
  // never roll over — a punishment schedule is how training dies.
  const w = weekSoFar([], { today: '2026-08-15', target: 3 });   // Saturday
  assert.match(w.say, /finish short/);
  assert.match(w.say, /not a debt/);
  assert.match(w.say, /next week starts at zero/);
  assert.ok(!/behind|owe|catch up|make up/i.test(w.say), 'the say string scolds');
});

await test('no target set is said plainly, not invented', () => {
  const w = weekSoFar([{ date: '2026-08-10', sessions: 2 }], { today: '2026-08-12' });
  assert.equal(w.target, null);
  assert.match(w.say, /No weekly target is set/);
});

await test('the brief carries the week, and the instructions set it up once', () => {
  const src = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  assert.match(src, /training_week: weekSoFar\(range\.days/);
  assert.match(SERVER_INSTRUCTIONS, /THE EXPECTATION IS SET ONCE, THEN KEPT VISIBLE/);
  // Ask once, all together — days, equipment, limitations — same shape as the
  // five facts, because a drip of questions is an interrogation.
  assert.match(SERVER_INSTRUCTIONS, /ask ONCE, in one short message/);
  assert.match(SERVER_INSTRUCTIONS, /anything they cannot do/);
  assert.match(SERVER_INSTRUCTIONS, /category "health"/);
  // The pushes that must never happen.
  assert.match(SERVER_INSTRUCTIONS, /never roll over|sessions never roll over/i);
  assert.match(SERVER_INSTRUCTIONS, /care flag is up, do not push/);
});

await test('a single day is an answerable question', () => {
  // The founder asked for a 1d view. The API used to clamp at 3, which turned
  // "show me today" into "show me three days" silently.
  const api = readFileSync(new URL('../netlify/functions/api-progress.js', import.meta.url), 'utf8');
  assert.match(api, /params\.days, 10\) \|\| 30, 1\)/);
  assert.match(page('app.html'), /data-days="1"/);
});

group('Every item its own number, and the total underneath');

await test('the day card lists what each thing was, not just the sum', () => {
  // "One steak's up to the right and the pizza's to the left — should be
  // altogether and then a total. Each one should have its own list and then add
  // it together." A list of names above one figure is unauditable: you cannot
  // see which item is the 750, so a mis-heard entry hides in an average.
  const src = page('app.html');
  const fn = src.slice(src.indexOf('function entryRows('), src.indexOf('function balancePanel('));
  assert.match(fn, /e\.calories != null \? e\.calories\.toLocaleString\(\)/);
  assert.match(fn, /class="total"/);
  // Items first, sum after — a total above a list reads as a headline.
  assert.ok(fn.indexOf('class="rows"') < fn.indexOf('class="total"'),
    'the total is printed above the items again');
  // Tapping opens the macros rather than putting four numbers on every row.
  assert.match(fn, /<details class="entry">/);
  assert.match(fn, /g protein/);
});

await test('an entry with no calories says it counts for nothing', () => {
  // Silently showing an em dash lets a named food sit in the log contributing
  // zero to every total, which looks like a small gap and is a wrong day.
  const src = page('app.html');
  const fn = src.slice(src.indexOf('function entryRows('), src.indexOf('function todayPanel('));
  assert.match(fn, /counts for nothing in the day/);
});

await test('the server hands over per-entry macros, so the page adds nothing', () => {
  const src = readFileSync(new URL('../netlify/functions/lib/wrought.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('log: evs.map('), src.indexOf('log: evs.map(') + 900);
  for (const k of ['calories', 'protein_g', 'carbs_g', 'fat_g']) {
    assert.ok(block.includes(k), `entries do not carry ${k}`);
  }
});

group('The five facts, asked where the number is missing');

await test('the website can record a weigh-in at all', () => {
  // This was a hole, not a preference. Resting burn needs height, birth year
  // AND a recent weight — and a weight is an EVENT, not a profile column, so
  // somebody could fill in every box on the Account screen and still be told
  // "calories out needs a recent weigh-in" with nowhere on the site to give it
  // one. The assistant could do it. The website could not.
  const src = readFileSync(new URL('../netlify/functions/api-profile.js', import.meta.url), 'utf8');
  assert.match(src, /'weight' in body/);
  assert.match(src, /event_type: 'weight'/);
  assert.match(src, /value_kg: weighed/);
  // Pounds are converted, never stored as typed.
  assert.match(src, /weight_unit === 'lb' \? 'lb' : 'kg'/);
  assert.match(src, /lbToKg\(raw\)/);
  // A fat-fingered 8400 must not become a resting burn nobody can explain.
  assert.match(src, /kg < 20 \|\| kg > 400/);
  // The profile saving and the weigh-in failing are different outcomes.
  assert.match(src, /weight_not_saved/);
});

await test('the five facts sit on the panel that refuses to draw', () => {
  // The founder read "calories out needs a recent weigh-in and birth year" and
  // had no way to answer it from that screen. A form buried under Account is a
  // form nobody fills in.
  const src = page('app.html');
  const hero = src.slice(src.indexOf('function hero(d) {'), src.indexOf('function hero(d) {') + 900);
  assert.match(hero, /factsForm\(b\)/);
  for (const id of ['ff-h', 'ff-w', 'ff-y', 'ff-s', 'ff-a']) {
    assert.ok(src.includes(`id="${id}"`), `${id} is not on the form`);
  }
  // Both unit systems, because half the people who need this think in stones
  // and inches and the other half do not.
  assert.match(src, /<option value="in">in<\/option>/);
  assert.match(src, /<option value="lb">lb<\/option>/);
});

await test('it names what is still missing rather than half-saving', () => {
  const src = page('app.html');
  const fn = src.slice(src.indexOf('async function saveFacts('), src.indexOf('function wireFacts('));
  assert.match(fn, /Still need \$\{list\}/);
  // Height, a weight and a birth year are the three the arithmetic cannot do
  // without. Sex and activity level are optional and flagged, never demanded.
  assert.match(fn, /!body\.height_cm && 'height'/);
  assert.match(fn, /!body\.weight && 'a weight'/);
  assert.match(fn, /!body\.birth_year/);
  assert.ok(!/!body\.sex/.test(fn), 'sex is being demanded');
  assert.ok(!/!body\.activity_level/.test(fn), 'activity level is being demanded');
});

await test('the demo never asks for facts it cannot use', () => {
  // Borrowed numbers. A form on the demo would collect somebody's real weight
  // into a screen that throws it away.
  const src = page('app.html');
  const hero = src.slice(src.indexOf('function hero(d) {'), src.indexOf('function hero(d) {') + 500);
  assert.match(hero, /if \(DEMO\)/);
  assert.ok(hero.indexOf('if (DEMO)') < hero.indexOf('factsForm(b)'),
    'the demo reaches the form before it is turned away');
});

group('The zone the days are filed under');

await test('a wrong timezone is caught by the DATE, never the name', () => {
  // A pizza eaten at 11:44 landed on yesterday, stamped 23:28, because the
  // account was still on the default zone twelve hours away. Nothing errored;
  // the day card, the streak and every weekly total were quietly wrong.
  const src = page('app.html');
  const fn = src.slice(src.indexOf('function zoneWarning('), src.indexOf('async function fixZone('));
  assert.match(fn, /if \(!here \|\| !filed \|\| here === filed\) return '';/);
  // America/Toronto and America/New_York disagree about nothing that matters
  // here, and nagging about them trains somebody to dismiss the one that counts.
  assert.ok(!/resolvedOptions\(\)\.timeZone !== d\.timezone/.test(fn),
    'it is comparing zone names rather than the day they produce');
  assert.match(fn, /one tap|Use \$\{esc\(mine\)\} instead/);
  // And the server has to say which zone it is filing under for any of it.
  const api = readFileSync(new URL('../netlify/functions/api-progress.js', import.meta.url), 'utf8');
  assert.match(api, /timezone: profile\.timezone/);
});

await test('the demo is reachable from inside the app, and has a way back', () => {
  // It lived only at a URL somebody had to be told about, so the one person who
  // most needs it — looking at a dashboard with a single meal on it, deciding
  // whether this is worth a fortnight — never saw it.
  const src = page('app.html');
  assert.match(src, /id="whoami-demo"/);
  assert.match(src, /See it full of data/);
  assert.match(src, /Back to my record/);
  // Signing out of borrowed numbers is meaningless.
  const demo = src.slice(src.indexOf('if (DEMO) {'), src.indexOf('if (DEMO) {') + 600);
  assert.match(demo, /whoami-out'\)\.hidden = true/);
});

group('The calendar — both halves of the sum, on every square');

const { calendarDays, calendarRollups, calendarMissing } =
  await import('../netlify/functions/lib/calendar.js');

const CAL_PROFILE = { height_cm: 180, birth_year: 1990, sex: 'male', activity_level: 'moderate', timezone: 'America/Toronto' };
const calDay = (date, over = {}) => ({
  date, logged: true, calories: 2000, protein_g: 140, carbs_g: null, fat_g: null,
  meals: 2, sessions: 0, minutes: 0, volume_kg: null, weight_kg: null,
  steps: null, sleep_minutes: null, active_calories: null, muscles: [], ...over,
});

await test('an unlogged day is empty, never a zero-calorie day', () => {
  // The whole reason this is not thirty lines in the page. Counting calendar
  // days would read every forgotten day as a perfect fast, manufacture an
  // enormous deficit out of forgetfulness, and then advise on it — an error
  // that runs in the dangerous direction.
  const days = [
    calDay('2026-08-01', { weight_kg: 84 }),
    calDay('2026-08-02', { logged: false, calories: null, meals: 0 }),
    calDay('2026-08-03'),
  ];
  const entries = calendarDays({ days, foodRows: [], profile: CAL_PROFILE });
  assert.equal(entries[1].in, null, 'a blank day was given a calorie count');
  assert.equal(entries[1].net, null, 'a blank day was given a net');

  const r = calendarRollups(entries.concat(entries).concat(entries).slice(0, 7));
  // Seven squares, but only the logged ones are counted, and it says so.
  assert.ok(r.week.days_counted < r.week.span_days);
  assert.match(r.week.say, /Counted across \d+ days, not the whole/);
});

await test('no net until BOTH sides are actually known', () => {
  // A net computed against a zero nobody measured is a fabricated deficit.
  const days = [calDay('2026-08-01', { weight_kg: 84 })];
  const noBurn = calendarDays({ days, foodRows: [], profile: { timezone: 'UTC' } });
  assert.equal(noBurn[0].in, 2000);
  assert.equal(noBurn[0].out, null);
  assert.equal(noBurn[0].net, null);

  const withBurn = calendarDays({ days, foodRows: [], profile: CAL_PROFILE });
  assert.ok(withBurn[0].out > 0);
  assert.equal(withBurn[0].net, 2000 - withBurn[0].out);
});

await test('what is missing is named once, not on thirty empty squares', () => {
  const days = [calDay('2026-08-01', { weight_kg: 84 })];
  const blocked = calendarMissing({ timezone: 'UTC' }, calendarDays({ days, foodRows: [], profile: { timezone: 'UTC' } }));
  assert.ok(blocked.blocking.length, 'nothing named as missing');
  assert.match(blocked.note, /height|birth year|weigh-in/);

  // With a figure but nothing measuring movement, the burn is resting-only and
  // the deficit looks bigger than the day really had. Silence there is the
  // dangerous kind.
  const restOnly = calendarDays({ days, foodRows: [], profile: { ...CAL_PROFILE, activity_level: null } });
  assert.equal(restOnly[0].active_source, 'none');
  assert.match(calendarMissing(CAL_PROFILE, restOnly).note, /resting burn alone/);
});

await test('a measured burn beats a multiplier', () => {
  const days = [calDay('2026-08-01', { weight_kg: 84, active_calories: 900 })];
  const e = calendarDays({ days, foodRows: [], profile: CAL_PROFILE })[0];
  assert.equal(e.active, 900);
  assert.equal(e.active_source, 'device');
  assert.equal(e.out, e.resting + 900);
});

await test('the weigh-in nearest the day is used, forwards then back', () => {
  // Bodyweight moves slowly and is weighed irregularly. A Tuesday with no
  // weigh-in still gets a real burn rather than a hole.
  const days = [
    calDay('2026-08-01'),                        // before any weigh-in
    calDay('2026-08-02', { weight_kg: 84 }),
    calDay('2026-08-03'),                        // after one
  ];
  const e = calendarDays({ days, foodRows: [], profile: CAL_PROFILE });
  assert.ok(e[0].out > 0, 'a day before the first weigh-in got nothing');
  assert.equal(e[1].out, e[2].out, 'the weight did not carry forward');
});

await test('the day carries what was actually eaten', () => {
  // The whole reason to tap a square: an average can never say the Thursday was
  // one enormous takeaway rather than three ordinary meals.
  const foodRows = [
    { local_date: '2026-08-01', summary: 'Slice of pizza', detail: { calories: 300, protein_g: 12 }, estimated: true },
    { local_date: '2026-08-01', summary: '8oz steak and a baked potato', detail: { calories: 750 }, estimated: true },
  ];
  const e = calendarDays({ days: [calDay('2026-08-01', { weight_kg: 84 })], foodRows, profile: CAL_PROFILE })[0];
  assert.equal(e.meal_count, 2);
  assert.equal(e.meals[0].summary, 'Slice of pizza');
  assert.equal(e.meals[1].calories, 750);
  assert.ok(e.estimated, 'estimated meals are not flagged as estimates');
});

await test('the three numbers shown side by side actually subtract', () => {
  // in averaged over every logged day while out averaged over the days that
  // also have a burn puts three figures on screen that visibly do not add up,
  // and a screen whose own arithmetic is wrong is worse than one that says it
  // does not know.
  const days = [
    calDay('2026-08-01', { weight_kg: 84 }),
    calDay('2026-08-02', { weight_kg: 84 }),
    calDay('2026-08-03', { weight_kg: 84 }),
    calDay('2026-08-04', { weight_kg: 84 }),
    calDay('2026-08-05', { weight_kg: 84 }),
    calDay('2026-08-06', { weight_kg: 84 }),
    calDay('2026-08-07', { weight_kg: 84 }),
  ];
  const entries = calendarDays({ days, foodRows: [], profile: CAL_PROFILE });
  // One day where the burn is unknowable — no weight anywhere near it.
  entries[0].out = null; entries[0].net = null;
  const r = calendarRollups(entries).week;
  assert.equal(r.in_avg - r.out_avg, r.net_avg, 'the trio does not subtract');
  assert.equal(r.in_total - r.out_total, r.net_total, 'the totals do not subtract');
  assert.equal(r.days_counted, 6, 'it counted the day it could not work out');
});

await test('with no burn at all, calories in still stands on its own', () => {
  const days = [calDay('2026-08-01'), calDay('2026-08-02'), calDay('2026-08-03'),
                calDay('2026-08-04'), calDay('2026-08-05'), calDay('2026-08-06'), calDay('2026-08-07')];
  const r = calendarRollups(calendarDays({ days, foodRows: [], profile: { timezone: 'UTC' } })).week;
  assert.equal(r.in_avg, 2000);
  assert.equal(r.out_avg, null);
  assert.equal(r.net_avg, null);
  assert.match(r.say, /Calories out is not worked out yet/);
});

await test('a window is only reported when the range actually covers it', () => {
  // "This year" computed from seven days is a fabrication wearing a long label.
  const mk = k => Array.from({ length: k }, (_, i) => calDay(`2026-08-${String((i % 28) + 1).padStart(2, '0')}`, { weight_kg: 84 }));
  const week = calendarRollups(calendarDays({ days: mk(7), foodRows: [], profile: CAL_PROFILE }));
  assert.ok(week.week, 'no week rollup from 7 days');
  assert.equal(week.month, undefined, 'a month was reported from a week of data');
  assert.equal(week.year, undefined, 'a year was reported from a week of data');

  // Fully covered, not nearly. "The last 30 days" off 28 of them, or "the last
  // year" off 300, is the same fabrication just small enough to feel harmless.
  assert.equal(calendarRollups(calendarDays({ days: mk(29), foodRows: [], profile: CAL_PROFILE })).month,
    undefined, '29 days was reported as "the last 30 days"');
  assert.ok(calendarRollups(calendarDays({ days: mk(30), foodRows: [], profile: CAL_PROFILE })).month);
  assert.equal(calendarRollups(calendarDays({ days: mk(364), foodRows: [], profile: CAL_PROFILE })).year,
    undefined, '364 days was reported as "the last year"');
});

await test('the page never does its own arithmetic', () => {
  // If the calendar summed anything itself it could disagree with the brief
  // about the same Tuesday, and after that neither is worth reading.
  const src = page('app.html');
  const view = src.slice(src.indexOf('function calendarView('), src.indexOf('function wireCalendar('));
  assert.ok(!/reduce\(/.test(view), 'the calendar view is summing things in the browser');
  // It reads the server's block and nothing else.
  assert.match(view, /const c = d\.calendar;/);
});

await test('only food is told it counts for nothing in the total', () => {
  // A weigh-in or a session carrying "it counts for nothing in the day's total"
  // is nonsense that reads as a bug, and it appeared on every one of them.
  const src = page('app.html');
  const fn = src.slice(src.indexOf('function entryRows('), src.indexOf('function todayPanel('));
  assert.match(fn, /const eats = e\.type === 'food' \|\| e\.type === 'drink'/);
  assert.match(fn, /eats && e\.calories == null/);
});

await test('redrawing the calendar does not refetch the whole record', () => {
  // Tapping a square changes what is SHOWN, not what is known. A round trip per
  // tap is slow on a phone and replays every entry animation.
  const src = page('app.html');
  const fn = src.slice(src.indexOf('function wireCalendar('), src.indexOf('function wireCalendar(') + 700);
  assert.match(fn, /const held = DEMO \? demoData\(\) : lastPayload;/);
  assert.match(fn, /if \(held\) render\(held\); else refresh\(\);/);
  assert.match(src, /lastPayload = await res\.json\(\);/);
});

group('When a tool falls over');

await test('a failed write says the words back and does not lose them', () => {
  // "Wrought's logging action is erroring right now" — no cause, and no sign
  // of what became of the sentence somebody said in passing. A log that throws
  // is the worst case in the product: they said it once, while doing something
  // else, and it is gone.
  const src = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf("error: 'tool_failed'"), src.indexOf("error: 'tool_failed'") + 1600);
  assert.match(block, /tool: params\.name/);
  assert.match(block, /detail: err\.message/);
  assert.match(block, /say:/, 'nothing human to relay');
  assert.match(block, /NOTHING WAS WRITTEN/);
  assert.match(block, /repeat the detail back/i);
  // A failed read must never be dressed up as an answer from memory.
  assert.match(block, /never substitute a number from your own memory/i);
});

group('Class names that collide, and the screens they collapse');

await test('nothing else claims .bar — the header owns it', () => {
  // A 6px tall overflow:hidden .bar rule added for a progress bar collapsed the
  // ENTIRE header row, which is what was clipping the navigation. The header
  // owns the name; anything else gets its own.
  const src = page('app.html');
  const rules = [...src.matchAll(/^\.bar\s*\{([^}]*)\}/gm)].map(m => m[1]);
  assert.equal(rules.length, 1, '.bar is defined more than once');
  assert.match(rules[0], /display: flex/);
  assert.ok(!/height:\s*6px/.test(rules[0]), 'the header row has a fixed height again');
  // And no element carries a bare class="bar" any more.
  assert.ok(!/class="bar"/.test(src), 'something is still using class="bar"');
});

group('One wordmark, on every page');

await test('the word is set in the same slab everywhere', () => {
  // "The page looks nothing like the advertising outside of it." It was the
  // typeface: the landing page set WROUGHT in the bracketed slab that matches
  // the tile, and the dashboard, connect, privacy and terms set it in a
  // compressed grotesque — so signing in swapped the company. One mark.
  const PAGES = {
    'index.html':     /--stamp:\s*Rockwell/,
    'app.html':       /--stamp:\s*Rockwell/,
    'authorize.html': /\.mark \.name\{font-family:Rockwell/,
    'connect.html':   /\.mark \.name\{font-family:Rockwell/,
    'privacy.html':   /\.wordmark\{font-family:Rockwell/,
    'terms.html':     /\.wordmark\{font-family:Rockwell/,
    'about.html':     /\.wordmark\{font-family:Rockwell/,
  };
  for (const [file, re] of Object.entries(PAGES)) {
    assert.match(page(file), re, `${file} sets the wordmark in something else`);
  }
});

await test('the compressed grotesque keeps its own variable', () => {
  // The two roles drifted into one name once already. Big display numbers and
  // lift names are --grotesk; the word is --stamp. Never the reverse.
  const src = page('app.html');
  assert.match(src, /--grotesk:\s*-apple-system/);
  assert.match(src, /\.hero \.net \{\s*font-family: var\(--grotesk\)/);
  // Nothing squashes the mark any more — font-stretch belongs to the grotesque.
  const mark = src.match(/\.mark \.name \{([^}]*)\}/)[1];
  assert.ok(!/font-stretch/.test(mark), 'the wordmark is being compressed again');
  assert.match(mark, /font-family: var\(--stamp\)/);
});

group('Tabs at the top, and a reset that lands somewhere useful');

await test('the view switcher sits in the header and scrolls sideways', () => {
  const src = page('app.html');
  const phone = src.slice(src.indexOf('@media (max-width: 700px)'));
  assert.match(phone, /flex-wrap: nowrap; overflow-x: auto/);
  // Not a bottom bar, and not fixed — it belongs to the header now.
  assert.ok(!/position: fixed/.test(phone), 'the tab row is still pinned somewhere');
  // Views before the date range: which screen outranks how far back.
  assert.match(phone, /order: 2/);
  assert.match(phone, /#rangebtns \{ order: 3; \}/);
});

await test('the mark goes home instead of reloading the page', () => {
  // href="/app.html" reloaded the page and looked like nothing happened.
  const src = page('app.html');
  assert.match(src, /<a class="mark" href="#record" id="home"/);
  assert.match(src, /data-view="record"\]'\)\?\.click\(\)/);
});

await test('a password reset lands on a set-a-password screen', () => {
  // It was landing on the ordinary sign-in form — with a password they do not
  // know. That is the exact moment somebody gives up.
  const src = page('app.html');
  assert.match(src, /id="reset"/);
  assert.match(src, /id="newpass"/);
  assert.match(src, /PASSWORD_RECOVERY/);
  assert.match(src, /type=recovery/);
  assert.match(src, /sb\.auth\.updateUser\(\{ password \}\)/);
});

await test('/status says which sign-in doors are actually open', async () => {
  // The pages hide a provider Supabase has switched off — a button that dumps
  // somebody on raw JSON is worse than no button — but that left "where is
  // Sign in with Apple?" with no answer anywhere.
  const src = readFileSync(new URL('../netlify/functions/api-status.js', import.meta.url), 'utf8');
  assert.match(src, /auth\/v1\/settings/);
  assert.match(src, /sign_in_providers/);
  assert.match(src, /Authentication → Providers/);

  const { handler: status } = await import('../netlify/functions/api-status.js');
  const html = (await status({ httpMethod: 'GET', headers: { accept: 'text/html' } })).body;
  assert.match(html, /<h2>Sign-in<\/h2>/);
  // Still no values, ever — the key used to ask must not appear in the answer.
  process.env.SUPABASE_ANON_KEY = 'anon-key-must-not-leak';
  try {
    const again = (await status({ httpMethod: 'GET', headers: { accept: 'text/html' } })).body;
    assert.ok(!again.includes('anon-key-must-not-leak'));
  } finally { delete process.env.SUPABASE_ANON_KEY; }
});

group('Height, by thumb');

await test('height is a slider, not a keyboard', () => {
  // A bounded number on a phone should not open a keyboard.
  const src = page('app.html');
  assert.match(src, /id="f-height" type="range"/);
  assert.match(src, /id="f-height-out"/);
  // Ranges in the unit on screen: inches when imperial, centimetres when not.
  assert.match(src, /min="\$\{imp \? 54 : 137\}" max="\$\{imp \? 84 : 214\}"/);
});

await test('an untouched slider is not an answer', () => {
  // A slider always has a position. Reading an untouched one as a height is
  // how somebody ends up with a number they never gave — and this is exactly
  // the field the whole no-invented-numbers doctrine is about.
  const src = page('app.html');
  assert.match(src, /data-set="\$\{p\.height_cm == null \? '0' : '1'\}"/);
  assert.match(src, /dataset\.set === '1'\s*\n?\s*\? \(\$\('f-units'\)/);
  assert.match(src, /: null,/);
  assert.match(src, /'not set'/);
});

await test('switching units moves the slider, not just the label', () => {
  // Otherwise the same position quietly means a different height.
  const src = page('app.html');
  assert.match(src, /Convert the position rather than the label/);
  assert.match(src, /el\.value = nowImp \? Math\.round\(cm \/ 2\.54\) : Math\.round\(cm\)/);
});

await test('born is a picker, not a keyboard', () => {
  const src = page('app.html');
  assert.match(src, /<select id="f-year">/);
  // Newest first — somebody born in 1990 should not scroll past 1926.
  assert.match(src, /now - 8 - i/);
  // Blank stays blank: an unanswered year is not a year.
  assert.match(src, /birth_year: \$\('f-year'\)\.value \? Number/);
});

await test('a Supabase setting is named with the place it lives', () => {
  // "Manual linking is disabled" names a setting without saying where, and it
  // lands on the exact screen somebody is on when they try to link.
  const src = page('app.html');
  assert.match(src, /manual linking is disabled/i);
  assert.match(src, /Authentication → Sign In \/ Providers/);
});

// ── Report ──────────────────────────────────────────────────────────────────

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
