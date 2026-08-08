// test/harness.mjs
// Local protocol + arithmetic harness. `npm test`.
//
// Runs with no environment set, which is the point: with no SUPABASE_URL and
// no OPENAI_API_KEY, lib/forge.js builds no clients, so nothing here touches a
// network or a database. What gets tested is the two halves that break
// silently in production — the JSON-RPC envelope, which fails as an
// uninformative "could not connect" inside ChatGPT, and the arithmetic, which
// fails as a confidently wrong number in somebody's nightly verdict.

import assert from 'node:assert/strict';
import { handler, TOOLS, handleRpc } from '../netlify/functions/mcp.js';
import { canonicalMetric, normalise } from '../netlify/functions/ingest.js';
import {
  localDateFor, addDays, daysBetween, clockString, humanDuration,
  kgToLb, lbToKg, cmToIn, inToCm, sayWeight,
  windowStatus, weightTrend, trainingMatrix, summariseRange, careFlags, scoreGoals,
} from '../netlify/functions/lib/forge.js';

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
  assert.equal(body.result.serverInfo.name, 'forge');
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

await test('a non-numeric sample is dropped, not stored as NaN', () => {
  assert.equal(normalise('steps', 'lots', 'count'), null);
});

// ── Report ──────────────────────────────────────────────────────────────────

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
