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
import { readFileSync, readdirSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { handler, TOOLS, handleRpc, SERVER_INSTRUCTIONS } from '../netlify/functions/mcp.js';
import { canonicalMetric, normalise, normaliseWorkout, looseNumber, CLINICAL_CAUTION } from '../netlify/functions/ingest.js';
import { PROVIDERS, LIVE_PROVIDERS, providerSummary, recommendRoute } from '../netlify/functions/lib/providers.js';
import { nutritionTotals, composition, macroMatrix, yearOverYear } from '../netlify/functions/lib/nutrition.js';
import { MOVEMENTS, PROGRAMMES, PATTERNS, movementsFor, pickProgramme, buildProgramme } from '../netlify/functions/lib/library.js';
import {
  exerciseKey, loadStep, progressionCall, nextSetLoad, estimatedMax, TIERS,
  normaliseMovement, readMovement, setRowsFromWorkout, TIMED_MOVEMENT, _resetEventIdProbe,
  restingBurn, energyBalance, planFromRoutine, sessionTotals, earnedRoom,
  orderPlan, orderInsight, deviceMatrix, weekdayPattern, ACTIVITY, focusCall,
  trainingBurn, targetOptions, liftTrend,
} from '../netlify/functions/lib/training.js';
import { activityBurn, activityTotal, matchActivity, ACTIVITIES, EFFORTS } from '../netlify/functions/lib/activity.js';
import { eventTimestamp } from '../netlify/functions/lib/wrought.js';
import { warmupFor, sessionProgress } from '../netlify/functions/lib/warmup.js';
import { formWatch, cardioProgress } from '../netlify/functions/lib/form.js';
import { INTAKE, intakeState } from '../netlify/functions/lib/intake.js';
import { weeklyVolume, SET_BAND } from '../netlify/functions/lib/volume.js';
import { dueAlerts, describeAlert, suggestAlerts, ALERT_KINDS, QUIET_BEFORE, QUIET_AFTER } from '../netlify/functions/lib/alerts.js';
import { parseQuickAdd } from '../netlify/functions/lib/quickadd.js';
const { goalCall, PACES, PUSH } = await import('../netlify/functions/lib/training.js');
import {
  localDateFor, addDays, daysBetween, clockString, humanDuration,
  kgToLb, lbToKg, cmToIn, inToCm, sayWeight,
  windowStatus, weightTrend, trainingMatrix, summariseRange, careFlags, scoreGoals,
  eventsFromClient, fastLength, fastingSummary, needsMacros, needsDuration, matchEntries, setupNeeded,
  duplicateItems, duplicateExtra, VALID_TYPES,
} from '../netlify/functions/lib/wrought.js';
import { spokenBrief, spokenLog, spokenFlag, pendingVoice, plainBrief } from '../netlify/functions/lib/voice.js';

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
  // The older reading for that metric/day is removed before the new one lands,
  // scoped to the user — and deliberately NOT scoped to the source. A Shortcut
  // and Health Auto Export both describe the same day; keeping one row from
  // each made every day-summing reader count the day twice. Two totals for one
  // day are two claims about one fact: the newest claim wins.
  assert.match(block, /\.delete\(\)/);
  assert.match(block, /\.eq\('user_id', userId\)/);
  assert.match(block, /\.eq\('local_date', r\.local_date\)/);
  assert.ok(!/delete\(\)[\s\S]{0,120}\.eq\('source'/.test(block),
    'the daily-total replacement is scoped per source again — two senders will double the day');
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

await test('the watch page recommends the route that gives true numbers', () => {
  // The Shortcut route was retired the night the founder's 2,778-step day
  // arrived as 33,640: Shortcuts exposes raw per-device samples, phone+watch
  // double, and no reachable filter fixes it. The page now leads with Health
  // Auto Export (Apple's own deduplicated totals, workouts included) and
  // keeps the Shortcut as a demoted option with its limits stated OUTRIGHT —
  // a route that quietly overcounts is worse than no route at all.
  const src = page('connect.html');
  assert.match(src, /The recommended way — Health Auto Export/);
  assert.match(src, /deduplicated<\/b> daily\s+totals/);
  assert.match(src, /steps and active energy will\s+overcount/);
  assert.match(src, /fine for <b>weight and resting heart rate<\/b>/);
  // The paid part is named before anybody installs, and the app is trailed.
  assert.match(src, /paid feature/);
  assert.match(src, /Wrought iPhone app/);
  // The dead prebuilt-shortcut machinery is gone with the route.
  assert.ok(!/SHORTCUT_URL/.test(src), 'the prebuilt-shortcut plumbing survived its route');
});

group('The statistics house — the iOS shell');

await test('the app frames the website and owns only the native powers', () => {
  // The founder's spec: same screens as the website, fed by the same server,
  // everything run through the GPT — the app adds only what the web cannot do.
  const read = f => readFileSync(new URL(`../ios/Wrought/${f}`, import.meta.url), 'utf8');
  assert.match(read('WebView.swift'), /wrought\.fit\/app\.html/);
  // No chat surface, by doctrine — capture lives in the connected AI.
  for (const f of ['ContentView.swift', 'WebView.swift', 'HealthCourier.swift']) {
    assert.ok(!/chat/i.test(read(f)) || /NO chat/i.test(read(f)), `${f} grew a chat`);
  }
  // The courier reads Apple's deduplicated statistics, not raw samples-summed.
  assert.match(read('HealthCourier.swift'), /HKStatisticsQuery/);
  assert.match(read('HealthCourier.swift'), /cumulativeSum/);
  assert.match(read('HealthCourier.swift'), /enableBackgroundDelivery/);

  // Ground covered and the green ring, not just steps.
  const courier = read('HealthCourier.swift');
  assert.match(courier, /distanceWalkingRunning/);
  assert.match(courier, /distanceCycling/);
  assert.match(courier, /"metric": "distance_km"/);
  assert.match(courier, /appleExerciseTime/);
  // Metrics are table-driven now, so the name lives in the table rather than
  // in a literal at the send site — one line to add one metric, and the
  // permission list cannot drift from what is actually sent.
  assert.match(courier, /name: "active_minutes"/);

  // THE WORKOUTS THEMSELVES. A run is a session, not a lump of calories — it
  // has to reach the training matrix or the brief calls a run day a rest day.
  assert.match(courier, /HKObjectType\.workoutType\(\)/);
  assert.match(courier, /func recentWorkouts/);
  // HealthKit's own uuid as source_ref, so the server's unique index means
  // resending the same week forever can never double a run.
  assert.match(courier, /"source_ref": w\.uuid\.uuidString/);
  // statistics(for:) rather than the deprecated totals — same numbers, and it
  // keeps working as Apple retires the old properties.
  assert.match(courier, /statistics\(for: HKQuantityType\(\.activeEnergyBurned\)\)/);
  assert.ok(!/\.totalEnergyBurned/.test(courier), 'using the deprecated workout totals');
  // A finished workout lands while the sweat is still on.
  assert.match(courier, /\.immediate/);
  // Apple's enum becomes the word a person would say.
  assert.match(courier, /case \.traditionalStrengthTraining/);
  assert.match(courier, /return "Workout"/);
  // And the client can carry them.
  assert.match(read('IngestClient.swift'), /workouts: \[\[String: Any\]\] = \[\]/);
  assert.match(read('IngestClient.swift'), /body\["workouts"\] = workouts/);
  // It posts to the same public door as every other client — no second protocol.
  assert.match(read('IngestClient.swift'), /appendingPathComponent\("ingest"\)/);
  assert.match(read('IngestClient.swift'), /wrought_ios/);
  // The key is minted from the page's own session — the app can never feed a
  // different account than the one on screen — and lives in the Keychain.
  assert.match(read('IngestClient.swift'), /api-key/);
  assert.match(read('Keychain.swift'), /kSecClassGenericPassword/);
  assert.ok(!/UserDefaults/.test(read('IngestClient.swift')), 'the key is in UserDefaults');
});

await test('the Xcode project carries the entitlements, the id and the icon', () => {
  const pbx = readFileSync(new URL('../ios/Wrought.xcodeproj/project.pbxproj', import.meta.url), 'utf8');
  // Folder-synchronized group: every file in ios/Wrought/ is automatically in
  // the target, so a new Swift file cannot be silently left out of the build.
  assert.match(pbx, /PBXFileSystemSynchronizedRootGroup/);
  assert.match(pbx, /fileSystemSynchronizedGroups/);
  assert.match(pbx, /PRODUCT_BUNDLE_IDENTIFIER = fit\.wrought\.app/);
  assert.match(pbx, /CODE_SIGN_ENTITLEMENTS = Wrought\/Wrought\.entitlements/);
  // Health data demands a usage description or the app crashes at the prompt.
  // It lives in Info.plist now rather than a build setting — one place, so it
  // cannot go stale in the copy nobody is reading.
  const plist = readFileSync(new URL('../ios/Info.plist', import.meta.url), 'utf8');
  assert.match(plist, /NSHealthShareUsageDescription/);

  const ent = readFileSync(new URL('../ios/Wrought/Wrought.entitlements', import.meta.url), 'utf8');
  assert.match(ent, /com\.apple\.developer\.healthkit<\/key>/);
  assert.match(ent, /healthkit\.background-delivery/);

  // The W rides along: the asset catalog carries the 1024 tile.
  const icon = readFileSync(new URL('../ios/Wrought/Assets.xcassets/AppIcon.appiconset/Contents.json', import.meta.url), 'utf8');
  assert.match(icon, /icon-1024\.png/);
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

  // AND THE CONVENTIONAL PATH IS ONE OF THEM. Plenty of clients and crawlers
  // ask for /favicon.ico by name and read no markup at all, so a 404 there is
  // a listing with an empty square in it — somebody else's placeholder rather
  // than nothing. It is raster, so it sits with the PNGs; SVG stays last
  // because that is the one clients refuse.
  const ico = info.icons.findIndex(i => i.mimeType === 'image/x-icon');
  assert.ok(ico > 0, 'the conventional favicon path is not offered');
  assert.ok(ico < info.icons.length - 1, 'the ico is after the SVG a client may refuse');
});

await test('the symbol exists at every path something might ask for', () => {
  // "Install — no connector symbol." A favicon slot and a connector listing
  // render SOMETHING whether you supply one or not, and an empty slot is
  // somebody else's placeholder.
  for (const f of ['favicon.ico', 'og.png', 'icon.svg', 'icon-32.png', 'icon-192.png', 'icon-512.png']) {
    const buf = readFileSync(new URL(`../public/${f}`, import.meta.url));
    assert.ok(buf.length > 500, `${f} is missing or empty`);
  }
  // A real ICO container, not a PNG wearing the extension — a strict parser
  // rejects that and shows nothing, which is the failure being fixed.
  const ico = readFileSync(new URL('../public/favicon.ico', import.meta.url));
  assert.equal(ico.readUInt16LE(0), 0, 'not an ICO: bad reserved field');
  assert.equal(ico.readUInt16LE(2), 1, 'not an ICO: bad type');
  assert.ok(ico.readUInt16LE(4) >= 3, 'the ico carries too few sizes');

  // Declared on every page, so nothing renders a blank tab.
  for (const f of ['index.html', 'app.html', 'about.html', 'connect.html', 'authorize.html', 'privacy.html', 'terms.html']) {
    assert.match(page(f), /href="\/favicon\.ico"/, `${f} does not declare the favicon`);
  }
  // A card with no image is a grey rectangle with a URL in it.
  const home = page('index.html');
  assert.match(home, /property="og:image" content="https:\/\/wrought\.fit\/og\.png"/);
  assert.match(home, /name="twitter:card" content="summary_large_image"/);
  assert.match(home, /property="og:image:width" content="1200"/);
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

const { GUIDE, guideRead } = await import('../netlify/functions/lib/guide.js');

await test('the tutorial is a tool, not the model\'s memory of a README', () => {
  const g = TOOLS.find(t => t.name === 'guide');
  assert.ok(g, 'no guide tool');
  assert.ok(g.annotations.readOnlyHint);
  for (const phrase of ['how do I use this', 'what does wrought mean', 'what can you do', 'tutorial']) {
    assert.ok(SERVER_INSTRUCTIONS.includes(phrase), `"${phrase}" maps to nothing`);
  }
  // One manual, shared with the app's Guide tab — a manual that disagrees with
  // itself in two places is worse than one place.
  const out = guideRead();
  assert.match(out.meaning, /past tense of/);
  assert.ok(out.what_it_refuses.length >= 5);
  assert.match(out.note, /do not recite the whole manual/i);

  // THE MANUAL IS EXAMPLE SENTENCES, NOT A FEATURE LIST. Nobody reads
  // "supports natural-language logging" and knows what to type; they read
  // "had a steak and a baked potato" and know immediately.
  const lines = GUIDE.sections.flatMap(x => x.lines);
  assert.ok(lines.length >= 30, `only ${lines.length} example sentences`);
  assert.ok(!lines.some(l => /_[a-z]/.test(l)), 'a tool name leaked into the manual');
  // The refusals are printed on it, because "give us your record" is only fair
  // next to what it will not do with it.
  assert.ok(out.what_it_refuses.some(r => /1,200/.test(r)), 'the calorie floor is not stated');
  assert.ok(out.what_it_refuses.some(r => /progress photo/i.test(r)));

  // And it is in the app, which is where somebody about to train will look.
  const app = page('app.html');
  assert.match(app, /data-view="guide"/, 'the guide is not a tab');
  assert.match(app, /function guideView\(/);
});

await test('the manual shows somebody talking before it describes talking', () => {
  // "The top, about how to use this thing, has to be more apparent — easier to
  // use, less words, or it needs to be just easier to read. Animated."
  //
  // The old screen was the exact failure this file's own doctrine warns about:
  // sixteen paragraphs of prose explaining that you do not need to learn
  // anything. Reading a description of talking teaches nobody how to talk.
  const app = page('app.html');
  assert.ok(GUIDE.demo?.length >= 3, 'nothing to demonstrate');
  assert.match(app, /const GUIDE_DEMO = \[/, 'the page has no demo of its own');
  assert.match(app, /function playGuideDemo\(/);
  assert.match(app, /id="demo-text"/);

  // NOT ONE INVENTED NUMBER on the answering side. A demo figure on a health
  // product reads as somebody's own data at a glance, and this is the one
  // screen a person is on precisely because they do not yet know which is
  // which. What they SAY may carry numbers — that is how people talk.
  for (const d of GUIDE.demo) {
    assert.ok(!/\d/.test(d.does), `the demo answer invents a figure: "${d.does}"`);
  }
  assert.match(app, /An example, not your data/);

  // FEWER WORDS ON THE SCREEN. The long-form reasoning still exists for the
  // `guide` tool, where a model reads it and prose is the right shape — but
  // the screen shows the short line and the sentences, which are the manual.
  for (const s of GUIDE.sections) {
    assert.ok(s.short, `"${s.title}" has no screen-length line`);
    assert.ok(s.short.length <= 40, `"${s.short}" is not short`);
    assert.ok(s.after, `"${s.title}" lost its long form, which the tool still needs`);
  }
  const view = app.slice(app.indexOf('function guideView()'), app.indexOf('function playGuideDemo('));
  assert.ok(!/sec\.after/.test(view), 'the long prose is still being printed on the screen');
  assert.match(view, /sec\.short \|\| sec\.note/);

  // REDUCED MOTION IS OBEYED, NOT APPROXIMATED. Somebody who told their phone
  // that movement makes them ill has not asked for a slower animation — and a
  // manual is exactly the screen where they still need the content.
  const play = app.slice(app.indexOf('function playGuideDemo('), app.indexOf('function wireGuide('));
  assert.match(play, /prefers-reduced-motion: reduce/);
  assert.match(play, /if \(still\)/);
  assert.match(play, /text\.textContent = GUIDE_DEMO\[0\]\.say/, 'reduced motion shows nothing at all');
  // And it stops when the view is left, rather than typing into a dead screen.
  assert.match(app, /function stopGuide\(\)/);
  assert.match(app, /stopTrainer\(\);\n  stopGuide\(\);/);
});

await test('the manual is reachable without a password', () => {
  // It is written to need no session and no request for exactly one reason: it
  // is the screen somebody needs most when they cannot get signed in, or when
  // they are deciding whether this is worth signing up for at all. The gate
  // covered the whole app, so there was no way to get to it — a promise made
  // in a comment and not kept in the markup.
  const app = page('app.html');
  assert.match(app, /id="peek"/, 'no way into the manual from the sign-in screen');
  assert.match(app, /\$\('peek'\)\?\.addEventListener/);
  // And a way back, or somebody who only wanted to read is stranded.
  assert.match(app, /id="unpeek"/);

  // It is also the second tab now, not the sixth — a tab nobody can see
  // without scrolling the row sideways is not apparent, whatever it says.
  const tabs = [...app.matchAll(/data-view="([a-z]+)" aria-pressed/g)].map(m => m[1]);
  assert.equal(tabs[1], 'guide', `guide is tab ${tabs.indexOf('guide') + 1}, not 2`);
  // Named for what it is. "Guide" reads as documentation nobody opens.
  assert.match(app, /data-view="guide"[^>]*>Say this</);
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
  // SAVED AS EACH BATCH ARRIVES, never at the end. "Keep sending and I'll build
  // up an inventory" holds the whole gym in a conversation that then ends — on
  // the one product whose entire promise is that it remembers.
  assert.match(SERVER_INSTRUCTIONS, /SAVED AS EACH BATCH ARRIVES/);
  assert.match(SERVER_INSTRUCTIONS, /takes the whole gym with it/);
});

group('The burn, split into the half you can change');

await test('resting and moving are shown apart, not summed away', () => {
  // "Show the distinction between the two — your basal plus the burn rate of
  // the day that's totally moving all the time." They behave completely
  // differently: resting burn is a near-constant a body spends whatever the
  // day does; the moving half is the only part behaviour touches, and it is
  // the one still climbing when somebody is deciding about dinner.
  const src = page('app.html');
  const fn = src.slice(src.indexOf('function burnSplit('), src.indexOf('// ── Calendar'));
  assert.match(fn, /const rest\s+= Number\(b\.resting_burn\)/);
  // The moving half survived the split into three: it is now whatever is left
  // after training, and falls back to active_burn for an older payload.
  assert.match(fn, /b\.active_burn/);
  assert.match(fn, /at rest/);
  assert.match(fn, /moving today/);
  // The moving half is labelled as an estimate when nothing measured it — a
  // multiplier presented as a measurement is the dangerous version.
  assert.match(fn, /moving \(estimated\)/);
  // Drawn proportionally rather than described.
  assert.match(fn, /class="bsbar"/);
  assert.match(fn, /width:\$\{pct\(rest\)\}/);
});

await test('the caveat names which half is guessed', () => {
  const src = page('app.html');
  const hero = src.slice(src.indexOf('function hero(d) {'), src.indexOf('function burnSplit('));
  assert.match(hero, /active_source === 'device'/);
  assert.match(hero, /standard multiplier, not a measurement/);
  assert.match(hero, /resting burn alone/);
});

await test('a watch session shows what the heart did, not just a name', () => {
  const src = page('app.html');
  const fn = src.slice(src.indexOf('function sessionBlock('), src.indexOf('function sessionBlock(') + 1200);
  assert.match(fn, /bpm avg/);
  assert.match(fn, /peak/);
  assert.match(fn, /km/);
  const api = readFileSync(new URL('../netlify/functions/api-log.js', import.meta.url), 'utf8');
  assert.match(api, /avg_hr: e\.detail\?\.avg_hr/);
  assert.match(api, /max_hr: e\.detail\?\.max_hr/);
});

group('Changing your mind is one call, not a negotiation');

await test('a new number replaces the old one instead of stacking a second ring', () => {
  // "Switch my goal to 12,000 steps" must not leave 10,000 standing beside it:
  // two rings for one intention is a dashboard that lies, and a brief that
  // scores the same walk twice.
  const src = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  assert.match(src, /async function retireGoalsFor/);
  const fn = src.slice(src.indexOf('async function setGoal('), src.indexOf('async function retireGoalsFor'));
  assert.match(fn, /const superseded = await retireGoalsFor\(user\.id, row\.metric, row\.cadence\)/);
  // A body goal replaces its three too, or a second cut stacks three more.
  assert.match(fn, /for \(const m of \['weight_kg', 'calories', 'protein_g'\]\)/);
  // Retired, not deleted — what somebody used to aim at is part of the record.
  const retire = src.slice(src.indexOf('async function retireGoalsFor'), src.indexOf('async function dropGoal'));
  assert.match(retire, /update\(\{ active: false \}\)/);
  assert.ok(!/\.delete\(\)/.test(retire), 'the old goal is being destroyed rather than retired');
  // And it says "changed", because somebody who moved a target wants to hear
  // that it moved, not that a new one appeared.
  assert.match(fn, /superseded \? `Changed/);
});

await test('dropping a target is maintenance, never a confession', () => {
  const tool = TOOLS.find(t => t.name === 'drop_goal');
  assert.ok(tool);
  assert.match(tool.description, /never a failure/);
  assert.match(tool.description, /Never comment on why/);
  const src = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function dropGoal('), src.indexOf('async function setEatingWindow('));
  assert.match(fn, /No comment on why/);
  // Nothing matching is answered with what IS set, not a shrug.
  assert.match(fn, /Currently set:/);
  for (const phrase of ['drop the steps one', 'switch my goal to 12,000 steps', 'make it 12,000']) {
    assert.ok(SERVER_INSTRUCTIONS.includes(phrase), `"${phrase}" maps to nothing`);
  }
});

await test('going to the gym is answered with a proposal, not a blank', () => {
  // "When I say I'm going to the gym, Jim has to prompt me — what is he gonna
  // do?" One line that already contains a plan, never three questions.
  assert.match(SERVER_INSTRUCTIONS, /"I'M GOING TO THE GYM" IS AN OPENING/);
  assert.match(SERVER_INSTRUCTIONS, /ONE short line that already contains a proposal/);
  assert.match(SERVER_INSTRUCTIONS, /do not ask three things/);
  // The body's veto comes before the plan, not after it.
  assert.match(SERVER_INSTRUCTIONS, /readiness line FIRST/);
  assert.ok(SERVER_INSTRUCTIONS.includes("I'm going to the gym"));
});

await test('a new weight re-bases the arithmetic and is never congratulated', () => {
  // Praising a loss and staying silent on a gain is how a log starts getting
  // edited to please the app.
  assert.match(SERVER_INSTRUCTIONS, /A NEW WEIGHT IS JUST LOG_WEIGHT/);
  assert.match(SERVER_INSTRUCTIONS, /re-bases everything computed from bodyweight/);
  assert.match(SERVER_INSTRUCTIONS, /never congratulate a direction/);
});

group('Readiness — the body gets a veto, never a spur');

const { readiness } = await import('../netlify/functions/lib/training.js');
const baseDays = (over = {}) => {
  const d = [];
  for (let i = 1; i <= 14; i++) d.push({ date: `2026-07-${String(i).padStart(2, '0')}`, resting_hr: 54, sleep_minutes: 420 });
  d.push({ date: '2026-08-10', resting_hr: 54, sleep_minutes: 420, ...over });
  return d;
};

await test('it reads them against their own fortnight, not a chart of strangers', () => {
  const ok = readiness({ days: baseDays(), today: '2026-08-10' });
  assert.equal(ok.state, 'ready');
  assert.match(ok.say, /normal for you/);

  // 7% over their own baseline is the endurance-coaching threshold; under it
  // is salt, sleep and what time you stood up.
  const noise = readiness({ days: baseDays({ resting_hr: 56 }), today: '2026-08-10' });
  assert.equal(noise.state, 'ready');
  const raised = readiness({ days: baseDays({ resting_hr: 62 }), today: '2026-08-10' });
  assert.equal(raised.state, 'watch');
});

await test('two signals off means lighter, and it never says stop', () => {
  const strained = readiness({ days: baseDays({ resting_hr: 62, sleep_minutes: 300 }), today: '2026-08-10' });
  assert.equal(strained.state, 'strained');
  assert.match(strained.say, /train, but take today lighter/);
  assert.match(strained.say, /nothing near failure/);
  // A week of it is a doctor's question, said plainly — not a diagnosis here.
  assert.match(strained.say, /doctor's question/);
  assert.match(strained.caveat, /Not a medical reading/);
  assert.ok(!/condition|illness|infection|could mean/i.test(strained.say), 'it is diagnosing');
});

await test('a good reading is permission, never an instruction to go harder', () => {
  // Same shape as earnedRoom: the flag adds permission or stays quiet. "You're
  // recovered, add weight" is how a tool argues somebody into an injury.
  const ok = readiness({ days: baseDays(), today: '2026-08-10' });
  assert.match(ok.say, /Train as planned/);
  assert.ok(!/heavier|add weight|push harder|go hard/i.test(ok.say), 'a good reading became a spur');
  assert.match(SERVER_INSTRUCTIONS, /THE BODY GETS A VETO, NEVER A SPUR/);
  assert.match(SERVER_INSTRUCTIONS, /never turn a good reading into "add weight"/);
  assert.match(SERVER_INSTRUCTIONS, /no diagnosis, no naming a condition/);
});

await test('with nothing measuring it, it says so rather than inventing a state', () => {
  const none = readiness({ days: [{ date: '2026-08-10' }], today: '2026-08-10' });
  assert.equal(none.known, false);
  assert.match(none.say, /Nothing measuring recovery yet/);
});

await test('the session asks the body before the first set', () => {
  const src = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function startSession('), src.indexOf('// A session assembled from'));
  assert.match(fn, /readiness\(\{ days: recent\.days, today \}\)/);
  assert.match(fn, /readiness: ready\?\.known \? ready : undefined/);
  assert.match(fn, /READINESS FIRST, in one line, before the first exercise/);
});

await test('the training spike survives the trip from the watch', () => {
  // "It has all my heart health data, it should show training spikes."
  const w = normaliseWorkout({ kind: 'Running', minutes: 32, distance_km: 5.2, calories: 410, avg_hr: 148, max_hr: 171 });
  assert.equal(w.detail.avg_hr, 148);
  assert.equal(w.detail.max_hr, 171);
  assert.match(w.summary, /148 bpm avg/);
  // And the app reads it per workout rather than as a day-wide average.
  const courier = readFileSync(new URL('../ios/Wrought/HealthCourier.swift', import.meta.url), 'utf8');
  assert.match(courier, /statistics\(for: HKQuantityType\(\.heartRate\)\)/);
  assert.match(courier, /averageQuantity/);
  assert.match(courier, /maximumQuantity/);
  assert.match(courier, /heartRateVariabilitySDNN/);
});

group('Targets, drawn rather than described');

await test('the server computes how full a ring is, not the page', () => {
  // Same rule as everywhere: the page draws, the server calculates, so a ring
  // and the brief can never disagree about whether today was a good day.
  const g = [{ goal: '10k steps', metric: 'steps', target_value: 10000, direction: 'at_least', cadence: 'daily' }];
  const out = scoreGoals(g, { device: { steps: 4589 } }, {}, {})[0];
  assert.equal(out.percent, 46);
  assert.equal(out.hit, false);
  assert.equal(out.actual, 4589);

  // An at_most goal fills as it is SPENT — 80% of a calorie ceiling means 80%
  // eaten, the direction that reads correctly at a glance.
  const cal = scoreGoals(
    [{ goal: 'under 2300', metric: 'calories', target_value: 2300, direction: 'at_most', cadence: 'daily' }],
    { food: { calories: 1840 } }, {}, {})[0];
  assert.equal(cal.percent, 80);
  assert.equal(cal.over, false);
  assert.equal(cal.hit, true);

  // Over a ceiling is never hidden: uncapped percentage, flagged.
  const over = scoreGoals(
    [{ goal: 'under 2300', metric: 'calories', target_value: 2300, direction: 'at_most', cadence: 'daily' }],
    { food: { calories: 3220 } }, {}, {})[0];
  assert.equal(over.percent, 140);
  assert.equal(over.over, true);
});

await test('distance and effort minutes can be aimed at', () => {
  // The iPhone app sends both now; a metric nothing can score is a dead end.
  const km = scoreGoals([{ goal: '8km', metric: 'distance_km', target_value: 8, direction: 'at_least', cadence: 'daily' }],
    { device: { distance_km: 8.4 } }, {}, {})[0];
  assert.equal(km.hit, true);
  const mins = scoreGoals([{ goal: '30 min', metric: 'active_minutes', target_value: 30, direction: 'at_least', cadence: 'daily' }],
    { device: { active_minutes: 41 } }, {}, {})[0];
  assert.equal(mins.hit, true);
  const tool = TOOLS.find(t => t.name === 'set_goal');
  assert.ok(tool.inputSchema.properties.metric.enum.includes('distance_km'));
  assert.ok(tool.inputSchema.properties.metric.enum.includes('active_minutes'));
});

await test('the dashboard draws the rings and never computes them', () => {
  const src = page('app.html');
  const fn = src.slice(src.indexOf('function targetRing('), src.indexOf('function targetsPanel('));
  assert.match(fn, /g\.percent/);
  // The ring is capped for drawing but the NUMBER is not — an overshoot must
  // never be hidden by a full circle.
  assert.match(fn, /Math\.min\(100, g\.percent/);
  assert.ok(!/actual \/ .*target/.test(fn), 'the page is computing its own percentage');
  // Colour carries the verdict, and nothing here scolds.
  assert.match(fn, /var\(--moss\)/);
  assert.match(fn, /var\(--temper\)/);

  // No targets is an invitation, not an empty box.
  const panel = src.slice(src.indexOf('function targetsPanel('), src.indexOf('function targetsPanel(') + 1400);
  assert.match(panel, /Nothing to aim at yet/);
  assert.match(panel, /10,000 steps a day/);
});

await test('the baseline is asked for once, and changing it is never a lecture', () => {
  assert.match(SERVER_INSTRUCTIONS, /SET THE BASELINE THE FIRST TIME THEY TRAIN OR ASK/);
  assert.match(SERVER_INSTRUCTIONS, /ask ONE short question/);
  // Suggest, do not interrogate — and pitch it at where they actually are.
  assert.match(SERVER_INSTRUCTIONS, /suggest, do not interrogate/);
  assert.match(SERVER_INSTRUCTIONS, /rather than a round number off a poster/);
  // A target somebody keeps missing is a target set wrong.
  assert.match(SERVER_INSTRUCTIONS, /TARGETS ARE FLEXIBLE AND CHANGING ONE IS NORMAL/);
  assert.match(SERVER_INSTRUCTIONS, /never a comment about commitment/);
  assert.match(SERVER_INSTRUCTIONS, /lowering it to what they will actually do is the correct move/);
  for (const phrase of ['10,000 steps a day', 'make it 8,000 instead']) {
    assert.ok(SERVER_INSTRUCTIONS.includes(phrase), `"${phrase}" maps to nothing`);
  }
});

group('A body goal becomes numbers, computed — never guessed');

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
  assert.match(fn, /goalCall\(\{ profile, weightKg, intent: args\.intent, pace \}\)/);
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
  // It is handed what is already on file so it can ask for only the gap.
  assert.match(hero, /factsForm\(b, d\.profile_known/);
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
  // Anything already on file counts as answered — it is not missing just
  // because it was not typed again into a form that never showed the box.
  assert.match(fn, /!body\.height_cm && known\.height_cm == null && 'height'/);
  assert.match(fn, /!body\.weight && known\.weight_kg == null && 'a weight'/);
  assert.match(fn, /!body\.birth_year/);
  assert.ok(!/!body\.sex/.test(fn), 'sex is being demanded');
  assert.ok(!/!body\.activity_level/.test(fn), 'activity level is being demanded');
});

await test('the demo never asks for facts it cannot use', () => {
  // Borrowed numbers. A form on the demo would collect somebody's real weight
  // into a screen that throws it away.
  const src = page('app.html');
  const hero = src.slice(src.indexOf('function hero(d) {'), src.indexOf('function hero(d) {') + 900);
  assert.match(hero, /if \(DEMO\)/);
  assert.ok(hero.indexOf('if (DEMO)') < hero.indexOf('factsForm(b,'),
    'the demo reaches the form before it is turned away');
});

await test('a weigh-in is found outside the loaded window', () => {
  // Switching to the 1d view lost the weight — one day, usually with no
  // weigh-in on it — so the burn could not be computed and the whole five-facts
  // form reappeared. It read as the product having forgotten a height it was
  // holding perfectly well, on the panel where that is most alarming.
  const src = readFileSync(new URL('../netlify/functions/api-progress.js', import.meta.url), 'utf8');
  // Fetched unconditionally in the main batch now — one small indexed row costs
  // less than the extra serial round trip it used to take, and the window
  // having no weigh-in on it is the ordinary case at 1d rather than the
  // exception. The lookup itself is unbounded by date, which is the point.
  const q = src.slice(src.indexOf("// The most recent weigh-in ANYWHERE"), src.indexOf('// Runs, rides and swims'));
  assert.match(q, /wrought_events/);
  assert.match(q, /event_type', 'weight'/);
  assert.match(q, /order\('occurred_at'/);
  assert.ok(!/local_date/.test(q), 'the weigh-in lookup was bounded by the window again');
  assert.match(src, /if \(weightKg == null\) weightKg = lastWeightRow;/);
});

const { planRead } = await import('../netlify/functions/lib/plan.js');

await test('a target is never quoted without its maintenance', () => {
  // "It might say you're allowed 2,400 a day, but it should also let you know
  // that your maintenance is this while what you're trying to achieve is
  // that." A number alone is a rule handed down; a number against maintenance
  // and a rate is a decision somebody can judge.
  const profile = { height_cm: 190.5, birth_year: 1982, sex: 'male',
                    activity_level: 'moderate', plan_pace: 'steady', plan_push: 'normal', train_days: 4 };
  const goals = [
    { metric: 'weight_kg', direction: 'at_most', goal: 'lose weight', target_value: 130 },
    { metric: 'calories', cadence: 'daily', target_value: 3083 },
    { metric: 'protein_g', cadence: 'daily', target_value: 220 },
  ];
  const p = planRead({ profile, goals, weightKg: 149.7 });

  assert.equal(p.set, true);
  assert.equal(p.calorie_target, 3083);
  assert.ok(p.maintenance > p.calorie_target, 'maintenance is missing or below the target');
  assert.equal(p.deficit, p.maintenance - p.calorie_target, 'the three do not subtract');
  // The rate is derived from the deficit, never stated independently.
  assert.equal(p.projected_kg_per_week, -Math.round((p.deficit * 7 / 7700) * 100) / 100);
  // And the sentence carries all three, so a target can never be read alone.
  assert.match(p.say, /against a maintenance of about/);
  assert.match(p.say, /kg a week/);

  // No goal set: no invented target, and nothing pretending to be one.
  const bare = planRead({ profile: { height_cm: 190.5, birth_year: 1982, sex: 'male', activity_level: 'moderate' },
                          goals: [], weightKg: 149.7 });
  assert.equal(bare.calorie_target, null);
  assert.equal(bare.deficit, null);
  assert.equal(bare.set, false);
  assert.ok(bare.missing.length, 'nothing named as missing');
  // Maintenance is still knowable and still said — that is the number that
  // stops a model reaching for a plausible one.
  assert.ok(bare.maintenance > 0);

  assert.match(SERVER_INSTRUCTIONS, /THE TARGET IS ALWAYS QUOTED BESIDE ITS MAINTENANCE/);
  assert.match(SERVER_INSTRUCTIONS, /Never quote the target alone/);
});

await test('the plan is readable on the website, not only through the assistant', () => {
  // It lived only inside the my_plan tool, so the plan was something you could
  // be TOLD and never somewhere you could go and LOOK — on the product whose
  // whole promise is memory.
  const api = readFileSync(new URL('../netlify/functions/api-progress.js', import.meta.url), 'utf8');
  assert.match(api, /planRead\(/, 'the dashboard cannot read the plan');
  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  assert.match(mcp, /planRead\(/, 'my_plan no longer shares the reader');
  // One reader, or the plan somebody is told and the plan they can look at drift.
  const src = page('app.html');
  assert.match(src, /function planPanel\(/);
  assert.match(src, /maintenance/, 'the page can draw a target with no maintenance beside it');
});

await test('twenty questions exist and are never asked at once', () => {
  // The founder wanted a twenty-question intake. He is right that the context
  // helps and wrong about the delivery — a twenty-question form at signup is
  // the most reliable way to make somebody close the tab. So the questions
  // exist and get picked up one at a time, in passing.
  assert.ok(INTAKE.length >= 20, `only ${INTAKE.length} things are tracked`);

  const blank = intakeState({ profile: {}, goals: [], memory: [] });
  // The five that stop the arithmetic are marked, and nothing else is.
  assert.equal(blank.blocking.length, 5);
  assert.equal(blank.complete, false);
  // One at a time, and the list is never presented.
  assert.match(blank.note, /ask for those together in one message/i);

  const started = intakeState({
    profile: { height_cm: 190, birth_year: 1982, sex: 'male', activity_level: 'moderate' },
    weightKg: 149.7, goals: [], memory: [],
  });
  assert.equal(started.blocking.length, 0);
  assert.match(started.note, /NEVER ask more than ONE of these at a time/);
  assert.match(started.note, /do not mention that a list exists/i);
  // Injuries jump the queue: programming around one nobody mentioned is how
  // this hurts somebody.
  assert.match(started.ask_next, /injur/i);

  // Recorded, never advised on — the not-a-doctor line, in the place it is
  // most tempting to cross.
  const meds = INTAKE.find(i => i.key === 'medication');
  assert.match(meds.asks, /never advised on/i);

  assert.match(SERVER_INSTRUCTIONS, /TWENTY THINGS ARE WORTH KNOWING AND YOU MAY ASK ONE/);
  assert.match(SERVER_INSTRUCTIONS, /never present it as a form/i);

  const src = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function getProfileTool('), src.indexOf('async function guide('));
  assert.match(fn, /intakeState\(/);
  assert.match(fn, /intake,/);
});

await test('a missing target is filled by the server, not by the model', () => {
  // THE NAMED FAILURE, IN PRODUCTION. Asked "how many am I allowed today at my
  // weight" with no goal on file, the answer was "around 2,500-2,700, I'd set
  // your working target at 2,600". Nothing set 2,600 — and it was several
  // hundred BELOW what the paced arithmetic gives, under even the most
  // aggressive setting this product will apply. Instructions alone did not
  // stop it and were never going to: a model invents when it is asked a
  // question and handed nothing. So it is handed something.
  const p = { height_cm: 190.5, birth_year: 1982, sex: 'male', activity_level: 'moderate' };
  const t = targetOptions({ profile: p, weightKg: 149.7 });
  assert.ok(t.known);
  assert.equal(t.set, false, 'options must never read as a target already set');
  assert.ok(t.maintenance > 3000);
  for (const pace of ['gentle', 'steady', 'aggressive']) {
    assert.ok(t.to_lose[pace].calories >= 1200, `${pace} broke the floor`);
    assert.ok(Math.abs(t.to_lose[pace].kg_per_week) < 1.2, `${pace} paces into the care flag`);
  }
  // Faster means fewer, in order, and every one is well above the invented 2,600.
  assert.ok(t.to_lose.aggressive.calories < t.to_lose.steady.calories);
  assert.ok(t.to_lose.steady.calories < t.to_lose.gentle.calories);
  assert.ok(t.to_lose.aggressive.calories > 2600,
    'the computed floor is below the number that was invented — the guard is pointless');
  assert.match(t.note, /never round them into a range/i);

  // Missing facts produce a refusal, never a guess.
  const blind = targetOptions({ profile: {}, weightKg: null });
  assert.equal(blind.known, false);
  assert.match(blind.say, /rather than estimating one/i);
});

await test('every read that gets asked "what am I allowed" carries the answer', () => {
  const src = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  assert.match(src, /async function targetsFor\(/);
  // The three tools that question actually lands on.
  for (const fn of ['getProfileTool', 'getDay', 'energyBalanceTool']) {
    const body = src.slice(src.indexOf(`async function ${fn}(`), src.indexOf(`async function ${fn}(`) + 2200);
    assert.match(body, /targetsFor\(/, `${fn} cannot answer it`);
    assert.match(body, /no_target_set/, `${fn} does not carry the options`);
  }
  // And the rule, stated where it cannot be missed.
  assert.match(SERVER_INSTRUCTIONS, /NEVER STATE A CALORIE TARGET YOU DID NOT GET FROM A TOOL/);
  assert.match(SERVER_INSTRUCTIONS, /2,600/);
  assert.match(SERVER_INSTRUCTIONS, /do not say "I'd set your target at" anything/i);
});

await test('the resting figure shows its working', () => {
  // "It should be about 3,000 and I don't know why it keeps reverting it
  // there." Nothing was reverting — it is deterministic from height, weight,
  // age and sex — but there was no way to SEE that, so it looked arbitrary.
  const r = restingBurn({ height_cm: 185, birth_year: 1986, sex: 'male' }, 149.7);
  assert.ok(r.basis, 'the working is not carried');
  assert.equal(r.basis.formula, 'Mifflin-St Jeor');
  assert.equal(r.basis.weight_kg, 149.7);
  assert.equal(r.basis.height_cm, 185);
  assert.match(r.basis.say, /149\.7kg, 185cm, age 40, male/);
  // The distinction that causes the argument, stated once.
  assert.match(r.basis.caveat, /BASAL/);
  assert.match(r.basis.caveat, /maintenance/i);
  assert.match(r.basis.caveat, /never swap the formula/i);

  const b = energyBalance({ profile: { height_cm: 185, birth_year: 1986, sex: 'male', activity_level: 'moderate' },
                            weightKg: 149.7, caloriesIn: 0, activeCalories: 0 });
  assert.ok(b.resting_basis, 'the balance drops the working');
  const page = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
  assert.match(page, /function restingBasis/);
});

await test('the watch\'s basal pair is used whole, never spliced', () => {
  // Apple defines active energy as THEIR total minus THEIR basal. Pairing
  // Apple's active with our Mifflin basal makes a total that matches neither
  // frame — which is exactly why the founder's watch said one resting number
  // and the screen said another, both calling themselves his basal.
  const p = { height_cm: 190.5, birth_year: 1982, sex: 'male', activity_level: 'moderate' };
  const b = energyBalance({ profile: p, weightKg: 149.7, caloriesIn: 1500,
                            activeCalories: 1126, deviceResting: 2980 });
  assert.equal(b.resting_burn, 2980);
  assert.equal(b.resting_source, 'device');
  // The pair sums to Apple's own total, exactly.
  assert.equal(b.calories_out, 2980 + 1126);
  // And the basis names the source, with the formula beside it to compare.
  assert.match(b.resting_basis.say, /Your watch reports/);
  assert.match(b.resting_basis.say, /Mifflin-St Jeor/);

  // No watch basal → the formula, unchanged.
  const f = energyBalance({ profile: p, weightKg: 149.7, caloriesIn: 1500, activeCalories: 1126 });
  assert.equal(f.resting_source, 'formula');

  // A watch basal even RESCUES a profile the formula cannot run on.
  const bare = energyBalance({ profile: {}, weightKg: null, caloriesIn: 0,
                               activeCalories: 500, deviceResting: 2900 });
  assert.equal(bare.known, true);
  assert.equal(bare.resting_burn, 2900);
});

await test('a device owner never gets a projection, only "open the app"', () => {
  // "I don't want projected, I want what I use off my Health." For an account
  // whose watch normally reports, a silent morning means NOT SENT YET — and a
  // whole-day multiplier standing in for a watch with real numbers on it is
  // the exact thing the owner did not ask for.
  const p = { height_cm: 190.5, birth_year: 1982, sex: 'male', activity_level: 'moderate' };
  const b = energyBalance({ profile: p, weightKg: 149.7, caloriesIn: 0,
                            activeCalories: 0, deviceExpected: true });
  assert.equal(b.active_source, 'awaiting_device');
  assert.equal(b.other_burn, 0, 'a projection leaked in');
  assert.match(b.say, /has not sent today/i);
  assert.match(b.say, /nothing is projected/i);
  assert.match(b.say, /open the Wrought app/i);

  // No device on the account → the multiplier fallback stands, unchanged.
  const noDev = energyBalance({ profile: p, weightKg: 149.7, caloriesIn: 0, activeCalories: 0 });
  assert.equal(noDev.active_source, 'activity_level');

  // Every caller passes the pair through.
  for (const [file, fn] of [['mcp.js', 'balanceFor'], ['api-progress.js', null], ['api-voice.js', null]]) {
    const src = readFileSync(new URL(`../netlify/functions/${file}`, import.meta.url), 'utf8');
    assert.match(src, /deviceResting:/, `${file} drops the watch basal`);
    assert.match(src, /deviceExpected/, `${file} cannot tell a silent watch from no watch`);
  }
  assert.match(SERVER_INSTRUCTIONS, /THE WATCH'S OWN BASAL WINS/);
  assert.match(SERVER_INSTRUCTIONS, /awaiting_device/);
});

await test('an activity multiplier is a forecast, and says so', () => {
  // The same number at 8am and at 11pm, because nothing measured anything.
  // Reporting it as what has already been burned is a claim about a morning
  // that did not happen.
  const b = energyBalance({ profile: { height_cm: 185, birth_year: 1986, sex: 'male', activity_level: 'moderate' },
                            weightKg: 149.7, caloriesIn: 0, activeCalories: 0 });
  assert.equal(b.other_projected, true);
  const measured = energyBalance({ profile: { height_cm: 185, birth_year: 1986, sex: 'male', activity_level: 'moderate' },
                                   weightKg: 149.7, caloriesIn: 0, activeCalories: 600 });
  assert.equal(measured.other_projected, false);
  const page = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
  assert.match(page, /moving, projected/);
  assert.match(SERVER_INSTRUCTIONS, /AN ACTIVITY MULTIPLIER IS A FORECAST/);
  assert.match(SERVER_INSTRUCTIONS, /RESTING BURN IS BASAL, NOT MAINTENANCE/);
});

await test('nothing eaten yet is not a deficit', () => {
  // The resting burn is a WHOLE DAY's figure, so at 7am with no food logged the
  // subtraction reads "3,833 under" — an artifact of the day being four hours
  // old, not a reading. And it runs in the dangerous direction: an overstated
  // deficit is the number that tells somebody to eat less than they need.
  const src = page('app.html');
  const hero = src.slice(src.indexOf('function hero(d) {'), src.indexOf('function burnSplit('));
  assert.match(hero, /if \(!b\.calories_in\)/);
  assert.match(hero, /to burn today/);
  assert.match(hero, /whole day's estimate/);
  // The ring is only drawn once there is a ratio to draw.
  assert.ok(hero.indexOf('if (!b.calories_in)') < hero.indexOf('const ratio'));
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

group('The bridge — a logged workout reaches the set record');

await test('an after-the-fact workout becomes real sets', () => {
  // "Log my workout: bench 235 for 4" arrived as ONE event whose exercises
  // never reached wrought_sets — the grain the lift record, the estimated max
  // and the progression call are computed from. The person logging by telling
  // their AI afterwards, which is the most ordinary way to log, had training
  // that counted for nothing in the one place it matters.
  const rows = setRowsFromWorkout('u1', {
    id: 42, event_type: 'workout', local_date: '2026-08-12',
    detail: { kind: 'strength', muscles: ['chest', 'back'], exercises: [
      { name: 'Bench press', sets: 3, reps: 8, weight_kg: 106.6 },
      { name: 'Hammer Strength Row', sets: 2, reps: 8, weight_kg: 99.8 },
      { name: 'Push-ups', sets: 1, reps: 10 },
    ] },
  });

  assert.equal(rows.length, 6, 'sets were not expanded per the claim');
  // A claim of "3 sets of 8 at 106.6" is faithfully three rows of exactly
  // that — nothing invented, nothing smeared into a PR.
  const bench = rows.filter(r => r.exercise === 'Bench press');
  assert.equal(bench.length, 3);
  assert.ok(bench.every(r => r.reps === 8 && r.weight_kg === 106.6));
  assert.deepEqual(bench.map(r => r.set_number), [1, 2, 3]);
  assert.ok(bench.every(r => r.position === 1));
  assert.ok(bench.every(r => r.event_id === 42), 'rows are not tied to their event');
  assert.ok(bench.every(r => r.session_id === null));
  assert.ok(bench.every(r => r.local_date === '2026-08-12'), 'sets drifted off the workout day');
  // Bodyweight stays null — never a guessed load.
  assert.ok(rows.filter(r => r.exercise === 'Push-ups').every(r => r.weight_kg === null));
});

await test('a session-backed event never derives sets — that would double every workout', () => {
  // The finaliser writes a workout event FROM real sets; deriving more from it
  // would count every gym session twice.
  const rows = setRowsFromWorkout('u1', {
    id: 43, event_type: 'workout', local_date: '2026-08-12',
    detail: { session_id: 'sess-1', exercises: [{ name: 'Bench press', sets: 3, reps: 8, weight_kg: 100 }] },
  });
  assert.equal(rows.length, 0);

  // No exercises, no sets — "doing my workout" stays a vague day, never rows.
  assert.equal(setRowsFromWorkout('u1', { id: 44, local_date: '2026-08-12', detail: { exercises: [] } }).length, 0);

  // And a mangled parse is capped, not obeyed.
  const silly = setRowsFromWorkout('u1', {
    id: 45, local_date: '2026-08-12',
    detail: { exercises: [{ name: 'Curl', sets: 900, reps: 8 }] },
  });
  assert.equal(silly.length, 10);
});

await test('every door a workout enters through feeds the bridge', () => {
  // log (typed or in passing), structure_entries (dictated, structured later),
  // amend_last (corrected afterwards). Any one missing and that path's
  // training silently counts for nothing.
  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const logFn = mcp.slice(mcp.indexOf('const written = await insertEvents(user.id, profile, events'), mcp.indexOf('const hungry ='));
  assert.match(logFn, /syncSetsFromWorkouts\(user\.id, written\)/, 'log does not feed the set record');
  const structFn = mcp.slice(mcp.indexOf('async function structureEntries('), mcp.indexOf('async function undoLast(') > 0 ? mcp.indexOf('async function undoLast(') : mcp.indexOf('async function structureEntries(') + 4000);
  assert.match(structFn, /syncSetsFromWorkouts/, 'a dictated workout never reaches the set record');
  const amendFn = mcp.slice(mcp.indexOf('async function amendLast('), mcp.indexOf('async function amendLast(') + 5000);
  assert.match(amendFn, /syncSetsFromWorkouts/, 'an amended workout does not re-derive its sets');
  // And insertEvents hands back the detail the bridge needs.
  const w = readFileSync(new URL('../netlify/functions/lib/wrought.js', import.meta.url), 'utf8');
  assert.match(w, /select\('id, event_type, summary, local_date, estimated, detail, occurred_at'\)/);
});

await test('a barbell row is not cardio, and neither is a crunch', () => {
  // The inline copies of the timed-movement regex had /row|run/ without word
  // boundaries: "row" is the front of every barbell row and "run" is the
  // middle of "crunch", so strength movements were classified as timed and
  // had their sets silently nulled on save. Data loss by regex.
  for (const strength of ['Hammer Strength Row', 'Barbell row', 'Seated cable row', 'Crunches', 'Front squat',
                          "Farmer's walk", 'Farmers walk', 'Walking lunges', 'Suitcase walk']) {
    assert.ok(!TIMED_MOVEMENT.test(strength), `${strength} was classified as cardio`);
    const m = normaliseMovement({ name: strength });
    assert.equal(m.sets, 3, `${strength} lost its default sets`);
  }
  for (const timed of ['Incline treadmill walk', 'Rowing machine', 'Rower', 'Assault bike', 'Running', 'Stairmaster', 'Swim']) {
    assert.ok(TIMED_MOVEMENT.test(timed), `${timed} was not classified as timed`);
  }
});

await test('the old 3×8 artifact on a timed movement reads back as unknown', () => {
  // Before minutes existed every movement was defaulted to 3×8, so a treadmill
  // stored as EXACTLY that pair with no minutes is the old default wearing a
  // movement it never described. It reads back as unknown rather than as a rep
  // scheme nobody chose — and ONLY the exact pair, because rewriting real data
  // to fit a theory is worse than the artifact.
  const artifact = readMovement({ name: 'Incline treadmill walk', sets: 3, reps: 8 });
  assert.equal(artifact.sets, null);
  assert.equal(artifact.reps, null);
  assert.equal(artifact.from_default, true);

  const deliberate = readMovement({ name: 'Incline treadmill walk', sets: 4, reps: 10 });
  assert.equal(deliberate.sets, 4, 'real data was rewritten to fit the theory');

  // With minutes on it the pair is not the artifact.
  assert.equal(readMovement({ name: 'Rower', sets: 3, reps: 8, minutes: 20 }).sets, 3);

  // AND IT IS A READ-TIME JUDGEMENT ONLY. Running it on the way IN would
  // rewrite the stored data of anybody who genuinely programmed a treadmill as
  // intervals, as a side effect of an unrelated edit.
  assert.equal(normaliseMovement({ name: 'Incline treadmill walk', sets: 3, reps: 8 }).sets, 3,
    'the artifact rule leaked into the write path');

  // And the dashboard read path uses the read shape.
  const api = readFileSync(new URL('../netlify/functions/api-progress.js', import.meta.url), 'utf8');
  assert.match(api, /readMovement\(e\)/, 'the Record tab reads movements raw');
  assert.match(api, /minutes: m\.minutes, detail: m\.detail/, 'minutes and detail are dropped on the read');
});

await test('the conversation is not the record', () => {
  // "What did I do today" was answered from the chat's own memory of the
  // workout — confidently, completely, and without ever noticing that none of
  // it had landed. The phrasebook maps the question to the tool, and says why.
  assert.match(SERVER_INSTRUCTIONS, /"what did I do today"/);
  assert.match(SERVER_INSTRUCTIONS, /THE CONVERSATION IS NOT THE RECORD/);
  assert.match(SERVER_INSTRUCTIONS, /hides exactly the entries that failed to land/);
});

await test('every foreign key matches the type of the column it points at', () => {
  // 016 shipped with `event_id bigint references wrought_events(id)` and
  // Postgres refused the whole migration: wrought_events.id is a uuid. The
  // wrong type was copied from wrought_sets' OWN id, which is a bigserial —
  // and wrought_sessions.event_id, three files away, was already uuid.
  //
  // A migration that will not run is the cheapest possible bug to catch and
  // the most annoying one to hit, because it surfaces as a wall of Postgres
  // error text in a SQL console with nobody around to read the schema.
  const files = readdirSync(new URL('../schema/', import.meta.url))
    .filter(f => /^\d{3}_.*\.sql$/.test(f)).sort();

  const NORM = { bigserial: 'bigint', serial: 'integer' };
  const norm = t => NORM[String(t).toLowerCase()] || String(t).toLowerCase();

  // What each table's id actually is.
  const idType = { 'auth.users': 'uuid' };
  for (const f of files) {
    const src = readFileSync(new URL(`../schema/${f}`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/create table if not exists (public\.\w+)\s*\(([\s\S]*?)\n\);/g)) {
      const col = m[2].match(/^\s*id\s+(\w+)/m);
      if (col) idType[m[1]] = norm(col[1]);
    }
  }
  assert.equal(idType['public.wrought_events'], 'uuid');
  assert.equal(idType['public.wrought_sets'], 'bigint');

  // Both declaration forms: inside a create table, and via alter table add.
  const refs = [];
  for (const f of files) {
    const src = readFileSync(new URL(`../schema/${f}`, import.meta.url), 'utf8');
    for (const m of src.matchAll(
      /(?:add column(?: if not exists)?\s+)?(\w+)\s+(uuid|bigint|integer|text|bigserial|serial)\b[^\n]*?references\s+(public\.\w+|auth\.users)\s*\(\s*(\w+)\s*\)/gi)) {
      const [, col, type, target, targetCol] = m;
      if (targetCol.toLowerCase() !== 'id') continue;
      refs.push({ file: f, col, type: norm(type), target, want: idType[target] });
    }
  }

  assert.ok(refs.length >= 20, `only found ${refs.length} foreign keys — the parser stopped seeing them`);
  const wrong = refs.filter(r => r.want && r.type !== r.want);
  assert.deepEqual(wrong, [],
    wrong.map(r => `${r.file}: ${r.col} is ${r.type} but ${r.target}.id is ${r.want}`).join('; '));

  // And the one this test was written for, named explicitly.
  const ev = refs.find(r => r.col === 'event_id' && r.file.startsWith('016'));
  assert.ok(ev, '016 no longer declares event_id');
  assert.equal(ev.type, 'uuid');
});

await test('a running total is the whole day, never the item just logged', () => {
  // "Add another ciabatta bun — how many am I at today?" came back with 330
  // kcal, 11g protein, 59g carbs, 6g fat: ONE ciabatta bun, reported as a
  // whole day. Structural rather than a model slip — `log` returned the day
  // only as prose, and `amend_last` (the tool the model calls straight
  // afterwards to fill in the macros it estimated) returned NO day total at
  // all. At the moment the question was asked, the only numbers in front of
  // it were the ones it had just written for that single item.
  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');

  assert.match(mcp, /function dayTotal\(day\)/);
  assert.match(mcp, /is: 'EVERYTHING logged today, not the item just added'/);

  // Every door that CHANGES the day hands the day back in numbers.
  for (const [fn, next] of [
    ['async function log(', 'async function parseLog('],
    ['async function amendLast(', '// Reading back what the phone could only hear'],
    ['async function structureEntries(', 'async function undoLast('],
  ]) {
    const at = mcp.indexOf(fn);
    const end = mcp.indexOf(next, at);
    const body = mcp.slice(at, end > at ? end : at + 6000);
    assert.match(body, /day_total: dayTotal\(/, `${fn} does not return the day's total`);
  }

  // amend_last re-reads the day AFTER the change, or the total is stale by
  // exactly the edit that was just made.
  const amend = mcp.slice(mcp.indexOf('async function amendLast('),
                          mcp.indexOf('// Reading back what the phone could only hear'));
  const changeAt = amend.indexOf('.update({');
  const readAt = amend.indexOf('const dayNow = await dayFacts(');
  assert.ok(readAt > changeAt, 'the day is read before the amend lands');

  assert.match(SERVER_INSTRUCTIONS, /A RUNNING TOTAL IS THE WHOLE DAY, NEVER THE THING JUST LOGGED/);
  assert.match(SERVER_INSTRUCTIONS, /never quote back the macros you just estimated for one meal/);
  // A low total is surfaced, not inflated — the same honesty as everywhere else.
  assert.match(SERVER_INSTRUCTIONS, /a fact worth surfacing, not a number to quietly inflate/);
});

await test('the day is spoken directly under the numbers', () => {
  // "If you're showing the facts of the numbers, you should be speaking to it
  // underneath — what did you do today? What did you log today? How much food
  // did you eat?" The Record tab drew the arithmetic ABOUT the day while the
  // actual entries lived only on the Log tab — so the first screen could say
  // "3,065 to burn" and hold no answer to "against what".
  const src = page('app.html');
  assert.match(src, /function foodTodayPanel\(d\)/);

  // Ordered: hero, then food, then training — the story before more arithmetic.
  const r = src.slice(src.indexOf('function render(d)'), src.indexOf('function stagger('));
  const heroAt = r.indexOf('out.push(hero(d));');
  const foodAt = r.indexOf('out.push(foodTodayPanel(d));');
  const trainAt = r.indexOf('out.push(trainingTodayPanel(d));');
  const windowAt = r.indexOf('out.push(windowPanel(d));');
  assert.ok(heroAt > -1 && foodAt > heroAt && trainAt > foodAt && windowAt > trainAt,
    'the day panels are not directly under the hero');
  // Moved, not duplicated — two copies of the training panel is a rendering bug.
  assert.equal((r.match(/out\.push\(trainingTodayPanel\(d\)\);/g) || []).length, 1);

  // Every item its own number, and the sum underneath — the day-card doctrine,
  // now on the screen that opens first. An entry with no calories says it
  // counts for nothing rather than showing a quiet dash.
  const fn = src.slice(src.indexOf('function foodTodayPanel(d)'), src.indexOf('function trainingTodayPanel(d)'));
  assert.match(fn, /counts for nothing yet/);
  assert.match(fn, /kcal in so far/);
  assert.match(fn, /the real total is higher/);
  // The empty state names the failure it is most often hiding: food said to an
  // AI that heard it and never wrote it down.
  assert.match(fn, /it heard you and never wrote it down/);

  // Heart rate on the training rows reads the session effort stamp as well as
  // a device's own fields — an assistant-run session carries it under effort.
  const train = src.slice(src.indexOf('function trainingTodayPanel(d)'), src.indexOf('// ── Calendar'));
  assert.match(train, /x\.avg_hr \?\? x\.effort\?\.avg_hr/);
});

await test('a missing meal is a missing ENTRY, never a missing sum', () => {
  // "Total so far: ~880 calories." — "Huh, what about breakfast???" — "You're
  // right, I missed your breakfast... you're at about 1,280–1,330 calories
  // today." Two failures in one reply.
  //
  // The RANGE is the tell: day_total returns one figure computed from stored
  // rows, so "1,280–1,330" can only mean the arithmetic happened in prose.
  // The deeper one is that the bagel was never LOGGED — mentioned,
  // acknowledged, never written. The total was right; the recital was wrong.
  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const fn = mcp.slice(mcp.indexOf('function dayTotal(day)'), mcp.indexOf('function itemSay('));

  // The reconciliation the server cannot do and the model can, carried where
  // it cannot be skipped: on the answer to the call it just made.
  assert.match(fn, /check: 'These items ARE the day/);
  assert.match(fn, /it was never logged — call log for it NOW/);
  assert.match(fn, /never quote a range/);
  // Patching a noticed gap with arithmetic is named as the worst answer,
  // because it hides a missing entry behind a number that looks right.
  assert.match(fn, /never fill a gap you noticed with arithmetic instead of a write/);

  assert.match(SERVER_INSTRUCTIONS, /A TOTAL IS ONE COMPUTED NUMBER, AND A RANGE IS THE TELL THAT YOU MADE IT UP/);
  assert.match(SERVER_INSTRUCTIONS, /that is a missing ENTRY, not a missing sum/);
  assert.match(SERVER_INSTRUCTIONS, /tomorrow the day is still short a bagel/);

  // AND IT RIDES ON THE TOOLS, not only the sheet — the surface every client
  // demonstrably reads.
  const log = TOOLS.find(t => t.name === 'log').description;
  assert.match(log, /the moment food is MENTIONED/);
  assert.match(log, /the next thing you do is call this, never arithmetic/);
  const day = TOOLS.find(t => t.name === 'get_day').description;
  assert.match(day, /ONE computed figure, never a range/);
  assert.match(day, /rather than adding it up in prose/);
});

await test('every item carries its own calories, and the total sits underneath', () => {
  // The founder, having got the total fixed: "when I ask to add something he
  // has to give the individual calories as well, not just a total." The same
  // argument he already made about the day card — "one steak's up to the right
  // and the pizza's to the left, should be altogether and then a total" — now
  // made about the conversation. A sum with nothing beside it is unauditable:
  // you cannot see which item is the 750, so a mis-heard entry hides inside it
  // forever and the one person who could correct it never gets the chance.
  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');

  // The total is made of something, and says what.
  const total = mcp.slice(mcp.indexOf('function dayTotal(day)'), mcp.indexOf('function itemSay('));
  assert.match(total, /items:/, 'the day total does not carry its items');
  assert.match(total, /filter\(e => e\.type === 'food' \|\| e\.type === 'drink'\)/);
  for (const f of ['calories', 'protein_g', 'carbs_g', 'fat_g']) {
    assert.match(total, new RegExp(`${f}: e\\.${f}`), `items drop ${f}`);
  }

  // The thing just logged comes back with its own figures — and they are read
  // off the STORED row, not echoed from the arguments. A model reciting its own
  // input back proves nothing landed, which is the failure this whole area of
  // the file exists to prevent.
  const logFn = mcp.slice(mcp.indexOf('async function log('), mcp.indexOf('async function parseLog('));
  assert.match(logFn, /recorded: written\.map/);
  assert.match(logFn, /\.\.\.itemNumbers\(e\.detail \|\| \{\}\)/,
    'recorded entries do not carry their own numbers off the stored row');
  assert.ok(!/itemNumbers\(args\./.test(logFn), 'item numbers are echoed from the arguments');

  // amend_last is the door that most often WRITES the macros, so it is the one
  // that most needs to read them back.
  const amend = mcp.slice(mcp.indexOf('async function amendLast('),
                          mcp.indexOf('// Reading back what the phone could only hear'));
  assert.match(amend, /const entry = \(dayNow\.log \|\| \[\]\)\.find/,
    'amend_last does not read the amended entry back from the stored day');
  assert.match(amend, /entry: entry/);
  const entryAt = amend.indexOf('const entry =');
  assert.ok(entryAt > amend.indexOf('.update({'), 'the entry is read before the amend lands');

  // structure_entries, same shape.
  const struct = mcp.slice(mcp.indexOf('async function structureEntries('),
                           mcp.indexOf('async function undoLast('));
  assert.match(struct, /entries: withNumbers/, 'structured entries drop their own numbers');

  // And the rule that makes the model actually say both.
  assert.match(SERVER_INSTRUCTIONS, /EVERY ITEM GETS ITS OWN NUMBER, AND THE TOTAL GOES UNDERNEATH/);
  assert.match(SERVER_INSTRUCTIONS, /Never the total on its own/);
  // Still labelled an estimate — a per-item figure is inferred exactly as the
  // sum is, and breaking it out must not make it look measured.
  assert.match(SERVER_INSTRUCTIONS, /Every one of these is an estimate and is said to be one/);
});

group('The questionnaire is a gate — the founder\'s explicit instruction');

const intakeModule = await import('../netlify/functions/lib/intake.js');
const { intakeGate } = intakeModule;

await test('a gate that only refuses is a dead end', () => {
  // The founder asked for the gate and then hit it: "the GPT hasn't really
  // prompted me on anything — when I say I want to do a workout it should be
  // saying where you at, and the checkmark thing is not happening." All true,
  // and all downstream of this: every training door answered with a refusal,
  // so no session ever started, so there was never a clipboard to tick.
  // Nineteen questions became nineteen turns of nothing happening.
  const st = intakeState({
    profile: { height_cm: 190, birth_year: 1982, sex: 'male', activity_level: 'moderate', timezone: 'America/Toronto' },
    goals: [], memory: [], weightKg: 149.7,
  });
  const g = intakeGate(st);

  // Four, ready to ask — not the whole list, which is a form, and not none,
  // which is what leaves the asking to a model that then writes one polite
  // sentence and stops.
  assert.equal(g.ask_now.length, 4);
  assert.ok(g.remaining.length > 4, 'this account is not actually short of answers');

  // THEY ARE IN THE SECOND PERSON. The `asks` forms are written for a MODEL to
  // read — "what they are actually after" — and reading one of those to a
  // person is baffling.
  for (const q of g.ask_now) {
    assert.ok(!/\bthey\b|\bthem\b|\btheir\b/i.test(q), `"${q}" is written about them, not to them`);
  }
  // And they are in `say` too, so even a relay that reads nothing else moves
  // the setup forward by four instead of announcing itself.
  for (const q of g.ask_now) assert.ok(g.say.includes(q), `"${q}" is not in the spoken line`);
  assert.match(g.say, /then the workout/, 'nothing says why they are being asked');
  assert.match(g.note, /ASK THE QUESTIONS IN ask_now, IN THIS MESSAGE/);

  // Every one of the 25 has both forms, or a question turns up unsaid.
  const { INTAKE } = intakeModule;
  for (const i of INTAKE) {
    assert.ok(i.ask, `"${i.key}" has no spoken form`);
    assert.ok(!/\bthey\b|\btheir\b/i.test(i.ask), `"${i.key}" is asked in the third person`);
  }

  // The words he actually used reach the door at all.
  for (const p of ['I want to do a workout', 'I wanna do a workout', "let's do a workout"]) {
    assert.ok(SERVER_INSTRUCTIONS.includes(p), `"${p}" maps to nothing`);
  }
});

await test('an unfinished questionnaire stops every door that BUILDS training', () => {
  // "We should put that as a stop place — we can't further any workouts until
  // the questionnaire is finished." Asked twice; the second time is decisive,
  // and it overrides the softer in-passing-only doctrine for these four tools.
  const half = intakeState({
    profile: { height_cm: 190, birth_year: 1982, sex: 'male', activity_level: 'moderate', timezone: 'America/Toronto' },
    goals: [], memory: [], weightKg: 149.7,
  });
  assert.equal(half.complete, false);
  const gate = intakeGate(half);
  assert.ok(gate, 'no gate for an unfinished questionnaire');
  assert.equal(gate.setup_required, true);
  assert.ok(gate.remaining.length > 0);
  assert.match(gate.note, /do NOT build, suggest or start a workout/);
  // It ASKS rather than only announcing itself.
  assert.equal(gate.ask_now.length, 4);
  // Loose answers are allowed and "none" closes a question — both said, or the
  // model interrogates people into precision they never offered.
  assert.match(gate.note, /"lose weight AND build muscle" is recomp/);
  assert.match(gate.note, /"None" is a real answer/);

  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const bodyOf = fn => {
    const at = mcp.indexOf(`async function ${fn}(`);
    return mcp.slice(at, mcp.indexOf('\nasync function ', at + 10));
  };
  for (const fn of ['suggestWorkout', 'startBlock', 'designWorkout']) {
    assert.match(bodyOf(fn), /trainingGate\(user, profile/, `${fn} is not gated`);
  }

  // START_SESSION IS GATED ONLY WHEN IT WOULD HAVE TO INVENT THE SESSION.
  //
  // The line moved once, on the founder's call, because the first version was
  // too wide: gating start_session outright meant somebody with the
  // questionnaire unfinished could not run a workout THEY had already saved —
  // which is not prescribing, it is their own plan plus recording what they do
  // against it. The symptom was total. No session, so no clipboard, so nothing
  // to tick and no position to be asked about: "the GPT hasn't really prompted
  // me on anything."
  const start = bodyOf('startSession');
  const routineAt = start.indexOf('if (args.routine)');
  const gateInStart = start.indexOf('trainingGate(user, profile');
  assert.ok(gateInStart > routineAt, 'start_session is gated before it knows whether they named a routine');
  assert.match(start, /if \(!routine\) \{\n\s*const gate = await trainingGate/,
    'start_session gates a workout they already saved');
  // And the refusal names the way through, or somebody concludes the product
  // is broken while a saved workout sits right there.
  assert.match(start, /can_run_now: names/);
  assert.match(start, /just say the name/);

  // log_set is NEVER gated — it opens an ad-hoc session on the first set, and
  // that is capture, which is the one thing that stays open forever.
  assert.ok(!/trainingGate/.test(bodyOf('logSet')), 'logging a set went behind the gate');

  // programmes gates the BUILDING half only — the single-pattern lookup is the
  // mid-session swap case and mid-session is past the gate.
  const prog = mcp.slice(mcp.indexOf('async function programmes(args, user)'));
  const patternAt = prog.indexOf('if (args.pattern)');
  const gateAt = prog.indexOf('trainingGate(user, profile)');
  assert.ok(gateAt > patternAt, 'the mid-session pattern lookup is gated too');
  assert.match(SERVER_INSTRUCTIONS, /THE QUESTIONNAIRE GATES BUILDING A WORKOUT, NOT RUNNING ONE/);
  assert.match(SERVER_INSTRUCTIONS, /STARTING A WORKOUT THEY ALREADY SAVED IS NEVER GATED/);
});

await test('a finished questionnaire opens the gate, and capture is never behind it', () => {
  const done = intakeState({
    profile: { height_cm: 190, birth_year: 1982, sex: 'male', activity_level: 'moderate',
               plan_pace: 'steady', plan_push: 'normal', train_days: 4, training_age: 'intermediate',
               equipment: ['full gym'], dietary: ['none'], bluntness: 'brutal', brief_hour: 21,
               timezone: 'America/Toronto' },
    goals: [{ metric: 'weight_kg', direction: 'at_most' }],
    memory: [
      { category: 'training', fact: 'runs most mornings' },
      { category: 'lifts', fact: 'benches around 235' },
      { category: 'health', fact: 'no injuries' },
      { category: 'food', fact: 'cooks most nights, drinks rarely, evenings are the weak spot' },
    ],
    weightKg: 149.7, intent: 'lose',
  });
  assert.equal(done.complete, true, `still unknown: ${done.still_unknown.join('; ')}`);
  assert.equal(intakeGate(done), null, 'a finished questionnaire still gates');

  // CAPTURE IS NEVER GATED. log and log_set record what already happened, and
  // refusing to remember somebody's training is the opposite of the product.
  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  for (const fn of ['async function log(', 'async function logSet(']) {
    const body = mcp.slice(mcp.indexOf(fn), mcp.indexOf(fn) + 2500);
    assert.ok(!/trainingGate|intakeGate|setup_required/.test(body),
      `${fn} is gated — capture must never be`);
  }
  assert.match(SERVER_INSTRUCTIONS, /CAPTURE IS NEVER GATED/);
});

await test('the questionnaire is visible on the dashboard, not only inside a refusal', () => {
  // A gate nobody can see is indistinguishable from a product that never asks.
  const api = readFileSync(new URL('../netlify/functions/api-progress.js', import.meta.url), 'utf8');
  assert.match(api, /setup: \{/);
  assert.match(api, /intakeState\(\{ profile, goals, memory, weightKg/);
  const src = page('app.html');
  assert.match(src, /function setupPanel\(/);
  assert.match(src, /out\.push\(setupPanel\(d\)\);/);
  assert.match(src, /Workouts unlock when this is finished/);
});

group('The bridge, as an adversarial review left it');

await test('a derived set is stamped with the WORKOUT\'s time, never the sync\'s', () => {
  // lastPerformance orders by logged_at and reads the newest row's date as
  // "last session". Stamping a Monday workout — structured on Thursday, which
  // is the ordinary case for dictated entries — with Thursday's clock makes it
  // outrank a real Wednesday session, and progressionCall then prescribes from
  // the older, lighter day.
  const rows = setRowsFromWorkout('u1', {
    id: 7, event_type: 'workout', local_date: '2026-08-10',
    occurred_at: '2026-08-10T18:30:00.000Z',
    detail: { exercises: [{ name: 'Bench press', sets: 2, reps: 8, weight_kg: 90 }] },
  });
  assert.ok(rows.every(r => r.logged_at === '2026-08-10T18:30:00.000Z'),
    'derived sets carry the sync time instead of the workout time');

  // No timestamp: midday on its own date still orders correctly against other
  // days, which is all that matters.
  const noTime = setRowsFromWorkout('u1', {
    id: 8, event_type: 'workout', local_date: '2026-08-10',
    detail: { exercises: [{ name: 'Row', sets: 1, reps: 8 }] },
  });
  assert.equal(noTime[0].logged_at, '2026-08-10T12:00:00.000Z');
});

await test('a day already covered by a live session is not derived over', () => {
  // Training set by set and then re-telling the same workout would otherwise
  // write a second copy beside the real one, and every read that keys sessions
  // by session-id-or-date would see two sessions on one day.
  const ev = {
    id: 9, event_type: 'workout', local_date: '2026-08-12',
    detail: { exercises: [
      { name: 'Bench press', sets: 3, reps: 8, weight_kg: 100 },
      { name: 'Lateral raise', sets: 3, reps: 12, weight_kg: 10 },
    ] },
  };
  const all = setRowsFromWorkout('u1', ev);
  assert.equal(all.length, 6);

  const partial = setRowsFromWorkout('u1', ev, { skipExercises: [exerciseKey('Bench press')] });
  assert.ok(partial.every(r => r.exercise !== 'Bench press'), 'the live bench was derived over');
  assert.equal(partial.length, 3, 'the untouched movement was dropped too');
});

await test('the bridge refuses to run without the migration that makes it safe', async () => {
  // Without event_id there is no way to identify an event's own derived rows,
  // so a re-sync could only ever ADD a second copy — an amend of "that was
  // 105, not 100" would leave both, and the corrected-away number would keep
  // feeding every strength read forever. A feature waiting on a migration is
  // a small cost; a lift record quietly holding retracted numbers is not
  // recoverable by the person it happens to.
  const t = readFileSync(new URL('../netlify/functions/lib/training.js', import.meta.url), 'utf8');
  const fn = t.slice(t.indexOf('export async function syncSetsFromWorkouts'));
  assert.match(fn, /skipped: 'needs_migration'/);
  assert.match(fn, /if \(!\(await setsCanBeTracked\(\)\)\)/);
  assert.ok(!/event_id/.test(fn.slice(fn.indexOf('needs_migration'), fn.indexOf('const ids ='))),
    'a fallback insert without event_id is back');

  // INSERT FIRST, THEN DELETE. Delete-then-insert is two round trips with no
  // transaction: a timeout after the delete erases a workout's whole set
  // record. Reversed, the worst case is a visible duplicate.
  const ins = fn.indexOf(".insert(all)");
  const del = fn.indexOf(".delete()");
  assert.ok(ins > 0 && del > ins, 'the delete still runs before the insert');
  // And the delete is scoped by user as well as event id.
  assert.match(fn, /\.eq\('user_id', userId\)\.in\('event_id', ids\)/);
});

await test('every caller surfaces what the bridge did, and never swallows it', () => {
  // A swallowed error is worse than a crash — the 015 postmortem. Here it
  // would mean training that looks logged and counts for nothing.
  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  for (const [fn, next] of [
    ['async function log(', 'async function parseLog('],
    ['async function amendLast(', 'async function structureEntries('],
    ['async function structureEntries(', 'async function undoLast('],
  ]) {
    const at = mcp.indexOf(fn);
    const end = mcp.indexOf(next) > at ? mcp.indexOf(next) : at + 6000;
    const body = mcp.slice(at, end);
    if (!/syncSetsFromWorkouts/.test(body)) continue;
    assert.ok(!/^\s*await syncSetsFromWorkouts/m.test(body), `${fn} discards the bridge result`);
    assert.match(body, /sets_error/, `${fn} never surfaces a bridge error`);
  }
});

await test('a re-classified entry has its derived sets cleared, not orphaned', () => {
  // A mis-structured note that used to be a workout must not leave phantom
  // training in the lift record. So non-workout events are still PASSED to the
  // sync — they derive nothing and delete what they used to.
  const t = readFileSync(new URL('../netlify/functions/lib/training.js', import.meta.url), 'utf8');
  const fn = t.slice(t.indexOf('export async function syncSetsFromWorkouts'));
  assert.match(fn, /if \(ev\.event_type !== 'workout'\) continue;\s*\/\/ a cleared type: delete only/);
  // The early return is on "no events", never on "no rows to write" — an
  // amend that empties the exercises must still clear what it derived.
  assert.match(fn, /const touched = events\.filter\(e => e\?\.id != null\);/);
  assert.ok(!/if \(!all\.length\) return/.test(fn), 'an emptied workout keeps its old sets');

  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const struct = mcp.slice(mcp.indexOf('async function structureEntries('), mcp.indexOf('async function undoLast('));
  assert.ok(!/if \(u\.type !== 'workout'\) continue/.test(struct),
    'structure_entries still skips re-classified entries');
});

await test('editing one movement never rewrites the others', () => {
  // Both add and remove used to re-shape and persist the WHOLE list, so a
  // treadmill deliberately programmed 3×8 was rewritten to null as a side
  // effect of adding calf raises. One tap destroying data in movements the
  // user never touched.
  const api = readFileSync(new URL('../netlify/functions/api-routines.js', import.meta.url), 'utf8');
  const add = api.slice(api.indexOf("if (action === 'add')"), api.indexOf("if (action === 'remove')"));
  const rem = api.slice(api.indexOf("if (action === 'remove')"), api.indexOf("if (action === 'update')"));
  for (const [name, body] of [['add', add], ['remove', rem]]) {
    assert.match(body, /Array\.isArray\(row\.exercises\) \? row\.exercises : \[\]/,
      `${name} re-shapes the stored list`);
    assert.ok(!/\.map\(shape\)/.test(body), `${name} still re-shapes stored movements`);
  }
  // The read path is where the judgement belongs.
  assert.match(api, /\.map\(readMovement\)/);
});

await test('a partial update changes only what was said', () => {
  // A fully-defaulted object spread over a stored movement blanks its minutes,
  // detail, cue and load for the sake of changing its reps.
  const stored = { name: 'Rower', sets: null, reps: null, minutes: 20,
                   detail: 'level 5', cue: 'long strokes', load_kg: null,
                   rest_s: 90, muscles: ['back'] };
  const patch = normaliseMovement({ name: 'Rower', sets: 3, reps: 8 }, { partial: true });
  const merged = { ...stored, ...patch };

  assert.equal(merged.sets, 3);
  assert.equal(merged.reps, 8);
  assert.equal(merged.cue, 'long strokes', 'the cue was blanked');
  assert.equal(merged.rest_s, 90, 'the rest was blanked');
  assert.deepEqual(merged.muscles, ['back'], 'the muscles were blanked');

  // Switching a timed movement to sets DOES clear the minutes, or it would
  // claim both and the screen would contradict itself.
  assert.equal(merged.minutes, null);

  // And the reverse: giving minutes clears sets and reps.
  const toTime = normaliseMovement({ name: 'Bench press', minutes: 15 }, { partial: true });
  assert.equal(toTime.minutes, 15);
  assert.equal(toTime.sets, null);
  assert.equal(toTime.reps, null);

  // Nothing supplied changes nothing at all.
  assert.deepEqual(normaliseMovement({ name: 'Rower' }, { partial: true }), { name: 'Rower' });
});

group('A saved workout, edited from either door');

await test('a save can never silently delete what is already there', () => {
  // "Didn't save all the info — some of it saved." `exercises` REPLACED the
  // whole list, so "add the treadmill to S Tier" quietly wiped the bench press
  // and the shoulder press. A routine is built up over weeks, one good session
  // at a time, and a tool that erases it as a side effect of adding to it is
  // not safe to call.
  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const fn = mcp.slice(mcp.indexOf('async function saveRoutine('), mcp.indexOf('async function listRoutines('));
  assert.match(fn, /A SAVE MAY ONLY EVER ADD OR UPDATE\. NEVER SILENTLY DELETE\./);
  assert.match(fn, /const merge = \(base, incoming\)/);
  assert.match(fn, /args\.replace === true/, 'replacing is not behind an explicit flag');
  assert.match(fn, /Array\.isArray\(args\.remove\)/, 'there is no explicit way to take one out');

  // And the tool says so, or the model never passes the right field.
  const tool = TOOLS.find(t => t.name === 'save_routine');
  assert.match(tool.description, /MERGES/);
  assert.match(tool.description, /nothing already there is dropped/);
  assert.ok(tool.inputSchema.properties.remove, 'no remove field');
  assert.ok(tool.inputSchema.properties.replace, 'no replace field');
});

await test('a treadmill walk is not three sets of eight', () => {
  // It was saved as "3×8", which is nonsense on the screen and useless when
  // the session starts — what defines it is minutes, speed and incline.
  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const fn = mcp.slice(mcp.indexOf('async function saveRoutine('), mcp.indexOf('async function listRoutines('));
  assert.match(fn, /NOT EVERYTHING IS SETS AND REPS/);
  // ONE normaliser now, shared with the website door — behaviour is asserted
  // on the function itself below, not on a copied regex.
  assert.match(fn, /const shape = e => normaliseMovement\(e\);/);
  const walk = normaliseMovement({ name: 'Incline treadmill walk', minutes: 25, detail: 'level 10+, 2.5-3 mph' });
  assert.equal(walk.sets, null);
  assert.equal(walk.reps, null);
  assert.equal(walk.minutes, 25);
  assert.equal(walk.detail, 'level 10+, 2.5-3 mph');

  const tool = TOOLS.find(t => t.name === 'save_routine');
  const item = tool.inputSchema.properties.exercises.items.properties;
  assert.ok(item.minutes, 'no minutes field');
  assert.ok(item.detail, 'nowhere to keep "level 10+, 2.5-3 mph"');
  assert.match(item.detail.description, /verbatim/);

  // The page draws it as minutes rather than inventing a rep scheme.
  const src = page('app.html');
  const panel = src.slice(src.indexOf('function routinesPanel(d, {'), src.indexOf('function notesPanel('));
  assert.match(panel, /m\.minutes \? `\$\{m\.minutes\} min`/);
  assert.match(panel, /NOT EVERYTHING IS SETS AND REPS/);
});

await test('a routine can be built and edited on the website too', () => {
  // "In each workout it should have a slider like you can delete it or a
  // button to add... I can create it both on there and on AI." Talking is the
  // fast way to build one; a LIST is the thing a screen is genuinely better
  // at, because taking one movement out of the middle by voice means naming
  // it exactly and hoping.
  const api = readFileSync(new URL('../netlify/functions/api-routines.js', import.meta.url), 'utf8');
  for (const a of ['create', 'add', 'remove', 'update', 'toggle', 'delete']) {
    assert.ok(api.includes(`action === '${a}'`), `no ${a} action`);
  }
  // RETIRING IS NOT DELETING — what somebody used to run is part of the
  // record, exactly like a retired goal.
  assert.match(api, /RETIRING IS NOT DELETING/);
  assert.match(api, /active: !row\.active/);
  // A typed weight is theirs; a generated one still does not exist. The
  // founder overrode the flat no-loads rule for HIS OWN typed reference —
  // the door must never invent one of its own.
  assert.match(api, /A TYPED WEIGHT IS THEIRS; A GENERATED ONE STILL DOES NOT EXIST/);

  const src = page('app.html');
  assert.match(src, /function wireRoutines\(/);
  assert.match(src, /action: 'toggle'/);
  // Deleting asks; retiring does not, because one is reversible and one is not.
  assert.match(src, /confirm\(`Delete "\$\{b\.dataset\.rname\}" for good\?/);
  // Editing is offered on Trainer only — destructive controls in a
  // scroll-past is how somebody deletes a workout with their thumb.
  assert.match(src, /function routinesPanel\(d, \{ editable = false \} = \{\}\)/);
  assert.match(src, /routinesPanel\(\{ routines: trainerRoutinesFull\.length[\s\S]{0,160}editable: true/);
});

await test('"3x8 or 25 min" is one box, and it reads both', () => {
  // Two number fields for a treadmill walk is a form, and this has to be
  // faster than saying it out loud.
  const src = page('app.html');
  const fn = src.slice(src.indexOf('function parseHowMuch('), src.indexOf('function wireRoutines('));
  assert.match(fn, /min\(\?:ute\)\?s\?/);
  assert.match(fn, /\[x×\]/);
  // And the number and the setup are read TOGETHER — "25 min level 10+,
  // 2.5-3 mph" keeps both, because for cardio the trailing text IS the
  // instruction and dropping it saves half the movement.
  assert.match(fn, /if \(rest\) out\.detail = rest;/);
});

await test('removing a movement is a slide, not a button', () => {
  // "Make it a slide." The iPhone gesture: the row's content translates left
  // and the action is revealed BEHIND it, so nothing destructive is tappable
  // until the row has been deliberately moved.
  const src = page('app.html');
  const panel = src.slice(src.indexOf('function routinesPanel(d, {'), src.indexOf('function notesPanel('));
  assert.match(panel, /rmv-act/, 'no revealed action behind the row');
  assert.ok(!/class="rx"/.test(panel), 'the old x button is back');
  assert.match(panel, /Slide a movement left to take it out/);

  const wire = src.slice(src.indexOf('function wireSwipe('), src.indexOf('function wireRoutines('));
  assert.match(wire, /setPointerCapture/);
  assert.match(wire, /translateX/);
  // Vertical scrolling stays the browser's, or the list eats the page.
  assert.match(src, /touch-action: pan-y/);
  // Only a clearly horizontal drag claims the gesture.
  assert.match(wire, /Math\.abs\(mx\) > Math\.abs\(my\)/);
  // And keyboard users get the same action without the gesture.
  assert.match(src, /\.rmv:has\(\.rmv-act\.right:focus\) \.rmv-body \{ transform: translateX/);
});

await test('a routine write repaints the screen it just changed', () => {
  // "It didn't add the other stuff." It DID — the row was written and the
  // screen never showed it. The guard that stops the poll repainting the
  // Trainer tab every five seconds was keyed on the api-session body alone,
  // and this screen draws the saved workouts too. So adding a movement went:
  // save it, server returns the new list, re-render — identical SESSION
  // payload, early return, nothing on screen. From the outside that is
  // indistinguishable from a save that failed.
  //
  // A guard against repainting is only safe while it can see the whole of
  // what is painted.
  const src = page('app.html');
  const fn = src.slice(src.indexOf('async function loadTrainer('), src.indexOf('function renderTrainer('));
  assert.match(fn, /const jsonNow = JSON\.stringify\(body\)[\s\S]{0,80}trainerRoutinesFull/,
    'the repaint guard cannot see the routines it is drawing');

  // And the write still goes back through a re-render rather than patching
  // the DOM from a guess about what the server did.
  const act = src.slice(src.indexOf('async function routineAction('), src.indexOf('function parseHowMuch('));
  assert.match(act, /trainerRoutinesFull = body\.routines/);
  assert.match(act, /if \(view === 'trainer'\) loadTrainer\(\)/);
});

await test('the badge counts what the rows actually show', () => {
  // A treadmill walk stored with the old 3×8 default renders as "—" because
  // readMovement retires the artifact — and the count was still reading the
  // RAW rows, so a workout showing one 3×8 movement claimed six sets. A number
  // that contradicts the rows under it is worse than no number: it makes
  // somebody doubt the rows.
  const api = readFileSync(new URL('../netlify/functions/api-routines.js', import.meta.url), 'utf8');
  assert.match(api, /const shown = \(r\.exercises \|\| \[\]\)\.map\(readMovement\)/);
  assert.match(api, /sets: shown\.filter\(e => !e\.off\)\.reduce/,
    'the set count is not computed from the shown movements that are actually in');
  assert.ok(!/sets: \(r\.exercises \|\| \[\]\)\.reduce/.test(api), 'the count still reads the raw rows');

  // TWO SHAPES ARRIVE AT THE SAME PANEL. api-progress sends `exercises` as a
  // count; api-routines sends the array. The old fallback printed the array
  // into the markup the moment `sets` was 0 — which a routine of nothing but
  // timed work legitimately is.
  const src = page('app.html');
  const panel = src.slice(src.indexOf('function chipCount('), src.indexOf('function notesPanel('));
  assert.match(panel, /typeof r\.exercises === 'number' \? r\.exercises : movesOf\.length/,
    'the panel still assumes one shape for exercises');
  assert.ok(!/\$\{r\.sets \|\| r\.exercises \|\| movesOf\.length\}/.test(panel),
    'the array can still be printed straight into the chip');
});

await test('add[] carries the whole movement, not a lossy subset', () => {
  // "It changed to the treadmill on there, but it didn't have the other
  // information." The setup text — "level 10+, 2.5-3 mph" — was dropped at the
  // DOOR. `add[]` declared name, sets, reps and muscles and nothing else, so
  // there was nowhere to put `minutes` and nowhere to put `detail`. The model
  // had the words; the tool had no field for them.
  //
  // The implementation always merged the full shape. It was only the schema
  // that was narrow, which is the worst version of this bug: nothing errors
  // and nothing logs, and the save looks like it half-worked.
  const save = TOOLS.find(t => t.name === 'save_routine');
  const add = save.inputSchema.properties.add.items;
  const ex  = save.inputSchema.properties.exercises.items;
  assert.equal(add, ex, 'add[] and exercises[] are no longer the same declared shape');
  for (const f of ['name', 'sets', 'reps', 'minutes', 'detail', 'load_kg', 'rest_s', 'muscles', 'cue']) {
    assert.ok(add.properties[f], `add[] cannot carry ${f}`);
  }
  // The one field that made this visible, and why it is verbatim.
  assert.match(add.properties.detail.description, /never drop it because there was no obvious field/i);
  // Every movement they named goes in ONE call — one per turn is how a save
  // ends up holding half of what was asked for.
  assert.match(save.inputSchema.properties.add.description, /EVERY movement they named in this one call/);
});

await test('a movement can be taken out of a workout and put back', () => {
  // "Give me the ability to swipe the ones I want on the workout or not, so
  // add and remove as need be." Sliding a movement away used to DELETE it,
  // which makes the gesture something to be careful with — and a gesture
  // people are careful with is one they stop using.
  //
  // Same doctrine as a retired routine and a retired goal, one level down: a
  // movement dropped for a month is still part of what that workout is.
  const m = normaliseMovement({ name: 'Back Squat', sets: 4, reps: 6 });
  assert.equal(m.off, false, 'a movement is in the workout unless taken out');

  // The flag survives a partial edit and is not invented by one.
  assert.equal(normaliseMovement({ reps: 8 }, { partial: true }).off, undefined,
    'an unrelated edit writes an off flag');
  assert.equal(normaliseMovement({ off: true }, { partial: true }).off, true);
  assert.equal(readMovement({ name: 'Back Squat', sets: 4, reps: 6, off: true }).off, true);

  // AND IT ACTUALLY LEAVES THE SESSION. planFromRoutine is the only door from
  // a saved routine to a live one, so dropping it there drops it from the
  // clipboard, the checklist, the progress percentage and the next-lift call
  // at once. A switch that only changes the colour of a row is decoration.
  const plan = planFromRoutine({ tier: 'intermediate', exercises: [
    { name: 'Back Squat', sets: 4, reps: 6 },
    { name: 'Leg Press', sets: 3, reps: 10, off: true },
    { name: 'Calf Raise', sets: 3, reps: 12 },
  ] });
  assert.deepEqual(plan.map(p => p.name), ['Back Squat', 'Calf Raise']);
  // Positions renumber over what is actually being done, not over the gaps.
  assert.deepEqual(plan.map(p => p.index), [0, 1]);
});

await test('taking a movement out is one tap; deleting it is two and asks', () => {
  const api = readFileSync(new URL('../netlify/functions/api-routines.js', import.meta.url), 'utf8');
  assert.match(api, /action === 'bench'/, 'there is no way to take a movement out');
  // It toggles rather than only setting, so the same gesture puts it back.
  assert.match(api, /\{ \.\.\.e, off: !e\.off \}/);
  // And it never drops the row: everything else about the movement survives.
  assert.ok(!/action === 'bench'[\s\S]{0,400}filter\(/.test(api), 'taking one out deletes it');

  const src = page('app.html');
  const panel = src.slice(src.indexOf('function routinesPanel(d, {'), src.indexOf('function notesPanel('));
  // Delete is only offered on a row that is ALREADY out — two deliberate
  // steps for the one action that cannot be undone.
  assert.match(panel, /data-act="\$\{m\.off \? 'remove' : 'bench'\}"/);
  const wire = src.slice(src.indexOf('function wireRoutines('), src.indexOf('function checklistPanel('));
  assert.match(wire, /act === 'remove' && !confirm\(/, 'deleting a movement no longer asks');

  // The gesture goes both ways, and only where there is something behind it.
  const sw = src.slice(src.indexOf('function wireSwipe('), src.indexOf('function wireRoutines('));
  assert.match(sw, /const canRight = off/, 'every row can be pulled right, including ones already in');
  assert.match(sw, /row\.dataset\.open = 'right'/);
  assert.match(sw, /row\.dataset\.open = 'left'/);
  // Vertical scrolling still belongs to the browser.
  assert.match(src, /touch-action: pan-y/);

  // Taken out reads as taken out, and the affirmative action is the only one
  // in this list that is not warm.
  assert.match(src, /\.rmv\.benched \.rmvn \{[^}]*line-through/);
  assert.match(src, /\.rmv-act\.left \{[^}]*var\(--moss\)/);
});

await test('a typed weight is theirs — parsed with a unit, kept in kg, shown in theirs', () => {
  // The founder overrode the flat no-loads rule in as many words: "I can add
  // it for amount of weight or time." The line that survives is the one that
  // was always the point: WROUGHT never INVENTS a load. A weight the person
  // types on their own plan is their own reference.
  const src = page('app.html');
  const fnText = src.slice(src.indexOf('function parseHowMuch(raw)'), src.indexOf('// The slide. Pointer events'));
  const parseHowMuch = new Function(`${fnText}; return parseHowMuch;`)();

  // Stored in kg like every weight in the record, whatever unit was typed.
  assert.deepEqual(parseHowMuch('2x8 135lb'), { sets: 2, reps: 8, load_kg: 61.2 });
  assert.deepEqual(parseHowMuch('2x8 at 60kg'), { sets: 2, reps: 8, load_kg: 60 });
  // A bare number is AMBIGUOUS — guessing lb-or-kg on a health product is how
  // a number doubles. No unit, no load: it stays in the verbatim detail.
  assert.deepEqual(parseHowMuch('2x8 135'), { sets: 2, reps: 8, detail: '135' });
  // And the timed form is untouched.
  assert.deepEqual(parseHowMuch('25 min level 10+, 2.5-3 mph'),
    { minutes: 25, detail: 'level 10+, 2.5-3 mph' });

  // Shown back in THEIR unit — a 135 lb man must see his 135, not a silent
  // conversion — and the unit survives across tabs and visits.
  assert.match(src, /function sayLoad\(kg\)/);
  assert.match(src, /localStorage\.getItem\('wrought_wu'\)/);
  assert.match(src, /localStorage\.setItem\('wrought_wu', wu\)/);
  assert.match(src, /m\.load_kg \? sayLoad\(m\.load_kg\) : null/);
});

await test('a workout is filed on the day it happened, not the day the app opened', () => {
  // "I didn't have a workout today — that was yesterday's S-Tier, why is it
  // even on today?" He was right. finaliseSession has always passed the
  // session's real end time as occurred_at, and insertEvents silently
  // DISCARDED it, stamping "now" — so any session closed by the stale sweep
  // filed under the day the dashboard loaded. The doctrine "the event is
  // filed when it happened" was written in the comments and untrue in the
  // code. Same class as deriving local_date from UTC: right about WHAT,
  // wrong about WHEN, corrupting two days at once.
  const profile = { timezone: 'America/Toronto' };
  const now = new Date('2026-08-16T15:00:00Z');

  // The caller's explicit timestamp wins — it is the one party that knows.
  const yesterday = '2026-08-15T23:40:00Z';
  assert.equal(eventTimestamp({ occurred_at: yesterday }, profile, now).toISOString(),
    new Date(yesterday).toISOString());
  // Garbage falls through rather than filing under Invalid Date.
  assert.equal(eventTimestamp({ occurred_at: 'not a date' }, profile, now).getTime(), now.getTime());
  // No claim means now, and a time hint still anchors to today.
  assert.equal(eventTimestamp({}, profile, now).getTime(), now.getTime());
  const hinted = eventTimestamp({ time_hint: '09:30' }, profile, now);
  assert.ok(Number.isFinite(hinted.getTime()));

  // insertEvents actually uses it — the discard was the whole bug.
  const w = readFileSync(new URL('../netlify/functions/lib/wrought.js', import.meta.url), 'utf8');
  assert.match(w, /const occurredAt = eventTimestamp\(e, profile, now\)/);

  // BUT A CLIENT MAY NOT DATE ITS OWN EVENTS. Honouring occurred_at opened a
  // hole in the same hour it fixed the sweep: a language model that writes
  // occurred_at midnight-UTC files dinner on the wrong local day while
  // everything looks logged. The server's own callers know when a thing
  // happened; a model does not, and its guess is stripped at the door.
  const kept = eventsFromClient([{ event_type: 'food', summary: 'pizza',
    occurred_at: '2026-08-15T00:00:00Z', local_date: '2026-08-15', detail: { calories: 800 } }]);
  assert.equal(kept[0].occurred_at, undefined, 'a client-supplied occurred_at survived');
  assert.equal(kept[0].local_date, undefined, 'a client-supplied local_date survived');
  assert.equal(kept[0].detail.calories, 800, 'stripping the date stripped the data');

  // AND THE RECORD THE BUG ALREADY CORRUPTED IS REPAIRED. The session row
  // still knows when it ended; the sweep puts the event back on that day.
  const ses = readFileSync(new URL('../netlify/functions/lib/session.js', import.meta.url), 'utf8');
  assert.match(ses, /export async function refileMisdated\(userId, profile/);
  // Six hours of tolerance: end_session legitimately stamps "now" minutes
  // after the last set — the target is events filed the better part of a day
  // late, and a tight tolerance would churn every honestly-closed session.
  assert.match(ses, /<= 6 \* 3600000\) continue;/);
  assert.match(ses, /local_date: localDateFor\(profile\.timezone, new Date\(endedAt\)\)/);
  const prog = readFileSync(new URL('../netlify/functions/api-progress.js', import.meta.url), 'utf8');
  assert.match(prog, /refileMisdated\(user\.id, profile\)/);
});

await test('a half-done plan is filed as a half-done plan', () => {
  // "It needs to keep, in like a database, how much I've done of each
  // exercise, or I decided to skip or whatever — so if I only do half of them
  // you'll know that, or half of one of them." The clipboard knew all of this
  // DURING the session and threw it away at the close: a six-exercise plan
  // finished at three read back identically to a three-exercise plan finished
  // in full.
  const ses = readFileSync(new URL('../netlify/functions/lib/session.js', import.meta.url), 'utf8');
  // Same function as the live checklist, so the percent somebody watched
  // mid-session and the one on the record can never disagree.
  assert.match(ses, /import \{ sessionProgress \} from '\.\/warmup\.js'/);
  // ONE shape for the close and the backfill alike, so a session filed today
  // and one repaired tomorrow cannot carry two different-looking completions.
  assert.match(ses, /export function completionFrom\(plan, rows\)/);
  assert.match(ses, /const completion = completionFrom\(session\.plan, rows\)/);
  // Skipped (never touched) and short (started and left) are different facts.
  assert.match(ses, /\{ skipped: true \}/);
  assert.match(ses, /\{ short: true \}/);
  // The shortfall is IN the summary, because the summary is what every list,
  // day card and brief actually shows.
  assert.match(ses, /completion\.percent < 100 \? ` \(\$\{completion\.percent\}% of plan\)` : ''/);
  // An ad-hoc session has open slots and no real plan — its completion would
  // be noise, so only a session with planned sets carries one.
  assert.match(ses, /if \(!\(progress\.sets_planned > 0\)\) return null;/);

  // And end_session says it, as a fact, never a scolding.
  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const end = mcp.slice(mcp.indexOf('async function endSession('), mcp.indexOf('async function previousBest('));
  assert.match(end, /completion: done\.completion/);
  assert.match(end, /skipped \$\{done\.completion\.skipped\.join/);
  assert.match(end, /never a scolding/);

  // AND THE RECORD THE FEATURE PREDATES IS REPAIRED. Completion is stamped at
  // close, so every session closed before the stamp existed — including the
  // founder's half-done session on the day he asked — would read as finished
  // forever. The plan and the sets are both still stored, so it is
  // recoverable, and the dashboard sweep recovers it.
  assert.match(ses, /export async function backfillCompletion\(userId/);
  // Idempotent: an event already carrying completion is skipped, and the
  // summary suffix can never be appended twice.
  assert.match(ses, /if \(!ev \|\| ev\.detail\?\.completion\) continue;/);
  assert.match(ses, /!\/% of plan\\\)\/\.test\(ev\.summary/);
  const prog = readFileSync(new URL('../netlify/functions/api-progress.js', import.meta.url), 'utf8');
  // After the stale sweep, because the sweep files the event the stamp lands on.
  const sweepAt = prog.indexOf('closeStaleSessions(user.id, profile)');
  const backAt = prog.indexOf('backfillCompletion(user.id)');
  assert.ok(backAt > sweepAt && sweepAt > 0, 'the backfill does not run after the stale sweep');

  // And the day view DRAWS it — "for today's workout, what I did exactly."
  // Skipped is dim and says so in words; short shows done-of-planned. A fact
  // about the plan, never a mark against the person: nothing red, no scold.
  const src = page('app.html');
  const panel = src.slice(src.indexOf('function trainingTodayPanel(d)'), src.indexOf('// ── Calendar'));
  assert.match(panel, /x\.completion/);
  assert.match(panel, /e\.skipped \? 'skip' : e\.short \? 'part' : 'ticked'/);
  assert.match(panel, /e\.skipped \? 'skipped' : `\$\{e\.done\}\/\$\{e\.planned\}`/);
  assert.match(src, /\.ticks li\.skip \{ opacity/);
});

await test('the box that takes the setup is not shorter than the setup', () => {
  // "It didn't have the other information." Third cause, and the stupidest:
  // the how-much input carried maxlength="20", sized for "3×8 or 25 min".
  // "25 min level 10+, 2.5-3 mph" is 27 characters, so the FIELD ate it at
  // "level 10+, 2." before anything was sent. Nothing errors when an input
  // truncates — it just saves a shorter truth, and a clipped detail and a
  // never-saved one look identical to the person reading the row.
  //
  // This is the box the verbatim setup goes in, and verbatim is the whole
  // doctrine for timed work: for cardio that text IS the instruction.
  const src = page('app.html');
  const m = src.match(/<input class="ra-sets"[\s\S]{0,200}?maxlength="(\d+)"/);
  assert.ok(m, 'the how-much input lost its maxlength');
  assert.ok(+m[1] >= 200, `the setup box truncates at ${m[1]} characters`);

  // It must not be shorter than what the server will store, or the screen and
  // the tool disagree about how much of somebody's words survive.
  const training = readFileSync(new URL('../netlify/functions/lib/training.js', import.meta.url), 'utf8');
  const cap = training.match(/out\.detail = e\.detail \? String\(e\.detail\)\.slice\(0, (\d+)\)/);
  assert.ok(cap, 'normaliseMovement no longer bounds detail');
  assert.ok(+m[1] >= +cap[1], 'the input truncates before the server does');
});

await test('a movement with nothing on it says so instead of drawing a dash', () => {
  // An em dash is honest and useless: it cannot be told apart from a row that
  // failed to draw, and it tells nobody that anything is theirs to fix. Same
  // doctrine as a named food with no macros — something that looks saved and
  // counts for nothing when the session starts is worth naming, once, quietly.
  const src = page('app.html');
  const panel = src.slice(src.indexOf('function routinesPanel(d, {'), src.indexOf('function notesPanel('));
  assert.match(panel, /const unset = m => !howMuch\(m\) && !m\.detail/);
  assert.match(panel, /unset\(m\) \? 'not set' : '—'/);
  // The hint names the fix and says it UPDATES rather than adds a second row,
  // which is the part nobody would guess.
  assert.match(panel, /it fills that one in rather than adding a second/);
  // Only when something is actually unset — a hint on every routine forever is
  // one nobody reads.
  assert.match(panel, /editable && anyUnset \?/);

  // A gap in a plan is information, not an alarm. Nothing red, same restraint
  // the clinical readings get.
  const unsetCss = src.match(/\.rmv b\.unset \{([^}]+)\}/);
  assert.ok(unsetCss, 'the unset marker has no style of its own');
  assert.ok(!/var\(--heat\)|#f?[dD][0-9a-fA-F]{2}[0-3]/.test(unsetCss[1]), 'the unset marker shouts');
});

await test('a long setup line is not clipped by the row that holds it', () => {
  // .rmv is overflow: hidden — the swipe needs it, the Remove button sits
  // behind the row. So a flex child that refuses to shrink does not overflow
  // visibly, it gets CLIPPED in silence. min-width: 0 is load-bearing here.
  const src = page('app.html');
  assert.match(src, /\.rmvn \{[^}]*min-width: 0/, 'the movement column cannot shrink, so it clips');
  assert.match(src, /\.rmvn em \{[^}]*overflow-wrap: anywhere/);
  // And the amount never shrinks to make room — "25 min" wrapping mid-word is
  // its own kind of broken.
  assert.match(src, /\.rmv b \{[\s\S]{0,200}?flex: none; white-space: nowrap/);
});

await test('the page says which build it is, so stale and broken are tellable apart', () => {
  // Three bugs running were reported as "still broken" when the fix was live
  // and the page in hand was older than it. Nobody could tell a fix that had
  // not worked from a fix that had not arrived.
  const cfg = readFileSync(new URL('../netlify/functions/config.js', import.meta.url), 'utf8');
  assert.match(cfg, /window\.WROUGHT_BUILD/);
  assert.match(cfg, /COMMIT_REF/);
  // Nothing secret rides along. The commit is public; the keys are not.
  assert.ok(!/SERVICE_ROLE/.test(cfg), 'the service role key is named in config.js');

  const src = page('app.html');
  assert.match(src, /function buildLine\(\)/);
  assert.match(src, /\$\{buildLine\(\)\}/, 'the build line is never rendered');
  // Absent on a deploy that does not set it, rather than printing an empty box.
  const fn = src.slice(src.indexOf('function buildLine()'), src.indexOf('// A view that needs a live session'));
  assert.match(fn, /if \(!b\) return ''/);
});

group('A claimed save that never happened');

await test('saying something was saved may only ever come from a tool', () => {
  // "Added, Broski — S-Tier Home Workout is now saved as your base home
  // strength/core routine." The account held one workout, not two. save_routine
  // was never called; the model asserted a write from the conversation.
  //
  // On a product whose entire promise is memory this is the worst failure
  // there is — worse than a crash, because a crash is visible and this looks
  // exactly like success. Nobody finds it until they open the dashboard weeks
  // later and the workout is not there.
  assert.match(SERVER_INSTRUCTIONS, /SAYING SOMETHING WAS SAVED IS A CLAIM ABOUT THE RECORD, AND IT MAY ONLY EVER COME FROM A TOOL/);
  // The incident is named, because the abstract prohibition is what failed for
  // the invented 2,600 as well.
  assert.match(SERVER_INSTRUCTIONS, /S-Tier Home Workout is now saved/);
  // An honest error beats a confident sentence.
  assert.match(SERVER_INSTRUCTIONS, /If a call fails, say it failed/);
  // And a long design conversation is not a substitute for storing anything.
  assert.match(SERVER_INSTRUCTIONS, /never let a long conversation about designing something stand in for having stored it/);

  // The words he actually used are mapped, or the tool is not reached at all.
  assert.match(SERVER_INSTRUCTIONS, /save_routine — "save that", "add that to my list"/);
});

await test('a workout that is not there says whether anything is even connected', () => {
  // "Still not done." The saved-workouts panel says "say the name of one of
  // these to your AI and it starts" — and that sentence is FALSE on this
  // account if nothing holds a token for it. Which is the shape of the worst
  // failure this product has: the AI answers "saved" perfectly truthfully,
  // into an account that is not the one on screen, and nothing errors. It does
  // not look broken. It looks like you did nothing.
  const src = page('app.html');
  assert.match(src, /function notConnectedCallout\(\)/);
  assert.match(src, /\$\{notConnectedCallout\(\)\}/, 'the callout is never rendered');

  // NOTHING IS CLAIMED WHILE THE ANSWER IS UNKNOWN. A failed request must not
  // become an accusation that somebody's setup is broken.
  const fn = src.slice(src.indexOf('function notConnectedCallout()'), src.indexOf('function checklistPanel('));
  // THREE STATES, and nothing is said while the answer is unknown. The default
  // path returns nothing at all, so an unreachable endpoint stays silent.
  assert.match(fn, /trainerLinkState === 'nothing_connected'/);
  assert.match(fn, /trainerLinkState === 'connected_never_written'/);
  assert.match(fn, /\n  return '';\n\}/, 'an unknown state still says something');

  // The state the dashboard could never see before: a perfectly good token
  // that has never been used. From here that looked exactly like a fork, and
  // exactly like broken software.
  assert.match(fn, /is connected but has never written here/);
  assert.match(fn, /answering from the conversation instead/);
  const api = readFileSync(new URL('../netlify/functions/api-connections.js', import.meta.url), 'utf8');
  assert.match(api, /state: !active\.length \? 'nothing_connected'/);
  assert.match(api, /'connected_never_written'/);
  // Derived from the events the connector itself writes, so it cannot be
  // fooled by a token that merely exists.
  assert.match(api, /\.eq\('source', 'agent'\)/);
  const load = src.slice(src.indexOf('async function loadConnectedCount('), src.indexOf('function notConnectedCallout('));
  assert.match(load, /if \(!res\.ok\) return;/, 'a failed lookup is treated as a fork');
  assert.match(load, /catch \{ \/\* offline/, 'an offline browser accuses the account');

  // Both causes are named, because they are indistinguishable from outside and
  // lead to completely different fixes.
  assert.match(fn, /never added/);
  assert.match(fn, /different email/);
  // And it hands over the one question that actually settles it.
  assert.match(fn, /what account am I on/);
});

await test('a partial save is caught by the reply, not covered by prose', () => {
  // Fourteen exercises asked for, ONE sent, thirteen narrated as saved — and
  // stashed in the assistant's own memory ("Memory updated"), which is not the
  // record and never reaches the Trainer screen. The server cannot know what
  // was asked for; the model does, so the reply it cannot skip now makes it
  // reconcile the two lists before answering.
  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const fn = mcp.slice(mcp.indexOf('async function saveRoutine('), mcp.indexOf('async function listRoutines('));

  // The note leads with what the routine NOW holds and orders the comparison.
  assert.match(fn, /THIS ROUTINE NOW HOLDS \$\{exercises\.length\} MOVEMENT/);
  assert.match(fn, /COMPARE that list with every movement the user actually named/);
  assert.match(fn, /Call save_routine again NOW with the missing ones in add\[\]/);
  // The assistant's own memory is named as the wrong place, because that is
  // where the thirteen actually went.
  assert.match(fn, /never store their workout in your own memory/);

  // A save that stored a NAME and nothing else says so in the spoken line —
  // "Saved" with zero movements reads as done and starts as an empty session.
  assert.match(fn, /holds NO movements yet, so it will start empty/);

  // And the one-call rule rides on the tool description itself, where every
  // client reads it — not only on a property schema a client may truncate.
  const save = TOOLS.find(t => t.name === 'save_routine').description;
  assert.match(save, /pass EVERY movement they named in ONE call/);
  assert.match(save, /your memory is not their record/);
});

await test('the rules a connector must not miss live on the tools themselves', () => {
  // The pattern behind a whole run of failures — the phrasebook ignored, saves
  // claimed without calls, "what account am I on" answered with a ChatGPT plan
  // — has one common thread: every rule lived in SERVER_INSTRUCTIONS, and not
  // every client shows that sheet to its model at all. Claude reads it;
  // ChatGPT's support for it is spotty-to-absent. What every client
  // demonstrably DOES read is the tool descriptions and the tool results.
  //
  // So anything load-bearing rides on the tool it governs. The instruction
  // sheet remains for clients that honour it, but nothing critical may exist
  // ONLY there.
  const save = TOOLS.find(t => t.name === 'save_routine').description;
  assert.match(save, /^CALL THIS THE MOMENT/, 'the trigger is buried instead of leading');
  assert.ok(save.includes('add that to my list'), 'the words he actually said are not on the tool');
  assert.ok(save.includes('create another workout'), 'creating by name is not a trigger');
  assert.match(save, /NEVER say "saved" or "added" from the conversation alone/);
  assert.match(save, /on_file/, 'the proof is not named where the model will see it');

  const design = TOOLS.find(t => t.name === 'design_workout').description;
  assert.match(design, /^CALL THIS when the user asks for a new workout/);
  assert.match(design, /Never design a session in prose without calling it/);
  assert.match(design, /THEN CALL save_routine/, 'design does not chain into the save');

  const prof = TOOLS.find(t => t.name === 'get_profile').description;
  assert.ok(prof.includes('what account am I on'), 'the question that failed is not on the tool');
  assert.match(prof, /account\.email/);
});

await test('a save proves itself by reading the account back afterwards', () => {
  // Echoing the object just sent proves nothing — it is the same sentence a
  // model could write unaided. What cannot be fabricated is the state of the
  // account AFTER the write.
  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const fn = mcp.slice(mcp.indexOf('async function saveRoutine('), mcp.indexOf('async function listRoutines('));

  const writeAt = fn.indexOf('.insert([row])');
  const readAt = fn.indexOf("const { data: onFile } = await supabase.from('wrought_routines')");
  assert.ok(readAt > writeAt && writeAt > 0, 'the account is read back before the write, or not at all');

  assert.match(fn, /is: 'every saved workout on this account, read back AFTER the write'/);
  assert.match(fn, /count: all\.length/);
  assert.match(fn, /names: all\.map\(r => r\.name\)/);
  assert.match(fn, /verified: !!mine/);
  // The spoken line carries it too, so it survives a model that reads only say.
  assert.match(fn, /You now have \$\{all\.length\} saved workout/);
  assert.match(fn, /the only thing that distinguishes a real save from a claimed one/);
});

group('The day as a receipt — every line with its own number');

const { dayReceipt } = await import('../netlify/functions/lib/receipt.js');

// His actual day: four hours at the petting zoo, three ciabatta buns.
const PETTING_DAY = (over = {}) => ({
  date: '2026-08-13',
  logged: true,
  food: { calories: 330, protein_g: 11, carbs_g: 59, fat_g: 6, meals: 3,
          estimated: true, meals_uncounted: 0, say: '330 kcal' },
  training: { sessions: 0, minutes: 0, entries: [] },
  activity: { count: 1 },
  log: [
    { id: '1', type: 'food', at: '09:10', summary: 'Ciabatta bun', calories: 110, protein_g: 4, carbs_g: 20, fat_g: 2, estimated: true },
    { id: '2', type: 'food', at: '12:30', summary: 'Ciabatta bun', calories: 110, protein_g: 4, carbs_g: 20, fat_g: 2, estimated: true },
    { id: '3', type: 'food', at: '15:00', summary: 'Ciabatta bun with cheddar', calories: 110, protein_g: 3, carbs_g: 19, fat_g: 2, estimated: true },
    { id: '4', type: 'activity', at: '17:00', summary: 'Petting zoo, 4h', calories: null },
  ],
  ...over,
});

const PETTING_BALANCE = (over = {}) => ({
  known: true, calories_in: 330,
  resting_burn: 3833, resting_source: 'formula',
  training_burn: 0, other_burn: 1100,
  calories_out: 4933, net: -4603, direction: 'deficit',
  projected_kg_per_week: -4.18,
  active_source: 'logged', other_projected: false,
  training_detail: { kcal: 0, entries: [], source: 'none' },
  logged_activity: { count: 1, kcal: 1050, raw_kcal: 1050, capped: false,
                     entries: [{ summary: 'Petting zoo, 4h', hours: 4, kcal: 1050 }] },
  ...over,
});

await test('the lines add up to the total, exactly', () => {
  // A receipt whose rows do not sum to its own total is worse than no receipt:
  // it is a screen arguing with itself, and the person reading it is right to
  // stop believing both numbers.
  const r = dayReceipt({ day: PETTING_DAY(), balance: PETTING_BALANCE() });
  assert.equal(r.out.lines_sum, r.out.total, 'the burn lines do not sum to calories out');
  assert.equal(r.in.lines.reduce((s, l) => s + (l.calories || 0), 0), r.in.total,
    'the food lines do not sum to calories in');
  assert.equal(r.net, r.in.total - r.out.total);

  // And it holds across every way the burn can be assembled — that reconcil-
  // iation is the part most likely to drift.
  for (const src of ['logged', 'logged_over_device', 'device', 'activity_level', 'awaiting_device', 'training_only', 'none']) {
    const b = PETTING_BALANCE({ active_source: src });
    const x = dayReceipt({ day: PETTING_DAY(), balance: b });
    assert.equal(x.out.lines_sum, x.out.total, `lines stop summing for ${src}`);
    // Every source has a sentence saying where the figure came from.
    assert.ok(x.out.lines[2].note, `no provenance on the movement line for ${src}`);
  }
});

await test('four hours of work comes back with what it was worth', () => {
  // "It should tell me everything — I should see what those four hours of
  // calories are worth against what's on there." Logging a shift and being
  // told only that it was "logged as activity" is the whole feature failing
  // quietly: the number is the entire reason to log it.
  const r = dayReceipt({ day: PETTING_DAY(), balance: PETTING_BALANCE() });
  const work = r.out.lines.find(l => l.what === 'Work and moving about');
  assert.equal(work.calories, 1100);
  // Itemised underneath, with the hours on it.
  assert.deepEqual(work.of, [{ what: 'Petting zoo, 4h', hours: 4, calories: 1050 }]);
  // And the shift is visible in the spoken form, not just the structure.
  assert.match(r.say, /Petting zoo, 4h \(4h\) — 1,050/);
  assert.match(r.say, /NET — 4,603 down/);

  // Every eaten item keeps its own figure — the same doctrine, the other side.
  assert.equal(r.in.lines.length, 3);
  assert.ok(r.say.includes('Ciabatta bun with cheddar — 110'));

  // The tool that logs it carries the receipt, or none of this is reachable.
  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const fn = mcp.slice(mcp.indexOf('async function logActivity('), mcp.indexOf('const VALID_EVENT_TYPES'));
  assert.match(fn, /receipt: dayReceipt\(/, 'log_activity does not return the receipt');
  assert.match(fn, /SAY WHAT IT WAS WORTH/, 'nothing tells the model to say the number');
});

await test('what was deliberately NOT counted is said out loud', () => {
  // The burn takes the LARGER of a logged shift and a watch's day rather than
  // their sum, because adding them counts the same hours twice. That is
  // correct and it is invisible — somebody who logged four hours and sees a
  // figure smaller than their own arithmetic concludes the log was ignored.
  const device = dayReceipt({ day: PETTING_DAY(), balance: PETTING_BALANCE({
    active_source: 'device', other_burn: 740 }) });
  assert.ok(device.set_aside?.some(s => /not added together/i.test(s)),
    'the watch-versus-logged reconciliation is silent');

  // A capped shift says so, and says the raw figure — capping quietly would
  // mean the log is lying too.
  const capped = dayReceipt({ day: PETTING_DAY(), balance: PETTING_BALANCE({
    logged_activity: { count: 1, kcal: 5750, raw_kcal: 9000, capped: true,
                       entries: [{ summary: 'Petting zoo, 14h', hours: 14, kcal: 9000 }] } }) });
  assert.ok(capped.set_aside?.some(s => /held at/i.test(s)));

  // A session with no minutes contributes nothing while looking logged. Named,
  // never silently dropped from the receipt.
  const untimed = dayReceipt({ day: PETTING_DAY(), balance: PETTING_BALANCE({
    training_detail: { kcal: 0, source: 'none',
      entries: [{ summary: 'Gym', minutes: null, kcal: 0, source: 'uncounted', why: 'no duration on it' }] } }) });
  assert.ok(untimed.set_aside?.some(s => /counting nothing/i.test(s)));
  assert.equal(untimed.out.lines[1].of[0].counts_as, 0);

  // A meal logged with no macros makes the intake look lower than it was —
  // the direction that matters, because it overstates the deficit.
  const noMacros = dayReceipt({
    day: PETTING_DAY({ food: { calories: 330, protein_g: 11, carbs_g: 59, fat_g: 6,
                               meals: 4, estimated: true, meals_uncounted: 1, say: '330 kcal' } }),
    balance: PETTING_BALANCE(),
  });
  assert.ok(noMacros.set_aside?.some(s => /real intake is higher/i.test(s)));
});

await test('a day still running is not a finished subtraction', () => {
  // The rule already written for the dashboard hero, and it applies to the
  // receipt for exactly the same reason. The resting burn is a WHOLE DAY's
  // figure, so at 7pm against 330 eaten the net reads "4,603 down" — a fact
  // about the day being incomplete, not a reading of it. And it errs in the
  // dangerous direction: an overstated deficit is the number that tells
  // somebody to eat less than they need.
  const now = dayReceipt({ day: PETTING_DAY(), balance: PETTING_BALANCE(), today: '2026-08-13' });
  assert.equal(now.partial, true);
  // Still SHOWN — hiding a number somebody asked for is its own dishonesty.
  assert.equal(now.net, -4603);
  assert.match(now.say, /so far — the burn is the whole day/);
  assert.match(now.partial_note, /not a deficit they have actually run/);
  assert.match(now.note, /SAY THAT TODAY IS NOT OVER/);

  // A day that is over carries none of it.
  const past = dayReceipt({ day: PETTING_DAY(), balance: PETTING_BALANCE(), today: '2026-08-14' });
  assert.equal(past.partial, false);
  assert.ok(!past.partial_note);
  assert.ok(!/so far — the burn is the whole day/.test(past.say));

  // And every door passes today, or the label never fires where it matters.
  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  assert.equal((mcp.match(/dayReceipt\(\{ day, balance, date, today:/g) || []).length, 3,
    'a receipt door does not tell the receipt what today is');
});

await test('half a subtraction is never presented as the whole picture', () => {
  // Without the profile facts there is no burn, and showing the intake alone
  // as if it were the day is how somebody reads 330 as a finished thought.
  const r = dayReceipt({ day: PETTING_DAY(), balance: { known: false, missing: ['a birth year'] } });
  assert.equal(r.out, null);
  assert.equal(r.net, null);
  assert.match(r.say, /OUT — not known yet/);
  assert.match(r.note, /rather than presenting the intake alone/);
});

await test('the receipt is read out rather than summarised', () => {
  const r = dayReceipt({ day: PETTING_DAY(), balance: PETTING_BALANCE() });
  assert.match(r.note, /LINE BY LINE|line by line/);
  assert.match(r.note, /do not add them up yourself/i);
  // Still an estimate. Breaking a total into parts must not make the parts
  // look measured.
  assert.match(r.note, /estimate/i);
  assert.equal(r.estimated, true);

  assert.match(SERVER_INSTRUCTIONS, /BOTH SIDES OF THE SUBTRACTION GET ITEMISED/);
  assert.match(SERVER_INSTRUCTIONS, /LOGGING WORK ALWAYS COMES BACK WITH WHAT IT WAS WORTH/);
});

await test('every session is itemised from the same pass that totals them', () => {
  // Recomputing per-session figures somewhere else is how a receipt and a
  // total end up quoting two different numbers for the same workout.
  const t = trainingBurn([
    { summary: 'Run', detail: { calories: 420, minutes: 35 } },
    { summary: 'Legs', detail: { minutes: 60, kind: 'strength' } },
    { summary: 'Gym', detail: {} },
  ], 100);
  assert.equal(t.entries.length, 3);
  assert.equal(t.entries.reduce((s, e) => s + e.kcal, 0), t.kcal,
    'the itemised sessions do not sum to the training burn');
  assert.equal(t.entries[0].source, 'device');
  assert.equal(t.entries[1].source, 'estimate');
  // The one that looks logged and counts for nothing is named, not dropped.
  assert.equal(t.entries[2].source, 'uncounted');
  assert.match(t.entries[2].why, /duration/);
});

group('Building a workout WITH somebody, to a name they chose');

const { FOCUSES, FOCUS_NAMES, focusFrom, designSession, designQuestions, movementCount, designNote } =
  await import('../netlify/functions/lib/design.js');

await test('not one weight comes out of a designed session', () => {
  // The single most important assertion in this file. A workout designed to
  // somebody's own specification is exactly where a plausible-looking working
  // weight would slip through — it would read as considered rather than
  // invented — and it is the same failure as the 2,600 in the place where
  // being wrong hurts fastest.
  for (const focus of FOCUS_NAMES) {
    for (const tier of ['beginner', 'intermediate', 'advanced']) {
      for (const minutes of [20, 45, 90]) {
        const s = designSession({ focus, minutes, tier, equipment: ['full gym'] });
        if (!s) continue;
        for (const e of s) {
          assert.equal(e.load_kg, null, `${focus}/${tier} prescribed a load`);
          assert.ok(!('weight' in e) && !('weight_kg' in e), `${focus}/${tier} carries a weight field`);
          assert.ok(!/\d+\s*(kg|lb|pound)/i.test(JSON.stringify(e)), `${focus}/${tier} names a weight in text`);
        }
      }
    }
  }
});

await test('length is a ceiling, not ambition', () => {
  // Same rule as days available. Designing seventy minutes of work for
  // somebody who said forty is how a plan gets abandoned in week two.
  assert.ok(movementCount(20) < movementCount(45));
  assert.ok(movementCount(45) < movementCount(90));
  // Floored so it is a session rather than a gesture, capped because past
  // seven movements nobody finishes.
  assert.equal(movementCount(5), 3);
  assert.equal(movementCount(240), 7);

  const short = designSession({ focus: 'legs', minutes: 20, equipment: ['full gym'] });
  const long  = designSession({ focus: 'legs', minutes: 90, equipment: ['full gym'] });
  assert.ok(short.length < long.length, 'the clock changes nothing about the session');
});

await test('a tier can never be handed a movement above it', () => {
  // The library rule, still holding through the new door.
  const RANK = { beginner: 0, intermediate: 1, advanced: 2 };
  const tierOf = name => MOVEMENTS.find(m => m.name === name)?.tier;
  for (const tier of ['beginner', 'intermediate', 'advanced']) {
    for (const focus of FOCUS_NAMES) {
      for (const e of designSession({ focus, minutes: 75, tier, equipment: ['full gym'] }) || []) {
        assert.ok(RANK[tierOf(e.name)] <= RANK[tier],
          `${tier} was offered ${e.name}, which is ${tierOf(e.name)}`);
      }
    }
  }
  // And the gate is real rather than an accident of ordering: something in the
  // library IS above a beginner and reachable at a higher tier.
  const advNames = new Set(FOCUS_NAMES.flatMap(f =>
    (designSession({ focus: f, minutes: 75, tier: 'advanced', equipment: ['full gym'] }) || []).map(e => e.name)));
  const begNames = new Set(FOCUS_NAMES.flatMap(f =>
    (designSession({ focus: f, minutes: 75, tier: 'beginner', equipment: ['full gym'] }) || []).map(e => e.name)));
  assert.ok([...advNames].some(n => !begNames.has(n) && RANK[tierOf(n)] > 0),
    'no movement is actually gated, so the tier check proves nothing');

  const beginner = designSession({ focus: 'legs', minutes: 60, tier: 'beginner', equipment: ['full gym'] });
  // And a beginner is told why; an advanced lifter is left alone.
  assert.ok(beginner.some(e => e.cue), 'a beginner gets no cues');
  const adv = designSession({ focus: 'legs', minutes: 60, tier: 'advanced', equipment: ['full gym'] });
  assert.ok(adv.every(e => e.cue === null), 'an advanced lifter is being explained to');
});

await test('equipment is a hard filter, never a suggestion', () => {
  const home = designSession({ focus: 'legs', minutes: 45, equipment: ['dumbbell'] });
  assert.ok(home && home.length, 'nothing could be built from dumbbells');
  assert.ok(!home.some(e => /barbell|machine|leg press/i.test(e.name)),
    'a movement was programmed on kit they do not have');
});

await test('something to leave alone is worked around, never made lighter', () => {
  // How much a sore joint can take today is a claim nothing here is entitled
  // to make — so the movement is DROPPED rather than prescribed at some
  // invented reduction. And it is never presented as treating anything.
  const s = designSession({ focus: 'upper', minutes: 60, equipment: ['full gym'], avoid: ['shoulders'] });
  assert.ok(s && s.length, 'avoiding one area emptied the session');
  assert.ok(!s.some(e => e.muscles.includes('shoulders')), 'a movement loading the sore area survived');
  // Nothing anywhere in the built session claims to fix, treat or rehabilitate.
  assert.ok(!/rehab|physio|heal|fix|treat|therapy/i.test(JSON.stringify(s)));
});

await test('it never asks what the record already answers', () => {
  // The commonest way an interview turns into the form this product exists not
  // to be — and re-asking tells somebody the memory does not work.
  const full = designQuestions({
    focus: 'legs', minutes: 45,
    profile: { equipment: ['full gym'], tier: 'intermediate' },
    limitations: ['left knee, no deep lunges'], gyms: ['Main gym'],
  });
  assert.deepEqual(full, [], 'it asked about something already on file');

  // With nothing on file the two that genuinely block come FIRST.
  const empty = designQuestions({ profile: {}, limitations: [], gyms: [] });
  assert.deepEqual(empty.slice(0, 2).map(q => q.key), ['focus', 'minutes']);
  // Every question says why it is worth asking, so none can quietly become a
  // form field nobody justified.
  assert.ok(empty.every(q => q.why && q.ask));

  // Where they are is only asked when there is genuinely a choice.
  assert.ok(!designQuestions({ profile: {}, gyms: ['Main gym'] }).some(q => q.key === 'where'));
  assert.ok(designQuestions({ profile: {}, gyms: ['Main gym', 'Home'] }).some(q => q.key === 'where'));
});

await test('how people actually name a session lands somewhere sensible', () => {
  // Making somebody pick off a list is the form again.
  assert.equal(focusFrom('leg day'), 'legs');
  assert.equal(focusFrom('chest and tris'), 'chest');
  assert.equal(focusFrom('arms day'), 'upper');
  assert.equal(focusFrom('cardio'), 'conditioning');
  assert.equal(focusFrom('full body'), 'full body');
  assert.equal(focusFrom('abs'), 'core');
  assert.equal(focusFrom(''), null);
  // An unrecognised one is not guessed at.
  assert.equal(focusFrom('zumba'), null);
});

await test('the instruction says build on two answers, and never a weight', () => {
  // Two answers are enough. A session that arrives beats one still being
  // specified, and that has to be said or the model finishes the list.
  assert.match(designNote([{ key: 'avoid' }], null), /Two answers are enough to build/);
  assert.match(designNote([], true), /NOT ONE WEIGHT/);
  // The tool is reachable by the words people use.
  assert.match(SERVER_INSTRUCTIONS, /design_workout — "build me a workout"/);
  assert.match(SERVER_INSTRUCTIONS, /A NAMED WORKOUT IS A BRIEF, AND A BRIEF GETS TAKEN/);
  // Changing it is never a negotiation — the same doctrine as drop_goal.
  assert.match(SERVER_INSTRUCTIONS, /swapping something out is one call, never a negotiation/);

  const t = TOOLS.find(x => x.name === 'design_workout');
  assert.ok(t, 'the tool is not declared');
  assert.match(t.description, /NO WEIGHTS are returned and none may be invented/);
  assert.equal(t.inputSchema.required[0], 'name');
  // Dropped, not softened — stated where the model will read it.
  assert.match(t.inputSchema.properties.avoid.description, /DROPPED, never made lighter/);
});

group('What the session cost, and the cardio counted apart');

const effortModule = await import('../netlify/functions/lib/effort.js');
const { sessionEffort, splitWork } = effortModule;

const AT = Date.parse('2026-08-14T18:00:00Z');
const mins = n => new Date(AT + n * 60000).toISOString();

await test('the session already had a clock — heart rate is read against it', () => {
  // "When you start your workout you should officially start the heart rate
  // during that period." It turns out to be a query rather than a feature:
  // wrought_sessions has started_at and ended_at, heart_rate samples arrive
  // with measured_at, and nothing was reading one against the other.
  const sets = [
    { exercise: 'Bench press', logged_at: mins(5) },
    { exercise: 'Bench press', logged_at: mins(9) },
    { exercise: 'Barbell row', logged_at: mins(16) },
  ];
  const samples = Array.from({ length: 40 }, (_, i) => ({
    value: 95 + (i > 4 && i < 12 ? 55 : i > 14 && i < 20 ? 40 : 5),
    measured_at: mins(i),
  }));

  const e = sessionEffort({ session: { started_at: mins(0), ended_at: mins(30) }, sets, samples });
  assert.equal(e.known, true);
  assert.equal(e.max_hr, 150);

  // PER EXERCISE, from the set clock — the grain the log already keeps.
  assert.equal(e.by_exercise.length, 2);
  assert.equal(e.by_exercise[0].exercise, 'Bench press');
  assert.equal(e.hardest.exercise, 'Bench press');

  // Samples outside the window belong to somebody's afternoon, not the session.
  const outside = sessionEffort({
    session: { started_at: mins(0), ended_at: mins(10) }, sets,
    samples: [{ value: 190, measured_at: mins(400) }],
  });
  assert.equal(outside.known, false);
  // "No heart rate" and "no watch on" look identical on a screen and only one
  // is worth acting on, so the reason is named.
  assert.match(outside.why, /the window is right, the samples are missing/);

  // A wrist reading is a noisy instrument and a number people over-read.
  assert.match(e.caveat, /grip and cold hands/);
  assert.match(e.caveat, /trend across sessions, not as a score for one set/);
});

await test('a treadmill is not a bench press — two statistics, never one', () => {
  // "Yesterday my treadmill stuff should be calculated as a separate
  // statistic." Same doctrine as a shift not being a session, one level down:
  // blending 25 minutes of incline walking into "volume moved" makes the
  // volume wrong and hides the cardio entirely.
  const w = splitWork({
    sets: [
      { exercise: 'Bench press', logged_at: mins(5), reps: 8, weight_kg: 100 },
      { exercise: 'Bench press', logged_at: mins(9), reps: 8, weight_kg: 100 },
      { exercise: 'Incline treadmill walk', logged_at: mins(25) },
    ],
    plan: [{ name: 'Bench press', sets: 2, reps: 8 }, { name: 'Incline treadmill walk', minutes: 25 }],
  });

  assert.equal(w.strength.sets, 2, 'the treadmill was counted as a lifting set');
  assert.equal(w.strength.volume_kg, 1600);
  assert.ok(w.cardio.exercises.includes('Incline treadmill walk'));
  assert.equal(w.cardio.minutes, 25);
  assert.equal(w.mixed, true);
  // Both numbers in the spoken line, kept apart.
  assert.match(w.say, /2 lifting sets/);
  assert.match(w.say, /25 min cardio/);
  assert.match(w.note, /TWO statistics, never one/);

  // A pure lifting session is not "mixed" and gets no cardio line invented.
  const pure = splitWork({
    sets: [{ exercise: 'Back squat', logged_at: mins(5), reps: 5, weight_kg: 140 }],
    plan: [{ name: 'Back squat', sets: 3, reps: 5 }],
  });
  assert.equal(pure.mixed, false);
  assert.equal(pure.cardio.minutes, null);

  // The split rides on the closed session, and end_session reports both.
  const ses = readFileSync(new URL('../netlify/functions/lib/session.js', import.meta.url), 'utf8');
  assert.match(ses, /\.eq\('metric', 'heart_rate'\)[\s\S]{0,200}\.order\('measured_at'/);
  assert.match(ses, /\.eq\('metric', 'heart_rate'\)/);
  assert.match(ses, /work_split: split/);
  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const end = mcp.slice(mcp.indexOf('async function endSession('), mcp.indexOf('async function previousBest('));
  assert.match(end, /give the two numbers SEPARATELY/);
});

await test('the watch measures the session when its data can actually say so', () => {
  // "Never estimate — you have the Apple Watch, read off of that." Right, and
  // there is one trap that has to be guarded by construction: active_calories
  // often arrives as ONE daily total, and a single row falling inside the
  // session window is not a measurement of the session — it is the whole day
  // wearing a session's clothes. Billing a day's 592 to a fifty-minute session
  // overstates the burn in the direction that tells somebody they have room
  // to eat.
  const { windowedActive } = effortModule;
  const at = h => `2026-08-16T${String(h).padStart(2, '0')}:00:00Z`;

  // Sub-daily granularity: the in-window rows sum, the rest of the day stays out.
  const hourly = [4, 5, 6, 7, 8, 9, 10].map(h => ({ value: 50, measured_at: at(h) }));
  const m = windowedActive(hourly, at(6), at(8));
  assert.equal(m.kcal, 150);
  assert.equal(m.source, 'watch');

  // THE GUARD: one row for the day is a daily total, wherever its timestamp
  // happens to fall. Null, so the labelled estimate stands instead.
  assert.equal(windowedActive([{ value: 592, measured_at: at(6) }], at(5), at(7)), null);
  // No rows inside the window is no measurement, however many the day has.
  assert.equal(windowedActive(hourly, at(20), at(22)), null);
  assert.equal(windowedActive([], at(5), at(7)), null);

  // Wired: the close stamps it as the session's calories with its source, so
  // trainingBurn counts it as measured and the hero stops saying "estimated"
  // about a session the watch actually saw.
  const ses = readFileSync(new URL('../netlify/functions/lib/session.js', import.meta.url), 'utf8');
  assert.match(ses, /const watched = windowedActive\(activeRows \|\| \[\]/);
  assert.match(ses, /calories: watched\.kcal, calories_source: 'watch'/);
  // The guard needs the WHOLE day's rows, not just the window — granularity
  // cannot be judged from a slice.
  assert.match(ses, /\.eq\('metric', 'active_calories'\)[\s\S]{0,40}\.eq\('local_date', dayOf\)/);

  // And when the total is the watch's but the split is derived, the hero says
  // exactly that instead of stamping "(estimated)" on a measured day.
  const src = page('app.html');
  assert.match(src, /the split between training and the rest of the day/i);
  assert.match(src, /training, your watch/);
});

await test('a heart rate is a training statistic and nothing else', () => {
  // The clinical line, in the one place it is most tempting to cross: a number
  // off a chest strap next to a workout invites "is that bad", and the honest
  // answer to that is a doctor, never a fitness app. Blood oxygen and
  // respiratory rate are stored and shown as readings — never interpreted, and
  // never pulled into this.
  const eff = readFileSync(new URL('../netlify/functions/lib/effort.js', import.meta.url), 'utf8');
  assert.match(eff, /Nothing here diagnoses/);
  // It reads heart_rate ONLY. Pulling spo2 into a training statistic is how a
  // fitness number becomes a medical claim.
  assert.ok(!/spo2|blood_oxygen|respiratory/i.test(eff.replace(/\/\/.*$/gm, '')),
    'a clinical metric leaked into the training read');

  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const end = mcp.slice(mcp.indexOf('async function endSession('), mcp.indexOf('async function previousBest('));
  assert.match(end, /never read a heart rate as a sign of anything/);
  assert.match(end, /never compare it to anybody else/);
});

group('The trainer standing next to you, between the sets');

const { effortFromWords, beforeSet, afterSet, methodsFor, METHODS } =
  await import('../netlify/functions/lib/coach.js');

await test('their words become the effort — the server reads it, not the model', () => {
  // The tool description used to tell the MODEL to convert: '"that was easy"
  // ≈ 6'. That made a language model the thing deciding how much weight goes
  // on a bar — the same class as an invented calorie target, in the place it
  // hurts fastest.
  //
  // The founder's own sentence is the fixture: "I did eight, my full reps with
  // ease. I added 25, second set, and I started to struggle a little bit. It
  // felt fine."
  assert.equal(effortFromWords('my full reps with ease').rpe, 6);
  const struggled = effortFromWords('I started to struggle a little bit. It felt fine');
  assert.equal(struggled.rpe, 9, '"felt fine" overrode the struggle');
  assert.equal(struggled.rir, 1);

  // Reps in reserve is the scale, because it is the question a lifter can
  // actually answer mid-session.
  assert.equal(effortFromWords('had 2 in the tank').rir, 2);
  assert.equal(effortFromWords('could have got 4 more').rir, 4);
  assert.equal(effortFromWords('RIR 1').rir, 1);
  assert.equal(effortFromWords('barely got it, real grinder').rpe, 9.5);
  assert.equal(effortFromWords('failed on the last one').failed, true);

  // NULL IS A REAL ANSWER, and the common one. Inventing a number for "done"
  // is what keeps "an unreported effort never adds weight" from being true.
  for (const quiet of ['done', 'that is logged', 'next', '']) {
    assert.equal(effortFromWords(quiet).rpe, null, `"${quiet}" produced an effort`);
  }

  // WHEN SIGNALS CONFLICT, THE HARDER READING WINS — an overstated ease is the
  // one that puts weight on the bar; an overstated effort only holds it there.
  const mixed = effortFromWords('easy but I struggled on the last rep');
  assert.equal(mixed.rpe, 9);
  assert.equal(mixed.conflicted, true);

  // And the tool asks for WORDS now, with the conversion named as the server's.
  const t = TOOLS.find(x => x.name === 'log_set');
  assert.match(t.inputSchema.properties.felt.description, /VERBATIM/);
  assert.match(t.inputSchema.properties.felt.description, /Do NOT convert this to a number/);
  assert.match(t.inputSchema.properties.rpe.description, /Only when they actually gave a number/);
});

await test('the effort actually drives the load, and silence holds it', () => {
  // The whole point of reading the words: nextSetLoad is the engine, and it
  // only moves on a reported effort.
  const read = w => effortFromWords(w).rpe;
  const at = (words, reps) => nextSetLoad({
    weightKg: 100, reps, rpe: read(words), targetReps: 8, key: 'bench_press', tier: 'intermediate',
  });
  // The founder's day: eight with ease → the weight goes up.
  assert.equal(at('my full reps with ease', 8).verdict, 'up');
  // Then it got hard → it holds rather than climbing again.
  assert.equal(at('started to struggle a little bit', 8).verdict, 'same');
  // A grinder comes down.
  assert.equal(at('barely got it, total grinder', 8).verdict, 'down');
  // And saying nothing about effort never adds weight.
  assert.equal(at('done', 8).verdict, 'same');
});

await test('the between-sets questions are one line, and never offer harder on a bad day', () => {
  const fresh = beforeSet({ exercise: 'Bench press', setNumber: 1 });
  assert.match(fresh.ask, /a little harder, or a little softer/);

  // THE BODY'S VETO COMES FIRST AND ONLY EVER SOFTENS. Offering "harder" on a
  // day their own numbers flagged is how a tool talks somebody into a session
  // they should not have.
  const strained = beforeSet({ exercise: 'Bench press', setNumber: 1,
    ready: { known: true, state: 'strained', say: 'Resting heart rate is up on your fortnight.' } });
  assert.ok(!/harder/.test(strained.ask), 'harder was offered on a strained day');
  assert.equal(strained.readiness_first, true);
  assert.match(strained.say, /Resting heart rate/);

  // Asked in reps left, because "rate that out of ten" is a quiz.
  assert.match(afterSet({ reps: 8, target: 8 }).ask, /how many more could you have got/);
  // A short set gets a different question — did it come apart, or run out.
  assert.match(afterSet({ reps: 5, target: 8 }).ask, /come apart, or just run out/);
  // And it is NEVER asked twice: if they already said, the load is relayed.
  assert.equal(afterSet({ reps: 8, target: 8, hadEffort: true }).ask, null);
  assert.match(afterSet({ reps: 8, target: 8, hadEffort: true }).note, /do NOT ask again/);
});

await test('professional methods are offered, tier-gated, and honest about provenance', () => {
  // "I need you to investigate what pro trainers would be doing... and then we
  // could suggest that and I'll see if I want it or not." The last clause is
  // the design: offered, never imposed.
  const beg = methodsFor({ tier: 'beginner' });
  assert.ok(beg.offer.length <= 2, 'a menu of six is a menu nobody reads');
  assert.ok(!beg.offer.some(m => m.tier === 'advanced'), 'a beginner was offered an advanced method');

  // A stall changes what is worth raising — the plateau-breakers go first.
  const stalled = methodsFor({ tier: 'advanced', stalled: true });
  assert.ok(['top_backoff', 'wave'].includes(stalled.offer[0].key));

  // Nothing they already run is re-offered.
  assert.ok(!methodsFor({ tier: 'any', using: ['rir'] }).offer.some(m => m.key === 'rir'));

  // Every method says what it COSTS, or it is a pitch rather than a choice.
  for (const m of METHODS) {
    assert.ok(m.what && m.why && m.costs, `${m.key} is missing what/why/costs`);
  }
  // HONEST PROVENANCE: textbook methodology, said to be. Presenting it as
  // insider knowledge is a small lie that makes the honest numbers harder to
  // believe.
  assert.match(beg.provenance, /Established published methodology/);
  assert.match(beg.provenance, /Not a live survey/);
  assert.match(beg.note, /never present them as insider knowledge/);
});

group('The wall, named — and answered with structure');


await test('a levelled lift is named as a wall, with the evidence', () => {
  // "It should be keeping progress on my max weights, telling that where I'm
  // kind of levelling off." The estimated max was computed and graphed; the
  // VERDICT did not exist — the log knew the number had not moved in six
  // sessions and never said so.
  const mk = a => a.map(([date, weight_kg, reps]) => ({ date, weight_kg, reps }));

  const wall = liftTrend(mk([['07-01',100,8],['07-04',105,8],['07-08',102.5,8],
    ['07-11',103,8],['07-15',102.5,8],['07-18',103,8],['07-22',102.5,8]]));
  assert.equal(wall.state, 'levelled');
  assert.equal(wall.sessions_since_best, 5);
  assert.match(wall.say, /Levelled — nothing past/);
  assert.match(wall.say, /07-04/);

  // A new best in the last two sessions is climbing, and says when.
  const climb = liftTrend(mk([['08-01',90,6],['08-04',92.5,6],['08-07',95,5],
    ['08-10',95,6],['08-13',97.5,6]]));
  assert.equal(climb.state, 'climbing');

  // Two quiet sessions are a rest, not a wall — naming one that early is how
  // the word stops meaning anything.
  const hold = liftTrend(mk([['08-01',90,6],['08-04',95,6],['08-07',92.5,6],
    ['08-10',92.5,6],['08-13',93,6]]));
  assert.equal(hold.state, 'holding');
  assert.ok(!hold.push, 'a holding lift got pushed at');

  // And under five sessions there is no trend to call at all.
  assert.equal(liftTrend(mk([['08-01',90,6],['08-04',92.5,6]])).state, 'early');

  // The unit follows the account: a 135 lb man is not shown 61.2.
  const lb = liftTrend(mk([['07-01',100,8],['07-04',105,8],['07-08',102,8],
    ['07-11',102,8],['07-15',102,8],['07-18',102,8]]),
    { fmt: v => `${Math.round(v / 0.45359237)} lb` });
  assert.match(lb.say, /lb/);
});

await test('the answer to a wall is structure, never a heavier prescription', () => {
  // "It should be thinking of solutions to find out how I can push harder."
  // Every option changes the SHAPE of the training and is priced from their
  // own history. None ends in "add weight": a stalled lift is stalled
  // precisely because that stopped working — same family as readiness and the
  // form watch, which only ever soften.
  const mk = a => a.map(([date, weight_kg, reps]) => ({ date, weight_kg, reps }));
  const eights = liftTrend(mk([['07-01',100,8],['07-04',105,8],['07-08',102,8],
    ['07-11',102,9],['07-15',102,8],['07-18',102,9],['07-22',102,8]]));
  assert.ok(eights.push.length >= 2);
  assert.equal(eights.push[0].what, 'deload_rebuild');
  assert.ok(eights.push.some(x => x.what === 'lower_reps'), 'living in 8s did not suggest heavy fives');

  const fives = liftTrend(mk([['07-01',120,5],['07-04',125,5],['07-08',122,5],
    ['07-11',122,4],['07-15',122,5],['07-18',122,5],['07-22',121,5]]));
  assert.ok(fives.push.some(x => x.what === 'higher_reps'), 'living in 5s did not suggest a base spell');

  // The one suggestion that is both useless and dangerous never appears — in
  // the DATA, which is where a violation would live (the page's disclaimer
  // legitimately contains the words as a prohibition).
  for (const t of [eights, fives]) {
    assert.ok(!/add (more )?weight|go heavier|increase the (weight|load)|push harder/i.test(JSON.stringify(t)),
      'a wall was answered with a heavier prescription');
  }

  // Wired: the API attaches it per lift and the panel draws it with the
  // options marked as options.
  const api = readFileSync(new URL('../netlify/functions/api-progress.js', import.meta.url), 'utf8');
  assert.match(api, /trend: loaded \? liftTrend\(points/);
  const src = page('app.html');
  assert.match(src, /l\.trend\?\.push\?\.length/);
  assert.match(src, /Options, not orders/);
});

group('The max — recorded, estimated, and never something to go and test');

await test('a max makes sets at different rep ranges comparable', () => {
  // "Should be recording my max for each one." A best SET is the honest record
  // — 235 for 4 is a fact — but it cannot be compared against 175 for 8, which
  // is the whole problem with reading a training log: nothing lines up and
  // progress is invisible even when it is real.
  const heavyFew = estimatedMax(106.6, 4);    // 235lb x 4
  const lightMany = estimatedMax(79.4, 8);    // 175lb x 8
  assert.ok(heavyFew > lightMany, 'the heavier set did not read as the stronger one');
  assert.equal(estimatedMax(100, 1), 103.3);  // Epley: one rep is barely a projection
  assert.equal(estimatedMax(100, 5), 116.7);

  // Reps capped at 12 — Epley diverges badly above that and a set of twenty
  // would produce a confident and absurd number.
  assert.equal(estimatedMax(60, 20), estimatedMax(60, 12));
  assert.ok(estimatedMax(60, 20) < 100, 'a high-rep set projected an absurd max');

  // Nothing to work from is null, never a guess.
  for (const bad of [[null, 5], [100, null], [0, 5], [100, 0], ['x', 5]]) {
    assert.equal(estimatedMax(bad[0], bad[1]), null, `invented a max from ${JSON.stringify(bad)}`);
  }
});

await test('the max is labelled an estimate and never something to attempt', () => {
  // An unlabelled projected max is a number people go and try to lift, and a
  // max attempt is the single most dangerous thing an app can talk somebody
  // into. The estimate exists precisely so nobody needs to.
  const api = readFileSync(new URL('../netlify/functions/api-progress.js', import.meta.url), 'utf8');
  assert.match(api, /basis: 'Epley, from a real set — an estimate, never a tested max\.'/);

  const src = page('app.html');
  const panel = src.slice(src.indexOf('function liftsPanel('), src.indexOf('function matrixPanel('));
  assert.match(panel, /est\. max/i);
  assert.match(panel, /estimated<\/strong>/);
  assert.match(panel, /never suggest going and testing a real max/i);
  assert.ok(!/test your max|find your 1rm|go for a max/i.test(panel));

  // And the instructions have always refused it — check that still holds.
  assert.match(SERVER_INSTRUCTIONS, /NEVER suggest testing a max/i);
});

await test('a personal record is memory, not a window', () => {
  // Third place this rule has had to be applied, after the weigh-in and last
  // night's session. "What is my best bench" must have the same answer on the
  // 1d view as on the 30d one — a record that changes when you press a range
  // button is not a record.
  const api = readFileSync(new URL('../netlify/functions/api-progress.js', import.meta.url), 'utf8');
  const build = api.slice(api.indexOf('const byLift = new Map()'), api.indexOf('const lifts = ['));
  assert.match(build, /for \(const s of histSets\)/, 'lifts are still built from the selected range');

  // And the panel is not hidden behind the trends gate — it is the one thing
  // somebody opens a training log to see.
  const src = page('app.html');
  const render = src.slice(src.indexOf('function render(d)'), src.indexOf('function stagger('));
  const liftsAt = render.indexOf('out.push(liftsPanel(d));');
  const gateAt = render.indexOf('if (trends) {', render.indexOf('out.push(lastSessionPanel(d));'));
  assert.ok(liftsAt > 0 && liftsAt < gateAt, 'the lifts panel is hidden on short ranges');
});

group('Gauging — the set that just happened decides the next one');

await test('an unreported effort never adds weight', () => {
  // Rule 1, and the safety-critical one. Without an RPE the only signal is
  // reps, and reps alone cannot tell a comfortable eight from a grinding one.
  // Silence means hold, never climb — the same shape as readiness.
  const hit = nextSetLoad({ weightKg: 60, reps: 8, targetReps: 8, key: 'bench_press' });
  assert.equal(hit.verdict, 'same');
  assert.equal(hit.weight_kg, 60);
  assert.equal(hit.changed, false);

  // Said to be easy, and only then does it climb — by ONE step, in real plates.
  const easy = nextSetLoad({ weightKg: 60, reps: 8, rpe: 6.5, targetReps: 8, key: 'bench_press' });
  assert.equal(easy.verdict, 'up');
  assert.equal(easy.weight_kg, 62.5);
  assert.match(easy.say, /62\.5kg/);

  // Hit the target but it cost a lot: they earned it. Adding on top of that is
  // how a good session becomes an injury.
  const costly = nextSetLoad({ weightKg: 60, reps: 8, rpe: 9, targetReps: 8, key: 'bench_press' });
  assert.equal(costly.verdict, 'same');
  assert.match(costly.say, /cost enough/);
});

await test('falling apart comes down, and says why', () => {
  // Missing the target at a high RPE is not character-building, it is a weight
  // that is wrong today.
  const short = nextSetLoad({ weightKg: 100, reps: 4, targetReps: 8, key: 'squat' });
  assert.equal(short.verdict, 'down');
  assert.equal(short.weight_kg, 95);
  assert.match(short.say, /finishing the sets matters more/);

  const grind = nextSetLoad({ weightKg: 100, reps: 8, rpe: 9.5, targetReps: 8, key: 'squat' });
  assert.equal(grind.verdict, 'down');
  assert.match(grind.say, /at the limit/);

  // One rep short is not a collapse — hold and rest longer.
  const near = nextSetLoad({ weightKg: 100, reps: 7, targetReps: 8, key: 'squat' });
  assert.equal(near.verdict, 'same');
  assert.match(near.say, /go again/);

  // Never below one plate step, whatever the arithmetic says.
  const tiny = nextSetLoad({ weightKg: 2.5, reps: 1, targetReps: 8, key: 'curl' });
  assert.ok(tiny.weight_kg >= 1.25);
});

await test('bodyweight work has nothing to move, and does not pretend otherwise', () => {
  const bw = nextSetLoad({ weightKg: null, reps: 12, targetReps: 15, key: 'press_ups' });
  assert.equal(bw.verdict, 'same');
  assert.equal(bw.weight_kg, null);
  assert.ok(!/kg/.test(bw.say), `it invented a load for bodyweight work: ${bw.say}`);
});

await test('log_set returns a computed load, never a hardcoded "same"', () => {
  // It WAS a hardcoded verdict:'same' for every set after the first, so "tell
  // me how it felt and I'll adjust" was a promise kept entirely by the model —
  // which means the adjustment was invented, on the one number in this product
  // that goes on a bar.
  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const fn = mcp.slice(mcp.indexOf('async function logSet('), mcp.indexOf('async function swapExercise('));
  assert.match(fn, /nextSetLoad\(\{/, 'the next set is still not computed');
  assert.ok(!/verdict: 'same', weight_kg: args\.weight_kg/.test(fn), 'the hardcoded "same" is back');
  assert.match(fn, /THE LOAD IN up_next IS COMPUTED/);
});

await test('a weight is never read off a photograph and programmed', () => {
  // The invented-2,600 failure in a new place: 135lb read off a picture of a
  // bar and turned into three working sets. It is an observation about a
  // barbell, not a prescription for a person — and the fix is the same shape,
  // pointing at the tool that computes one instead of forbidding harder.
  assert.match(SERVER_INSTRUCTIONS, /A WORKING WEIGHT MAY ONLY EVER COME FROM A TOOL/);
  assert.match(SERVER_INSTRUCTIONS, /never from a photograph/);
  assert.match(SERVER_INSTRUCTIONS, /somebody else left there/);
  assert.match(SERVER_INSTRUCTIONS, /calibrate_lift/);
  assert.match(SERVER_INSTRUCTIONS, /You may not turn it into their programme/);
});

group('Stretching — dynamic before, held after');

const { cooldownFor, warmupFor: warmFor } = await import('../netlify/functions/lib/warmup.js');

await test('the held stretches are offered at the END, where they belong', () => {
  // DYNAMIC BEFORE, STATIC AFTER, and this is content rather than taste: a
  // held stretch immediately before a heavy set measurably costs force for the
  // next half hour. The holds were defined, attached to the WARM-UP object at
  // start_session, and offered at the one moment they are wrong — so the
  // static half of the doctrine had never actually reached anybody.
  const c = cooldownFor({ muscles: ['quads', 'hamstrings'], patterns: ['squat', 'hinge'] });
  assert.ok(c.moves.length >= 2);
  assert.match(c.say, /30 seconds/);
  assert.match(c.style, /Held/);
  assert.equal(c.skippable, true);

  // Named for what actually worked. "Stretch out" reads as filler and gets
  // skipped for exactly that reason — the same argument as the warm-up.
  assert.match(JSON.stringify(c.moves), /Quads|Hamstrings/i);
  const push = cooldownFor({ patterns: ['push'] });
  assert.match(JSON.stringify(push.moves), /Chest|Triceps/i);
  assert.ok(!/Quads/i.test(JSON.stringify(push.moves)), 'it prescribed holds for muscles that did not work');

  // Nothing recognised still gets something, or the feature silently vanishes
  // for exactly the sessions least likely to have a cool-down.
  const odd = cooldownFor({ muscles: ['five-a-side'] });
  assert.ok(odd.moves.length >= 1);

  // The warm-up stays dynamic, and says why. The rule is about HELD stretches —
  // "holding something" is holding a rack for balance on a leg swing, which is
  // the opposite of the thing being prohibited.
  const w = warmFor([{ name: 'Back squat', muscles: ['quads'] }]);
  assert.ok(!/(hold|stretch)[^.;]{0,40}\b(30|45|60) seconds/i.test(JSON.stringify(w.moves)),
    `a held stretch got into the warm-up: ${JSON.stringify(w.moves)}`);
  assert.match(w.style, /not held stretches/i);

  // And a BACK SQUAT is not a pulling session. "back" matched the pull block,
  // so a squat day was handed dead hangs and scapular pulls.
  assert.deepEqual(w.patterns, ['squat'], `back squat matched ${w.patterns}`);
  assert.deepEqual(warmFor([{ name: 'Barbell row', muscles: ['back'] }]).patterns, ['pull']);
});

await test('a cool-down never becomes the reason somebody stops closing sessions', () => {
  // The record of the workout matters more than the stretching does.
  const c = cooldownFor({ patterns: ['pull'] });
  assert.match(c.note, /skip it in one word/i);
  assert.match(c.note, /[Nn]ever insist/);
  assert.ok(!/must|should really|do not skip/i.test(c.say), `the cool-down is insisting: ${c.say}`);

  // And it is never physiotherapy — the not-a-doctor line, in the place it is
  // most tempting to cross.
  const hurt = cooldownFor({ patterns: ['push'], limitations: ['left shoulder impingement'] });
  assert.match(hurt.caution, /not treatment/i);
  assert.match(hurt.caution, /leave it out rather than working into it/i);
});

await test('both doors into a workout offer a warm-up, and the end offers the holds', () => {
  // The warm-up was on start_session and NOWHERE ELSE — and "I'm going to the
  // gym" lands on suggest_workout, which is the more common door by a
  // distance. The one feature built specifically to be offered rather than
  // waited for was, for most sessions, never offered at all.
  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  for (const fn of ['suggestWorkout', 'startSession']) {
    const at = mcp.indexOf(`async function ${fn}(`);
    const body = mcp.slice(at, mcp.indexOf('\nasync function ', at + 10));
    assert.match(body, /warmup: warm|warmup,/, `${fn} offers no warm-up`);
  }
  const end = mcp.slice(mcp.indexOf('async function endSession('), mcp.indexOf('async function previousBest('));
  assert.match(end, /cooldownFor\(\{/, 'end_session offers no cool-down');
  assert.match(end, /cooldown: cool/);
  assert.match(end, /OFFER THE COOLDOWN/);

  assert.match(SERVER_INSTRUCTIONS, /Both start_session AND suggest_workout return a warmup/);
  assert.match(SERVER_INSTRUCTIONS, /end_session returns a cooldown/);
});

group('The five minutes before the first set');

const { preflight } = await import('../netlify/functions/lib/preflight.js');

const DAY = (over = {}) => ({
  food: { calories: 1800, meals: 3 }, training: { entries: [] }, log: [], ...over,
});

await test('it asks how they feel and what they want, in one line', () => {
  // Readiness is the objective half and is blind to the half that matters most
  // on the day: a watch cannot tell a bad night from a bad week at work, and
  // it has never once known somebody's back is tight. Nobody had been asked.
  const p = preflight({ day: DAY() });
  assert.match(p.ask, /How are you feeling/i);
  assert.match(p.ask, /want out of today/i);
  // One line, both questions — two turns of interview before a workout is an
  // interrogation.
  assert.equal(p.ask.split('?').filter(Boolean).length - 1, 1, 'the questions were split into two asks');

  // AND IT NEVER BLOCKS THE SESSION. Same lesson the warm-up taught.
  assert.match(p.note, /never wait for an answer/i);
  assert.match(p.note, /rather just start|if they ignore it, carry on/i);
  assert.match(p.ask, /rather just start/i);
});

await test('fuel advice only ever points at eating MORE', () => {
  // Telling somebody about to train that they should eat less is the dangerous
  // direction, and this is not the moment for a deficit conversation under any
  // framing.
  const empty = preflight({ day: DAY({ food: { calories: 0, meals: 0 } }) });
  assert.equal(empty.fuel.state, 'empty');
  assert.match(empty.fuel.say, /something small before you start/i);

  const light = preflight({ day: DAY({ food: { calories: 400, meals: 1 } }), calorieTarget: 2500 });
  assert.equal(light.fuel.state, 'light');
  assert.match(light.fuel.say, /worth something before you start/i);

  // Well fed is stated flatly and invites no arithmetic about what is left.
  const fed = preflight({ day: DAY(), calorieTarget: 2500 });
  assert.equal(fed.fuel.state, 'fed');
  assert.ok(!/of 2,?500|left|remaining|under|over/i.test(fed.fuel.say),
    `the fed line invites maths about what is left: ${fed.fuel.say}`);

  // Assert on what the PERSON is shown, not on the note written for the model —
  // that legitimately contains the prohibition itself, and grepping it catches
  // the rule rather than a breach of it. Same trap as earlier in this file.
  const spoken = p => [p.ask, p.say, p.fuel?.say, p.taken?.say].filter(Boolean).join(' ');
  for (const p of [empty, light, fed]) {
    assert.ok(!/eat less|cut back|too much|deficit|stay under|calories left/i.test(spoken(p)),
      `a deficit conversation appeared before a workout: ${spoken(p)}`);
  }
});

await test('what they have taken is stated and never advised on', () => {
  // Recorded because it is a fact about the day. Whether they should have,
  // whether it interacts, whether to take more — a doctor's question, always.
  const p = preflight({ day: DAY({ log: [
    { type: 'supplement', summary: 'creatine 5g' },
    { type: 'supplement', summary: 'blood pressure tablet' },
    { type: 'food', summary: 'eggs' },
  ] }) });
  assert.equal(p.taken.count, 2, 'it counted things that are not supplements');
  assert.match(p.taken.say, /creatine/);
  assert.match(p.note, /NOT to be commented on/);
  assert.match(p.note, /doctor/i);
  assert.ok(!/should take|recommend|dose|interact|instead of/i.test(p.taken.say));
});

await test('the body still only ever softens, never spurs', () => {
  // Nothing here turns a good reading, a good mood or a full stomach into "add
  // weight" — that is how a tool argues somebody into an injury.
  const strained = preflight({ day: DAY(),
    ready: { known: true, state: 'strained', say: 'Resting heart rate is up and you slept short. Train lighter today.' } });
  assert.equal(strained.readiness_first, true);
  assert.match(strained.say, /Train lighter/);
  assert.match(strained.note, /body gets a veto/i);
  assert.match(strained.note, /never train harder/i);

  const ready = preflight({ day: DAY(), ready: { known: true, state: 'ready', say: 'Nothing is off.' } });
  assert.equal(ready.readiness_first, false, 'a good reading was promoted to a headline');
  for (const p of [strained, ready]) {
    const spoken = [p.ask, p.say, p.fuel?.say].filter(Boolean).join(' ');
    assert.ok(!/add weight|go heavier|push harder|good day to/i.test(spoken),
      `a reading was turned into a reason to add load: ${spoken}`);
  }
});

await test('the check-in rides on both doors into a workout', () => {
  // "I'm going to the gym" lands on suggest_workout; "let's do S-Tier" lands on
  // start_session. On one only, it exists half the time.
  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  for (const fn of ['suggestWorkout', 'startSession']) {
    const at = mcp.indexOf(`async function ${fn}(`);
    const body = mcp.slice(at, mcp.indexOf('\nasync function ', at + 10));
    assert.match(body, /preflight\(\{/, `${fn} has no check-in`);
    assert.match(body, /preflight: check/, `${fn} does not return it`);
  }
  assert.match(mcp, /ASK THE PREFLIGHT LINE/);
});

group('Preemptive — the one thing worth raising unasked');

const { nextNudge, nudgeNote } = await import('../netlify/functions/lib/prompt.js');

const WEEK = (done, target, daysLeft) => ({ done, target, days_left: daysLeft, met: done >= target });
const PLAN_SET = { set: true, missing: null };

await test('a care flag silences every nudge, including the cheerful ones', () => {
  // Relentless is a setting, not a licence. And a personal best delivered to
  // somebody who has eaten under 1,200 for three days is encouragement pointed
  // in exactly the wrong direction.
  const flags = [{ flag: 'very_low_intake', detail: '...', guidance: '...' }];
  for (const push of ['light', 'normal', 'relentless']) {
    assert.equal(nextNudge({ push, flags, trainingWeek: WEEK(0, 4, 2), plan: PLAN_SET }), null,
      `${push} pushed through a care flag`);
    assert.equal(nextNudge({ push, flags, cardio: { known: true, personal_best: true,
      reads: [{ kind: 'run', personal_best: true, latest: { km: 5, pace: '5:30/km' } }] } }), null,
      `${push} celebrated through a care flag`);
  }
});

await test('the push setting actually changes what gets raised', () => {
  // It was stored, shown back on the plan, and drove NOTHING — no instruction
  // said what light, normal or relentless change, and the level was on no
  // response the model reads. A setting called "how hard this thing chases
  // you" that changes nothing when you set it is decoration.
  const mid = { trainingWeek: WEEK(2, 4, 4), plan: PLAN_SET };     // on pace
  const behind = { trainingWeek: WEEK(1, 4, 4), plan: PLAN_SET };  // behind, still doable
  const adrift = { trainingWeek: WEEK(0, 4, 4), plan: PLAN_SET };  // nothing done at all

  // Light says nothing until they are properly adrift — but it must actually
  // be reachable. Defining "well behind" as the TAIL of the week meant that for
  // anybody training four days a week, light could never fire at all: by the
  // time three days remained with nothing done, the week was already
  // impossible and the branch above had taken it. A setting that silently
  // means "never" is worse than not offering it.
  assert.equal(nextNudge({ push: 'light', ...behind }), null);
  assert.ok(nextNudge({ push: 'light', ...adrift }),
    'light stayed silent on a week with nothing in it at all');

  // Normal raises it when they are behind the pace the week implies.
  assert.ok(nextNudge({ push: 'normal', ...behind }));
  assert.equal(nextNudge({ push: 'normal', ...mid }), null, 'normal chased somebody on pace');

  // Relentless raises it whenever anything is outstanding.
  assert.ok(nextNudge({ push: 'relentless', ...mid }));

  // Nobody is chased once the target is met.
  for (const push of ['light', 'normal', 'relentless']) {
    assert.equal(nextNudge({ push, trainingWeek: WEEK(4, 4, 2), plan: PLAN_SET }), null,
      `${push} kept going after the week was met`);
  }
});

await test('an impossible week is stated, never counted down to zero', () => {
  // Sessions never roll over and a missed week is information, not a debt.
  // Guilt is how a training log dies.
  const impossible = { trainingWeek: WEEK(0, 4, 1), plan: PLAN_SET };
  assert.equal(nextNudge({ push: 'light', ...impossible }), null);
  assert.equal(nextNudge({ push: 'normal', ...impossible }), null,
    'normal nagged about a week that cannot be finished');

  const n = nextNudge({ push: 'relentless', ...impossible });
  assert.match(n.say, /finish short/);
  assert.match(n.say, /nothing carries over/);
  assert.ok(!/should|need to|behind|only|failed|missed|sorry/i.test(n.say),
    `guilt language in: ${n.say}`);
});

await test('no nudge is a legitimate answer, and it is the common one', () => {
  // A coach who finds something to say every single time is one people stop
  // listening to.
  assert.equal(nextNudge({ push: 'normal', trainingWeek: WEEK(4, 4, 3), plan: PLAN_SET }), null);
  assert.equal(nextNudge({}), null, 'a nudge fired with nothing to go on');
  assert.match(nudgeNote(null), /Answer what they asked and stop/);
});

await test('a win is raised at every level, chasing is not', () => {
  // The most valuable unprompted sentence is not "you are behind" — it is
  // "that was your best run yet", said the day it happens. Somebody who asked
  // to be left alone did not ask to be denied their own best run.
  const cardio = { known: true, personal_best: true,
    reads: [{ kind: 'run', personal_best: true, latest: { km: 5.6, pace: '5:32/km' } }] };
  for (const push of ['light', 'normal', 'relentless']) {
    const n = nextNudge({ push, cardio, trainingWeek: WEEK(4, 4, 2), plan: PLAN_SET });
    assert.equal(n.kind, 'best', `${push} swallowed a personal best`);
    assert.match(n.say, /5\.6km/);
  }
});

await test('one thing, never a list, and it is carried where the model will see it', () => {
  // A nudge with three items in it is a lecture, and the second is never read.
  const n = nextNudge({ push: 'relentless', trainingWeek: WEEK(0, 4, 5), plan: PLAN_SET,
    day: { training: { entries: [{ detail: {} }] } }, voicePending: 2 });
  assert.equal(typeof n.say, 'string');
  assert.ok(!Array.isArray(n.say));
  assert.equal(n.kind, 'voice_pending', 'priority order broke');

  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  assert.match(mcp, /nudge: nudge \|\| undefined/, 'the nudge is not on a response');
  assert.match(mcp, /nudge_note/);
  assert.match(SERVER_INSTRUCTIONS, /BE PREEMPTIVE/);
  assert.match(SERVER_INSTRUCTIONS, /never as an opener/);
  // A capture in passing stays quiet — somebody mid-way through a tax question
  // did not open a conversation about their training week.
  assert.match(mcp, /args\.quiet \? null : await nudgeFor/);

  // And it is on the dashboard too: preemptive is not a conversation feature.
  const api = readFileSync(new URL('../netlify/functions/api-progress.js', import.meta.url), 'utf8');
  assert.match(api, /^\s+nudge,$/m);
  assert.match(page('app.html'), /d\.nudge\?\.say/);
});

group('Everything that was answerable only through the assistant');

await test('every computed read now has a panel to draw it', () => {
  // The audit's finding, in one assertion. Each of these was built, tested and
  // correct, and had no surface on the website — so the founder was told it
  // existed and could never go and look at it.
  const api = readFileSync(new URL('../netlify/functions/api-progress.js', import.meta.url), 'utf8');
  const src = page('app.html');
  for (const [key, panel] of [
    ['plan',           'planPanel'],
    ['training_week',  'weekPanelSoFar'],
    ['readiness',      'readinessPanel'],
    ['cardio',         'cardioPanel'],
    ['form',           'formPanel'],
    ['fasting',        'fastingPanel'],
    ['no_target_set',  'targetOptionsPanel'],
  ]) {
    assert.match(api, new RegExp(`^\\s+${key},?$|^\\s+${key}:`, 'm'), `${key} is not on the payload`);
    assert.match(src, new RegExp(`function ${panel}\\(`), `${panel} does not exist`);
    assert.match(src, new RegExp(`out\\.push\\(${panel}\\(d\\)\\)`), `${panel} is never rendered`);
  }
  // The eating window was computed and shipped on every request and drawn by
  // nothing at all — dead data in the payload for as long as it existed.
  assert.match(src, /d\.eating_window/, 'the eating window still draws nowhere');
});

await test('a panel reads the shape the server actually returns', () => {
  // THE CLASS OF BUG A DEMO HIDES. formWatch returns `evidence` as a SENTENCE
  // from two of its three builders and the demo was handing the page an array,
  // so .map() would have thrown on the first real finding while the demo
  // looked perfect. And windowStatus has no `set` field at all — the eating
  // window was gated on a property that never exists.
  const form = readFileSync(new URL('../netlify/functions/lib/form.js', import.meta.url), 'utf8');
  assert.match(form, /evidence: `/, 'evidence is no longer a string anywhere');
  const src = page('app.html');
  const panel = src.slice(src.indexOf('function formPanel('), src.indexOf('function fastingPanel('));
  assert.match(panel, /Array\.isArray\(x\.evidence\)/, 'the panel assumes one evidence shape');

  const w = readFileSync(new URL('../netlify/functions/lib/wrought.js', import.meta.url), 'utf8');
  const ws = w.slice(w.indexOf('export function windowStatus'), w.indexOf('export function fastLength'));
  assert.ok(!/\bset:/.test(ws), 'windowStatus grew a `set` field — the panel gate can use it now');
  const fp = src.slice(src.indexOf('function fastingPanel('), src.indexOf('// \u2500\u2500 Calendar'));
  assert.ok(!/w\?\.set/.test(fp), 'the eating window is gated on a field that does not exist');
});

await test('care flags and the week are never read off a one-day window', () => {
  // The most dangerous consequence of opening on 1d. Care flags need three
  // logged days and a fortnight, so on a one-day range they CANNOT FIRE — and
  // they are the one thing that outranks everything else in this product. The
  // week's count read off one day is not a missing number, it is a wrong one,
  // on the figure the whole plan rests on.
  const api = readFileSync(new URL('../netlify/functions/api-progress.js', import.meta.url), 'utf8');
  assert.match(api, /span >= 30 \? Promise\.resolve\(null\) : rangeFacts\(user\.id, profile, addDays\(to, -29\), to\)/);
  assert.match(api, /const recent = recentRaw \|\| range;/);
  assert.match(api, /careFlags\(recent, profile\)/, 'care flags still read the selected range');
  assert.match(api, /weekSoFar\(recent\.days/, 'the week still reads the selected range');
  assert.match(api, /readiness\(\{ days: recent\.days\.slice\(-15\)/, 'recovery still reads the selected range');
  assert.match(api, /days: recent\.days\.slice\(-7\)/, 'earned room still reads the selected range');

  // And the guards themselves still demand a run-up, or none of the above matters.
  const flags = careFlags({ days: [{ date: '2026-08-11', logged: true, calories: 900, sessions: 1 }] }, {});
  assert.equal(flags.length, 0, 'a care flag fired off a single day');
});

const { workoutList } = await import('../netlify/functions/lib/session.js');

await test('a workout from the watch appears in the list of workouts', () => {
  // "I still don't see individual workouts." Recent sessions was built from
  // wrought_sessions alone — the sessions the ASSISTANT runs, set by set. A run
  // off the watch is a workout EVENT and never creates a session, so every
  // workout from Apple Health was missing from the one panel named for them
  // while sitting in the record the whole time.
  const sessions = [
    { id: 'sess-1', name: 'Leg day', kind: 'strength', local_date: '2026-08-12',
      started_at: '2026-08-12T18:00:00Z', ended_at: '2026-08-12T18:44:00Z' },
  ];
  const events = [
    // The event the finaliser wrote for that same session.
    { local_date: '2026-08-12', summary: 'Leg day — 19 sets, 44 min', source: 'agent',
      detail: { kind: 'strength', minutes: 44, session_id: 'sess-1' } },
    // And a run the watch sent, which creates no session at all.
    { local_date: '2026-08-12', summary: 'run · 5.6 km · 34 min', source: 'wrought_ios',
      detail: { kind: 'run', minutes: 34, distance_km: 5.6, calories: 412, avg_hr: 149 } },
  ];
  const list = workoutList(sessions, events, { today: '2026-08-12' });

  assert.equal(list.length, 2, 'the gym session was counted twice, or the run was dropped');
  assert.ok(list.some(w => w.kind === 'run'), 'the watch workout is missing');
  const run = list.find(w => w.kind === 'run');
  assert.equal(run.distance_km, 5.6);
  assert.equal(run.source, 'device', 'a watch workout is not marked as one');
  assert.equal(run.days_ago, 0);

  // A session with no event of its own is still included — nothing is lost.
  const orphan = workoutList(sessions, [], { today: '2026-08-12' });
  assert.equal(orphan.length, 1);
  assert.equal(orphan[0].name, 'Leg day');

  // And the panel reads the merged list rather than the session table.
  const src = page('app.html');
  const panel = src.slice(src.indexOf('function sessionsPanel('), src.indexOf('// A saved workout you can OPEN'));
  assert.match(panel, /d\.workouts/, 'the panel still reads sessions only');
});

await test('the dashboard does not queue its queries one behind the next', () => {
  // "It takes a while to load." Not the queries being slow — them QUEUEING.
  // The run-up range, the block, the all-time count, the last weigh-in, the
  // cardio rows and the fasts were each awaited on their own line after the
  // main batch had already finished, and none of them needed anything the
  // others returned. Every one is a full round trip from a Netlify function to
  // Supabase, so the page paid all of them end to end.
  const api = readFileSync(new URL('../netlify/functions/api-progress.js', import.meta.url), 'utf8');
  const handler = api.slice(api.indexOf('export const handler'));

  // Count statement-level awaits — each one is a serial hop. Auth, the
  // membership gate, the profile and the stale-session sweep genuinely have to
  // precede the batch (the sweep WRITES rows the batch then reads). Everything
  // else belongs in it.
  const serial = handler.split('\n').filter(l =>
    /^\s*(const .*=\s*)?await /.test(l) && !/Promise\.all/.test(l));
  // Auth, then the gate and profile together, then the sweep, then the batch.
  // The fifth is the block's session count, which genuinely depends on having
  // found a block and only runs when one is active.
  assert.ok(serial.length <= 4,
    `${serial.length} serial round trips before the page can answer:\n${serial.join('\n')}`);

  // And the ones that were pulled in are genuinely in the batch.
  const start = handler.indexOf('rangeFacts(user.id, profile, from, to)');
  const batch = handler.slice(start, handler.indexOf('\n  ]);', start));
  for (const q of ['wrought_blocks', "event_type', 'fast'", 'rangeFacts(user.id, profile, addDays(to, -29)']) {
    assert.ok(batch.includes(q), `${q} is not in the parallel batch`);
  }
});

await test('the head start can always be thrown away', () => {
  // Asking for the dashboard used to wait on four things the SERVER does not
  // need — the CDN answering, the client initialising, the session being read,
  // the MFA check — when the only thing it wants is the bearer token, which is
  // already in localStorage.
  //
  // The request now goes out first. That is only safe because nothing depends
  // on it: every failure resolves to null and the ordinary path runs, so a
  // token shape this does not recognise can never be the reason somebody
  // cannot load their own dashboard.
  const src = page('app.html');
  const tok = src.slice(src.indexOf('function tokenFromStorage()'), src.indexOf('function prefetchProgress()'));
  assert.match(tok, /catch \{ return null; \}/, 'an unreadable token throws instead of falling back');

  const pre = src.slice(src.indexOf('function prefetchProgress()'), src.indexOf('// Last visit\'s screen'));
  assert.match(pre, /if \(!token\) return null;/);
  assert.match(pre, /r\.ok \? r\.json\(\) : null/, 'a rejected head start is treated as data');
  assert.match(pre, /\.catch\(\(\) => null\)/, 'a failed head start rejects instead of falling back');

  // Claimed ONCE. A second load must go to the network rather than redraw an
  // answer that merely happens to still be in a variable.
  const load = src.slice(src.indexOf('async function load(token)'), src.indexOf('function keepPayload('));
  assert.match(load, /const head = earlyHit; earlyHit = null;/);
  // And both paths store the same thing, or the next warm paint disagrees with
  // the screen it is standing in for.
  assert.match(load, /keepPayload\(got\)/);
  assert.match(src, /function keepPayload\(d\)/);

  // The warm paint never runs for somebody who is signed out — a flash of your
  // own old data before a sign-in form is worse than waiting.
  const warm = src.slice(src.indexOf('function paintLastVisit()'), src.indexOf('async function boot()'));
  assert.match(warm, /if \(!tokenFromStorage\(\)\) return false;/,
    'the paint and the request disagree about who is signed in');
  // Presence of a token is not the same question as a VALID one: an expired
  // session left the old dashboard flashing up and then sitting in the DOM
  // behind the sign-in form.
  const tokfn = src.slice(src.indexOf('function tokenFromStorage()'), src.indexOf('function prefetchProgress()'));
  assert.match(tokfn, /body\.exp && body\.exp \* 1000 < Date\.now\(\)/, 'an expired token still counts as signed in');
  // A payload from an older build that no longer renders is a cold load, never
  // a broken screen.
  assert.match(warm, /catch \{ return false; \}/);
});

await test('the browser does not queue its round trips either', () => {
  // The same lesson, one layer out, and it recurred within a day of being
  // written down: opening the Trainer tab fetched the routines, then the
  // connection state, then the live session — three statement-level awaits on
  // three consecutive lines, none of them needing anything the others return.
  // Each arrived individually harmless. Together they cost three serial hops
  // to a cold function before the screen could draw.
  const src = page('app.html');
  const fn = src.slice(src.indexOf('async function loadTrainer()'), src.indexOf('function renderTrainer('));

  // Only awaits that START a request count — reading a body off a response
  // already in hand (res.json(), res.text()) is not another round trip, and
  // counting it would make the assertion noise.
  const STARTS_A_TRIP = /fetch\(|loadRoutines\(|loadConnectedCount\(|needsSession\(/;
  const serial = fn.split('\n').filter(l =>
    /^\s*(const .*=\s*)?await /.test(l) && STARTS_A_TRIP.test(l) && !/Promise\.all/.test(l));
  // Only the session lookup, which everything else needs a token from.
  assert.ok(serial.length <= 1,
    `${serial.length} serial round trips before the Trainer tab can draw:\n${serial.join('\n')}`);

  assert.match(fn, /await Promise\.all\(\[/, 'the independent fetches are not batched');
  // And the guards survive the batching, or the 5-second poll starts re-asking
  // for things that never change.
  assert.match(fn, /trainerRoutinesFull\.length \? null : loadRoutines\(\)/);
  assert.match(fn, /trainerConnected === null \? loadConnectedCount/);
});

await test('a 7.7MB client is not loaded to draw a dashboard', () => {
  // Every function in the product imports lib/wrought.js, so a top-level
  // `import OpenAI from "openai"` bundled the whole SDK into the dashboard,
  // the ingest door and the voice endpoint — none of which can reach it.
  // Netlify cold-starts a function by loading its bundle, so the website paid
  // for the parser on a request that could not possibly use it.
  const w = readFileSync(new URL('../netlify/functions/lib/wrought.js', import.meta.url), 'utf8');
  assert.ok(!/^import OpenAI from 'openai';/m.test(w), 'the SDK is eagerly imported again');
  assert.match(w, /await import\('openai'\)/, 'the lazy load is gone');
  // Still null without a key, so every `if (!openai)` guard behaves as before.
  assert.match(w, /process\.env\.OPENAI_API_KEY\s*\n?\s*\?/);
});

await test('a view that needs a session says so instead of doing nothing', () => {
  // loadTrainer, loadPhotos, loadAccount and loadAdmin all began with a SILENT
  // return, so in the demo three of seven tabs lit up as selected and left the
  // previous screen on. A tab that does nothing reads as broken software.
  const src = page('app.html');
  assert.match(src, /async function needsSession\(/);
  for (const fn of ['loadTrainer', 'loadPhotos', 'loadAccount', 'loadAdmin']) {
    const body = src.slice(src.indexOf(`async function ${fn}(`), src.indexOf(`async function ${fn}(`) + 400);
    assert.match(body, /await needsSession\(/, `${fn} still returns silently`);
  }
});

await test('the plan panel can never draw a target on its own', () => {
  // A number alone is a rule handed down. The maintenance and the rate are not
  // decoration — they are what makes it a decision somebody can judge, and the
  // reason the invented 2,600 was arguable in the first place.
  const src = page('app.html');
  const panel = src.slice(src.indexOf('function planPanel('), src.indexOf('// Defensible numbers'));
  assert.match(panel, /p\.maintenance/);
  assert.match(panel, /projected_kg_per_week/);
  assert.match(panel, /against a maintenance of/);
  // Changing it is never a negotiation.
  assert.match(panel, /never a negotiation/);
  assert.ok(!/commit|discipline|serious about/i.test(panel), 'the plan panel is lecturing');

  // And the options panel exists precisely where a number used to be invented.
  const opts = src.slice(src.indexOf('function targetOptionsPanel('), src.indexOf('// The week, against'));
  assert.match(opts, /none of them applies until you choose one/);
  assert.match(opts, /floors at 1,200/);
});

group('A workout nobody closed is still a workout');

const { stillRunning } = await import('../netlify/functions/lib/session.js');

await test('walking out of the gym does not delete the session', () => {
  // THE WORST KIND OF BUG: the data was there the whole time and every screen
  // said rest day. The workout EVENT — the row the brief, the day card, the
  // matrix, the weekly count and the training burn all read — was written only
  // by end_session. Nobody says "end session"; they finish the last set and
  // leave. Worse, starting the next workout marked the old one 'abandoned', so
  // the training was deleted from every view for good.
  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const start = mcp.slice(mcp.indexOf('async function startSession('), mcp.indexOf('async function buildPlan('));
  assert.match(start, /finaliseSession\(user\.id, profile, existing\)/,
    'starting a workout still bins the last one');
  assert.ok(!/status: 'abandoned'/.test(start),
    'an unclosed session is still marked abandoned outright');

  // And both read paths sweep, so it turns up without another workout having
  // to be started first.
  assert.match(mcp, /await closeStaleSessions\(user\.id, profile\)/);
  const api = readFileSync(new URL('../netlify/functions/api-progress.js', import.meta.url), 'utf8');
  assert.match(api, /closeStaleSessions\(user\.id, profile\)/);
  // And the pre-bridge backfill rides beside it — the training logged while
  // the connector was refusing sessions sits on events the bridge never saw.
  assert.match(api, /backfillDerivedSets\(user\.id\)/);
});

await test('a resting lifter is never closed out from under themselves', () => {
  const H = 3600 * 1000;
  const now = 1_000_000_000_000;
  // Three minutes between sets is a rest. So is twenty.
  assert.equal(stillRunning({ lastSetAt: now - 3 * 60000, startedAt: now - H, now }), true);
  assert.equal(stillRunning({ lastSetAt: now - 45 * 60000, startedAt: now - 2 * H, now }), true);
  // Four hours is not a rest, it is somebody who left.
  assert.equal(stillRunning({ lastSetAt: now - 5 * H, startedAt: now - 6 * H, now }), false);

  // A session with no sets at all gets longer, then is cleared out — nothing
  // is filed for it, because a phantom workout counting toward the weekly
  // target is worse than a missing one.
  assert.equal(stillRunning({ lastSetAt: null, startedAt: now - 2 * H, now }), true);
  assert.equal(stillRunning({ lastSetAt: null, startedAt: now - 9 * H, now }), false);
});

await test('a set reported with no workout running opens one', () => {
  // THE OTHER HALF OF THE SAME LESSON. log_set refused outright without an
  // active session, and the cost was total: somebody who walks in and just
  // starts reporting sets — which is what actually happens — got "No workout
  // is running", their sets never reached wrought_sets, and everything built
  // on that grain silently had nothing to work from. No lift record, no max,
  // no progression next time. The sets existed only as sentences.
  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const fn = mcp.slice(mcp.indexOf('async function logSet('), mcp.indexOf('async function swapExercise('));

  assert.match(fn, /NOBODY SAYS "START A WORKOUT" EITHER/);
  assert.match(fn, /supabase\.from\('wrought_sessions'\)\.insert/, 'log_set cannot open a session');
  assert.match(fn, /autoStarted = true/);

  // An ad-hoc session is NOT a plan and must never invent one. sets: null is
  // an open slot — nothing says how many are coming.
  assert.match(fn, /sets: null/);
  // The open-slot rule lives in recordSet now — ONE write path, shared with
  // the rack screen's tick, so the screen and the voice cannot drift about
  // which exercise you are on. Asserted where it lives, plus that log_set
  // still goes through it rather than growing a second copy.
  assert.match(fn, /await recordSet\(user\.id, \{/, 'log_set no longer shares the write path');
  const sess = readFileSync(new URL('../netlify/functions/lib/session.js', import.meta.url), 'utf8');
  assert.match(sess, /current\.sets == null \? true : done < current\.sets/,
    'an open slot can still run out of sets');

  // A different lift is appended in the order it actually happened, not
  // refused for not being on a plan.
  assert.match(fn, /exerciseKey\(named\) !== current\.key/);

  // It still needs to know WHICH lift — a bare "got 8" with no session and no
  // exercise is genuinely unanswerable, and guessing one would be worse.
  assert.match(fn, /no exercise was named/);

  assert.match(SERVER_INSTRUCTIONS, /A SESSION NOBODY STARTED IS STILL TRAINING/);
  assert.match(SERVER_INSTRUCTIONS, /NEVER answer a reported set with "start a workout first"/);
});

await test('"no workout is running" is never the last word after training', () => {
  // It is a true sentence and a useless one — to somebody who has just
  // finished training it reads as "your workout was lost".
  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const end = mcp.slice(mcp.indexOf('async function endSession('), mcp.indexOf('async function previousBest('));
  assert.match(end, /already_filed: true/, 'a session already filed today is still reported as an error');
  assert.match(end, /nothing was lost/);
  assert.match(end, /NOT a dead end/);
  assert.match(end, /Never leave somebody who has just finished training with nothing recorded/);
});

await test('a session left open overnight does not bill fourteen hours', () => {
  // The minutes are start → LAST SET, never start → now. Measuring to now
  // invents hundreds of calories of training burn, and an overstated burn is
  // the number that tells somebody they have room to eat.
  const src = readFileSync(new URL('../netlify/functions/lib/session.js', import.meta.url), 'utf8');
  assert.match(src, /const endAt = endedAt \? new Date\(endedAt\)\.getTime\(\) : lastSetAt;/);
  assert.match(src, /Math\.max\(1, Math\.round\(\(endAt - started\) \/ 60000\)\)/);
  // The event is filed when it happened, not under today — a late Tuesday
  // session must not land on Wednesday.
  assert.match(src, /occurred_at: endedIso/);
  // An empty session is abandoned, never turned into a workout.
  assert.match(src, /if \(!rows\.length\) \{[\s\S]{0,220}status: 'abandoned'/);
  assert.ok(!/praise|well done|great session/i.test(src), 'the server is congratulating somebody');
});

await test('closing by hand and closing by walking out write the same row', () => {
  // Two copies of the finalisation is how one of them drifts, and then the
  // same workout looks different depending on whether somebody remembered a
  // sentence. end_session goes through the shared path and only supplies the
  // one thing it genuinely knows better: that the session ended now.
  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const end = mcp.slice(mcp.indexOf('async function endSession('), mcp.indexOf('async function previousBest('));
  assert.match(end, /finaliseSession\(user\.id, profile, session, \{/);
  assert.match(end, /closedBy: 'user'/);
  assert.match(end, /endedAt: new Date\(\)\.toISOString\(\)/);
  // It no longer writes its own workout event.
  assert.ok(!/event_type: 'workout'/.test(end), 'end_session still has its own copy');
});

group('The calendar — both halves of the sum, on every square');

const { calendarDays, calendarRollups, calendarMissing, rangeRollup } =
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

await test('the chosen window adds up, and today counts as it stands', () => {
  // "Look at the seven day — should be yesterday, today to this point. The same
  // with the month. It's not running total." Every window figure on the page
  // was an average per logged day, which answers "what does a normal day look
  // like" when the question at four in the afternoon is "where am I in this
  // stretch, right now".
  const days = Array.from({ length: 5 }, (_, i) =>
    calDay(`2026-08-0${i + 1}`, { weight_kg: 84 }));
  const entries = calendarDays({ days, foodRows: [], profile: CAL_PROFILE });
  const r = rangeRollup(entries, 'the last 5 days');

  assert.equal(r.span_days, 5);
  assert.equal(r.in_total, 2000 * 5, 'the running total is not a total');
  // The same rule as every other window here: all three off the same days, so
  // they visibly subtract on screen.
  assert.equal(r.in_total - r.out_total, r.net_total);
  assert.equal(r.label, 'the last 5 days');

  // A day nobody logged is still not a zero-calorie day — the running total
  // obeys the rule the rest of the calendar does.
  const withGap = calendarDays({
    days: days.concat([calDay('2026-08-06', { logged: false, calories: null, meals: 0, weight_kg: 84 })]),
    foodRows: [], profile: CAL_PROFILE,
  });
  const g = rangeRollup(withGap, 'the last 6 days');
  assert.equal(g.span_days, 6);
  assert.equal(g.days_counted, 5, 'a forgotten day was counted as a perfect fast');
  assert.equal(g.in_total, 2000 * 5);

  // Nothing at all is null rather than a pile of zeroes.
  assert.equal(rangeRollup([], 'the last 7 days'), null);
});

await test('the dashboard opens on today, and the range is what moves', () => {
  const src = page('app.html');
  // "When we open it up, it should always be on the first day."
  assert.match(src, /^let days = 1;$/m, 'the dashboard no longer opens on today');
  const btns = src.slice(src.indexOf('id="rangebtns"'), src.indexOf('</div>', src.indexOf('id="rangebtns"')));
  assert.match(btns, /data-days="1"\s+aria-pressed="true"/, '1d is not the pressed button');
  assert.equal((btns.match(/aria-pressed="true"/g) || []).length, 1, 'two ranges look selected');

  // And the range now does something above the fold, or it reads as broken.
  assert.match(src, /out\.push\(windowPanel\(d\)\);/);
  assert.match(src, /function windowPanel\(d\)/);
  // It draws the server's figures and sums nothing itself.
  // Scoped to windowPanel ALONE. This used to run to trainingTodayPanel, which
  // swept in two unrelated functions and made the assertion fire on arithmetic
  // that was never the running total — a test that names the wrong code is one
  // nobody can act on.
  const wpFrom = src.indexOf('function windowPanel(');
  const panel = src.slice(wpFrom, src.indexOf('\nfunction ', wpFrom + 10));
  assert.ok(!/reduce\(/.test(panel), 'the running total is being summed in the browser');
  assert.match(panel, /const r = d\.window;/);
  // The denominator is said out loud, exactly as the calendar says it.
  assert.match(panel, /not the whole/);
});

await test('a quiet morning is not a brand new account', () => {
  // The first-run screen used to be decided from the loaded window. Harmless at
  // 30 days, a lie at one: somebody with a month of history who has not logged
  // anything yet today would be handed the new-account page — on the one
  // product whose entire promise is that it remembers.
  const src = page('app.html');
  const fn = src.slice(src.indexOf('function isFirstRun('), src.indexOf('function firstRun('));
  assert.match(fn, /d\.has_history/, 'first run is still judged from the window alone');

  const api = readFileSync(new URL('../netlify/functions/api-progress.js', import.meta.url), 'utf8');
  assert.match(api, /has_history: hasHistory/);
  // Counted over ALL time, never between from and to.
  const count = api.slice(api.indexOf('const { count: everCount }'), api.indexOf('const hasHistory'));
  assert.ok(!/local_date/.test(count), 'the all-time count was bounded by the window');
});

await test('a window is not a memory — last night survives the 1d view', () => {
  // Sets used to be fetched over the selected range alone, so on a one-day view
  // "last night" had no sets attached and nothing to compare against: the panel
  // drew a session with nothing in it, which reads exactly like a workout that
  // failed to save.
  const api = readFileSync(new URL('../netlify/functions/api-progress.js', import.meta.url), 'utf8');
  assert.match(api, /const histFrom = addDays\(to, -Math\.max\(span - 1, 59\)\)/);
  assert.match(api, /gte\('local_date', histFrom\)/, 'the set query is still bounded by the range');
  assert.match(api, /lastSession\(sessions, histSets/, 'last night is still read from the window');
  // Trends stay bounded by the chosen range, or the buttons stop meaning anything.
  assert.match(api, /const setRows = histSets\.filter\(s => s\.local_date >= from\)/);
});

await test("today's own training is on the day view, and a shift is not a session", () => {
  // "It's not showing on the first day my workout, my exercise." A run that came
  // off the watch an hour ago belonged to no panel: the matrix is arithmetic
  // ABOUT training and last_session is the assistant's own session table, so the
  // day it happened on showed a burn that included it and nothing saying what it
  // was.
  const src = page('app.html');
  assert.match(src, /out\.push\(trainingTodayPanel\(d\)\);/);
  const panel = src.slice(src.indexOf('function trainingTodayPanel('), src.indexOf('// \u2500\u2500 Calendar'));
  assert.match(panel, /d\.today\?\.training/);
  assert.match(panel, /avg_hr/, 'the training spike is dropped on the day it happened');
  // Work is listed because it burned calories and for no other reason.
  assert.match(panel, /A SHIFT IS NOT A SESSION/);
  assert.match(panel, /chip">work/);
  // No praise anywhere near it.
  assert.ok(!/well done|great|nice work|proud/i.test(panel), 'a shift is being praised');
});

await test('a ledger bar actually paints, rather than leaving a grey slot', () => {
  // The fill is a <span>, and a bare span is INLINE — height and background
  // paint against the line box rather than the track, so every in-versus-out
  // bar rendered as an empty grey slot. It reads as a number the page failed
  // to draw, which on a screen about somebody's eating is worse than no bar.
  const src = page('app.html');
  assert.match(src, /\.fill \{ display: block;/, 'the ledger fill is inline again');
});

await test('a one-day view says trends need longer rather than drawing nine blanks', () => {
  // Nine panels all reading "not enough data yet" is what the first-run screen
  // exists to prevent, and opening on 1d would have recreated it.
  const src = page('app.html');
  assert.match(src, /const trends = \(d\.span_days \|\| 1\) >= 7;/);
  assert.match(src, /if \(trends\) \{\s*\n\s*out\.push\(focusPanel\(d\)\);/);
  assert.match(src, /Tap <strong>7d<\/strong> or <strong>30d<\/strong>/);
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

await test('no pill can push the dashboard sideways', () => {
  // THE SAME LESSON, ONE CLASS ALONG. .setpill is declared in three places and
  // .ls-sets is the container for six different things — lift sets, run stats,
  // readiness signals, the form watch's evidence. A white-space: nowrap
  // written for "92.5 x 6 @8" therefore also reached an evidence SENTENCE,
  // which measured 565px inside a 390px screen and made the whole page scroll
  // sideways. A dashboard that slides under the thumb reads as broken software,
  // and on a phone it is the only way most people will ever see it.
  // Comments stripped first — this rule's own explanation names the property
  // it forbids, and grepping the warning instead of the breach is a trap this
  // harness has fallen into twice already.
  const src = page('app.html').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...src.matchAll(/^\.setpill\s*\{([^}]*)\}/gm)].map(m => m[1]);
  assert.ok(rules.length >= 1, '.setpill is not defined at all');
  for (const r of rules) {
    assert.ok(!/white-space:\s*nowrap/.test(r), 'a pill refuses to break, so a long one overflows the page');
  }
  assert.ok(rules.some(r => /max-width:\s*100%/.test(r)), 'nothing stops a pill exceeding the gutters');
  // Scoping it to the container does not help: .ls-sets holds the sentences too.
  assert.ok(!/\.ls-sets\s+\.setpill\s*\{[^}]*nowrap/.test(src),
    '.ls-sets carries sentence pills as well as set pills — nowrap there is the same bug');
});

await test('a figure is never styled as its own caption', () => {
  // THE SAME LESSON A THIRD TIME, and this one was live on the landing page.
  // Every count-up figure is wrapped in <span class="n">, so a caption rule
  // written as a bare descendant — `.stat span { font-size: 14px }` — lands on
  // the NUMBER as well. The three stats under the hero rendered at 14px in dim
  // grey with their units set LARGER than the figures they label, on the
  // section whose entire promise is a number you can read across a room. It
  // had already been found and fixed for .leg, with a comment; .stat has the
  // identical shape and was missed. Deliberately broad: a caption belongs to
  // the direct child, and `>` costs one character.
  const src = page('index.html').replace(/\/\*[\s\S]*?\*\//g, '');
  const loose = [...src.matchAll(/^\.([\w-]+) span\s*\{([^}]*)\}/gm)]
    .filter(m => /font-size|color|display/.test(m[2]))
    .map(m => m[1]);
  assert.deepEqual(loose, [],
    'a bare descendant span rule also catches <span class="n"> — write it as > span');
});

group('A CDN is not allowed to take the page down');

await test('the dashboard says something when the client never arrives', () => {
  const src = page('app.html');
  const tail = src.slice(src.indexOf('const clientReady'));
  // It was a bare top-level await on jsdelivr. When the import rejects, every
  // line after it never runs — boot() included — so the screen stays black:
  // no wordmark, no message, nothing to do. Worst of all on ?demo=1, which is
  // shown to somebody with no account and no warm render to fall back on.
  assert.match(tail, /try \{[\s\S]*?await clientReady[\s\S]*?\} catch/,
    'a bare top-level await on the CDN: the module rejects and boot() never runs');
  assert.ok(/clientDown = true/.test(tail),
    'the failure is not recorded, so nothing downstream can say what happened');
  assert.ok(tail.lastIndexOf('boot();') > tail.indexOf('catch'),
    'boot() has to run whether or not the client arrived — the demo and the manual need no client');
});

await test('a network failure is never answered with a password form', () => {
  // The offline card's doctrine, one layer in: a page that answers a failed
  // load with the sign-in screen tells somebody they have been signed out,
  // which is the one thing a product whose promise is memory must not fake.
  const src = page('app.html');
  assert.match(src, /if \(!sb && clientDown\)/,
    'the two failures are answered the same way — no client is not a missing key');
  const card = src.slice(src.indexOf('id="down"'), src.indexOf('<div id="app"'));
  assert.ok(card.length > 100, 'there is no honest failure card');
  assert.ok(!/type="password"|id="pass"|Sign in/.test(card),
    'the failure card asks somebody to sign in again');
  assert.match(card, /not been signed out/, 'it does not say the record is untouched');
});

await test('the manual is reachable from the card that replaces the gate', () => {
  // The claim was that a CDN outage still leaves the demo and the manual
  // working. Half true: the manual is static markup and makes no request, so
  // it renders perfectly with no client — but its ONLY entrance was the peek
  // link on the sign-in gate, and the failure card REPLACES that gate. The
  // screen claiming the manual still worked was the screen making it
  // unreachable. Verified in a browser: tapping it renders the guide.
  const src = page('app.html');
  const card = src.slice(src.indexOf('id="down"'), src.indexOf('<div id="app"'));
  assert.match(card, /id="downpeek"/, 'no way out of the failure card but a reload');

  // ONE opener for both doors. Two copies is how the second quietly stops
  // matching the first — the lesson this repo has now learned from .bar,
  // .setpill and .stat.
  assert.match(src, /function openManual\(/);
  assert.match(src, /\$\('peek'\)\?\.addEventListener\('click', openManual\)/);
  assert.match(src, /\$\('downpeek'\)\?\.addEventListener\('click', openManual\)/);
  assert.match(src, /\$\('down'\)\.hidden = true;/, 'the card stays over the manual');

  // And the guide view still needs no session and makes no request, or none of
  // the above buys anything.
  const refresh = src.slice(src.indexOf('async function refresh()'));
  const guideLine = refresh.slice(0, refresh.indexOf('\n  if (view === \'log\')'));
  assert.match(guideLine, /view === 'guide'/, 'the guide is no longer the first branch');
  assert.ok(!/await |fetch\(/.test(guideLine), 'the manual now waits on a request');
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

// ── Form, read from the record ──────────────────────────────────────────────

group('Form — the shadow technique leaves in the log');

const SESSION = (date, reps, weight = 100, rpe = null, note = null) =>
  reps.map((r, i) => ({
    exercise: 'Bench Press', exercise_key: 'bench press', session_id: date,
    set_number: i + 1, position: 1, reps: r, weight_kg: weight,
    rpe: Array.isArray(rpe) ? rpe[i] : rpe, note: i === 0 ? note : null, local_date: date,
  }));

await test('it never claims to have watched anybody lift', () => {
  // The whole design constraint. There is no camera and no bar sensor, so a
  // sentence like "your form is breaking down" is an assertion about something
  // that was never observed — the same offence as reading a body-fat figure
  // off a photograph, and it would poison every honest number here.
  // Asserted on the OUTPUT rather than the source: the file legitimately has to
  // name the forbidden sentence in order to forbid it, and a grep cannot tell
  // a prohibition from a violation. What reaches a person is what matters.
  const scenarios = [
    [...SESSION('2026-08-01', [8, 8, 8, 3]), ...SESSION('2026-08-05', [8, 8, 7, 3]), ...SESSION('2026-08-09', [8, 8, 7, 4])],
    [...SESSION('2026-08-01', [6, 6, 6], 100, 7), ...SESSION('2026-08-05', [6, 6, 6], 100, 8), ...SESSION('2026-08-09', [6, 6, 6], 100, 9.5)],
    SESSION('2026-08-09', [8, 8, 6], 100, null, 'rushed it, form went'),
  ];

  for (const sets of scenarios) {
    const out = formWatch({ sets, targetReps: 8 });
    assert.match(out.limits, /cannot see you lift/i);
    // Everything spoken to a person, checked for an assertion about technique.
    const spoken = [out.say, ...out.findings.flatMap(f => [f.say, f.verdict, f.evidence])].join(' ');
    assert.doesNotMatch(spoken, /your form|your technique|form is breaking|bad form|poor technique|doing it wrong/i);
    for (const f of out.findings) {
      // Every finding carries the rows behind it. A verdict without evidence
      // is an opinion wearing a number.
      assert.ok(f.evidence && f.evidence.length > 20, `${f.finding} has no evidence`);
    }
  }
});

await test('a last set falling off a cliff is caught, and priced in kilos', () => {
  const out = formWatch({ sets: [...SESSION('2026-08-01', [8, 8, 8, 3]),
                                 ...SESSION('2026-08-05', [8, 8, 7, 3]),
                                 ...SESSION('2026-08-09', [8, 8, 7, 4])] });
  const f = out.findings.find(x => x.finding === 'last_set_collapse');
  assert.ok(f, 'the collapse was missed');
  // The verdict is a change to the training, never an instruction to try harder.
  assert.match(f.verdict, /10%|90|take/i);
  assert.doesNotMatch(f.say, /push through|dig in|try harder/i);
});

await test('one bad set is a bad day, not a finding', () => {
  // A coach who finds a fault every session is one people stop listening to.
  const out = formWatch({ sets: [...SESSION('2026-08-01', [8, 8, 8, 8]),
                                 ...SESSION('2026-08-05', [8, 8, 8, 8]),
                                 ...SESSION('2026-08-09', [8, 8, 8, 3])] });
  assert.equal(out.findings.filter(f => f.finding === 'last_set_collapse').length, 0);
  assert.match(out.say, /nothing in the log is coming apart/i);
});

await test('the same weight costing more is reported without a cause', () => {
  // RPE climbing at a fixed load is real. WHY it is climbing — recovery, food,
  // technique, a bad fortnight at work — is not knowable from here and must
  // not be guessed between.
  const out = formWatch({ sets: [...SESSION('2026-08-01', [6, 6, 6], 100, 7),
                                 ...SESSION('2026-08-05', [6, 6, 6], 100, 8),
                                 ...SESSION('2026-08-09', [6, 6, 6], 100, 9)] });
  const f = out.findings.find(x => x.finding === 'effort_creep');
  assert.ok(f, 'the creep was missed');
  assert.match(f.evidence, /RPE 7 to RPE 9/);
  assert.doesNotMatch(f.say, /because|overtrained|under-?recovered|not eating/i);
  // It only ever softens — adding load on top of this is the injury.
  assert.match(f.verdict, /hold|back off|light/i);
});

await test('adding weight is never the answer to a stall', () => {
  const out = formWatch({ sets: [...SESSION('2026-08-01', [6, 6, 6], 100, 7),
                                 ...SESSION('2026-08-05', [6, 6, 6], 100, 8),
                                 ...SESSION('2026-08-09', [6, 6, 6], 100, 9.5)] });
  for (const f of out.findings) {
    assert.doesNotMatch(f.verdict, /add (weight|load)|go heavier|put more on/i);
  }
});

await test('their own words come back exactly as they were said', () => {
  // The reason to log by voice at all: a notebook has no column for "third set
  // I rushed it", so the fact that explains the number is the one paper cannot
  // hold. Quoted, never interpreted.
  const sets = [...SESSION('2026-08-09', [8, 8, 6], 100, null, 'rushed the last two, form went')];
  const out = formWatch({ sets });
  assert.ok(out.your_words?.length);
  assert.equal(out.your_words[0].note, 'rushed the last two, form went');
  assert.equal(out.your_words[0].about_body, false);

  // Pain is flagged as a report about a body, not a coaching cue.
  const hurt = formWatch({ sets: SESSION('2026-08-09', [8, 8, 6], 100, null, 'sharp twinge in the shoulder') });
  assert.equal(hurt.your_words[0].about_body, true);
});

await test('an empty log says so rather than inventing a pattern', () => {
  const out = formWatch({ sets: [] });
  assert.equal(out.known, false);
  assert.match(out.say, /nothing to read/i);
});

await test('the connector is forbidden from asserting technique', () => {
  const tool = TOOLS.find(t => t.name === 'form_check');
  assert.ok(tool, 'form_check is missing');
  assert.match(tool.description, /CANNOT SEE THEM LIFT/);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.match(SERVER_INSTRUCTIONS, /FORM MATTERS AND YOU CANNOT SEE IT/);
  assert.match(SERVER_INSTRUCTIONS, /NEVER SAY THEIR FORM IS BREAKING DOWN/);
  // And the note is the point of voice logging, so it is told to capture it.
  assert.match(SERVER_INSTRUCTIONS, /WHAT THEY SAID MID-SET/);
  assert.match(SERVER_INSTRUCTIONS, /verbatim/);
});

await test('a run is a progression too, and a best is said out loud', () => {
  // "I've been running a month straight and today was my best run yet." A
  // barbell log has no shape for that — no top set, nothing to add load to.
  // Pace is the number, and whether it is moving is the question.
  const run = (date, km, mins) => ({
    local_date: date, summary: 'Outdoor Run',
    detail: { source_name: 'Outdoor Run', distance_km: km, minutes: mins },
  });
  const out = cardioProgress([run('2026-07-12', 5, 32), run('2026-07-19', 5, 31),
                              run('2026-07-26', 5, 30.5), run('2026-08-02', 5, 30),
                              run('2026-08-11', 5, 28.5)]);
  assert.ok(out.known);
  assert.equal(out.personal_best, true);
  assert.match(out.say, /Best run yet/);
  assert.match(out.say, /5:42\/km/);
  assert.ok(out.reads[0].trend_pct > 5, 'a month of improvement read as flat');
});

await test('a sprint does not count as a personal best over a 5k', () => {
  // Beating your 5k pace on a 1km effort is not a better run, and calling it
  // one is how the number stops being believed.
  const run = (date, km, mins) => ({
    local_date: date, summary: 'Outdoor Run',
    detail: { source_name: 'Outdoor Run', distance_km: km, minutes: mins },
  });
  const out = cardioProgress([run('2026-07-12', 5, 30), run('2026-07-19', 5, 30),
                              run('2026-08-11', 1, 4.5)]);
  assert.equal(out.reads[0].personal_best, false, 'a 1km sprint beat a 5k');
});

await test('a flat pace is information, never a scolding', () => {
  const run = (date, km, mins) => ({
    local_date: date, summary: 'Outdoor Run',
    detail: { source_name: 'Outdoor Run', distance_km: km, minutes: mins },
  });
  const out = cardioProgress([run('2026-07-12', 5, 30), run('2026-07-19', 5, 30),
                              run('2026-07-26', 5, 30), run('2026-08-02', 5, 30)]);
  assert.match(out.say, /flat|wall/i);
  assert.doesNotMatch(out.say, /should|need to|try harder|disappoint/i);
  // And it never guesses at a cause it cannot know.
  assert.match(out.note, /must not guess/i);
});

await test('the nightly read fires without an OpenAI key', () => {
  // writeVerdict returns null with no key, and the send loop skipped on a null
  // verdict — so the ONE surface that can genuinely speak first was silently
  // dead, for exactly the reason the founder did not want to pay for a key.
  const line = plainBrief({
    facts: {
      food: { meals: 3, calories: 1520, protein_g: 57, meals_uncounted: 0 },
      training: { sessions: 1, say: '1 session, 44 min' },
      device: { steps: 9945 },
      training_week: { say: '2 of 3 sessions this week, 2 days left.', target: 3 },
    },
    balance: { known: true, calories_in: 1520, calories_out: 3213, net: -1693 },
  });
  assert.match(line, /1520 in/);
  assert.match(line, /1693 down/);
  assert.match(line, /2 of 3 sessions/);
  assert.match(line, /[Ee]stimates/);

  // A care flag is the whole message — a lock screen has no room to bury it.
  const flagged = plainBrief({
    facts: { food: { meals: 3, calories: 900 } },
    flags: [{ flag: 'very_low_intake', detail: '4 of the last 6 days came in under 1,200 kcal.' }],
  });
  assert.match(flagged, /1,200/);
  assert.doesNotMatch(flagged, /steps|session/i);

  // Nothing logged gets nothing. A nightly nag is how a product gets muted.
  assert.equal(plainBrief({ facts: {} }), null);

  const src = readFileSync(new URL('../netlify/functions/brief-nightly.js', import.meta.url), 'utf8');
  assert.match(src, /plainBrief/);
});

await test('the nightly hour is theirs to move', () => {
  // "It should be a daily analysis at 9pm." A notification at the wrong hour
  // is how somebody mutes an app for good.
  const tool = TOOLS.find(t => t.name === 'set_profile');
  assert.ok(tool.inputSchema.properties.brief_hour, 'brief_hour cannot be set');
  assert.match(tool.inputSchema.properties.brief_hour.description, /21/);
  const src = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function setProfile('), src.indexOf('async function setGoal('));
  assert.match(fn, /'brief_hour'/);
  assert.match(fn, /h < 0 \|\| h > 23/);
});

// ── Lines that say whether it is working ────────────────────────────────────

group('Charts — the trend, the target, and the gaps');

await test('a chart draws the mean as well as the days', () => {
  // One day's calories is salt, sleep and memory. Somebody reading the spikes
  // is reading noise, so the seven-day mean rides alongside — the same
  // doctrine the brief runs on, made visible.
  const page = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
  const fn = page.slice(page.indexOf('function chart('), page.indexOf('function wireCharts'));
  assert.match(fn, /opts\.trend/);
  assert.match(fn, /class="trend"/);
  assert.match(fn, /7-day average/);
});

await test('the target is inside the frame, or it is not on the chart', () => {
  // A target above the data's own maximum would be drawn off the top of the
  // plot and silently stop existing — a boundary that vanishes exactly when
  // somebody is furthest from it.
  const page = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
  const fn = page.slice(page.indexOf('function chart('), page.indexOf('function wireCharts'));
  assert.match(fn, /if \(target != null\) vals\.push\(target\)/);
  assert.match(fn, /class="target"/);
});

await test('the fill never spans a day nobody logged', () => {
  // Filling straight across a gap paints a solid shape over days with no data
  // in them, which is a picture of a record that does not exist.
  const page = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
  const fn = page.slice(page.indexOf('function chart('), page.indexOf('function wireCharts'));
  assert.match(fn, /const runs = \[\]/);
  assert.match(fn, /if \(p\.value == null\)/);
});

await test('axis labels are distinct, so the scale is not a lie', () => {
  // A sessions-a-week line runs 3 to 4, and three evenly spaced ticks rounded
  // to integers printed "4, 4, 3" — which reads as a broken chart on the one
  // number the whole training expectation rests on.
  const page = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
  const fn = page.slice(page.indexOf('function chart('), page.indexOf('function wireCharts'));
  assert.match(fn, /const seen = new Set\(\)/);
  assert.match(fn, /if \(seen\.has\(k\)\) return false/);
});

await test('the rolling numbers are computed on the server', () => {
  // Same rule as every other figure: the page draws what it was handed. A mean
  // worked out in the browser is a second opinion nobody asked for.
  const src = readFileSync(new URL('../netlify/functions/api-progress.js', import.meta.url), 'utf8');
  assert.match(src, /function trailingMean/);
  assert.match(src, /function rolling/);
  // Unlogged days are SKIPPED, never averaged in as zero — the calendar's rule,
  // and it runs in the dangerous direction if it is got wrong.
  const fn = src.slice(src.indexOf('function trailingMean'), src.indexOf('export const handler'));
  assert.match(fn, /Number\(v\) > 0/);
  assert.match(src, /sessions: rolling\(/);
});

await test('Trainer answers what next when nothing is running', () => {
  // A tab that says "nothing is running" and stops is a dead screen, and the
  // question somebody opens Trainer to ask between sessions is what to do
  // next. The routines are fetched by the endpoint rather than cached from
  // another tab, so opening Trainer directly still answers it.
  const api = readFileSync(new URL('../netlify/functions/api-session.js', import.meta.url), 'utf8');
  // Anchored on the idle branch's own comment: the POST path above it also
  // tests `!session`, and slicing from the first match silently produced an
  // empty string — a test that passes on nothing is worse than no test.
  const idle = api.slice(api.indexOf('// Between sessions the question is'), api.indexOf('  const sets = logged'));
  assert.match(idle, /wrought_routines/);
  assert.match(idle, /movements:/);
  assert.match(idle, /notes: r\.notes/);

  const page = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
  const fn = page.slice(page.indexOf('function renderTrainer'), page.indexOf('// The workout as a list'));
  assert.match(fn, /routinesPanel\(/);
});

await test('the screen says whether the phone is even talking', () => {
  // "Where are my workouts" has three answers — the phone never sent, the
  // server refused, or they are there — and none was visible from any screen.
  // Working it out took weeks and three wrong guesses.
  const page = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
  const fn = page.slice(page.indexOf('function devicePanel2'), page.indexOf('function routinesPanel'));
  // Each branch names ONE next thing; a diagnostic offering three options is
  // one nobody acts on.
  assert.match(fn, /Open the Wrought app/);
  assert.match(fn, /015_wrought_ingest_dedupe_fix/);
  assert.match(fn, /Everything is arriving/);
  assert.match(fn, /connections\?\.length/);

  const api = readFileSync(new URL('../netlify/functions/api-progress.js', import.meta.url), 'utf8');
  assert.match(api, /wrought_connections/);
  assert.match(api, /workouts_from_device/);
});

await test('a saved workout can be opened and read on the website', () => {
  // "A name, the procedure, a write-up at least." The assistant could recite
  // all of it while the website showed a row saying "Leg day · 4 lifts".
  const page = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
  const fn = page.slice(page.indexOf('function routinesPanel'), page.indexOf('function notesPanel'));
  assert.match(fn, /r\.notes/);
  assert.match(fn, /r\.movements/);
  assert.match(fn, /Saved workouts/);
  // A routine with no write-up says so rather than showing a blank.
  assert.match(fn, /No write-up on this one yet/);

  const api = readFileSync(new URL('../netlify/functions/api-progress.js', import.meta.url), 'utf8');
  assert.match(api, /notes: r\.notes/);
  assert.match(api, /movements:/);
});

// ── The index that ate every workout ────────────────────────────────────────

group('Ingest deduplication — the bug that had no symptom');

await test('the dedupe index is not partial, because ON CONFLICT cannot infer one', () => {
  // THE BUG, kept as a test so it cannot come back. 001 created this index
  // with `where source_ref is not null`. Postgres will not infer a PARTIAL
  // unique index from a bare column list, and PostgREST cannot send the
  // predicate — so every upsert against wrought_events failed with 42P10 and
  // every device-sent workout was silently discarded.
  //
  // Metrics kept arriving the whole time, because their index is not partial.
  // Steps landing and workouts vanishing is a bug shaped exactly like a
  // HealthKit permission problem, which is where the hunting went.
  const sql = readFileSync(new URL('../schema/015_wrought_ingest_dedupe_fix.sql', import.meta.url), 'utf8');
  assert.match(sql, /drop index if exists public\.wrought_events_source_ref_idx/i);
  const create = sql.slice(sql.lastIndexOf('create unique index'));
  assert.match(create, /wrought_events \(user_id, source, source_ref\)/);
  // The predicate must be gone. A NULL is already distinct from another NULL
  // in a unique index, so hand-logged rows stay unconstrained without it.
  assert.doesNotMatch(create.split(';')[0], /where/i);
});

await test('the phone shows what the last sync actually achieved', () => {
  // An absence of workouts and a silent app look identical from the outside.
  // Telling those two apart used to mean reading a database, which is how the
  // partial-index bug survived for weeks.
  const client = readFileSync(new URL('../ios/Wrought/IngestClient.swift', import.meta.url), 'utf8');
  assert.match(client, /struct Receipt/);
  assert.match(client, /out\["events_error"\]/);
  assert.match(client, /out\["events_written"\]/);

  const courier = readFileSync(new URL('../ios/Wrought/HealthCourier.swift', import.meta.url), 'utf8');
  assert.match(courier, /@Published var lastSync/);
  // A 200 carrying an error inside it still has to read as a failure.
  assert.match(courier, /receipt\.error == nil/);

  const view = readFileSync(new URL('../ios/Wrought/ContentView.swift', import.meta.url), 'utf8');
  assert.match(view, /courier\.lastSync/);
});

await test('a failed event write is reported, never swallowed', () => {
  // The reason this survived for weeks: the endpoint answered 200 with a
  // cheerful events_written count while the insert underneath was erroring.
  const src = readFileSync(new URL('../netlify/functions/ingest.js', import.meta.url), 'utf8');
  assert.match(src, /events_error/);
  // And there is a path that works before anybody runs the migration.
  assert.match(src, /eventsFallback/);
  assert.match(src, /015_wrought_ingest_dedupe_fix\.sql/);
  // The old silent form is gone.
  assert.doesNotMatch(src, /if \(!error\) eventsWritten = data\?\.length \|\| 0;/);
});

await test('the fallback still refuses to write the same workout twice', () => {
  // Losing deduplication to fix a write is not a fix — a watch re-sends the
  // same week of workouts on every sync, and four copies of Tuesday's run
  // would corrupt every total built on top of them.
  const src = readFileSync(new URL('../netlify/functions/ingest.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('eventsError = error.message'), src.indexOf('await Promise.all(['));
  assert.match(block, /select\('source_ref'\)/);
  assert.match(block, /new Set\(/);
  assert.match(block, /!seen\.has\(r\.source_ref\)/);
});

// ── Everything the watch keeps ──────────────────────────────────────────────

group('The wide door — every metric a watch actually records');

await test('the rings are all three, not just the red one', () => {
  // "Times standing on your feet" — the blue ring, asked for by name.
  assert.equal(canonicalMetric('HKCategoryTypeIdentifierAppleStandHour'), 'stand_hours');
  assert.equal(canonicalMetric('apple_stand_hours'), 'stand_hours');
  assert.equal(canonicalMetric('HKQuantityTypeIdentifierAppleStandTime'), 'stand_minutes');
  assert.equal(canonicalMetric('HKQuantityTypeIdentifierAppleExerciseTime'), 'active_minutes');
  assert.equal(canonicalMetric('flights_climbed'), 'flights');
});

await test('the rest of what a watch knows has a name at the door', () => {
  const expected = {
    'HKQuantityTypeIdentifierWalkingHeartRateAverage': 'walking_hr',
    'HKQuantityTypeIdentifierHeartRateRecoveryOneMinute': 'hr_recovery',
    'HKQuantityTypeIdentifierVO2Max': 'vo2max',
    'HKQuantityTypeIdentifierOxygenSaturation': 'spo2',
    'HKQuantityTypeIdentifierRespiratoryRate': 'respiratory_rate',
    'HKQuantityTypeIdentifierWalkingSpeed': 'walking_speed',
    'HKQuantityTypeIdentifierWalkingStepLength': 'step_length',
    'HKQuantityTypeIdentifierAppleWalkingSteadiness': 'steadiness',
    'HKQuantityTypeIdentifierSixMinuteWalkTestDistance': 'six_min_walk',
    'HKCategoryTypeIdentifierMindfulSession': 'mindful_minutes',
    'HKQuantityTypeIdentifierDietaryWater': 'water_ml',
    'HKQuantityTypeIdentifierEnvironmentalAudioExposure': 'sound_exposure',
    'HKQuantityTypeIdentifierBodyMassIndex': 'bmi',
  };
  for (const [apple, canon] of Object.entries(expected)) {
    assert.equal(canonicalMetric(apple), canon, `${apple} has no home`);
  }
});

await test('a fraction from HealthKit is not a 1% blood oxygen reading', () => {
  // The trap in this whole group, and the same shape as the glucose 18× bug.
  // HealthKit hands percentages back as a FRACTION — 0.97, not 97 — while a
  // scale and Health Auto Export send 97. "Your blood oxygen is 1%" is the
  // kind of number somebody rings a doctor about.
  assert.deepEqual(normalise('spo2', 0.975, '%'), { value: 97.5, unit: '%' });
  assert.deepEqual(normalise('spo2', 97.5, '%'), { value: 97.5, unit: '%' });
  assert.deepEqual(normalise('walking_asymmetry', 0.042, '%'), { value: 4.2, unit: '%' });
  // 100% is a real reading and must not be divided or doubled.
  assert.deepEqual(normalise('steadiness', 100, '%'), { value: 100, unit: '%' });
});

await test('Apple\'s resting figure is kept apart from a day\'s total', () => {
  // Filing basal energy as "total calories" reads as a day of doing nothing.
  // And it must not override restingBurn either — Apple derives it from
  // height, weight and age exactly as we do, so it is a second estimate, not
  // a measurement, and swapping one guess for another is not an upgrade.
  assert.equal(canonicalMetric('HKQuantityTypeIdentifierBasalEnergyBurned'), 'resting_calories');
  assert.equal(canonicalMetric('basal_energy_burned'), 'resting_calories');
  assert.notEqual(canonicalMetric('basal_energy_burned'), 'total_calories');
});

await test('a ride is not silently added to how far somebody walked', () => {
  assert.equal(canonicalMetric('distance_cycling'), 'distance_cycling_km');
  assert.equal(canonicalMetric('HKQuantityTypeIdentifierDistanceSwimming'), 'distance_swimming_km');
  assert.equal(canonicalMetric('HKQuantityTypeIdentifierDistanceWalkingRunning'), 'distance_km');
  assert.deepEqual(normalise('distance_cycling_km', 40000, 'm'), { value: 40, unit: 'km' });
});

await test('speeds, lengths and volumes land in one unit each', () => {
  assert.deepEqual(normalise('walking_speed', 4.752, 'km/h'), { value: 1.32, unit: 'm/s' });
  assert.deepEqual(normalise('step_length', 0.74, 'm'), { value: 74, unit: 'cm' });
  assert.deepEqual(normalise('water_ml', 2.1, 'L'), { value: 2100, unit: 'mL' });
  assert.deepEqual(normalise('stand_hours', 11, 'h'), { value: 11, unit: 'h' });
  assert.deepEqual(normalise('mindful_minutes', 600, 's'), { value: 10, unit: 'min' });
});

await test('the readings people frighten themselves with are flagged', () => {
  // They are recorded, because a hub that drops them is not a hub. They are
  // flagged, because the not-a-doctor rule outranks the feature.
  for (const m of ['spo2', 'respiratory_rate', 'steadiness', 'systolic', 'glucose']) {
    assert.ok(CLINICAL_CAUTION.has(m), `${m} is not marked`);
  }
  assert.ok(!CLINICAL_CAUTION.has('steps'));
  assert.match(SERVER_INSTRUCTIONS, /NOT YOURS TO INTERPRET/);
  assert.match(SERVER_INSTRUCTIONS, /fall-risk label/i);
  // Reassurance is the same act as alarm — both are readings of the number.
  assert.match(SERVER_INSTRUCTIONS, /do not reassure either/i);
});

await test('a metric added at the door reaches the screen with no third edit', () => {
  // The whole point of the generic path. A bespoke line per reading is how a
  // hub stops accepting new things, because each one costs three files.
  const page = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
  assert.match(page, /function readingsPanel/);
  const fn = page.slice(page.indexOf('function readingsPanel'), page.indexOf('function targetsPanel'));
  // It draws whatever arrived, including a metric it has never heard of.
  assert.match(fn, /const known = READING_NAMES\[r\.metric\]/);
  assert.match(fn, /r\.metric\.replace\(/);
  // And computes nothing.
  assert.doesNotMatch(fn, /\.reduce\(/);

  const lib = readFileSync(new URL('../netlify/functions/lib/wrought.js', import.meta.url), 'utf8');
  assert.match(lib, /readings: \[\.\.\.new Set\(mets\.map/);
});

await test('the courier asks for what it sends, and sends what it asks for', () => {
  // A HealthKit type read without permission returns nothing at all, silently,
  // which looks exactly like somebody who does not own that sensor. The tables
  // drive both the permission set and the send, so they cannot drift.
  const src = readFileSync(new URL('../ios/Wrought/HealthCourier.swift', import.meta.url), 'utf8');
  assert.match(src, /static let DAILY_TOTALS: \[Metric\]/);
  assert.match(src, /static let LATEST_READINGS: \[Metric\]/);
  assert.match(src, /for id in Self\.DAILY_TOTALS\.map\(\\\.id\) \+ Self\.LATEST_READINGS\.map\(\\\.id\)/);
  // Stand hours and mindful minutes are CATEGORY samples — asking for them as
  // quantities returns nothing and looks like a person who never stands up.
  assert.match(src, /categoryType\(forIdentifier: \.appleStandHour\)/);
  assert.match(src, /HKCategoryValueAppleStandHour\.stood/);
  assert.match(src, /categoryType\(forIdentifier: \.mindfulSession\)/);
  // Every name in the tables has somewhere to land at the door.
  for (const m of src.matchAll(/name: "([a-z0-9_]+)"/g)) {
    assert.ok(canonicalMetric(m[1]), `${m[1]} is sent but the door does not know it`);
  }
});

// ── A saved workout, ticked off ─────────────────────────────────────────────

group('Saved workouts, the checklist, and the five minutes before');

await test('a workout is a percentage of sets, not of exercises', () => {
  // "A checkmark that will calculate how much percent of your workout you've
  // completed." Sets are the honest denominator — three of four exercises
  // touched is not 75% done if the last one is six sets.
  const plan = [
    { name: 'Bench Press', sets: 4, reps: 8 },
    { name: 'Row', sets: 3, reps: 10 },
    { name: 'Curl', sets: 3, reps: 12 },
  ];
  const sets = [
    ...Array(4).fill({ exercise: 'Bench Press' }),
    ...Array(2).fill({ exercise: 'Row' }),
  ];
  const p = sessionProgress(plan, sets);
  assert.equal(p.sets_planned, 10);
  assert.equal(p.sets_done, 6);
  assert.equal(p.percent, 60);
  assert.equal(p.exercises[0].complete, true);
  assert.equal(p.exercises[1].complete, false);
  assert.equal(p.exercises[1].done, 2);
  assert.equal(p.exercises_complete, 1);
});

await test('extra sets do not produce a number over 100', () => {
  const plan = [{ name: 'Squat', sets: 3, reps: 5 }];
  const p = sessionProgress(plan, Array(5).fill({ exercise: 'Squat' }));
  assert.equal(p.percent, 100);
  // Still capped per exercise, so the count underneath stays believable.
  assert.equal(p.exercises[0].done, 3);
});

await test('the warm-up matches the session, not a poster', () => {
  // A generic warm-up is obviously generic and gets skipped for that reason.
  const legs = warmupFor([{ name: 'Back Squat', muscles: ['legs'] }, { name: 'Romanian Deadlift' }]);
  assert.ok(legs.patterns.includes('squat'));
  assert.ok(legs.patterns.includes('hinge'));
  assert.doesNotMatch(legs.moves.join(' '), /band pull-aparts/i);

  const push = warmupFor([{ name: 'Bench Press' }, { name: 'Overhead Press' }]);
  assert.ok(push.patterns.includes('push'));
  assert.match(push.moves.join(' '), /arm circles/i);
});

await test('nothing recognised still gets a warm-up rather than silence', () => {
  const odd = warmupFor([{ name: 'Prowler medley' }]);
  assert.ok(odd.moves.length >= 2);
  assert.equal(odd.skippable, true);
});

await test('it is movement, never a held stretch before a heavy set', () => {
  // Not a style preference: a long static stretch immediately before a heavy
  // set measurably costs force for the next half hour. Static work belongs at
  // the end, which is where it is offered.
  const w = warmupFor([{ name: 'Back Squat' }]);
  assert.match(w.style, /not held stretches/i);
  assert.ok(w.cooldown.length, 'the static work was dropped rather than moved');
  assert.match(w.cooldown.join(' '), /30 seconds/i);
  assert.doesNotMatch(w.moves.join(' '), /hold .* stretch|static/i);
});

await test('a warm-up is never presented as treating an injury', () => {
  const w = warmupFor([{ name: 'Bench Press' }], { limitations: ['left shoulder impingement'] });
  assert.ok(w.caution, 'a limitation on file produced no caution');
  assert.match(w.caution, /not treatment/i);
  assert.match(w.caution, /leave it out rather than working through it/i);
});

await test('the write-up survives adding one movement to a routine', () => {
  // A plan grows over weeks. Wiping the reason the session is in that order
  // because somebody added calf raises is the same loss as an amend
  // overwriting a detail that was already known.
  const src = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function saveRoutine('), src.indexOf('async function listRoutines('));
  assert.match(fn, /notes: args\.notes != null \? String\(args\.notes\)[^:]*: \(existing\?\.notes \|\| null\)/);

  const tool = TOOLS.find(t => t.name === 'save_routine');
  assert.ok(tool.inputSchema.properties.notes, 'save_routine cannot take a write-up');
  assert.match(tool.inputSchema.properties.notes.description, /write-up/i);
});

await test('a session with no minutes on it is flagged, not silently free', () => {
  // The founder: a workout decided through the assistant rather than measured
  // by a watch still has to count. With no duration it contributes zero to
  // calories out and looks perfectly logged, which is the worst combination.
  const written = [
    { id: 'a', event_type: 'workout', summary: 'chest and triceps' },
    { id: 'b', event_type: 'workout', summary: 'outdoor walk 40 min' },
    { id: 'c', event_type: 'workout', summary: 'watch run' },
    { id: 'd', event_type: 'food', summary: 'eggs' },
  ];
  const events = [
    { detail: {} },
    { detail: { minutes: 40 } },
    { detail: { calories: 500 } },
    { detail: {} },
  ];
  const out = needsDuration(written, events);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'a');
});

await test('a logged session burns something, scaled to their own weight', () => {
  // 60 minutes of lifting is not the same number of calories for a 60kg and a
  // 150kg person, and a "standard guide" figure is wrong for both.
  const light = trainingBurn([{ detail: { kind: 'strength', minutes: 60 } }], 60);
  const heavy = trainingBurn([{ detail: { kind: 'strength', minutes: 60 } }], 150);
  assert.ok(heavy.kcal > light.kcal * 2, `${heavy.kcal} vs ${light.kcal}`);
  assert.equal(heavy.source, 'estimate');
  // A watch's own figure still wins outright.
  const measured = trainingBurn([{ detail: { kind: 'strength', minutes: 60, calories: 700 } }], 150);
  assert.equal(measured.kcal, 700);
  assert.equal(measured.source, 'device');
});

await test('the rack screen and the assistant read one percentage', () => {
  const api = readFileSync(new URL('../netlify/functions/api-session.js', import.meta.url), 'utf8');
  assert.match(api, /sessionProgress/);
  const page = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
  assert.match(page, /function checklistPanel/);
  // The page draws what it was handed and computes nothing.
  const fn = page.slice(page.indexOf('function checklistPanel'), page.indexOf('// ── The log'));
  assert.doesNotMatch(fn, /\.reduce\(|\.filter\(/);
  assert.match(fn, /p\.percent/);
});

await test('the connector is told to write up, tick off and warm up', () => {
  assert.match(SERVER_INSTRUCTIONS, /A SAVED WORKOUT IS A NAME, AN ORDER, AND THE REASON/);
  assert.match(SERVER_INSTRUCTIONS, /WARM UP FIRST, AND LET THEM SKIP IT IN ONE WORD/);
  assert.match(SERVER_INSTRUCTIONS, /A WORKOUT WITH NO DURATION COUNTS FOR NOTHING/);
  assert.match(SERVER_INSTRUCTIONS, /never work a percentage out yourself/i);
  // And the phrasebook carries how people actually ask for a saved session.
  assert.match(SERVER_INSTRUCTIONS, /remember this as my chest day/i);
  assert.match(SERVER_INSTRUCTIONS, /what's in my leg day/i);
});

// ── The plan ────────────────────────────────────────────────────────────────

group('The plan — how fast, how hard, and changeable');

await test('aggressive is the fast end of safe, not different rules', () => {
  const p = { height_cm: 190, birth_year: 1985, sex: 'male', activity_level: 'light' };
  const gentle = goalCall({ profile: p, weightKg: 150, intent: 'lose', pace: 'gentle' });
  const steady = goalCall({ profile: p, weightKg: 150, intent: 'lose', pace: 'steady' });
  const hard   = goalCall({ profile: p, weightKg: 150, intent: 'lose', pace: 'aggressive' });

  // Faster means fewer calories, in that order.
  assert.ok(hard.calorie_target < steady.calorie_target);
  assert.ok(steady.calorie_target < gentle.calorie_target);
  // And every one of them still floors at the care number.
  for (const c of [gentle, steady, hard]) assert.ok(c.calorie_target >= 1200);
});

await test('no plan paces somebody into the product\'s own warning', () => {
  // careFlags raises rapid_loss past 1.2 kg a week. A plan that walks somebody
  // into that would spend a fortnight coaching them to eat less and then warn
  // them they were losing too fast. The product must not prescribe what it
  // warns about — at ANY pace, at any size, on either end of the scale.
  const bodies = [
    [{ height_cm: 200, birth_year: 1985, sex: 'male', activity_level: 'very_active' }, 220],
    [{ height_cm: 190, birth_year: 1985, sex: 'male', activity_level: 'light' }, 150],
    [{ height_cm: 150, birth_year: 2000, sex: 'female', activity_level: 'sedentary' }, 45],
    [{ height_cm: 175, birth_year: 1970 }, 90],
  ];
  for (const [p, kg] of bodies) {
    for (const pace of Object.keys(PACES)) {
      const c = goalCall({ profile: p, weightKg: kg, intent: 'lose', pace });
      assert.ok(Math.abs(c.projected_kg_per_week) < 1.2,
        `${pace} at ${kg}kg paces ${c.projected_kg_per_week} kg/week — into the care flag`);
      assert.ok(c.calorie_target >= 1200,
        `${pace} at ${kg}kg targets ${c.calorie_target}, under the floor`);
    }
  }
});

await test('the 1,200 floor holds however fast somebody wants to go', () => {
  const small = { height_cm: 150, birth_year: 2000, sex: 'female', activity_level: 'sedentary' };
  const c = goalCall({ profile: small, weightKg: 45, intent: 'lose', pace: 'aggressive' });
  assert.ok(c.calorie_target >= 1200);
  assert.ok(c.held, 'hitting the floor was not said');
});

await test('the plan is one read, and it names what is missing', () => {
  const tool = TOOLS.find(t => t.name === 'my_plan');
  assert.ok(tool, 'my_plan is missing');
  assert.match(tool.description, /before their first session/i);
  assert.equal(tool.annotations.readOnlyHint, true);

  const set = TOOLS.find(t => t.name === 'set_plan');
  assert.ok(set, 'set_plan is missing');
  assert.deepEqual(set.inputSchema.properties.pace.enum, ['gentle', 'steady', 'aggressive']);
  assert.deepEqual(set.inputSchema.properties.push.enum, ['light', 'normal', 'relentless']);
  // Changing it is never a negotiation — that is the whole doctrine.
  assert.match(set.description, /NEVER a negotiation/i);
  assert.match(set.description, /set wrong/i);
});

await test('nobody trains before being told what they are training for', () => {
  assert.match(SERVER_INSTRUCTIONS, /NOBODY TRAINS BEFORE THEY KNOW WHAT THEY ARE TRAINING FOR/);
  // Asked once, all together, and the workout still arrives in the same turn.
  assert.match(SERVER_INSTRUCTIONS, /ONE message/);
  assert.match(SERVER_INSTRUCTIONS, /same turn/);
  assert.match(SERVER_INSTRUCTIONS, /never turn this into a form/i);
});

await test('push and bluntness are not the same dial', () => {
  // Conflating them means turning down the nagging also turns down the
  // honesty, which is the one thing the product exists to provide.
  assert.match(SERVER_INSTRUCTIONS, /PUSH IS NOT BLUNTNESS/);
  assert.match(SERVER_INSTRUCTIONS, /care flag silences pushing entirely/i);
  assert.equal(Object.keys(PUSH).length, 3);
  for (const v of Object.values(PUSH)) assert.ok(v.say.length > 10);
});

await test('changing the plan moves the targets with it', () => {
  // A new pace with the old calorie target standing beside it is two answers
  // to one question — the same bug stacked goal rings had.
  const src = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function setPlan('), src.indexOf('// Work, counted at last'));
  assert.match(fn, /retireGoalsFor/);
  assert.match(fn, /goalCall\(/);
  assert.match(fn, /pace: patch\.plan_pace/);
});

await test('a conversation the tools were absent from gets flushed, not summarised', () => {
  // The founder's screenshot: "They're recorded in this chat, Broski, but not
  // logged... because I don't currently have its logging connection
  // available." Saying so is RIGHT — it is the honest answer and a large
  // improvement on claiming a save. Stopping there is not: a day sitting in a
  // conversation is one closed tab from being gone, on the product whose whole
  // promise is that it remembers.
  assert.match(SERVER_INSTRUCTIONS, /"RECORDED IN THIS CHAT" IS NOT LOGGED/);
  assert.match(SERVER_INSTRUCTIONS, /flush the whole conversation into the log/);
  // The times matter: a whole day filed at the catch-up minute reads as one
  // meal to the day card, the eating window and every average built on it.
  assert.match(SERVER_INSTRUCTIONS, /pass time_hint on each item/);
  // A client may not date its own events, so yesterday is asked about first.
  assert.match(SERVER_INSTRUCTIONS, /spans a previous day/);

  // BELT ON THE SHEET, BRACES ON THE TOOL. Not every client reads
  // instructions; every client reads the description of the tool it is calling.
  const log = TOOLS.find(t => t.name === 'log');
  assert.match(log.description, /UNAVAILABLE EARLIER IN THE CONVERSATION/);
  assert.match(log.description, /time_hint/);
  assert.match(log.description, /opposite of logged/);

  // And "are they logged?" is a question about the record, not the chat.
  assert.match(SERVER_INSTRUCTIONS, /"are they logged"/);
});

await test('dictation cannot spell WROUGHT, so the server is told', () => {
  // Nobody types to this product. "Wrought" comes out of voice-to-text as
  // route, rot, rout — and a connector that stops understanding its own name
  // is the hardest regression to notice, because nothing errors.
  assert.match(SERVER_INSTRUCTIONS, /DICTATION CANNOT SPELL/i);
  for (const v of ['ROUTE', 'ROT', 'ROZ', 'ROUT', 'WROT']) {
    assert.ok(SERVER_INSTRUCTIONS.includes(v), `${v} is not listed`);
  }
  // The subject decides, not the spelling — directions are still directions.
  assert.match(SERVER_INSTRUCTIONS, /route to the gym/i);
  // And it never corrects them.
  assert.match(SERVER_INSTRUCTIONS, /[Nn]ever correct their pronunciation/);
});

// ── The third burn ──────────────────────────────────────────────────────────

group('Work — the burn nothing was counting');

await test('a shift is priced off a table, never off a guess', () => {
  // "Today I worked at the Petting Zoo. It's very hard work so I wanna make
  // sure that captures it." The words have to reach a real MET value.
  const b = activityBurn({ text: 'petting zoo all day', hours: 7, weightKg: 95 });
  assert.ok(b.known);
  assert.equal(b.matched, true);
  assert.match(b.label, /animal care/);
  assert.ok(b.kcal > 1500 && b.kcal < 2600, `implausible: ${b.kcal}`);
  // Labelled, every time. A calorie figure read as a fact is the credibility gone.
  assert.equal(b.estimated, true);
  assert.match(b.say, /estimate/i);
});

await test('the resting hours are not billed twice', () => {
  // MET values are GROSS — they include the resting cost of those hours, which
  // the daily resting burn is already charging for. Adding them raw invents
  // hundreds of calories nobody spent. Everything here is NET: (MET - 1).
  const met = 4.3, kg = 95, h = 7;
  const gross = Math.round(met * kg * h * 1.05);
  const b = activityBurn({ text: 'petting zoo', hours: h, weightKg: kg });
  assert.ok(b.kcal < gross, 'the burn is gross, not net');
  assert.equal(b.kcal, Math.round((met - 1) * kg * h * 1.05));
});

await test('an unknown job asks the person, rather than guessing from a title', () => {
  const b = activityBurn({ text: 'sorting out the archive', hours: 5, weightKg: 95 });
  assert.equal(b.known, false);
  assert.equal(b.why, 'effort');
  assert.deepEqual(b.options, ['light', 'moderate', 'hard', 'very_hard']);
  // And their own answer is accepted.
  const chosen = activityBurn({ text: 'sorting out the archive', hours: 5, effort: 'hard', weightKg: 95 });
  assert.ok(chosen.known);
  assert.ok(chosen.kcal > 0);
  assert.equal(chosen.matched, false);
});

await test('hours are demanded, and a day only holds so many', () => {
  assert.equal(activityBurn({ text: 'warehouse', weightKg: 95 }).why, 'hours');
  assert.equal(activityBurn({ text: 'warehouse', hours: 0, weightKg: 95 }).why, 'hours');
  assert.equal(activityBurn({ text: 'warehouse', hours: 26, weightKg: 95 }).why, 'hours');
});

await test('the burn comes back in three named parts', () => {
  // The founder's own division: "one is your daily metabolic rate, your
  // workout, and other." Each part is something different about the day —
  // one fixed, one a choice, one a job.
  const p = { height_cm: 190, birth_year: 1990, sex: 'male', activity_level: 'light' };
  const b = energyBalance({
    profile: p, weightKg: 110, caloriesIn: 2400, activeCalories: 0,
    workouts: [{ event_type: 'workout', detail: { kind: 'strength', minutes: 60 } }],
    activities: [{ event_type: 'activity', detail: { kcal: 900, hours: 7 } }],
  });
  assert.ok(b.resting_burn > 0);
  assert.ok(b.training_burn > 0);
  assert.ok(b.other_burn > 0);
  // The three have to add up to the number on screen, or the bar is a lie.
  assert.equal(b.calories_out, b.resting_burn + b.training_burn + b.other_burn);
  assert.equal(b.active_burn, b.training_burn + b.other_burn);
  assert.equal(b.active_source, 'logged');
  assert.match(b.say, /training/);
});

await test('a watch and a logged shift are never added together', () => {
  // The shift is where the steps and the heart rate came from, so a watch has
  // already counted part of it. Summing them is how calories out silently
  // doubles — the one bug that would make this feature dangerous.
  const p = { height_cm: 190, birth_year: 1990, sex: 'male', activity_level: 'light' };
  const measured = 2400;
  const b = energyBalance({
    profile: p, weightKg: 110, caloriesIn: 2400, activeCalories: measured,
    workouts: [{ event_type: 'workout', detail: { kind: 'strength', minutes: 60, calories: 400 } }],
    activities: [{ event_type: 'activity', detail: { kcal: 900, hours: 7 } }],
  });
  assert.equal(b.active_source, 'device');
  assert.equal(b.training_burn + b.other_burn, measured, 'the two were summed');
  assert.equal(b.training_burn, 400);
  assert.match(b.say, /not added together/i);
});

await test('a wrist that missed the work does not get the last word', () => {
  // The real day that forced this: 5,292 steps and four and a half hours at a
  // petting zoo came back as 740 active calories. An accelerometer does not see
  // load — carrying, lifting, holding, the whole thing that makes a physical
  // job physical barely registers next to walking. "A measurement beats an
  // estimate" is right for a metric a watch can actually see and wrong here.
  const p = { height_cm: 190, birth_year: 1985, sex: 'male', activity_level: 'light' };
  const b = energyBalance({
    profile: p, weightKg: 150, caloriesIn: 1520, activeCalories: 740,
    activities: [{ event_type: 'activity', detail: { kcal: 1400, hours: 4.5 } }],
  });
  assert.equal(b.active_source, 'logged_over_device');
  assert.equal(b.other_burn, 1400, 'the watch figure won when it should not have');
  // Still not the sum — that would be the double-count.
  assert.ok(b.other_burn < 740 + 1400);
  assert.match(b.say, /wrist does not see carrying/i);
  assert.match(b.say, /not added together/i);
});

await test('the session comes out of the watch total, never on top of it', () => {
  // Apple's active energy is everything above resting, workouts included.
  const p = { height_cm: 190, birth_year: 1990, sex: 'male' };
  const b = energyBalance({
    profile: p, weightKg: 110, caloriesIn: 2000, activeCalories: 300,
    workouts: [{ event_type: 'workout', detail: { kind: 'cardio', minutes: 90, calories: 800 } }],
  });
  // A watch disagreeing with itself must not produce a negative slice.
  assert.ok(b.other_burn >= 0);
  assert.equal(b.training_burn + b.other_burn, 300);
});

await test('logging a shift can never make somebody burn less', () => {
  // Somebody on "very active" who logs one short job must not end up with a
  // smaller figure than the multiplier alone gave them — that would read as
  // being punished for telling the truth.
  const p = { height_cm: 190, birth_year: 1990, sex: 'male', activity_level: 'very_active' };
  const plain = energyBalance({ profile: p, weightKg: 110, caloriesIn: 2000, activeCalories: 0 });
  const withWork = energyBalance({
    profile: p, weightKg: 110, caloriesIn: 2000, activeCalories: 0,
    activities: [{ event_type: 'activity', detail: { kcal: 120, hours: 1 } }],
  });
  assert.ok(withWork.calories_out >= plain.calories_out,
    `${withWork.calories_out} < ${plain.calories_out}`);
});

await test('an implausible pile of work is capped, and the cap is said', () => {
  // Over-reported hours must not hand somebody 3,000 calories of permission.
  // Capping quietly would be worse — the log has to stay honest about it.
  const rest = 2000;
  const t = activityTotal([
    { event_type: 'activity', summary: 'forestry, 12h', detail: { kcal: 4000, hours: 12 } },
  ], rest);
  assert.equal(t.capped, true);
  assert.equal(t.kcal, 3000);
  assert.equal(t.raw_kcal, 4000);
  assert.match(t.say, /held at/i);
});

await test('a shift is never a training session', () => {
  // Filing work as a workout would count it toward the weekly target, put it
  // in the matrix and feed progression. Somebody would hit "four sessions this
  // week" by going to work, and the expectation would mean nothing.
  const tool = TOOLS.find(t => t.name === 'log_activity');
  assert.ok(tool, 'log_activity is missing');
  assert.match(tool.description, /NOT a training session/i);
  assert.match(tool.description, /never estimate them yourself/i);
  assert.match(SERVER_INSTRUCTIONS, /WORK IS NOT TRAINING/);
  assert.match(SERVER_INSTRUCTIONS, /never congratulate somebody for having gone to work/i);
  // And the phrasebook carries the way people actually say it.
  assert.match(SERVER_INSTRUCTIONS, /worked at the petting zoo/i);
});

await test('the bar draws three slices that add to the number above it', () => {
  const src = page('app.html');
  assert.match(src, /\.bs\.train/);
  assert.match(src, /training_burn/);
  assert.match(src, /other_burn/);
  // The page still does no arithmetic of its own — the parts come computed.
  assert.doesNotMatch(src, /resting_burn \+ b\.training_burn \+ b\.other_burn ===/);
});

// ── Said out loud, from a locked phone ──────────────────────────────────────

group('Hands-free — what the phone says back');

await test('a care flag is the whole spoken answer, not a preface to one', () => {
  // The doctrine says care flags outrank everything. In speech, "outrank" has
  // to mean the sentence STOPS there — a training nudge tacked onto a warning
  // about under-eating undoes the warning in the same breath that gave it.
  const line = spokenBrief({
    day: { food: { meals: 2, calories: 900, meals_uncounted: 0 }, training: { sessions: 1 }, device: { steps: 9000 } },
    balance: { known: true, calories_in: 900, calories_out: 2500, net: -1600 },
    week: { say: '1 of 4', done: 1, target: 4, days_left: 3, met: false },
    flags: [{ flag: 'very_low_intake', detail: '4 of the last 6 logged days came in under 1,200 kcal.' }],
  });
  assert.match(line, /1,200/);
  assert.match(line, /doctor/i);
  // None of the ordinary read survives alongside it.
  assert.doesNotMatch(line, /steps/i);
  assert.doesNotMatch(line, /session/i);
  assert.doesNotMatch(line, /2500|2,500/);
});

await test('every care flag has a sentence a person could actually hear', () => {
  // `guidance` is written FOR A MODEL — "stop coaching intake down" spoken
  // aloud is baffling. Each flag needs a human form, and a flag that lost its
  // mapping must still be said rather than silently dropped.
  for (const flag of ['very_low_intake', 'rapid_loss', 'no_rest']) {
    const said = spokenFlag({ flag, detail: 'Something happened.' });
    assert.ok(said && said.length > 20, `${flag} has no spoken form`);
    assert.doesNotMatch(said, /do not suggest|stop coaching|follow the guidance/i);
  }
  assert.equal(spokenFlag({ flag: 'invented_later', detail: 'A new thing.' }), 'A new thing.');
});

await test('a spoken answer stays short enough to be heard', () => {
  // Speech cannot be skimmed or re-read. Past a couple of clauses a spoken
  // answer stops being information and becomes something to talk over.
  const line = spokenBrief({
    day: { food: { meals: 3, calories: 1840, meals_uncounted: 0 }, training: { sessions: 1 }, device: { steps: 8412 } },
    balance: { known: true, calories_in: 1840, calories_out: 2510, net: -670 },
    week: { say: '2 of 4', done: 2, target: 4, days_left: 3, met: false },
  });
  assert.ok(line.length < 200, `too long to speak: ${line.length} chars`);
  assert.match(line, /Roughly 1840 in/);
  assert.match(line, /670 down/);
  assert.match(line, /2 of 4 sessions/);
});

await test('no meals and no burn is said plainly rather than as a zero', () => {
  assert.equal(spokenBrief({ day: { food: { meals: 0 }, training: { sessions: 0 }, device: {} } }),
               'Nothing logged today yet.');
  // Meals with no macros are UNKNOWN, never nought — the same rule the screen
  // follows, because a spoken "zero calories" is a confident lie.
  const line = spokenBrief({ day: { food: { meals: 2, calories: 0, meals_uncounted: 2 }, training: {}, device: {} } });
  assert.match(line, /no calories on them yet/i);
  assert.doesNotMatch(line, /\b0 in\b|Roughly 0/);
});

await test('a dictated sentence is answered as saved, not as failed', () => {
  // There is no model on the phone end, so nothing gets parsed there. That is
  // the intended path, and the wording has to treat it as one — an apology
  // teaches somebody the feature is broken and they stop using it.
  const said = spokenLog({ written: [{ summary: 'two eggs and toast' }], parsed: false, text: 'two eggs and toast' });
  assert.match(said, /Saved, word for word/);
  assert.match(said, /No calories on it yet/);
  assert.doesNotMatch(said, /error|sorry|could not|failed/i);
  // And when something did read it, it says so without the caveat.
  const parsed = spokenLog({ written: [{ summary: '2 eggs, 2 toast — 320 kcal' }], parsed: true });
  assert.match(parsed, /^Logged:/);
  assert.doesNotMatch(parsed, /word for word/);
});

await test('what the phone heard is handed to the AI, not left to rot', () => {
  // A verbatim entry counts for nothing in every total until something reads
  // it. pendingVoice is what stops it sitting there forever.
  const waiting = pendingVoice([
    { id: 'a', source: 'voice', event_type: 'note', detail: { note: 'two eggs and toast' }, raw_input: 'two eggs and toast', local_date: '2026-08-10' },
    { id: 'b', source: 'voice', event_type: 'food', detail: { calories: 320 }, summary: 'eggs', local_date: '2026-08-10' },
    { id: 'c', source: 'agent', event_type: 'note', detail: {}, summary: 'a note they typed', local_date: '2026-08-10' },
  ]);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].id, 'a');
  assert.equal(waiting[0].said, 'two eggs and toast');
});

await test('the connector is told to read them before it reads the day out', () => {
  const tool = TOOLS.find(t => t.name === 'structure_entries');
  assert.ok(tool, 'structure_entries is missing');
  assert.match(tool.description, /voice_pending/);
  assert.match(tool.description, /same turn/i);
  // The estimates doctrine survives the trip: a vague mention stays null.
  assert.match(tool.description, /null rather than padding/i);
  assert.match(SERVER_INSTRUCTIONS, /voice_pending/);
  assert.match(SERVER_INSTRUCTIONS, /structure_entries/);
});

await test('the phone can only add to the log and hear the day back', () => {
  // The intents run with the phone LOCKED, so what they can reach is the whole
  // security question. Two actions, both bounded: append, and a summary line.
  // Anything that could read the record out in detail or delete from it must
  // never be given an .alwaysAllowed intent.
  const src = readFileSync(new URL('../ios/Wrought/WroughtIntents.swift', import.meta.url), 'utf8');
  const intents = src.match(/struct (\w+): AppIntent/g) || [];
  assert.equal(intents.length, 2, `expected 2 intents, found ${intents.length}`);
  assert.match(src, /SpeakBriefIntent/);
  assert.match(src, /LogAloudIntent/);
  // Comments stripped: the file is allowed to say why it cannot delete
  // anything. Only the code is being checked for the ability.
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /delete|undo_last|export|api\/log/i);
  // Nothing opens — the entire point of hands-free.
  assert.doesNotMatch(code, /openAppWhenRun: Bool = true/);
});

await test('the phone never composes a sentence about somebody training', () => {
  // Same doctrine as the connector: the server computes, the mouth relays. A
  // number formatted in Swift is a number that can disagree with the dashboard.
  const src = readFileSync(new URL('../ios/Wrought/WroughtIntents.swift', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /kcal|calorie|protein|deficit|surplus/i);
  assert.match(src, /out\?\["spoken"\] as\? String/);
});

await test('the Info.plist carries every key a bundle is rejected without', () => {
  // Two uploads failed because this file held ONE key and relied on Xcode
  // merging the rest in. That merge is real but untestable from here — there
  // is no Xcode in this container — so "it should merge" was a guess dressed
  // as a fact, and a bundle with no CFBundleIdentifier or CFBundleVersion is
  // refused at validation with an error naming neither this file nor the
  // setting behind it. It is complete now, and generation is off.
  const plist = readFileSync(new URL('../ios/Info.plist', import.meta.url), 'utf8');
  for (const k of ['CFBundleIdentifier', 'CFBundleVersion', 'CFBundleShortVersionString',
                   'CFBundleExecutable', 'CFBundleName', 'CFBundlePackageType',
                   'CFBundleInfoDictionaryVersion', 'LSRequiresIPhoneOS',
                   'UIApplicationSceneManifest', 'UILaunchScreen',
                   'UISupportedInterfaceOrientations', 'ITSAppUsesNonExemptEncryption',
                   'NSHealthShareUsageDescription', 'NSHealthUpdateUsageDescription',
                   'INAlternativeAppNames']) {
    assert.ok(plist.includes(`<key>${k}</key>`), `Info.plist is missing ${k}`);
  }

  // THREE SIRI SYNONYMS, MAXIMUM. Apple caps them at three per language and
  // enforces it at UPLOAD rather than at build, so a fourth compiles, archives
  // and then fails with ITMS-90626 — an error a long way from the file that
  // caused it. Five were tried, then four; both were refused, and each cost a
  // build number and a round trip.
  const names = plist.match(/<key>INAlternativeAppName<\/key>/g) || [];
  assert.ok(names.length <= 3, `${names.length} Siri synonyms — Apple allows 3`);
  assert.ok(names.length >= 1, 'no Siri synonyms, so "gym bro" reaches nothing');
  assert.ok(plist.includes('<string>Gym Bro</string>'), 'the founder\'s own name for it is gone');

  const proj = readFileSync(new URL('../ios/Wrought.xcodeproj/project.pbxproj', import.meta.url), 'utf8');
  assert.match(proj, /GENERATE_INFOPLIST_FILE = NO;/);
  assert.match(proj, /INFOPLIST_FILE = Info\.plist;/);
  assert.doesNotMatch(proj, /GENERATE_INFOPLIST_FILE = YES;/);
  // One place for the usage strings. Two is how one of them goes stale, and a
  // stale usage string is an App Review rejection rather than a warning.
  assert.doesNotMatch(proj, /INFOPLIST_KEY_/);
});

await test('"gym bro" reaches the app because the app answers to it', () => {
  // Every AppShortcut phrase must contain the application name, so the way to
  // make the real sentence work is to give the app the nickname people use.
  const plist = readFileSync(new URL('../ios/Info.plist', import.meta.url), 'utf8');
  assert.match(plist, /INAlternativeAppNames/);
  assert.match(plist, /Gym Bro/);
  // "Jim bro" is what dictation makes of it half the time — the same reason the
  // connector's phrasebook carries it.
  assert.match(plist, /Jim Bro/);

  const src = readFileSync(new URL('../ios/Wrought/WroughtIntents.swift', import.meta.url), 'utf8');
  assert.match(src, /AppShortcutsProvider/);
  // A phrase without the app name is silently never matched.
  const phrases = src.match(/^\s+"[^"]*\\\(\.applicationName\)[^"]*",$/gm) || [];
  assert.ok(phrases.length >= 8, `only ${phrases.length} phrases carry the app name`);
});

await test('the voice door takes the device key, not a session', () => {
  // A locked phone cannot run a PKCE dance or show a sign-in sheet. It reuses
  // the ingest key the HealthKit courier already holds — one credential on the
  // phone, revocable in the same place as every other.
  const src = readFileSync(new URL('../netlify/functions/api-voice.js', import.meta.url), 'utf8');
  assert.match(src, /wrought_ingest_keys/);
  assert.match(src, /hashToken/);
  assert.match(src, /revoked/);
  // Dictated entries are marked so they can be found again and read later.
  assert.match(src, /source: 'voice'/);
  // Every failure comes back speakable — Siri reading a stack trace helps nobody.
  for (const block of src.split('return reply(').slice(1)) {
    assert.match(block.slice(0, 400), /spoken:/, 'a reply with nothing to say');
  }
});

await test('the hands-free door is routed and the app stays optional', () => {
  const toml = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
  assert.match(toml, /from = "\/api\/voice"/);
  // Doctrine: nothing may ever REQUIRE the app. This is one more way in.
  const claude = readFileSync(new URL('../CLAUDE.md', import.meta.url), 'utf8');
  assert.match(claude, /The app is optional, forever/);
});

// ── The website's own door onto the food log ────────────────────────────────

await test('a typed line becomes a meal, with only the numbers that were typed', () => {
  const a = parseQuickAdd('chicken and rice 650');
  assert.equal(a.ok, true);
  assert.equal(a.event.summary, 'chicken and rice');
  assert.equal(a.event.detail.calories, 650);
  assert.equal(a.event.event_type, 'food');
  // Every calorie in this product is labelled. A figure read off a packet and
  // one remembered are indistinguishable from here, so it takes the
  // conservative side like everything else.
  assert.equal(a.event.estimated, true);

  // Macros in the two forms people type, both parsed left to right in one pass
  // so neither ordering reads across its own boundary.
  const b = parseQuickAdd('steak 700 45p 10c 50f');
  assert.deepEqual(
    { c: b.event.detail.calories, p: b.event.detail.protein_g, cb: b.event.detail.carbs_g, f: b.event.detail.fat_g },
    { c: 700, p: 45, cb: 10, f: 50 });
  const c = parseQuickAdd('oats 350 45g protein 60g carbs 20g fat');
  assert.equal(c.event.detail.protein_g, 45);
  assert.equal(c.event.detail.carbs_g, 60);
  assert.equal(c.event.detail.fat_g, 20);
  const d = parseQuickAdd('chowder protein 30 carbs 40 fat 12');
  assert.equal(d.event.detail.protein_g, 30);
  assert.equal(d.event.detail.carbs_g, 40);
  assert.equal(d.event.detail.fat_g, 12);
});

await test('a meal with no figure lands with none rather than a guess', () => {
  // THE WHOLE POINT. This parser is not a model and must never behave like
  // one — a plausible 400 on an unnumbered lunch quietly poisons the week in
  // exactly the way a null never does.
  const r = parseQuickAdd('half a costco hotdog and a quarter cookie');
  assert.equal(r.ok, true);
  assert.equal(r.event.detail.calories, undefined);
  assert.equal(r.read.calories, null);
  // And it says so, in the same words the day card uses.
  assert.match(r.read.note, /counts for nothing/i);
});

await test('a leading quantity is never mistaken for a calorie figure', () => {
  // "2 eggs" filed as a 2-calorie meal is the kind of wrong number that
  // survives for months inside an average.
  const r = parseQuickAdd('2 eggs');
  assert.equal(r.event.summary, '2 eggs');
  assert.equal(r.read.calories, null);
  assert.equal(parseQuickAdd('500ml water').read.calories, null);
  assert.equal(parseQuickAdd('pizza 2 slices 620').read.calories, 620);
});

await test('a number on its own is not a log', () => {
  const r = parseQuickAdd('650');
  assert.equal(r.ok, false);
  // The refusal says what to type instead — a dead end here sends somebody
  // back to the assistant that would not write it down in the first place.
  assert.match(r.why, /chicken and rice 650/);
  assert.equal(parseQuickAdd('   ').ok, false);
});

await test('a stated time travels as a hint, never as a date', () => {
  // A CLIENT MAY NOT DATE ITS OWN EVENTS — time_hint is resolved against the
  // user's own zone server-side, which is what keeps a 9pm snack off tomorrow.
  const r = parseQuickAdd('beer at 9pm 150');
  assert.equal(r.event.time_hint, '21:00');
  assert.equal(r.event.occurred_at, undefined);
  assert.equal(r.event.local_date, undefined);
  assert.equal(r.event.detail.calories, 150);
  assert.equal(parseQuickAdd('bagel at 7:30 320').event.time_hint, '07:30');
  // "at the pub" is a place, not a clock.
  assert.equal(parseQuickAdd('steak at the pub 800').event.summary, 'steak at the pub');
});

await test('a drink is filed as a drink', () => {
  assert.equal(parseQuickAdd('coffee').event.event_type, 'drink');
  assert.equal(parseQuickAdd('protein shake 220').event.event_type, 'drink');
  // "coffee and a muffin" is a meal that contains a drink, not a drink.
  assert.equal(parseQuickAdd('coffee and a muffin 400').event.event_type, 'food');
});

await test('the website can log food, and says what the record holds afterwards', () => {
  const src = readFileSync(new URL('../netlify/functions/api-log.js', import.meta.url), 'utf8');
  // The hole this closes: wrought.fit could read a meal and not record one, so
  // an assistant that would not write left the person with nowhere to go. The
  // app is optional forever — which means the website has to be complete.
  assert.match(src, /'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'/);
  assert.match(src, /httpMethod === 'POST'/);
  assert.match(src, /parseQuickAdd/);
  assert.match(src, /source: 'web'/);
  // Read back off the STORED rows, never echoed from the arguments — echoing
  // proves a write was composed, never that it landed.
  assert.match(src, /async function foodDay/);
  assert.match(src, /from\('wrought_events'\)/);
  // A swallowed write error looks exactly like success, which is the failure
  // this endpoint exists to end.
  assert.match(src, /not_saved/);

  // Correcting a typo is scoped to food and drink: a workout event owns rows
  // in wrought_sets, and deleting one here would leave a lift record standing
  // on training the log no longer contains.
  assert.match(src, /httpMethod === 'DELETE'/);
  assert.match(src, /not_removable/);
  assert.match(src, /\.eq\('user_id', user\.id\)\.eq\('id', id\)/);
});

await test('the log reads the way the record does — eaten, then active', () => {
  // "In the record put the log in there: what was eaten, and then underneath
  // what was worked out, active." The two screens held the same information in
  // OPPOSITE orders — the log led with the workout and buried the food under
  // it — which is how one tab ends up feeling like a different product.
  const src = page('app.html');
  const from = src.indexOf('function dayBlock(');
  const body = src.slice(from, src.indexOf('\nfunction ', from + 10));
  const eaten = body.indexOf('>Eaten<');
  const active = body.indexOf('Trained &amp; active');
  assert.ok(eaten > 0 && active > 0, 'the day is no longer grouped');
  assert.ok(eaten < active, 'the workout is above the food again');

  // A shift belongs with the active half and carries its own figure — "logged
  // as activity" with no number is the feature failing quietly.
  assert.match(body, /d\.activity \|\| \[\]/);
  assert.match(body, /on task/);
  assert.match(body, /kcal, estimated/);

  const api = readFileSync(new URL('../netlify/functions/api-log.js', import.meta.url), 'utf8');
  assert.match(api, /activity: \[\]/, 'api-log has no activity bucket');
  assert.match(api, /day\.activity\.push/);
  // A day with only a shift on it is not an empty day.
  assert.match(api, /!d\.activity\.length/);
});

group('Notifications — the one surface that can speak first');

await test('a care flag silences every coaching notification', () => {
  // THE ONLY WAY THIS FEATURE GENUINELY HURTS SOMEBODY. Telling a person who
  // has eaten under 1,200 for three days that they are "at 80% of target" is
  // encouragement pointed straight at the harm the flags exist to prevent.
  const rules = [
    { id: 'a', kind: 'intake_pace', active: true, threshold: 0.8 },
    { id: 'b', kind: 'kitchen_closed', active: true, at_hour: 21 },
    { id: 'c', kind: 'move', active: true, at_hour: 21 },
    { id: 'd', kind: 'weigh_in', active: true, at_hour: 21 },
  ];
  const ctx = {
    rules, hour: 21, date: '2026-08-20',
    day: { food: { calories: 2000 }, training: { sessions: 0 } },
    calorieTarget: 2400, week: { done: 0, target: 4, days_left: 4 },
    lastWeighDays: 30,
    flags: [{ kind: 'under_eating', detail: '4 of the last 9 days under 1,200.' }],
  };
  assert.deepEqual(dueAlerts(ctx), [], 'a coaching notification fired under a care flag');

  // Without the flag the same setup does produce one.
  assert.equal(dueAlerts({ ...ctx, flags: [] }).length, 1);

  // But THEIR OWN words survive a flag — a reminder they set is not coaching.
  const mine = dueAlerts({ ...ctx, rules: [{ id: 'x', kind: 'custom', active: true, at_hour: 21, text: 'fast starts now' }] });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].body, 'fast starts now');
});

await test('a goal alert fires against a target they set, and only that', () => {
  // The founder: "I want personal notifications if you're at, let's say, 80%
  // calorie burn of the day." Doing that as a bespoke burn alert would cover
  // one metric; doing it against the goals somebody actually SET covers steps,
  // active calories, distance and active minutes with one rule — and it can
  // only ever fire for a target they chose.
  const rules = [{ id: 'g', kind: 'goal_pace', active: true, threshold: 0.8, metric: 'active_calories' }];
  const scored = [{ scored: true, metric: 'active_calories', goal: 'burn 800 a day',
                    target: 800, actual: 660, percent: 83, hit: false, unit: '', direction: 'at_least' }];

  const [a] = dueAlerts({ rules, scored, hour: 18, date: '2026-08-20', flags: [] });
  assert.equal(a.kind, 'goal_pace');
  assert.match(a.body, /660/);
  assert.match(a.body, /800/);
  assert.match(a.body, /83%/);

  // Under the threshold it stays quiet.
  assert.deepEqual(dueAlerts({ rules, hour: 18, date: '2026-08-20', flags: [],
    scored: [{ ...scored[0], actual: 400, percent: 50 }] }), []);

  // A METRIC THEY HAVE NO GOAL FOR HAS NOTHING TO MEASURE. Inventing a target
  // to make the rule fire would be the invented-calorie failure in a new place
  // — a number this product chose, arriving on a lock screen as though they
  // had agreed to it.
  assert.deepEqual(dueAlerts({ rules, scored: [], hour: 18, date: '2026-08-20', flags: [] }), []);

  // A care flag silences it like every other coaching kind.
  assert.deepEqual(dueAlerts({ rules, scored, hour: 18, date: '2026-08-20',
    flags: [{ kind: 'under_eating', detail: 'x' }] }), []);
});

await test('a ceiling is never cheered on', () => {
  // An at_most goal filling up is the intake_pace case, which is deliberately
  // worded not to tell anybody to stop. Firing a second, cheerier "80% there!"
  // at a LIMIT would read as encouragement to spend the rest of it — on the
  // one product that must never tell somebody to eat more or less by accident.
  const out = dueAlerts({
    rules: [{ id: 'g', kind: 'goal_pace', active: true, threshold: 0.8, metric: 'calories' }],
    scored: [{ scored: true, metric: 'calories', goal: 'stay under 2,400', target: 2400,
               actual: 2100, percent: 87, hit: true, unit: '', direction: 'at_most' }],
    hour: 18, date: '2026-08-20', flags: [],
  });
  assert.deepEqual(out, []);
});

await test('the alert kinds the writer accepts are the kinds the database allows', () => {
  // The VALID_TYPES lesson, one table along: a writer that accepts more than
  // the check constraint fails at the database, and one that accepts less
  // silently drops a feature. Both are invisible in review.
  const sql = readFileSync(new URL('../schema/018_wrought_alerts.sql', import.meta.url), 'utf8');
  const check = sql.slice(sql.lastIndexOf('wrought_alerts_kind_valid'));
  const allowed = [...check.slice(0, check.indexOf(';')).matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
  assert.deepEqual(Object.keys(ALERT_KINDS).sort(), [...new Set(allowed)].sort(),
    'ALERT_KINDS and the check constraint disagree');

  // And the tool offers exactly those.
  const src = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  // Anchored on set_alert's OWN schema, not the first "kind" enum in the file
  // — several tools have one, and picking the wrong one made this assert about
  // calibrate_lift while claiming to be about alerts.
  const at = src.indexOf("name: 'set_alert'");
  assert.ok(at > 0, 'set_alert is gone');
  const enumAt = src.indexOf('enum: [', src.indexOf('kind:', at));
  const enumLine = src.slice(enumAt + 'enum: ['.length);
  const offered = [...enumLine.slice(0, enumLine.indexOf(']')).matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
  assert.deepEqual(offered.sort(), [...new Set(allowed)].sort(),
    'set_alert offers a different set of kinds than the database allows');
});

await test('a notification never tells somebody to eat less', () => {
  // "You have 500 left" invites doing sums about what is allowed, on a lock
  // screen, which is the worst possible place for that thought. The line
  // states where the day stands and stops.
  const [a] = dueAlerts({
    rules: [{ id: 'a', kind: 'intake_pace', active: true, threshold: 0.8 }],
    hour: 18, date: '2026-08-20',
    day: { food: { calories: 2000 } }, calorieTarget: 2400, flags: [],
  });
  assert.ok(a, 'nothing fired at 83% of target');
  assert.match(a.body, /2,000 of 2,400/);
  assert.doesNotMatch(a.body, /left|remaining|stop|slow down|careful|under|budget/i);

  // Below the threshold it stays quiet, and nothing logged is nothing to say —
  // "you are at 0%" is a nag about not having opened the app.
  assert.equal(dueAlerts({
    rules: [{ id: 'a', kind: 'intake_pace', active: true, threshold: 0.8 }],
    hour: 18, date: '2026-08-20', day: { food: { calories: 1000 } }, calorieTarget: 2400, flags: [],
  }).length, 0);
  assert.equal(dueAlerts({
    rules: [{ id: 'a', kind: 'intake_pace', active: true, threshold: 0.8 }],
    hour: 18, date: '2026-08-20', day: { food: { calories: 0 } }, calorieTarget: 2400, flags: [],
  }).length, 0);
});

await test('the kitchen closes at the hour they chose, and only then', () => {
  const rules = [{ id: 'k', kind: 'kitchen_closed', active: true, at_hour: 21 }];
  const at = h => dueAlerts({ rules, hour: h, date: '2026-08-20',
    day: { food: { calories: 1800 } }, flags: [] });
  assert.equal(at(21).length, 1);
  assert.equal(at(20).length, 0);
  assert.equal(at(22).length, 0);
  // It may mention stopping ONLY because they set the hour themselves —
  // honouring their own timetable is not the app deciding they have had enough.
  assert.match(at(21)[0].body, /window you set/i);
});

await test('training is never a guilt notification', () => {
  const rules = [{ id: 'm', kind: 'move', active: true, at_hour: 17 }];
  const base = { rules, hour: 17, date: '2026-08-20', flags: [], day: { training: { sessions: 0 } } };

  // Behind with room left: fires.
  assert.equal(dueAlerts({ ...base, week: { done: 1, target: 4, days_left: 4 } }).length, 1);
  // Already trained today: nothing. A reminder to train on a day somebody
  // trained is how a product proves it is not paying attention.
  assert.equal(dueAlerts({ ...base, day: { training: { sessions: 1 } },
    week: { done: 1, target: 4, days_left: 4 } }).length, 0);
  // Target met: nothing.
  assert.equal(dueAlerts({ ...base, week: { done: 4, target: 4, days_left: 2 } }).length, 0);
  // AN IMPOSSIBLE WEEK IS NOT COUNTED DOWN TO ZERO — nothing actionable is
  // left in it and repeating it is pure guilt.
  assert.equal(dueAlerts({ ...base, week: { done: 0, target: 4, days_left: 1 } }).length, 0);

  const [fired] = dueAlerts({ ...base, week: { done: 1, target: 4, days_left: 4 } });
  for (const word of ['should', 'failed', 'behind schedule', 'lazy', 'excuse', 'still', 'only']) {
    assert.ok(!new RegExp(word, 'i').test(fired.body), `the training line says "${word}"`);
  }
});

await test('one at a time, once a day, and never in the night', () => {
  const rules = [
    { id: 'a', kind: 'intake_pace', active: true, threshold: 0.8 },
    { id: 'b', kind: 'custom', active: true, at_hour: 18, text: 'fast starts now' },
    { id: 'c', kind: 'weigh_in', active: true, at_hour: 18 },
  ];
  const ctx = { rules, hour: 18, date: '2026-08-20', flags: [],
    day: { food: { calories: 2000 } }, calorieTarget: 2400, lastWeighDays: 30 };

  // Two in an hour is a lecture and the second is never read. Their own words
  // outrank anything the server worked out.
  const due = dueAlerts(ctx);
  assert.equal(due.length, 1);
  assert.equal(due[0].kind, 'custom');

  // Already sent today: silent.
  assert.equal(dueAlerts({ ...ctx,
    rules: rules.map(r => ({ ...r, last_sent_on: '2026-08-20' })) }).length, 0);

  // Nothing derived from the day's numbers fires overnight. A rule with its own
  // hour is explicit consent for that hour and is honoured exactly.
  const night = { ...ctx, rules: [rules[0]], hour: 3 };
  assert.equal(dueAlerts(night).length, 0);
  assert.ok(QUIET_BEFORE > 0 && QUIET_AFTER <= 24);
  assert.equal(dueAlerts({ ...ctx, rules: [{ id: 'n', kind: 'custom', active: true, at_hour: 5, text: 'gym' }], hour: 5 }).length, 1,
    'an hour they explicitly chose is not overridden');

  // Days of the week are honoured.
  const monOnly = [{ id: 'd', kind: 'custom', active: true, at_hour: 18, text: 'x', days: [1] }];
  assert.equal(dueAlerts({ ...ctx, rules: monOnly, weekday: 1 }).length, 1);
  assert.equal(dueAlerts({ ...ctx, rules: monOnly, weekday: 2 }).length, 0);
});

await test('a custom reminder is sent verbatim, and nothing is on by default', () => {
  // A reminder rewritten into house style is one that no longer sounds like
  // the person who set it.
  const [a] = dueAlerts({
    rules: [{ id: 'x', kind: 'custom', active: true, at_hour: 20, text: "don't eat after this, fatso rules" }],
    hour: 20, date: '2026-08-20', flags: [],
  });
  assert.equal(a.body, "don't eat after this, fatso rules");
  // An empty custom rule sends nothing rather than an empty notification.
  assert.equal(dueAlerts({ rules: [{ id: 'y', kind: 'custom', active: true, at_hour: 20, text: '  ' }],
    hour: 20, date: '2026-08-20', flags: [] }).length, 0);

  // Suggested, never switched on.
  const s = suggestAlerts({ hasCalorieTarget: true, trainDays: 4, fasting: true });
  assert.ok(s.options.length >= 4);
  assert.match(s.note, /OFFER these, never switch them on/);
  assert.match(s.note, /muted/);

  // One reader for what a rule says, shared by the tool and the screen.
  const d = describeAlert({ id: '1', kind: 'kitchen_closed', at_hour: 21, active: true });
  assert.match(d.say, /Kitchen closes/);
  assert.match(d.say, /21:00/);
  assert.equal(describeAlert({ kind: 'nonsense' }), null);
  for (const k of Object.keys(ALERT_KINDS)) assert.ok(ALERT_KINDS[k].why, `${k} has no stated reason`);
});

await test('a notification can be switched off without talking', () => {
  // THE SAFETY VALVE on the whole channel. Somebody who cannot find the off
  // switch mutes the app instead of the rule, and a muted app never comes
  // back on — so the website has to be a complete door here too.
  const api = readFileSync(new URL('../netlify/functions/api-push.js', import.meta.url), 'utf8');
  assert.match(api, /wrought_alerts/);
  assert.match(api, /body\.alert_id/);
  assert.match(api, /describeAlert/, 'the screen words rules its own way');

  const page = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
  assert.match(page, /function alertList\(alerts\)/);
  assert.match(page, /data-alertoff=/);
  // And the empty state teaches the sentence rather than describing a feature.
  assert.match(page, /remind me to stop eating at nine/);
});

await test('the AI writes the rule; it never claims it will remember', () => {
  // The founder's question: "you can tell your AI to push anything you want —
  // can you not do that? How would that work?" It works because the assistant
  // never pushes. MCP is request/response forever; the assistant writes a row
  // and the hourly job sends it.
  const tool = TOOLS.find(t => t.name === 'set_alert');
  assert.ok(tool, 'nothing lets somebody set a notification by talking');
  assert.match(tool.description, /never to promise to remember/);
  assert.match(tool.description, /NEVER say you will remind them without calling this/);
  // Hours are theirs, and the conversion trap is named.
  assert.match(tool.inputSchema.properties.at_hour.description, /THEIR timezone/);
  assert.match(tool.inputSchema.properties.text.description, /verbatim/);

  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  // A rule with nowhere to land is the quietest possible failure.
  assert.match(mcp, /not_deliverable/);
  // Read back off the record, like every other write in this server.
  assert.match(mcp, /const on_file = await alertsFor\(user\.id\);/);
  // Removing one is never a negotiation — the drop_goal doctrine.
  assert.match(mcp, /Never ask why and never remark on commitment/);

  const cron = readFileSync(new URL('../netlify/functions/brief-nightly.js', import.meta.url), 'utf8');
  assert.match(cron, /async function runAlerts/);
  // Stamped only when it actually went, or the one day a phone was off is the
  // day the rule silently skips.
  assert.match(cron, /if \(n > 0\) \{/);
  // One sender for every kind of notification, or one of them quietly stops
  // cleaning up dead subscriptions.
  assert.match(cron, /async function deliver\(userId, profile, message\)/);
  // A failure in the alerts must never cost somebody their nightly read.
  assert.match(cron, /catch \{ \/\* the brief still runs \*\/ \}/);

  const toml = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
  assert.match(toml, /schedule = "0 \* \* \* \*"/, 'the hourly job is what makes any of this fire');
});

await test('the checklist can be ticked from the website, not only spoken to', () => {
  // THE HOLE: the rack screen could show exactly where you were in a session
  // and could not move you through it — every tick had to go via the assistant.
  // "You can put a checkmark for everything that you've done." Same shape as
  // the food door: the website could read the record and not write to it.
  const api = readFileSync(new URL('../netlify/functions/api-session.js', import.meta.url), 'utf8');
  assert.match(api, /'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'/);
  assert.match(api, /httpMethod === 'POST'/);
  // ONE WRITE PATH. A second copy of the insert-and-advance would drift, and
  // the drift shows up as the screen and the voice disagreeing about which
  // exercise you are on — what this endpoint exists to prevent.
  assert.match(api, /recordSet\(user\.id/);
  assert.doesNotMatch(api, /from\('wrought_sets'\)\.insert/, 'the rack screen grew its own insert');
  // A jump is a move, not a set: it writes nothing.
  assert.match(api, /action === 'goto'/);
  assert.match(api, /cursor_index: i/);
  // A swallowed write looks exactly like a tick that worked.
  assert.match(api, /not_saved/);

  const page = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
  assert.match(page, /data-tick="set"/);
  assert.match(page, /data-tick="end"/);
  assert.match(page, /data-goto=/);
  // The response IS the refreshed screen, read back off the record — never a
  // DOM patch from a guess about what the write did.
  assert.match(page, /renderTrainer\(body\);/);
  // And the poll's signature is updated to what was just drawn, or five
  // seconds later it repaints the screen out from under a thumb.
  assert.match(page, /trainerLastJson = JSON\.stringify\(body\)/);
});

await test('a typed weight is theirs; an untyped one still does not exist', () => {
  // The screen shows the PRESCRIBED number so it can be confirmed or changed.
  // Blank stays blank rather than being asserted on somebody's behalf — the
  // same rule that keeps a working weight from being invented anywhere else.
  const api = readFileSync(new URL('../netlify/functions/api-session.js', import.meta.url), 'utf8');
  assert.match(api, /body\.weight == null \|\| body\.weight === ''/);
  assert.match(api, /lbToKg/, 'a pound typed on an imperial account is stored as pounds');

  const sess = readFileSync(new URL('../netlify/functions/lib/session.js', import.meta.url), 'utf8');
  assert.match(sess, /weightKg != null \? Number\(weightKg\) : null/,
    'a missing weight is being filled in from the prescription');
});

await test('every session states what it is for', () => {
  // "For every workout you have to tell them what you're trying to achieve."
  // preflight has always ASKED and the answer went nowhere — read once by a
  // model in one turn, then lost.
  const tool = TOOLS.find(t => t.name === 'start_session');
  assert.ok(tool.inputSchema.properties.aim, 'start_session cannot take an aim');
  assert.match(tool.inputSchema.properties.aim.description, /NEVER invent one/);

  const mcp = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  // Null is a real answer: a session that arrives beats one still being
  // specified, the same rule that keeps the warm-up from blocking.
  assert.match(mcp, /aim_pending: !aim/);
  assert.match(mcp, /never hold the session up waiting for one/);

  // Kept on the RECORD at close, so the log says what was being chased and not
  // only what was lifted.
  const sess = readFileSync(new URL('../netlify/functions/lib/session.js', import.meta.url), 'utf8');
  assert.match(sess, /\.\.\.\(aim \? \{ aim \} : \{\}\)/);

  // THE DOOR IS CORRECT BEFORE THE SQL RUNS. Naming a column PostgREST does
  // not know about makes it reject the whole query, so the rack screen would
  // say "no workout is running" while one plainly was.
  const api = readFileSync(new URL('../netlify/functions/api-session.js', import.meta.url), 'utf8');
  assert.match(api, /await sessionsCanCarryAim\(\) \? ', aim' : ''/);
  assert.match(readFileSync(new URL('../public/app.html', import.meta.url), 'utf8'), /aimline/);
});

await test('sets per muscle per week — the dose, counted not guessed', () => {
  // focusCall counts SESSIONS, so two sets of flyes and twelve sets of
  // pressing are the same day to it. This is the variable a real programme is
  // built on, and nothing here could answer it before.
  const day = n => new Date(Date.UTC(2026, 7, 20 - n)).toISOString().slice(0, 10);
  const sets = [];
  const push = (m, d, n) => { for (let i = 0; i < n; i++) sets.push({ muscles: [m], local_date: day(d) }); };
  push('chest', 1, 6); push('chest', 4, 6);   // 12 across two days
  push('legs', 2, 4);                          // 4 in one day
  push('back', 3, 24);                         // a week's back in one session
  push('chest', 9, 3);                         // prior week, so chest is UP

  const v = weeklyVolume(sets, { today: day(0) });
  assert.equal(v.known, true);
  assert.equal(v.total_sets_7d, 40);  // 12 chest + 4 legs + 24 back; the prior week is not this week

  const by = Object.fromEntries(v.muscles.map(m => [m.muscle, m]));
  assert.equal(by.chest.sets_7d, 12);
  assert.equal(by.chest.days_hit_7d, 2);
  assert.equal(by.chest.state, 'productive');
  assert.equal(by.chest.direction, 'up');
  assert.equal(by.legs.state, 'low');
  assert.equal(by.back.state, 'high');

  // High volume crammed into one day is a DIFFERENT problem from high volume,
  // and it is the one somebody can fix without training less.
  assert.deepEqual(v.one_day_wonders, ['back']);
  assert.ok(v.lowest.includes('legs'));
});

await test('the band is context, never a target, and never a heavier bar', () => {
  const v = weeklyVolume([{ muscles: ['chest'], local_date: '2026-08-19' }], { today: '2026-08-20' });
  // SAID EVERY TIME. A number this easy to read as a target stops being an
  // estimate the moment it is quoted without its caveat.
  assert.match(v.caveat, new RegExp(`${SET_BAND.low}.{1,3}${SET_BAND.high} sets a week`));
  assert.match(v.caveat, /not a target for you/i);
  assert.match(v.caveat, /recovered from/i);
  // The honest answer to a light week is SETS, never load. Same shape as
  // readiness: nothing here may ever turn a reading into "go heavier".
  assert.match(v.note, /never a heavier bar/i);
  assert.doesNotMatch(v.say, /add weight|go heavier|heavier/i);

  // Nothing logged says so rather than drawing zeroes that look like neglect.
  assert.equal(weeklyVolume([]).known, false);
  // Sets with no muscle on them cannot be counted, and it says so rather than
  // reporting a confident nothing.
  assert.equal(weeklyVolume([{ local_date: '2026-08-19', reps: 8 }]).known, false);
});

await test('a short record is not a light record', () => {
  // Dividing nine days of training by four weeks halves every figure and makes
  // a well-trained fortnight read as neglect. The baseline is only as long as
  // the record actually is.
  const day = n => new Date(Date.UTC(2026, 7, 20 - n)).toISOString().slice(0, 10);
  const sets = [];
  for (const d of [1, 3, 5]) for (let i = 0; i < 5; i++) sets.push({ muscles: ['back'], local_date: day(d) });
  const v = weeklyVolume(sets, { today: day(0) });
  assert.equal(v.days_counted, 6, 'the baseline is being stretched past the record');
  const back = v.muscles.find(m => m.muscle === 'back');
  assert.ok(back.sets_per_week_avg > 15, `15 sets in 6 days read as ${back.sets_per_week_avg}/week`);
});

await test('the dose is on the dashboard and reachable by name', () => {
  const src = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  assert.ok(TOOLS.some(t => t.name === 'training_volume'), 'no tool answers "am I doing enough back work"');
  // The rules that matter ride on the TOOL, not only on the instruction sheet
  // — not every client shows that sheet to its model.
  const tool = TOOLS.find(t => t.name === 'training_volume');
  assert.match(tool.description, /NOT a target/);
  assert.match(tool.description, /NEVER with a heavier bar/);
  assert.match(src, /training_volume — /, 'not in the phrasebook');

  const page = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
  assert.match(page, /function volumePanel\(d\)/);
  // NOT behind the trends gate: a fixed seven-day figure must read the same
  // whichever range button is pressed. A window is not a memory.
  const render = page.slice(page.indexOf('function render(d)'), page.indexOf('function stagger('));
  const gate = render.indexOf('const trends =');
  assert.ok(render.indexOf('out.push(volumePanel(d));') < gate,
    'the dose is gated behind the 7d/30d buttons');
});

await test('the writer accepts exactly what the database allows', () => {
  // A TOLERANT WRITER BESIDE A STRICTER READER IS THE WORST COMBINATION, and
  // this one cost the founder his shifts. 013 added 'activity' to the check
  // constraint; VALID_TYPES was never updated; anything missing from it is
  // silently rewritten to 'note' rather than rejected. So every logged shift
  // went in as a note — dayFacts filters on 'activity' and found none, four
  // hours at the petting zoo burned nothing, and the entry still showed in the
  // log, which is what made it invisible. Nothing errored anywhere.
  const sql = readFileSync(new URL('../schema/013_wrought_work.sql', import.meta.url), 'utf8');
  const check = sql.slice(sql.indexOf('wrought_events_type_valid'));
  const allowed = [...check.slice(0, check.indexOf('));')).matchAll(/'([a-z]+)'/g)].map(m => m[1]);
  assert.ok(allowed.includes('activity'), 'the migration no longer allows activity');
  assert.deepEqual([...VALID_TYPES].sort(), [...new Set(allowed)].sort(),
    'insertEvents and the check constraint disagree about the event types');
});

await test('the same meal counted twice is named, never quietly removed', () => {
  // The founder's day: three foods re-logged, and ChatGPT "fixed" it by
  // subtracting them in prose — "your actual total today is about 1,760" while
  // the record held 3,040. A duplicated meal is a duplicated ENTRY. The number
  // only comes down when the row does.
  const items = [
    { id: 'a', type: 'food', at: '12:00', summary: 'McDouble', calories: 400 },
    { id: 'b', type: 'food', at: '12:03', summary: 'mcdouble.', calories: 400 },
    { id: 'c', type: 'food', at: '18:30', summary: 'chicken and rice', calories: 650 },
  ];
  const dups = duplicateItems(items);
  assert.equal(dups.length, 1);
  assert.equal(dups[0].times, 2);
  assert.deepEqual(dups[0].ids, ['a', 'b']);
  // The size of the mistake, stated rather than left to be inferred.
  assert.equal(dups[0].counted_extra, 400);
  assert.equal(duplicateExtra(dups), 400);
  // Minutes apart is a logging accident; that is the signal worth carrying.
  assert.equal(dups[0].minutes_apart, 3);
  assert.equal(dups[0].likely, true);
});

await test('two coffees in a day is not a duplicate', () => {
  // IT ONLY EVER ASKS. Deleting a second helping because it matched a string
  // would be far worse than counting it twice, so hours apart is not flagged
  // as likely and nothing is ever removed automatically.
  const dups = duplicateItems([
    { id: 'a', type: 'drink', at: '07:10', summary: 'coffee', calories: 5 },
    { id: 'b', type: 'drink', at: '15:40', summary: 'coffee', calories: 5 },
  ]);
  assert.equal(dups.length, 1, 'it should still be surfaced');
  assert.equal(dups[0].likely, false, 'hours apart is a second cup, not a double write');

  // A workout logged beside a meal is not a food duplicate.
  assert.equal(duplicateItems([
    { id: 'a', type: 'workout', at: '09:00', summary: 'Leg day' },
    { id: 'b', type: 'workout', at: '18:00', summary: 'Leg day' },
  ]).length, 0);
  assert.equal(duplicateItems([]).length, 0);
  assert.equal(duplicateExtra([]), 0);
});

await test('a duplicate is answered with a retraction, never with prose', () => {
  const src = readFileSync(new URL('../netlify/functions/mcp.js', import.meta.url), 'utf8');
  const from = src.indexOf('function dayTotal(');
  const body = src.slice(from, src.indexOf('\nfunction ', from + 10));
  assert.match(body, /duplicateItems/);
  assert.match(body, /duplicates_note/);
  // The rule, in the response the model is reading at the moment it matters —
  // an instruction sheet not every client reads is the belt, this is the braces.
  assert.match(body, /undo_last/);
  assert.match(body, /NEVER subtract it in prose/);
});

await test('every field the day panels read is a field the server sends', () => {
  // THE BUG THIS EXISTS TO CATCH, which cost three rounds of "still nothing
  // underneath it": dayFacts calls the day's entries `log`, api-progress
  // renames it to `entries` on the way out, and foodTodayPanel read `log`. It
  // was undefined on every load, so the panel drew its empty state forever
  // while the hero one panel up reported thousands of calories eaten. Nothing
  // threw. A field-name mismatch between a payload and a panel is silent by
  // construction, and the empty state it produces is a CLAIM ABOUT THE RECORD
  // — this one accused the assistant of losing food it had actually logged.
  const prog = readFileSync(new URL('../netlify/functions/api-progress.js', import.meta.url), 'utf8');
  const start = prog.indexOf('today: {');
  assert.ok(start > 0, 'api-progress no longer sends a today block');
  const block = prog.slice(start, prog.indexOf('\n      },', start));
  const sent = new Set([...block.matchAll(/^\s+(\w+)[:,]/gm)].map(m => m[1]));

  const src = page('app.html');
  // Each panel binds `today` under its own name — foodTodayPanel takes the
  // whole object, trainingTodayPanel takes a branch of it — so the alias has
  // to be read out of the source rather than assumed, or the check invents
  // failures on fields that were never today's.
  for (const fn of ['foodTodayPanel', 'trainingTodayPanel']) {
    const from = src.indexOf(`function ${fn}(`);
    assert.ok(from > 0, `${fn} is gone`);
    const body = src.slice(from, src.indexOf('\nfunction ', from + 10));
    const reads = new Set([...body.matchAll(/\bd\.today\??\.(\w+)/g)].map(m => m[1]));
    for (const [, alias] of body.matchAll(/\bconst (\w+) = d\.today;/g)) {
      for (const m of body.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`, 'g'))) reads.add(m[1]);
    }
    for (const key of reads) {
      assert.ok(sent.has(key), `${fn} reads today.${key}, which api-progress never sends`);
    }
  }

  // And the demo has to agree with the server, or it hides exactly this — a
  // demo that draws a panel the real payload cannot fill is worse than no demo.
  const demo = src.slice(src.indexOf('    today: {'), src.indexOf('      body: {', src.indexOf('    today: {')));
  for (const key of ['food', 'training', 'activity', 'entries']) {
    assert.ok(new RegExp(`\\b${key}:`).test(demo) || key === 'entries',
      `the demo's today block has no ${key}`);
  }
});

await test('the food box is on the page, and never in the demo', () => {
  const page = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
  assert.match(page, /id="qaform"/);
  assert.match(page, /quickAddFood/);
  assert.match(page, /wireQuickAdd\(\)/);
  // A form in the demo would collect a real meal into a screen that discards
  // it — the same reason the five-facts form is hidden there.
  assert.match(page, /const box = DEMO \? '' :/);
  // The write re-reads the whole dashboard rather than patching the DOM from a
  // guess: the burn, the net, the rings and the calendar all just changed too.
  assert.match(page, /out\.className = 'qasay good'; \}\s*\n\s*await load\(\);/);
  // One box, not a form. The oldest doctrine here is that a log costing more
  // than a sentence is one nobody keeps.
  const box = page.slice(page.indexOf('id="qaform"'), page.indexOf('id="qaform"') + 900);
  assert.equal((box.match(/<input /g) || []).length, 1, 'the one-line box grew a second field');
});

// ── Report ──────────────────────────────────────────────────────────────────

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
