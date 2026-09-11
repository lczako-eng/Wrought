// lib/dayread.js
// The whole day, read out — every line with its own number, both sides, the
// goals against it, and where the week stands.
//
// The founder, at 10:16pm, having just been told "that meal added 770,
// bringing today to 1,410": "When I asked for daily totals, it should come
// with absolutely everything — exactly what I've eaten, my walk, my burn,
// goals, and what I did."
//
// He is right, and the failure is the vacuum again. "Where am I at today"
// rode on a `log` call, and `log` answers with the FOOD total plus a note
// saying the burn lives in another tool — a note the model read past. Every
// number he asked for was already computed somewhere: the receipt itemises
// the burn, scoreGoals scores the rings, dayFacts holds the steps, weekSoFar
// holds the week. They were four tool results away from each other, and a
// question is answered from the one in front of the model.
//
// So this is ONE read: the day as a person thinks of it, composed here so the
// model relays rather than assembles. Nothing is computed in this file —
// every figure is the receipt's, scoreGoals', dayFacts' or weekSoFar's own,
// which is what lets a line here never disagree with a panel or a brief.

import { outSay } from './receipt.js';
import { macroLine } from './wrought.js';

const n = v => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
const money = v => (n(v) == null ? '—' : n(v).toLocaleString());

/**
 * @param day      dayFacts()
 * @param balance  energyBalance() for the day, or null
 * @param receipt  dayReceipt() for the day, or null
 * @param scored   scoreGoals() for the day
 * @param week     weekSoFar() or null
 * @param date     the day read
 * @param today    the person's local date — a day still running is said so
 */
export function dayReadout({ day = null, balance = null, receipt = null, scored = [], week = null, date = null, today = null } = {}) {
  if (!day) return null;
  const partial = !!(today && (date || day.date) === today);
  const lines = [];

  // ── IN ────────────────────────────────────────────────────────────────────
  const food = (day.log || []).filter(e => e.type === 'food' || e.type === 'drink');
  // Every item with ALL of its numbers, and the total in the same shape —
  // "a total always of everything you've eaten and broken down." macroLine
  // is the one renderer, shared with the log confirmation and the receipt.
  const inn = {
    total: n(day.food?.calories) || 0,
    protein_g: n(day.food?.protein_g) || 0, carbs_g: n(day.food?.carbs_g) || 0, fat_g: n(day.food?.fat_g) || 0,
    // Null when the day never carried them, never a zero standing in.
    sugar_g: n(day.food?.sugar_g), fibre_g: n(day.food?.fibre_g), sat_fat_g: n(day.food?.sat_fat_g),
    items: food.map(e => ({
      at: e.at, what: e.summary, calories: e.calories,
      protein_g: e.protein_g ?? null, carbs_g: e.carbs_g ?? null, fat_g: e.fat_g ?? null,
      sugar_g: e.sugar_g ?? null, fibre_g: e.fibre_g ?? null, sat_fat_g: e.sat_fat_g ?? null,
      estimated: e.estimated,
    })),
    without_calories: n(day.food?.meals_uncounted) || 0,
  };
  lines.push(food.length
    ? `IN — ${macroLine({ ...inn, calories: inn.total })}${day.food?.estimated ? ' (estimated)' : ''}`
    : 'IN — nothing logged');
  for (const it of inn.items) lines.push(`  ${it.at ? `${it.at} ` : ''}${it.what} — ${macroLine(it)}`);
  if (inn.without_calories) lines.push(`  (${inn.without_calories} with no calories, so the real intake is higher)`);

  // ── TRAINED / WORKED — off the receipt's own itemisation, never re-priced ──
  const t = balance?.training_detail?.entries || [];
  const training = t.map(e => ({ what: e.summary, minutes: e.minutes ?? null, calories: e.kcal ?? 0, source: e.source }));
  lines.push(training.length
    ? `TRAINED — ${training.map(e => `${e.what}${e.minutes ? ` (${e.minutes} min)` : ''} — ${money(e.calories)} kcal${e.source === 'device' ? ', watch' : e.source === 'uncounted' ? ', counts for nothing' : ', estimated'}`).join('; ')}`
    : `TRAINED — nothing logged${day.training?.sessions ? ` (${day.training.sessions} session on record but not priced yet)` : ''}`);
  const a = balance?.logged_activity?.entries || [];
  const work = a.map(e => ({ what: e.summary, hours: e.hours ?? null, calories: n(e.kcal) || 0 }));
  if (work.length || day.activity?.count) {
    lines.push(`WORKED — ${work.length
      ? work.map(e => `${e.what}${e.hours ? ` (${e.hours}h on task)` : ''} — ${money(e.calories)} kcal, estimated`).join('; ')
      : day.activity.say}`);
  }

  // ── MOVED — the watch, read and never asked for ───────────────────────────
  const dev = day.device || {};
  const moved = { steps: dev.steps ?? null, active_calories: dev.active_calories ?? null, distance_km: dev.distance_km ?? null, as_of: dev.as_of || null };
  lines.push(moved.steps != null || moved.active_calories != null
    ? `MOVED — ${[moved.steps != null ? `${money(moved.steps)} steps` : null, moved.distance_km != null ? `${Math.round(moved.distance_km * 10) / 10} km` : null, moved.active_calories != null ? `${money(moved.active_calories)} active kcal (watch)` : null].filter(Boolean).join(' · ')}`
    : 'MOVED — the watch has not sent today (nothing is projected)');

  // ── OUT / NET — the receipt's own accounting, every input on its line ─────
  // "2,473 resting + 953 active" was the equation alone, and the founder's
  // answer was "every calorie has to be accounted for". The block under the
  // equation is the receipt's — the resting basis, each session, each shift,
  // the watch's day with its steps, and which of them counted — rendered by
  // the one function the receipt itself uses, so the two cannot differ.
  if (receipt?.out) {
    lines.push(...outSay(receipt.out));
    lines.push(`NET — ${receipt.math.net}${partial ? ' so far — the burn is the whole day, the food is only what is logged yet' : ''}`);
    for (const s of receipt.set_aside || []) lines.push(`  set aside: ${s}`);
  } else {
    lines.push(`OUT — not known yet${balance?.missing?.length ? ` (needs ${balance.missing.join(' and ')})` : ''}`);
  }

  // ── GOALS ─────────────────────────────────────────────────────────────────
  const goals = (scored || []).filter(g => g.scored).map(g => ({
    goal: g.goal, metric: g.metric, cadence: g.cadence, target: g.target, actual: g.actual, percent: g.percent, hit: g.hit, over: g.over, unit: g.unit,
  }));
  if (goals.length) {
    lines.push(`GOALS — ${goals.map(g => `${g.goal}: ${money(g.actual)}${g.unit} of ${money(g.target)}${g.unit} (${g.percent}%${g.hit ? ', hit' : g.over ? ', over' : ''})${g.cadence === 'weekly' ? ' this week' : ''}`).join(' · ')}`);
  } else if ((scored || []).length) {
    lines.push('GOALS — set, but nothing logged today to score them against');
  } else {
    lines.push('GOALS — none set');
  }

  // ── WEEK ──────────────────────────────────────────────────────────────────
  if (week?.say) lines.push(`WEEK — ${week.say}`);

  return {
    date: date || day.date,
    partial,
    in: inn,
    training, work, moved,
    out: receipt?.out ? { total: receipt.out.total, lines: receipt.out.lines.map(l => ({ what: l.what, calories: l.calories, ...(l.basis ? { basis: l.basis } : {}), ...(l.of?.length ? { of: l.of } : {}) })) } : null,
    net: receipt?.net ?? null,
    set_aside: receipt?.set_aside || [],
    goals,
    week: week ? { say: week.say, done: week.done ?? null, target: week.target ?? null } : null,
    estimated: true,
    say: lines.join('\n'),
    note: 'THIS IS THE WHOLE DAY. Read it out LINE BY LINE as it stands — every item eaten with its own calories, the session, the work, the steps, the burn added up WITH EVERY INPUT UNDER IT (the resting figure and what it is computed from, each session, each shift with its hours, the watch\'s figure for the day, and which of them counted and which was set aside and why), the net with its sign, each goal with its percentage, the week. Never collapse the burn into "resting + active" — every calorie is accounted for on its own line and that is the point. Never quote only a total, never add anything up yourself, never answer "where am I at" from the food alone. ' +
      (partial ? 'Say the day is not over: the burn is a whole-day figure and the food is only what has been logged so far. ' : '') +
      'Every figure is an estimate and is said to be one.',
  };
}
