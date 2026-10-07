// test/fakedb/scenarios.mjs
// Run with `node --import ./test/fakedb/register.mjs test/fakedb/scenarios.mjs`.
// Calls the real tools through handleRpc against the in-memory database and
// prints ONE line: `SCENARIOS <json>` — each scenario's reply text (parsed)
// and the card its _meta carries. The harness spawns this and asserts on it,
// because these replies cannot be built without a database and a source grep
// cannot tell a working reply from a broken one.
process.env.SUPABASE_URL = 'http://fakedb.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
delete process.env.OPENAI_API_KEY;

const F = globalThis.__FAKEDB || (globalThis.__FAKEDB = { tables: {}, seq: 1000 });
const M = await import('../../netlify/functions/mcp.js');
const { localDateFor, addDays } = await import('../../netlify/functions/lib/wrought.js');

const tz = 'America/Toronto';
const user = { id: 'u1', email: 'someone@example.com' };
const today = localDateFor(tz);
const yday = addDays(today, -1);

const reset = (events = []) => {
  F.tables = {
    wrought_profile: [{ user_id: 'u1', timezone: tz, height_cm: 191, birth_year: 1982, sex: 'male', activity_level: null }],
    wrought_events: events,
  };
};
const at = (date, hh) => `${date}T${hh}:00Z`;
const ev = (id, date, type, summary, detail, { hh = '16:00', source = 'agent', estimated = true } = {}) => ({
  id, user_id: 'u1', event_type: type, summary, detail, source, local_date: date,
  occurred_at: at(date, hh), created_at: at(date, hh), estimated,
});
const weigh = () => ev('w0', addDays(today, -2), 'weight', 'weighed 150', { value_kg: 150 });
const call = async (name, args) => {
  const r = await M.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, user);
  const res = r.result || {};
  const text = res.content?.[0]?.text;
  let body = null;
  try { body = JSON.parse(text); } catch { body = { unparsed: text }; }
  return { keys: Object.keys(body || {}), body, card: res._meta?.['wrought/card'] ?? null, error: r.error ?? null };
};
const food = (summary, detail = {}, extra = {}) => ({ event_type: 'food', summary, detail: { items: [summary], ...detail }, estimated: true, ...extra });

const out = { today, yday };

// A named food logged with NO calorie figure — the 6 October toast.
reset([weigh()]);
out.nofig = await call('log', { text: 'two slices of toasted sourdough with cheese', events: [food('two slices of toasted sourdough with cheese', {}, { time_hint: '13:02' })] });
// …and through ChatGPT's account picker: connected_accounts is stamped first.
reset([weigh()]);
out.nofig_link = await call('log', { link_id: 'picker-1', text: 'toast', events: [food('toast with cheese')] });

// One food with its figure — the 3:17pm sausage.
reset([weigh()]);
out.sausage = await call('log', { text: 'Costco restaurant sausage', events: [food('Costco restaurant sausage', { calories: 570, protein_g: 22, carbs_g: 4, fat_g: 52 }, { time_hint: '15:17' })] });

// A figure sent as words, then the same words again on the follow-up.
reset([weigh()]);
out.words = await call('log', { text: 'toast with cheese', events: [food('toast with cheese', { calories: '~400', protein_g: 16, carbs_g: 48, fat_g: 16 })] });
const wid = out.words.body?.estimate_now?.entries?.[0]?.id ?? null;
out.words_again = wid == null ? null : await call('structure_entries', { entries: [{ id: wid, detail: { calories: '~400', protein_g: 16, carbs_g: 48, fat_g: 16 }, estimated: true }] });
out.words_fixed = wid == null ? null : await call('structure_entries', { entries: [{ id: wid, detail: { calories: 400, protein_g: 16, carbs_g: 48, fat_g: 16 }, estimated: true }] });

// A seven-item catch-up, and a food beside a weigh-in.
reset([weigh()]);
out.flush7 = await call('log', { text: 'catching up on today', events: Array.from({ length: 7 }, (_, i) => food(`item ${i + 1}`, { calories: 100 + i, protein_g: 5, carbs_g: 10, fat_g: 3 }, { time_hint: `${String(7 + i).padStart(2, '0')}:00` })) });
reset([weigh()]);
out.food_weight = await call('log', { text: 'eggs, and I weighed 150', events: [food('two eggs', { calories: 150, protein_g: 12, carbs_g: 1, fat_g: 10 }), { event_type: 'weight', summary: 'weighed 150 kg', detail: { value_kg: 150 } }] });

// Yesterday's dictation, filled in today: its figures are on the row.
reset([weigh(), ev('v1', yday, 'note', 'two eggs and toast', {}, { hh: '12:30', source: 'voice', estimated: false })]);
out.past_fill = await call('structure_entries', { entries: [{ id: 'v1', event_type: 'food', summary: 'two eggs and toast', detail: { calories: 380, protein_g: 18, carbs_g: 30, fat_g: 20 }, estimated: true }] });

// A quiet capture filled in: the item, no day.
reset([weigh(), ev('q0', today, 'food', 'lunch earlier', { calories: 800, protein_g: 40, carbs_g: 80, fat_g: 30 }, { hh: '15:00' }), ev('q1', today, 'food', 'a sausage roll', {}, { hh: '16:00', estimated: false })]);
out.quiet_fill = await call('structure_entries', { quiet: true, entries: [{ id: 'q1', detail: { calories: 330, protein_g: 9, carbs_g: 27, fat_g: 21 }, estimated: true }] });

// Macros but no calories, by amend_last and by structure_entries. The amend
// says nothing about estimation, so the row keeps its label.
reset([weigh()]);
await call('log', { text: 'a sausage', events: [food('a sausage')] });
out.amend_macros = await call('amend_last', { text: 'it had 20g protein', event: { event_type: 'food', summary: 'a sausage', detail: { protein_g: 20 } } });
out.amend_macros.stored_estimated = F.tables.wrought_events.filter(e => e.event_type === 'food').map(e => e.estimated);
// Nothing to amend today: a first mention, and the reading travels with it.
reset([weigh()]);
out.amend_first = await call('amend_last', { text: 'a bagel', event: food('a bagel', { calories: 300, protein_g: 11, carbs_g: 58, fat_g: 2 }) });
reset([weigh(), ev('s1', today, 'food', 'a hot dog', {}, { hh: '15:00' })]);
out.se_macros = await call('structure_entries', { entries: [{ id: 's1', detail: { protein_g: 20 }, estimated: true }] });

// What is left: said with every item counted, withheld while one is not.
const calorieGoal = { id: 'g1', user_id: 'u1', active: true, goal: 'Calories', metric: 'calories', target_value: 1723, target_unit: 'kcal', direction: 'at_most', cadence: 'daily', created_at: '2026-09-01T00:00:00Z' };
reset([weigh(), ev('l0', today, 'food', 'oatmeal', { calories: 350, protein_g: 12, carbs_g: 60, fat_g: 6 }, { hh: '12:00' })]);
F.tables.wrought_goals = [calorieGoal];
out.left_shown = await call('log', { text: 'an apple', events: [food('an apple', { calories: 95, protein_g: 0, carbs_g: 25, fat_g: 0 })] });
reset([weigh(), ev('l0', today, 'food', 'oatmeal', { calories: 350, protein_g: 12, carbs_g: 60, fat_g: 6 }, { hh: '12:00' })]);
F.tables.wrought_goals = [calorieGoal];
out.left_held = await call('log', { text: 'a muffin', events: [food('a blueberry muffin')] });

// A shift: the burn said the way the card's burn row says it.
reset([weigh(), ev('d0', today, 'food', 'oatmeal', { calories: 350, protein_g: 12, carbs_g: 60, fat_g: 6 }, { hh: '12:00' })]);
out.shift = await call('log_activity', { activity: 'animal care', hours: 3 });

// The day, asked for — today, and a past day with the watch and no food.
reset([weigh(), ev('d1', today, 'food', 'oatmeal', { calories: 350, protein_g: 12, carbs_g: 60, fat_g: 6 }, { hh: '12:00' })]);
out.get_day = await call('get_day', {});
reset([weigh()]);
F.tables.wrought_metrics = [
  { user_id: 'u1', local_date: yday, metric: 'steps', value: 9000, unit: 'count', measured_at: at(yday, '23:30'), created_at: at(today, '04:30'), source: 'wrought_ios', source_ref: 'p1' },
  { user_id: 'u1', local_date: yday, metric: 'active_calories', value: 700, unit: 'kcal', measured_at: at(yday, '23:30'), created_at: at(today, '04:30'), source: 'wrought_ios', source_ref: 'p2' },
];
out.past_nofood = await call('get_day', { date: yday });

console.log('SCENARIOS ' + JSON.stringify(out));
