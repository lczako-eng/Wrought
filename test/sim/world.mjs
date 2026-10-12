// test/sim/world.mjs
// The simulator's world: who is using Wrought, what their record already
// holds, and how they reach it (a browser session, Claude, ChatGPT). Every
// world is built fresh in the in-memory database (test/fakedb), so one
// scenario can never lean on what another left behind.

import { createHash } from 'node:crypto';

export const F = globalThis.__FAKEDB || (globalThis.__FAKEDB = { tables: {}, seq: 1000 });
F.users ||= {}; F.jwts ||= {}; F.queries ||= 0;

const hash = t => createHash('sha256').update(t).digest('base64url');

/** A small seeded generator, so a run can be repeated exactly. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function localDate(tz, when = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(when);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(when);
  }
}
export function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── Who ─────────────────────────────────────────────────────────────────────
// Fifteen people, chosen for the edges: the founder's own shape, a brand new
// account, both ends of body size and age, the time zones that break date
// arithmetic (+14, −11, half and quarter hours), a zone that does not exist,
// and an athlete.
export const PERSONAS = [
  { key: 'founder', tz: 'America/Toronto', weight: 150, profile: { height_cm: 191, birth_year: 1982, sex: 'male', units: 'imperial', train_days: 3, equipment: ['full gym'] } },
  { key: 'new_account', tz: 'America/Toronto', weight: null, profile: null },
  { key: 'small_woman', tz: 'Europe/London', weight: 52, profile: { height_cm: 158, birth_year: 1995, sex: 'female', units: 'metric', train_days: 4 } },
  { key: 'kolkata', tz: 'Asia/Kolkata', weight: 78, profile: { height_cm: 172, birth_year: 1988, sex: 'male' } },
  { key: 'kathmandu', tz: 'Asia/Kathmandu', weight: 66, profile: { height_cm: 168, birth_year: 1991, sex: 'female' } },
  { key: 'kiritimati_plus14', tz: 'Pacific/Kiritimati', weight: 84, profile: { height_cm: 178, birth_year: 1980, sex: 'male' } },
  { key: 'pago_minus11', tz: 'Pacific/Pago_Pago', weight: 95, profile: { height_cm: 181, birth_year: 1979, sex: 'male' } },
  { key: 'st_johns_half_hour', tz: 'America/St_Johns', weight: 72, profile: { height_cm: 165, birth_year: 1986, sex: 'female' } },
  { key: 'elder_88', tz: 'America/Vancouver', weight: 61, profile: { height_cm: 160, birth_year: 1938, sex: 'female' } },
  { key: 'teen_15', tz: 'America/Chicago', weight: 55, profile: { height_cm: 165, birth_year: 2011, sex: 'male' } },
  { key: 'sex_unspecified', tz: 'Australia/Sydney', weight: 70, profile: { height_cm: 175, birth_year: 1990, sex: 'nonbinary' } },
  { key: 'athlete', tz: 'America/Denver', weight: 88, profile: { height_cm: 183, birth_year: 1999, sex: 'male', track: 'athlete', sport: 'hockey', strength_per_week: 3, cardio_per_week: 2, train_days: 5 } },
  { key: 'bad_timezone', tz: 'Mars/Olympus_Mons', weight: 90, profile: { height_cm: 180, birth_year: 1985, sex: 'male' } },
  { key: 'very_large', tz: 'America/Toronto', weight: 260, profile: { height_cm: 200, birth_year: 1975, sex: 'male' } },
  { key: 'very_small', tz: 'Asia/Tokyo', weight: 38, profile: { height_cm: 147, birth_year: 1992, sex: 'female' } },
];

// ── What the record already holds ──────────────────────────────────────────
export const HISTORIES = ['none', 'week', 'heavy', 'thin', 'messy', 'years'];

const FOODS = [
  ['two eggs and toast', 380, 20, 30, 18, 3, 2, 6],
  ['chicken wrap with salad', 600, 40, 68, 19, 10, 8, 5],
  ['bowl of oatmeal with berries', 350, 12, 60, 6, 14, 8, 1],
  ['large poutine', 1700, 40, 160, 95, 6, 10, 40],
  ['protein shake', 220, 40, 8, 3, 3, 1, 1],
  ['McDouble', 400, 22, 33, 20, 7, 2, 9],
  ['steak and baked potato', 950, 70, 60, 45, 3, 6, 18],
  ['apple', 95, 0.5, 25, 0.3, 19, 4.4, 0],
  ['can of cola', 140, 0, 39, 0, 39, 0, 0],
  ['salmon with rice and broccoli', 720, 45, 70, 25, 3, 6, 5],
];

function foodRow(uid, tz, date, hh, f, r, extra = {}) {
  const [summary, kcal, p, c, fat, sugar, fibre, sat] = f;
  return {
    id: `e${F.seq++}`, user_id: uid, event_type: 'food', summary, local_date: date,
    occurred_at: `${date}T${String(hh).padStart(2, '0')}:${String(Math.floor(r() * 59)).padStart(2, '0')}:00Z`,
    created_at: `${date}T${String(hh).padStart(2, '0')}:00:00Z`,
    source: 'agent', estimated: true,
    detail: { items: [summary], calories: kcal, protein_g: p, carbs_g: c, fat_g: fat, sugar_g: sugar, fibre_g: fibre, sat_fat_g: sat },
    ...extra,
  };
}

function seedHistory(uid, persona, history, r) {
  const tz = persona.tz;
  const today = localDate(tz);
  const ev = [], mx = [], sets = [], sessions = [], goals = [], routines = [];
  const days = history === 'years' ? 730 : history === 'heavy' ? 90 : history === 'week' ? 7 : history === 'thin' ? 12 : history === 'messy' ? 20 : 0;
  for (let d = 1; d <= days; d++) {
    const date = addDays(today, -d);
    if (history === 'thin') {
      // The founder's own shape: one or two items a day, under 1,200.
      ev.push(foodRow(uid, tz, date, 16, FOODS[d % 3 === 0 ? 5 : 1], r));
      continue;
    }
    const n = 2 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) ev.push(foodRow(uid, tz, date, 12 + i * 3, FOODS[Math.floor(r() * FOODS.length)], r));
    if (d % 3 === 0) {
      const sid = `s${F.seq++}`;
      const ended = `${date}T23:00:00Z`;
      sessions.push({ id: sid, user_id: uid, name: 'Push day', kind: 'strength', status: 'done', started_at: `${date}T22:00:00Z`, ended_at: ended, local_date: date, plan: [], cursor_index: 3 });
      const lifts = [['Bench press', 'bench press', ['chest', 'triceps']], ['Overhead press', 'overhead press', ['shoulders']], ['Barbell row', 'barbell row', ['back']]];
      lifts.forEach(([name, key, muscles], pos) => {
        for (let s = 1; s <= 3; s++) {
          sets.push({ id: `x${F.seq++}`, user_id: uid, session_id: sid, exercise: name, exercise_key: key, set_number: s, position: pos + 1, reps: 8 - (s === 3 ? 1 : 0), weight_kg: 60 + pos * 5 + Math.floor(d / 10) * 2.5, rpe: 8, muscles, local_date: date, logged_at: `${date}T22:${String(10 + pos * 15 + s * 3).padStart(2, '0')}:00Z` });
        }
      });
      ev.push({ id: `e${F.seq++}`, user_id: uid, event_type: 'workout', summary: 'Push day — bench, press, row', local_date: date, occurred_at: ended, source: 'agent', estimated: false, detail: { session_id: sid, minutes: 55, kind: 'strength', muscles: ['chest', 'shoulders', 'back'] } });
    }
    if (d % 7 === 1 && persona.weight) ev.push({ id: `e${F.seq++}`, user_id: uid, event_type: 'weight', summary: `weighed ${Math.round((persona.weight - d / 30) * 10) / 10}kg`, local_date: date, occurred_at: `${date}T12:00:00Z`, source: 'agent', estimated: false, detail: { value_kg: Math.round((persona.weight - d / 30) * 10) / 10 } });
    mx.push({ id: `m${F.seq++}`, user_id: uid, metric: 'steps', value: 4000 + Math.floor(r() * 8000), unit: 'count', local_date: date, measured_at: `${date}T12:00:00Z`, source: 'wrought_ios', source_ref: 'day_final', created_at: `${date}T23:30:00Z` });
    mx.push({ id: `m${F.seq++}`, user_id: uid, metric: 'active_calories', value: 300 + Math.floor(r() * 600), unit: 'kcal', local_date: date, measured_at: `${date}T12:00:00Z`, source: 'wrought_ios', source_ref: 'day_final', created_at: `${date}T23:30:00Z` });
    mx.push({ id: `m${F.seq++}`, user_id: uid, metric: 'resting_hr', value: 62 + Math.floor(r() * 12), unit: 'bpm', local_date: date, measured_at: `${date}T12:00:00Z`, source: 'wrought_ios', created_at: `${date}T23:30:00Z` });
    if ((history === 'heavy' || history === 'years') && d % 5 === 0) mx.push({ id: `m${F.seq++}`, user_id: uid, metric: 'vo2max', value: Math.round((33 + r() * 3) * 10) / 10, unit: 'ml/kg/min', local_date: date, measured_at: `${date}T12:00:00Z`, source: 'wrought_ios', created_at: `${date}T23:30:00Z` });
  }
  if (history === 'messy') {
    const date = addDays(today, -1);
    // Every shape the real record has held at some point.
    ev.push({ id: `e${F.seq++}`, user_id: uid, event_type: 'food', summary: 'had lunch', local_date: date, occurred_at: `${date}T17:00:00Z`, source: 'agent', estimated: false, detail: { calories: null } });
    ev.push({ id: `e${F.seq++}`, user_id: uid, event_type: 'food', summary: 'toast | cheese 🧀', local_date: date, occurred_at: `${date}T13:00:00Z`, source: 'agent', estimated: true, detail: { calories: '~400', protein_g: 16 } });
    ev.push({ id: `e${F.seq++}`, user_id: uid, event_type: 'food', summary: 'a sausage', local_date: date, occurred_at: `${date}T19:00:00Z`, source: 'agent', estimated: true, detail: { protein_g: 20 } });
    ev.push({ id: `e${F.seq++}`, user_id: uid, event_type: 'workout', summary: 'worked six hours at the petting zoo', local_date: date, occurred_at: `${date}T21:00:00Z`, source: 'agent', estimated: true, detail: { minutes: 360, calories: 2400 } });
    ev.push({ id: `e${F.seq++}`, user_id: uid, event_type: 'note', summary: 'worked 4-5 hours at the zoo', local_date: date, occurred_at: `${date}T22:00:00Z`, source: 'agent', estimated: false, detail: {} });
    ev.push({ id: `e${F.seq++}`, user_id: uid, event_type: 'food', summary: 'same coffee', local_date: today, occurred_at: new Date(Date.now() - 3600e3).toISOString(), source: 'agent', estimated: true, detail: { calories: 120, protein_g: 6, carbs_g: 10, fat_g: 6 } });
    ev.push({ id: `e${F.seq++}`, user_id: uid, event_type: 'food', summary: 'same coffee', local_date: today, occurred_at: new Date(Date.now() - 3540e3).toISOString(), source: 'agent', estimated: true, detail: { calories: 120, protein_g: 6, carbs_g: 10, fat_g: 6 } });
    ev.push({ id: `e${F.seq++}`, user_id: uid, event_type: 'note', summary: 'two eggs and toast with jam', local_date: addDays(today, -2), occurred_at: `${addDays(today, -2)}T12:00:00Z`, source: 'voice', estimated: false, detail: {} });
    ev.push({ id: `e${F.seq++}`, user_id: uid, event_type: 'food', summary: 'future breakfast', local_date: addDays(today, 3), occurred_at: `${addDays(today, 3)}T12:00:00Z`, source: 'agent', estimated: true, detail: { calories: 500 } });
    ev.push({ id: `e${F.seq++}`, user_id: uid, event_type: 'food', summary: 'x', local_date: date, occurred_at: `${date}T11:00:00Z`, source: 'agent', estimated: true, detail: null });
  }
  if (history === 'heavy' || history === 'week' || history === 'years') {
    goals.push({ id: `g${F.seq++}`, user_id: uid, goal: 'Eat to 2,200 a day', metric: 'calories', target_value: 2200, target_unit: 'kcal', direction: 'at_most', cadence: 'daily', active: true });
    goals.push({ id: `g${F.seq++}`, user_id: uid, goal: '160g protein a day', metric: 'protein_g', target_value: 160, target_unit: 'g', direction: 'at_least', cadence: 'daily', active: true });
    goals.push({ id: `g${F.seq++}`, user_id: uid, goal: '9,000 steps a day', metric: 'steps', target_value: 9000, target_unit: 'steps', direction: 'at_least', cadence: 'daily', active: true });
    routines.push({ id: `r${F.seq++}`, user_id: uid, name: 'S-Tier', kind: 'strength', tier: 'intermediate', active: true, times_used: 4, last_used_on: addDays(today, -3), notes: 'Push the bench, leave a rep in the tank on the press.', exercises: [{ name: 'Bench press', sets: 3, reps: 8 }, { name: 'Overhead press', sets: 3, reps: 8 }, { name: 'Incline treadmill walk', minutes: 20, detail: 'level 10+, 2.5-3 mph' }] });
  }
  return { ev, mx, sets, sessions, goals, routines };
}

// ── How they reach it ──────────────────────────────────────────────────────
let worldSeq = 0;
const FAR = new Date(Date.now() + 30 * 86400e3).toISOString();

/**
 * A fresh world for one scenario. Returns the user, their bearer for each
 * door, and a handful of facts the checks need.
 */
export function world(persona, history = 'none', { revoked = false, seed = 1, second = false } = {}) {
  worldSeq++;
  const r = rng(seed * 7919 + worldSeq);
  F.tables = {}; F.users = {}; F.jwts = {};
  const uid = `u${worldSeq}`;
  const email = `${persona.key.replace(/_/g, '.')}.${worldSeq}@example.com`;
  F.users[uid] = { id: uid, email, app_metadata: {}, user_metadata: {} };
  F.tables.wrought_profile = persona.profile ? [{ user_id: uid, timezone: persona.tz, ...persona.profile }] : [];
  const seeded = seedHistory(uid, persona, history, r);
  F.tables.wrought_events = seeded.ev;
  F.tables.wrought_metrics = seeded.mx;
  F.tables.wrought_sets = seeded.sets;
  F.tables.wrought_sessions = seeded.sessions;
  F.tables.wrought_goals = seeded.goals;
  F.tables.wrought_routines = seeded.routines;
  if (persona.weight && history !== 'none') {
    // A recent weigh-in, so the burn can be priced.
    F.tables.wrought_events.push({ id: `e${F.seq++}`, user_id: uid, event_type: 'weight', summary: `weighed ${persona.weight}kg`, local_date: addDays(localDate(persona.tz), -2), occurred_at: `${addDays(localDate(persona.tz), -2)}T12:00:00Z`, source: 'agent', estimated: false, detail: { value_kg: persona.weight } });
  }
  if (revoked) F.tables.wrought_memberships = [{ user_id: uid, plan: 'free', status: 'revoked' }];

  // The doors: a browser session, Claude, ChatGPT with three connections.
  const claude = `wrought_claude${worldSeq}`, cgpt = `wrought_cgpt${worldSeq}`;
  F.tables.wrought_oauth_clients = [
    { client_id: claude, redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] },
    { client_id: cgpt, redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] },
  ];
  F.tables.wrought_oauth_tokens = [];
  F.tables.wrought_oauth_refresh = [];
  const grant = (client, tag) => {
    const t = `tok-${tag}-${worldSeq}-${Math.floor(r() * 1e9)}`;
    const at = new Date(Date.now() - Math.floor(r() * 5) * 86400e3).toISOString();
    F.tables.wrought_oauth_tokens.push({ token_hash: hash(t), user_id: uid, client_id: client, expires_at: FAR, created_at: at });
    F.tables.wrought_oauth_refresh.push({ token_hash: hash(`${t}-r`), user_id: uid, client_id: client, revoked: false, expires_at: FAR, created_at: at });
    return t;
  };
  const jwt = `jwt-${worldSeq}`;
  F.jwts[jwt] = F.users[uid];
  const tokens = { plain: jwt, claude: grant(claude, 'claude'), chatgpt: grant(cgpt, 'cgpt') };
  grant(cgpt, 'cgpt2'); grant(cgpt, 'cgpt3');
  tokens.chatgpt_link = tokens.chatgpt;

  // A second person on the same server, for the scenarios that try to reach
  // somebody else's record. Their rows must never change.
  let other = null;
  if (second) {
    const oid = `v${worldSeq}`;
    F.users[oid] = { id: oid, email: `other.${worldSeq}@example.com` };
    F.tables.wrought_profile.push({ user_id: oid, timezone: 'America/Toronto', height_cm: 170, birth_year: 1990, sex: 'female' });
    const os = seedHistory(oid, { tz: 'America/Toronto', weight: 65 }, 'week', rng(seed + 99));
    F.tables.wrought_events.push(...os.ev);
    F.tables.wrought_sets.push(...os.sets);
    F.tables.wrought_sessions.push(...os.sessions);
    F.tables.wrought_metrics.push(...os.mx);
    other = { id: oid, eventIds: os.ev.map(e => e.id), setIds: os.sets.map(s => s.id) };
  }

  // A device key for the phone doors.
  const deviceKey = `dev-${worldSeq}`;
  F.tables.wrought_ingest_keys = [{ id: `k${worldSeq}`, user_id: uid, token_hash: hash(deviceKey), revoked: false }];

  return { uid, email, persona, history, tz: persona.tz, today: localDate(persona.tz), tokens, deviceKey, other, r };
}

/** A deep copy of somebody else's rows, to compare after a scenario. */
export function snapshotOf(userId) {
  const out = {};
  for (const [t, rows] of Object.entries(F.tables)) {
    const mine = (rows || []).filter(x => x && x.user_id === userId);
    if (mine.length) out[t] = JSON.parse(JSON.stringify(mine));
  }
  return JSON.stringify(out);
}
