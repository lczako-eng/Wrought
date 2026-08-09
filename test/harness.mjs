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
import { handler, TOOLS, handleRpc, SERVER_INSTRUCTIONS } from '../netlify/functions/mcp.js';
import { canonicalMetric, normalise, normaliseWorkout } from '../netlify/functions/ingest.js';
import { PROVIDERS, LIVE_PROVIDERS, providerSummary, recommendRoute } from '../netlify/functions/lib/providers.js';
import { nutritionTotals, composition, macroMatrix, yearOverYear } from '../netlify/functions/lib/nutrition.js';
import { MOVEMENTS, PROGRAMMES, PATTERNS, movementsFor, pickProgramme, buildProgramme } from '../netlify/functions/lib/library.js';
import {
  exerciseKey, loadStep, progressionCall, TIERS,
  restingBurn, energyBalance, planFromRoutine, sessionTotals, earnedRoom,
  orderPlan, orderInsight, deviceMatrix, weekdayPattern,
} from '../netlify/functions/lib/training.js';
import {
  localDateFor, addDays, daysBetween, clockString, humanDuration,
  kgToLb, lbToKg, cmToIn, inToCm, sayWeight,
  windowStatus, weightTrend, trainingMatrix, summariseRange, careFlags, scoreGoals,
  eventsFromClient, fastLength, fastingSummary,
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
  assert.deepEqual(log.inputSchema.required, ['text'],
    'the user\'s own words stay required — a structured reading never replaces them');
});

await test('the schema still forbids inventing a number', () => {
  const events = TOOLS.find(t => t.name === 'log').inputSchema.properties.events;
  assert.match(events.description, /never a guessed 500/i);
  assert.match(events.description, /null/i);
  assert.match(events.items.properties.estimated.description, /inferred rather than stated/i);
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

await test('the tool says out loud that it prescribes no weight', () => {
  const t = TOOLS.find(x => x.name === 'programmes');
  assert.ok(t, 'programmes must be in the toolset');
  assert.match(t.description, /NO WEIGHTS/);
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

// ── Report ──────────────────────────────────────────────────────────────────

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
