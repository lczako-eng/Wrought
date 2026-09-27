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

// A missing figure is null, never a zero: Number(null) is 0, and a meal
// stored with no calories must not read as a zero-calorie meal.
const n = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
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
/**
 * Scored goals with the intake ceiling's remaining room taken off under a care
 * flag — pure. The figure of what is left to eat is exactly what a flag stops,
 * and a structured `gap` is as sayable as a sentence.
 */
export function roomless(scored = [], flags = []) {
  if (!flags?.length) return scored || [];
  return (scored || []).map(g => (g && g.metric === 'calories' && g.direction === 'at_most' ? { ...g, gap: null } : g));
}

export function dayReadout({ day = null, balance = null, receipt = null, scored = [], week = null, date = null, today = null, flags = [], left = null } = {}) {
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
  // Named by what the work WAS, then the hours once — "animal care, 3h (3h
  // on task)" said the hours twice and lost what the job was.
  const work = a.map(e => ({ what: e.label || e.summary, hours: e.hours ?? null, calories: e.kcal == null ? null : n(e.kcal) }));
  if (work.length || day.activity?.count) {
    lines.push(`WORKED — ${work.length
      ? work.map(e => `${e.what}${e.hours ? ` (${e.hours}h on task)` : ''} — ${e.calories != null ? `${money(e.calories)} kcal, estimated` : 'not priced yet — it needs a recent weigh-in'}`).join('; ')
      : day.activity.say}`);
  }

  // ── MOVED — the watch, read and never asked for ───────────────────────────
  const dev = day.device || {};
  // With WHEN the phone sent it. The founder at 7pm read 8,020 steps the phone
  // had sent at 6:01 and concluded the count was wrong; a figure without its
  // time is indistinguishable from a wrong one.
  const moved = { steps: dev.steps ?? null, active_calories: dev.active_calories ?? null, distance_km: dev.distance_km ?? null, as_of: dev.as_of || null, fresh: dev.fresh || null };
  lines.push(moved.steps != null || moved.active_calories != null
    ? `MOVED — ${[moved.steps != null ? `${money(moved.steps)} steps` : null, moved.distance_km != null ? `${Math.round(moved.distance_km * 10) / 10} km` : null, moved.active_calories != null ? `${money(moved.active_calories)} active kcal (watch)` : null].filter(Boolean).join(' · ')}${moved.fresh?.say ? ` — ${moved.fresh.say}` : ''}`
    : 'MOVED — the watch has not sent today (nothing is projected)');

  // ── OUT / NET — the receipt's own accounting, every input on its line ─────
  // "2,473 resting + 953 active" was the equation alone, and the founder's
  // answer was "every calorie has to be accounted for". The block under the
  // equation is the receipt's — the resting basis, each session, each shift,
  // the watch's day with its steps, and which of them counted — rendered by
  // the one function the receipt itself uses, so the two cannot differ.
  if (receipt?.out) {
    lines.push(...outSay(receipt.out));
    // NOTHING EATEN YET IS NOT A DEFICIT — the dashboard hero's rule. At
    // breakfast the subtraction reads "3,420 down", an artifact of a day four
    // hours old, and an overstated deficit is the dangerous direction.
    lines.push(partial && !inn.total
      ? 'NET — nothing eaten is logged yet, so there is no in-versus-out; the burn above is the whole day\'s estimate'
      : `NET — ${receipt.math.net}${partial ? ' so far — the burn is the whole day, the food is only what is logged yet' : ''}`);
    for (const s of receipt.set_aside || []) lines.push(`  set aside: ${s}`);
  } else {
    lines.push(`OUT — not known yet${balance?.missing?.length ? ` (needs ${balance.missing.join(' and ')})` : ''}`);
  }

  // ── GOALS ─────────────────────────────────────────────────────────────────
  const goals = roomless(scored, flags).filter(g => g.scored).map(g => ({
    goal: g.goal, metric: g.metric, cadence: g.cadence, target: g.target, actual: g.actual, percent: g.percent, hit: g.hit, over: g.over, unit: g.unit,
    gap: g.gap ?? null, direction: g.direction ?? null,
  }));
  // "HOW MUCH SHOULD I EAT TODAY" — answered here, off scoreGoals' own gap.
  // A calorie ceiling on a day still running is not "hit": it is where the
  // day stands against the target, and the target is priced off BASAL — the
  // founder's instruction — so what he trained and worked comes off on top
  // of it and is said so, every time. Under a care flag no remaining figure
  // is quoted at all: an intake number is exactly what a flag stops.
  const ceiling = g => partial && g.metric === 'calories' && g.direction === 'at_most' && g.cadence !== 'weekly';
  const goalSay = g => {
    if (ceiling(g)) {
      // With the LEFT line below carrying the figure, the goal line only
      // says where the day stands; without one it carries the figure itself.
      const room = left ? null : (n(g.gap) != null && n(g.gap) < 0 ? money(-n(g.gap)) : null);
      return `${g.goal}: ${money(g.actual)}${g.unit} of ${money(g.target)}${g.unit} so far${
        g.over ? ', over it' : !flags.length && room ? ` — ${room}${g.unit} short of it` : ''}`;
    }
    return `${g.goal}: ${money(g.actual)}${g.unit} of ${money(g.target)}${g.unit} (${g.percent}%${g.hit ? ', hit' : g.over ? ', over' : ''})${g.cadence === 'weekly' ? ' this week' : ''}`;
  };
  if (goals.length) {
    lines.push(`GOALS — ${goals.map(goalSay).join(' · ')}`);
    if (!left && goals.some(g => g.metric === 'calories' && g.direction === 'at_most')) {
      lines.push('  the calorie target is priced off basal: what you trained and worked today (the OUT lines above) comes off on top of it');
    }
  } else if ((scored || []).length) {
    lines.push('GOALS — set, but nothing logged today to score them against');
  } else {
    lines.push('GOALS — none set');
  }

  // ── LEFT — the target less what is eaten, off the plan's own numbers ──────
  if (left?.say) lines.push(`LEFT — ${left.say}`);

  // ── WEEK ──────────────────────────────────────────────────────────────────
  if (week?.say) lines.push(`WEEK — ${week.say}`);

  return {
    date: date || day.date,
    partial,
    in: inn,
    training, work, moved,
    out: receipt?.out ? {
      total: receipt.out.total,
      // Which figure counted for "other" and whether it is a projection —
      // the card words its rows off these, never a bare number.
      source: receipt.out.source ?? null, projected: !!receipt.out.projected,
      lines: receipt.out.lines.map(l => ({ what: l.what, calories: l.calories, ...(l.note ? { note: l.note } : {}), ...(l.basis ? { basis: l.basis } : {}), ...(l.of?.length ? { of: l.of } : {}) })),
    } : null,
    net: receipt?.net ?? null,
    set_aside: receipt?.set_aside || [],
    goals,
    left: left || null,
    // Whether a care flag stands — the card withholds the net and the held
    // target from an unprompted reply when it does.
    flagged: !!flags?.length,
    week: week ? { say: week.say, done: week.done ?? null, target: week.target ?? null } : null,
    // Why the burn is missing, when it is — the card says it rather than
    // drawing an empty balance.
    ...(receipt?.out ? {} : { out_missing: balance?.missing || [] }),
    estimated: true,
    say: lines.join('\n'),
    note: 'THIS IS THE WHOLE DAY. Read it out LINE BY LINE as it stands — every item eaten with its own calories, the session, the work, the steps, the burn added up WITH EVERY INPUT UNDER IT (the resting figure and what it is computed from, each session, each shift with its hours, the watch\'s figure for the day, and which of them counted and which was set aside and why), the net with its sign, each goal with its percentage, the week. Never collapse the burn into "resting + active" — every calorie is accounted for on its own line and that is the point. Never quote only a total, never add anything up yourself, never answer "where am I at" from the food alone. ' +
      (partial ? 'Say the day is not over: the burn is a whole-day figure and the food is only what has been logged so far. ' : '') +
      (left ? '"How much should I eat today" / "how much have I got left" is the LEFT line, said as it stands: the figure left (or that it is withheld and why), the target and its basis — basal less the deficit — and that today\'s burn comes off on top. Never a figure of your own, never recomputed. '
        : goals.some(g => g.metric === 'calories' && g.direction === 'at_most') ? '"How much should I eat today" is answered from the calorie GOALS line as it stands — the target, where the day is against it, and that the target is priced off basal so today\'s training and work come off on top of it. Never a figure of your own. ' : '') +
      (moved.fresh?.stale ? `Say WHEN the watch figures are from (${moved.fresh.at}) — never present them as current; if they want them current, the Wrought app on their phone sends the latest the moment it opens. ` : '') +
      'Every figure is an estimate and is said to be one.',
  };
}


// ── THE CARD — the layout the founder asked to keep ─────────────────────────
//
// 26 September. ChatGPT drew his day on its own: a table of what he ate with
// each item's calories and the total underneath, then an "energy balance" —
// eaten, the burn, the net. "Love the format." The next reply was a
// paragraph again: "what about the layout from before like I asked her to
// keep — why don't you ever do what I ask?"
//
// A layout the model invents is a layout the model can drop, and its numbers
// were its own. So the card is composed HERE, from dayReadout's figures and
// nothing else: the items and totals are `in`, the burn rows are the
// receipt's three counted lines (which sum to the total — the harness holds
// it), the net is the receipt's, what is left is leftFor's. Nothing is added
// up in this function. Markdown, because every chat client renders a table.
//
// The rules it keeps, each one already this server's:
//   - a missing figure is never a zero: an item with no calories says so, a
//     missing macro is a dash said to be one, and a day with no calories
//     counted has no "Eaten" row and no net;
//   - nothing eaten yet is not a deficit, and neither is a burn that is only
//     the resting half because the watch has not sent — no net on either;
//   - every burn row says where it came from: the work that counted, the
//     watch and when it sent, a projection named as one;
//   - under a care flag an unprompted reply carries neither the net nor the
//     held target; a read somebody asked for carries both, as dayReadout does.
const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim();
const grams = v => (n(v) == null ? '—' : `${money(v)}g`);

function workLabel(read) {
  const src = read.out?.source;
  const work = (read.work || []).filter(w => w.calories != null);
  const at = read.moved?.fresh?.at && !read.moved.fresh.final ? `, as of ${read.moved.fresh.at}` : '';
  if ((src === 'logged' || src === 'logged_over_device') && work.length) {
    return `work: ${work.map(w => `${w.what}${w.hours ? `, ${w.hours}h on task` : ''}`).join('; ')}`;
  }
  if (src === 'device') return `watch${at}`;
  if (src === 'activity_level') return 'projected from your activity level — nothing measured it';
  if (src === 'awaiting_device') return 'the watch has not sent today — nothing counted yet';
  return 'nothing is measuring it';
}

export function dayCard(read, { explicit = false } = {}) {
  if (!read) return null;
  const partial = !!read.partial;
  const inn = read.in || { items: [], total: 0 };
  const items = inn.items || [];
  const counted = items.some(it => n(it.calories) != null);
  const flagged = !!read.flagged;
  const out = [];

  // ── What was eaten ──────────────────────────────────────────────────────
  out.push(`**${partial ? 'Today\'s calorie breakdown so far' : `Calorie breakdown · ${read.date}`}**`, '');
  if (items.length) {
    out.push('| Food | kcal | Protein | Carbs | Fat |', '|---|---:|---:|---:|---:|');
    for (const it of items) {
      out.push(`| ${cell(`${it.what}${it.at ? ` (${it.at})` : ''}`)} | ${n(it.calories) == null ? 'not counted yet' : money(it.calories)} | ${grams(it.protein_g)} | ${grams(it.carbs_g)} | ${grams(it.fat_g)} |`);
    }
    const has = k => items.some(it => n(it[k]) != null);
    out.push(`| **Total** | **${counted ? money(inn.total) : 'not counted yet'}** | **${has('protein_g') ? grams(inn.protein_g) : '—'}** | **${has('carbs_g') ? grams(inn.carbs_g) : '—'}** | **${has('fat_g') ? grams(inn.fat_g) : '—'}** |`, '');
    const bare = items.filter(it => n(it.protein_g) == null || n(it.carbs_g) == null || n(it.fat_g) == null).length;
    if (bare) out.push(bare === items.length
      ? '— means that figure is not on the item yet.'
      : `— means that figure is not on the item yet: ${bare} of ${items.length} items have none, so those totals count only the items that carry them.`);
    const extra = [inn.sugar_g != null ? `sugar ${money(inn.sugar_g)}g` : null, inn.fibre_g != null ? `fibre ${money(inn.fibre_g)}g` : null, inn.sat_fat_g != null ? `saturated fat ${money(inn.sat_fat_g)}g` : null].filter(Boolean);
    if (extra.length) out.push(`${extra.join(' · ').replace(/^./, c => c.toUpperCase())}${bare ? ' (of the items that carry it)' : ''}.`);
    if (inn.without_calories) out.push(`${inn.without_calories} item${inn.without_calories === 1 ? ' has' : 's have'} no calories on ${inn.without_calories === 1 ? 'it' : 'them'} yet, so the real total is higher.`);
  } else {
    out.push(partial ? 'Nothing eaten is logged yet today.' : 'Nothing eaten was logged this day.');
  }
  out.push('');

  // ── The energy balance ──────────────────────────────────────────────────
  out.push(`**${partial ? 'Today\'s estimated energy balance' : 'Estimated energy balance'}**`, '');
  const notes = [];
  if (read.out) {
    const awaiting = read.out.source === 'awaiting_device';
    const trainSaid = (read.training || []).map(t => `${t.what}${t.minutes ? `, ${t.minutes} min` : ''}`).join('; ');
    out.push('| | kcal |', '|---|---:|');
    if (counted) out.push(`| Eaten | ${money(inn.total)} |`);
    for (const l of read.out.lines || []) {
      const said = /^resting/i.test(l.what) ? '' : /^training/i.test(l.what) ? (trainSaid ? ` (${trainSaid})` : '') : ` (${workLabel(read)})`;
      out.push(`| ${cell(`${l.what}${said}`)} | ${money(l.calories)} |`);
    }
    out.push(`| **${awaiting ? 'Burn counted so far — resting only' : partial ? `Burn for the whole day${read.out.projected ? ', projected' : ''}` : 'Burn'}** | **${money(read.out.total)}** |`);
    // NO NET off nothing eaten, off a resting-only burn, or — unprompted —
    // under a care flag. Each of those is a number that reads as a deficit
    // the person has not run.
    const net = n(read.net);
    if (net != null && counted && n(inn.total) > 0 && !awaiting && (!flagged || explicit)) {
      out.push(`| **Net${partial ? ' so far' : ''}** | **${net < 0 ? `${money(-net)} down` : net > 0 ? `${money(net)} over` : 'level'}** |`);
    }
    out.push('');
    if (awaiting) notes.push('No net yet: the watch has not sent today, so only the resting burn is counted.');
    for (const s of read.set_aside || []) notes.push(`Not added: ${s.replace(/the total below/g, 'the total above')}`);
  } else {
    const miss = read.out_missing || [];
    out.push(`Calories out isn't known yet${miss.length ? ` — it needs ${miss.join(' and ')}` : ''}.`, '');
  }

  const mv = read.moved || {};
  if (mv.steps != null) {
    const when = mv.fresh?.at && !mv.fresh.final ? `, as of ${mv.fresh.at}` : mv.fresh?.final ? ', full day' : '';
    notes.push(`Steps: **${money(mv.steps)}** (watch${when})`);
  }
  // What is left — and under a care flag the held line only on a read the
  // person ASKED for; an unprompted reply never carries the held target.
  if (read.left?.short && (!read.left.withheld || explicit)) notes.push(`Left: ${read.left.short}`);
  if (read.week?.say) notes.push(`Week: ${read.week.say}`);
  // A list, so a strict markdown renderer keeps each on its own line.
  for (const x of notes) out.push(`- ${x}`);
  if (notes.length) out.push('');
  out.push(`_Every figure is an estimate.${partial ? ' The day isn\'t over: the burn is the whole day, the food is only what\'s logged so far.' : ''}_`);

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// How the card is to be shown — one sentence, shared by every reply that
// carries it, so the instruction cannot drift between tools.
export const DAY_CARD_NOTE = 'SHOW day_card EXACTLY AS WRITTEN — it is the layout the person asked to keep: the food table with each item\'s calories and macros and the totals, then the energy balance. Put it after your first line, as markdown, unchanged: never rebuild it, reorder it, drop a row, add a row or a figure of your own, or turn any number into a range. If more than one reply this turn carries day_card, show only the LATEST one, once. ';
