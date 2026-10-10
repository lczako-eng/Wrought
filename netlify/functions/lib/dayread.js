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

import { outSay, burnSpan, netCaveat } from './receipt.js';
import { macroLine, macroSplit, clock12 } from './wrought.js';
import { writtenFlag } from './voice.js';

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
  // How much of the day the burn covers, decided once (burnSpan) and shared
  // with the receipt and the card, so the three never make different calls
  // about whether a net can be given.
  const span = burnSpan({ balance, day, partial });
  const cav = netCaveat(span, { partial, training: n(balance?.training_burn) || 0 });

  // ── IN ────────────────────────────────────────────────────────────────────
  const food = (day.log || []).filter(e => e.type === 'food' || e.type === 'drink');
  // Whether ANY item carries a calorie figure. With none, the day's total is
  // unknown, never zero: "IN — 0 kcal" off a toast logged with no figure (6
  // October) read as a day with nothing in it.
  const counted = food.some(e => n(e.calories) != null);
  // Nothing with a figure, or figures that come to nothing (a black coffee):
  // there is no intake to subtract, so there is no net — today or any day.
  const noIntake = !counted || !(n(day.food?.calories) > 0);
  // Every item with ALL of its numbers, and the total in the same shape —
  // "a total always of everything you've eaten and broken down." macroLine
  // is the one renderer, shared with the log confirmation and the receipt.
  const inn = {
    total: counted ? (n(day.food?.calories) || 0) : null,
    counted,
    protein_g: n(day.food?.protein_g) || 0, carbs_g: n(day.food?.carbs_g) || 0, fat_g: n(day.food?.fat_g) || 0,
    // Null when no item carries them, never a zero standing in — the day's
    // sums start at zero, so the day's own figure cannot say.
    ...Object.fromEntries(['sugar_g', 'fibre_g', 'sat_fat_g'].map(k => [k, food.some(e => n(e[k]) != null) ? n(day.food?.[k]) : null])),
    items: food.map(e => ({
      // The row's id, so a card can mark the rows a reply just wrote.
      id: e.id ?? null,
      at: e.at, what: e.summary, calories: e.calories,
      protein_g: e.protein_g ?? null, carbs_g: e.carbs_g ?? null, fat_g: e.fat_g ?? null,
      sugar_g: e.sugar_g ?? null, fibre_g: e.fibre_g ?? null, sat_fat_g: e.sat_fat_g ?? null,
      estimated: e.estimated,
    })),
    without_calories: n(day.food?.meals_uncounted) || 0,
  };
  lines.push(!food.length
    ? 'IN — nothing logged'
    : !counted
      ? `IN — ${food.length} thing${food.length === 1 ? '' : 's'} logged, no calories on ${food.length === 1 ? 'it' : 'any of them'} yet — the total is unknown rather than zero`
      : `IN — ${macroLine({ ...inn, calories: inn.total })}${day.food?.estimated ? ' (estimated)' : ''}`);
  for (const it of inn.items) lines.push(`  ${it.at ? `${it.at} ` : ''}${it.what} — ${macroLine(it)}`);
  if (inn.without_calories && counted) lines.push(`  (${inn.without_calories} with no calories, so the real intake is higher)`);

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
    // And a FINISHED day with nothing counted is the same: an unlogged day in
    // the past is not a day somebody fasted, and "0 in − 3,179 out = 3,179
    // down" off it is a deficit nobody ran.
    lines.push(noIntake && !partial
      ? `NET — ${food.length && !counted ? 'nothing with a calorie figure was logged this day' : food.length ? 'nothing with calories in it was logged this day' : 'nothing eaten was logged this day'}, so there is no in-versus-out`
      : partial && noIntake
      ? `NET — ${food.length && !counted ? 'nothing with a calorie figure is logged yet' : 'nothing eaten is logged yet'}, so there is no in-versus-out; ${!cav.show ? cav.why
        : span.watchSoFar ? `the burn above is resting for the whole day plus the watch as of ${span.at || 'its last send'}`
        : 'the burn above is the whole day\'s estimate'}`
      : !cav.show ? `NET — not worked out: ${cav.why}`
      : `NET — ${receipt.math.net}${cav.tail ? ` ${cav.tail}` : ''}`);
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
    // No net off items that carry no figure (their zero is not a zero), and
    // none off a day with nothing eaten on it — the NET line's own rule.
    net: cav.show && !noIntake ? (receipt?.net ?? null) : null,
    // What the burn covers — the card reads this rather than deciding again.
    burn: { half: span.half, resting_whole: span.restingWhole, watch_so_far: span.watchSoFar, short: span.short, at: span.at, net_shown: cav.show, ...(cav.show ? {} : { net_why: cav.why }) },
    set_aside: receipt?.set_aside || [],
    goals,
    left: left || null,
    // Whether a care flag stands — the card withholds the net and the held
    // target from an unprompted reply when it does.
    flagged: !!flags?.length,
    // The flags as a person reads them on the card — each flag's `guidance`
    // is written for a model, and the spoken form says "tap to review", which
    // a card has nothing to tap for: the review happens in the conversation.
    flag_says: (flags || []).map(writtenFlag).filter(Boolean),
    week: week ? { say: week.say, done: week.done ?? null, target: week.target ?? null } : null,
    // Why the burn is missing, when it is — the card says it rather than
    // drawing an empty balance.
    ...(receipt?.out ? {} : { out_missing: balance?.missing || [] }),
    estimated: true,
    say: lines.join('\n'),
    note: 'THIS IS THE WHOLE DAY. Read it out LINE BY LINE as it stands — every item eaten with its own calories, the session, the work, the steps, the burn added up WITH EVERY INPUT UNDER IT (the resting figure and what it is computed from, each session, each shift with its hours, the watch\'s figure for the day, and which of them counted and which was set aside and why), the net with its sign, each goal with its percentage, the week. Never collapse the burn into "resting + active" — every calorie is accounted for on its own line and that is the point. Never quote only a total, never add anything up yourself, never answer "where am I at" from the food alone. ' +
      (receipt?.out && noIntake ? 'There is NO NET: nothing with calories is logged for this day, so there is no in-versus-out. Say so and never work one out yourself. '
        : receipt?.out && !cav.show ? `There is NO NET today: ${cav.why}. Say so and never work one out yourself. ` : '') +
      (partial ? (span.watchSoFar
        ? `Say the day is not over: resting is a whole-day figure, the watch's part is only as of ${span.at || 'its last send'}, and the food is only what has been logged so far. `
        : !span.restingWhole ? 'Say the day is not over: the resting figure is only what the watch had counted so far, and the food is only what has been logged so far. '
        : 'Say the day is not over: the burn is a whole-day figure and the food is only what has been logged so far. ') : '') +
      (span.short ? `Say the watch stopped reporting for this day at ${span.at || 'before midnight'}, so the burn is short and the real net is further down. ` : '') +
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
//
// ONE DECISION, TWO RENDERERS. dayModel makes every one of those calls and
// returns strings; dayMarkdown prints them as the table a model relays, and
// dayView hands the same strings to Wrought's own drawn card. The text and the
// picture therefore cannot disagree about a figure, a label or a withheld net.
const cell = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim();
const grams = v => (n(v) == null ? '—' : `${money(v)}g`);
// Every clock on the card reads the same way: "17:00" off the log becomes
// "5:00pm", like the watch's "as of 6:01pm" beside it. One clock, in
// lib/wrought.js, shared with the log confirmation.
const clock = at => clock12(at);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const dayName = iso => {
  const d = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

// Where the "work and moving about" figure came from — read off the
// receipt's own inputs, so the row never names a shift the watch outranked,
// never calls the watch's figure less the training "the watch", and never
// credits the sedentary floor or a projection to the work.
// The activity-level projection beat the logged work — the "other" figure is
// then a forecast, whatever the balance's own flag says.
const levelWon = read => (read.out?.lines || []).find(l => /^work/i.test(l.what))?.of?.some(i => /activity level/i.test(i.what) && i.counted) || false;

function workLabel(read, train) {
  const src = read.out?.source;
  const of = (read.out?.lines || []).find(l => /^work/i.test(l.what))?.of || [];
  const fresh = read.moved?.fresh;
  const at = fresh?.at && !fresh.final ? `as of ${fresh.at}` : '';
  const shifts = (read.work || []).filter(w => w.calories != null)
    .map(w => `${w.what}${w.hours ? `, ${w.hours}h on task` : ''}`).join('; ');
  const lessTrain = train > 0 ? ', less the training above' : '';
  switch (src) {
    case 'logged_over_device':
      return `work: ${shifts}`;
    case 'device': {
      const watch = of.find(i => i.measured);
      return train > 0 && watch
        ? `the watch's ${money(watch.calories)}${at ? ` ${at}` : ''}, less the training above`
        : `watch${at ? `, ${at}` : ''}`;
    }
    case 'logged':
      return levelWon(read)
        ? `projected from your activity level, which is above the work you logged${lessTrain}`
        : `work: ${shifts}, plus the rest of the day at the sedentary floor${lessTrain}`;
    case 'activity_level':
      return `projected from your activity level — nothing measured it${lessTrain}`;
    case 'awaiting_device':
      return read.partial ? 'the watch has not sent today — nothing counted yet' : 'the watch sent nothing for this day';
    default:
      return 'nothing is measuring it';
  }
}

// A note under the balance: a lead word, an optional bold figure and the
// rest, so the markdown line ("Steps: **8,020** (watch, as of 6:01pm)") and
// the drawn card's line are the same three strings.
const noteOf = (kind, lead, body, strong = null) => ({
  kind, lead, strong, body,
  text: lead ? (strong != null ? `${lead}: **${strong}** ${body}` : `${lead}: ${body}`) : body,
});

/**
 * Every decision the day card makes, made once — pure. The markdown table
 * (dayMarkdown) and Wrought's own drawn card (dayView) both print THIS, so the
 * two can never disagree about a figure, a label, a withheld net or a note.
 */
export function dayModel(read, { explicit = false } = {}) {
  if (!read) return null;
  const partial = !!read.partial;
  const inn = read.in || { items: [], total: null };
  const items = inn.items || [];
  const counted = items.some(it => n(it.calories) != null);
  const has = k => items.some(it => n(it[k]) != null);
  const flagged = !!read.flagged;

  // ── What was eaten ──────────────────────────────────────────────────────
  // The founder's layout, 8 October — "I love the format … keep the format":
  // a label, the day's calories as the headline, every item with its own
  // calories in a two-column table, the total under it, then protein, carbs
  // and fat as three figures of their own. The time rides on the item (the
  // meal-timing doctrine: a clock read back is a clock that can be put right);
  // an item's own macros ride on the log confirmation and, on the drawn card,
  // under a tap.
  const food = {
    title: partial ? 'Estimated food intake · today so far' : `Estimated food intake · ${dayName(read.date)}`,
    head: { what: 'Food', kcal: 'Calories' },
    items: items.map(it => ({
      id: it.id ?? null, what: it.what, at: it.at ? clock(it.at) : '',
      kcal: n(it.calories) == null ? null : money(it.calories),
      protein: grams(it.protein_g), carbs: grams(it.carbs_g), fat: grams(it.fat_g),
    })),
    counted,
    headline: counted ? { figure: money(inn.total), unit: 'calories' } : null,
    total: {
      kcal: counted ? money(inn.total) : null,
      protein: has('protein_g') ? grams(inn.protein_g) : '—',
      carbs: has('carbs_g') ? grams(inn.carbs_g) : '—',
      fat: has('fat_g') ? grams(inn.fat_g) : '—',
    },
    // Protein, carbs and fat — only a macro some item carries. A macro no
    // item holds is a zero that was never there: it is left out, never drawn
    // as "0 g", and a partial one is said to be partial underneath.
    macros: items.length
      ? [['protein', 'Protein', 'protein_g'], ['carbs', 'Carbs', 'carbs_g'], ['fat', 'Fat', 'fat_g']]
        .filter(([, , k]) => has(k))
        .map(([key, label, k]) => ({ key, label, value: money(inn[k]), unit: 'g' }))
      : [],
    captions: [],
    // The drawn card prints the same sentences: neither draws a dash for a
    // missing macro any more, so neither explains one.
    card_captions: [],
    empty: items.length ? null : (partial ? 'Nothing eaten is logged yet today.' : 'Nothing eaten was logged this day.'),
  };
  const caption = text => { food.captions.push(text); food.card_captions.push(text); };
  if (items.length) {
    // Captions, each its own paragraph so no renderer runs them together.
    const bare = items.filter(it => n(it.protein_g) == null || n(it.carbs_g) == null || n(it.fat_g) == null).length;
    if (bare && food.macros.length) caption(bare === items.length
      ? `${items.length === 1 ? 'It is' : 'Every item is'} missing protein, carbs or fat, so the macro figures are partial.`
      : `${bare} of ${items.length} items ${bare === 1 ? 'is' : 'are'} missing protein, carbs or fat, so those totals count only the items that carry them.`);
    else if (bare) caption(`${items.length === 1 ? 'It has' : 'No item has'} protein, carbs or fat on it yet.`);
    // Sugar, fibre and saturated fat — only the ones some item carries. The
    // day's sums start at zero, so a figure no item holds is a zero that was
    // never there; it is left out, and a partial one says so.
    const extra = [['sugar_g', 'sugar'], ['fibre_g', 'fibre'], ['sat_fat_g', 'saturated fat']]
      .filter(([k]) => has(k))
      .map(([k, label]) => `${label} ${money(inn[k])}g${items.every(it => n(it[k]) != null) ? '' : ' (only the items that carry it)'}`);
    if (extra.length) caption(`${extra.join(' · ').replace(/^./, c => c.toUpperCase())}.`);
    if (inn.without_calories) caption(`${inn.without_calories} item${inn.without_calories === 1 ? ' has' : 's have'} no calories on ${inn.without_calories === 1 ? 'it' : 'them'} yet, so the real total is higher.`);
  }

  // ── The energy balance ──────────────────────────────────────────────────
  const energy = { title: partial ? 'Today\'s estimated energy balance' : 'Estimated energy balance', known: !!read.out, rows: [], burn: null, net: null, missing: null };
  const notes = [];
  const src = read.out?.source;
  const fresh = read.moved?.fresh;
  // What the burn covers, as dayReadout decided it (burnSpan) — the card
  // never decides again, so it cannot print a net the read withheld.
  const burn = read.burn || {};
  const watchSoFar = !!burn.watch_so_far;
  // Only the resting half (and any training) is counted: the watch has not
  // sent, or nothing measures the rest of the day. The real burn is higher,
  // so a net here would read as eating over when somebody may be under.
  const halfBurn = !!burn.half;
  // The resting figure is the watch's basal as it stood at its last send —
  // part of the day, not the whole of it.
  const restingPart = burn.resting_whole === false;
  const short = !!burn.short;
  const at = burn.at || fresh?.at || null;
  if (read.out) {
    const trainLine = (read.out.lines || []).find(l => /^training/i.test(l.what));
    const train = n(trainLine?.calories) || 0;
    const trainSaid = (read.training || []).map(t => `${t.what}${t.minutes ? `, ${t.minutes} min` : ''}`).join('; ');
    if (counted) energy.rows.push({ label: 'Eaten', kcal: money(inn.total), eaten: true });
    for (const l of read.out.lines || []) {
      const said = /^resting/i.test(l.what) ? '' : /^training/i.test(l.what) ? (trainSaid ? ` (${trainSaid})` : '') : ` (${workLabel(read, train)})`;
      energy.rows.push({ label: `${l.what}${said}`, kcal: money(l.calories) });
    }
    const counts = `resting${train > 0 ? ' and training' : ''} only`;
    const projected = read.out.projected || (src === 'logged' && levelWon(read));
    energy.burn = {
      label: halfBurn
        ? (partial && src === 'awaiting_device' ? `Burn counted so far — ${counts}` : `Burn counted — ${counts}`)
        : restingPart
          ? `Burn counted so far — the watch's resting figure only up to ${at || 'its last send'}`
          : watchSoFar
            ? (at ? `Burn so far — resting for the whole day, the watch as of ${at}` : 'Burn so far')
            : short ? `Burn — the watch only as of ${at || 'its last send'}`
            : partial ? `Burn for the whole day${projected ? ', projected' : ''}` : `Burn${projected ? ', projected' : ''}`,
      kcal: money(read.out.total),
    };
    // NO NET off nothing eaten, off a half burn, or — unprompted — under a
    // care flag. Each is a number that reads as a deficit (or a surplus) the
    // person has not run.
    const net = n(read.net);
    if (net != null && burn.net_shown !== false && counted && n(inn.total) > 0 && !halfBurn && !restingPart && (!flagged || explicit)) {
      energy.net = net < 0
        ? { label: `Net${partial ? ' so far' : ''}`, value: `${money(-net)} down`, tone: 'down' }
        : net > 0
          ? { label: `Net${partial ? ' so far' : ''}`, value: `${money(net)} over`, tone: 'over' }
          : { label: `Net${partial ? ' so far' : ''}`, value: 'level', tone: 'level' };
    }
    // The reason, in the read's own words — never a second wording here.
    if (burn.net_shown === false && counted && n(inn.total) > 0) {
      // "Yet" only where the rest of the burn is coming — a watch still to
      // send, a basal still accruing. Nothing measuring the day never will.
      notes.push(noteOf('net_why', `No net${partial && (src === 'awaiting_device' || restingPart) ? ' yet' : ''}`, `${burn.net_why}.`));
    }
    if (short) notes.push(noteOf('short', null, `The watch stopped reporting for this day at ${at || 'before midnight'}, so the evening is missing from the burn: the real burn is higher${net != null ? ' and the real net further down' : ''}.`));
    for (const sa of read.set_aside || []) {
      // Said once already, under the food table.
      if (/you ate (has|have) no calories/.test(sa)) continue;
      notes.push(noteOf('set_aside', 'Not added', sa.replace(/log it with log_activity instead/, 'say so and it goes in as work instead')));
    }
  } else {
    const miss = read.out_missing || [];
    energy.missing = `Calories out isn't known yet${miss.length ? ` — it needs ${miss.join(' and ')}` : ''}.`;
  }
  // A shift with no figure yet is on the record and counts for nothing —
  // said, never left off the card.
  for (const w of (read.work || []).filter(x => x.calories == null)) {
    notes.push(noteOf('work', null, `${w.what}${w.hours ? ` (${w.hours}h on task)` : ''}: not priced yet — it needs a recent weigh-in.`));
  }

  const mv = read.moved || {};
  if (mv.steps != null) {
    const when = mv.fresh?.at && !mv.fresh.final ? `, as of ${mv.fresh.at}` : mv.fresh?.final ? ', full day' : '';
    notes.push(noteOf('steps', 'Steps', `(watch${when})`, money(mv.steps)));
  }
  // What is left — and under a care flag the held line only on a read the
  // person ASKED for; an unprompted reply never carries the held target.
  if (read.left?.short && (!read.left.withheld || explicit)) {
    const uncounted = !read.left.withheld && inn.without_calories
      ? ` Plus ${inn.without_calories} item${inn.without_calories === 1 ? '' : 's'} with no calories yet, so ${read.left.over ? 'the real figure over is higher' : 'the real figure left is lower'}.`
      : '';
    notes.push(noteOf('left', read.left.over ? 'Target' : 'Left', `${read.left.short}${uncounted}`));
  }
  if (read.week?.say) notes.push(noteOf('week', 'Week', read.week.say));
  const foot = `Every figure is an estimate.${!partial ? ''
    : !read.out || halfBurn ? ' The day isn\'t over: the food is only what\'s logged so far.'
    : restingPart ? ' The day isn\'t over: the burn and the food are only what\'s in so far.'
    : watchSoFar ? ` The day isn't over: resting is the whole day, the watch's part${at ? ` is as of ${at}` : ' is only what it has sent'}, and the food is only what's logged so far.`
    : ' The day isn\'t over: the burn is the whole day, the food is only what\'s logged so far.'}`;
  return { partial, flagged, explicit, date: read.date, food, energy, notes, foot };
}

/** The model's decisions as the markdown a chat client renders — the founder's layout. */
export function dayMarkdown(m) {
  if (!m) return null;
  const out = [];
  out.push(`**${m.food.title}**`, '');
  if (m.food.items.length) {
    if (m.food.headline) out.push(`### ${m.food.headline.figure} ${m.food.headline.unit}`, '');
    out.push(`| ${m.food.head.what} | ${m.food.head.kcal} |`, '|---|---:|');
    for (const it of m.food.items) {
      out.push(`| ${cell(`${it.what}${it.at ? ` (${it.at})` : ''}`)} | ${it.kcal == null ? 'not counted yet' : it.kcal} |`);
    }
    out.push(`| **Total** | **${m.food.total.kcal ?? 'not counted yet'}** |`, '');
    if (m.food.macros.length) out.push(m.food.macros.map(x => `**${x.label}** ${x.value} ${x.unit}`).join(' · '), '');
    for (const c of m.food.captions) out.push(c, '');
  } else {
    out.push(m.food.empty, '');
  }
  out.push(`**${m.energy.title}**`, '');
  if (m.energy.known) {
    out.push('| | kcal |', '|---|---:|');
    for (const r of m.energy.rows) out.push(`| ${r.eaten ? r.label : cell(r.label)} | ${r.kcal} |`);
    out.push(`| **${m.energy.burn.label}** | **${m.energy.burn.kcal}** |`);
    if (m.energy.net) out.push(`| **${m.energy.net.label}** | **${m.energy.net.value}** |`);
    out.push('');
  } else {
    out.push(m.energy.missing, '');
  }
  // A list, so a strict markdown renderer keeps each on its own line.
  for (const x of m.notes) out.push(`- ${x.text}`);
  if (m.notes.length) out.push('');
  out.push(`_${m.foot}_`);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function dayCard(read, { explicit = false } = {}) {
  return read ? dayMarkdown(dayModel(read, { explicit })) : null;
}

// ── Wrought's own card ─────────────────────────────────────────────────────
// What a chat host that draws MCP Apps cards (ChatGPT, Claude) prints for a
// reply that logged something or read the day: the founder's ask, exactly —
// "so distinctive [that it] tells you, in like a framing, that it's using the
// connector", in Wrought's colours. The model may drop a figure from its own
// words (the 570-kcal sausage confirmed with no number at 3:17pm on 6 October);
// it cannot drop one from the card, because the card is drawn from this.
//
// EVERY LEAF IS A STRING, A BOOLEAN OR NULL. The widget prints and never
// calculates; the only numbers it receives are a bar segment's `share` and a
// ring's `arc`, already worked out here and held to 0–100.
export const CARD_OPEN = 'https://wrought.fit/app.html';
// Rows shown before the earliest fold behind one written line. Measured: a
// five-row day with a just-logged block is about 800px at 390px, the limit a
// chat host gives a card.
const CARD_ROWS = 5;
const GOAL_LABEL = {
  steps: 'Steps', calories: 'Calories', protein_g: 'Protein', sleep_minutes: 'Sleep',
  workout_days: 'Sessions', weight_kg: 'Weight', distance_km: 'Distance', active_minutes: 'Active minutes',
};
const CLAMP = v => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Number(v))) : 0);
// A goal's figure in the person's own unit. A kcal unit rides on the "of"
// only — the tile is narrow — and a distance keeps its decimal.
const goalFigure = (v, unit) => {
  const u = String(unit || '').trim();
  const num = u === 'km' ? (Math.round(Number(v) * 10) / 10).toLocaleString() : money(v);
  return { value: `${num}${u === 'g' || u === 'km' ? u : u && u !== 'kcal' ? ` ${u}` : ''}`, unit: u };
};

/**
 * The rows a reply just wrote, for the card's "just logged" block — pure.
 * A named food with no figure says so in words, never a quiet dash: the 1:02pm
 * toast went in with nothing on it and nothing on the screen said so.
 */
export function justRows(items = []) {
  return (items || []).filter(Boolean).map(it => {
    const food = it.type === 'food' || it.type === 'drink';
    const kcal = n(it.calories);
    const anyMacro = ['protein_g', 'carbs_g', 'fat_g'].some(k => n(it[k]) != null);
    return {
      what: String(it.summary ?? it.what ?? 'entry'),
      // A row from another day than the one drawn carries its day too.
      at: [it.at ? clock(it.at) : null, it.date ? dayName(it.date) : null].filter(Boolean).join(' · ') || null,
      figure: kcal != null ? `${money(kcal)} kcal` : null,
      macros: anyMacro ? macroLine({ ...it, calories: null }) : null,
      flag: food && kcal == null ? 'No figure' : null,
      gap: food && kcal == null ? 'No calories on it yet — it counts for nothing in today\'s total until it has one.' : null,
      est: it.estimated && kcal != null ? 'estimated' : null,
    };
  });
}

/**
 * The "just logged" block for a reply that wrote `rows` — pure. A row the
 * day's table holds is marked there (bold, its time in heat) and never drawn
 * a second time: only the rows the table does not hold — a weigh-in, a
 * session, a day other than the one drawn — are listed. A seven-meal catch-up
 * drawn twice ran the card to 1,060px at 390, and since the founder's layout
 * (8 October) put the headline and the table first, even one meal repeated
 * above them pushed the table he asked for down the screen.
 *
 * @param inTable  whether the day's table holds a row (default: food and drink)
 */
export function justBlock(rows = [], { caption = 'Just logged', inTable = r => r.type === 'food' || r.type === 'drink' } = {}) {
  const shown = (rows || []).filter(Boolean).filter(r => !inTable(r));
  return shown.length ? { caption, rows: justRows(shown) } : null;
}

// The drawn card's view, off the model's own strings.
function viewOf(m, read, { explicit = false, badge = null, fresh = [], just = null } = {}) {
  const inn = read.in || {};
  const raw = inn.items || [];
  const fresher = new Set((fresh || []).filter(x => x != null).map(String));
  // The newest rows show; the earliest fold behind one line the server
  // writes. A row this reply just wrote never folds, wherever it sits — and
  // ONE row never folds: a "Show 1 earlier" line is as tall as the row it
  // hides, so a six-item day (the founder's 8 October) shows all six.
  const over = m.food.items.length - CARD_ROWS;
  let toFold = over > 1 ? over : 0;
  let folded = 0;
  const rows = m.food.items.map((it, i) => {
    const isFresh = it.id != null && fresher.has(String(it.id));
    const fold = toFold > 0 && !isFresh;
    if (fold) { toFold -= 1; folded += 1; }
    const r = raw[i] || {};
    const anyMacro = ['protein_g', 'carbs_g', 'fat_g'].some(k => n(r[k]) != null);
    return {
      id: it.id == null ? null : String(it.id), at: it.at, what: it.what,
      kcal: it.kcal ?? 'not counted yet', uncounted: it.kcal == null,
      protein: it.protein, carbs: it.carbs, fat: it.fat,
      macros: anyMacro ? macroLine({ ...r, calories: null }) : null,
      fresh: isFresh, folded: fold,
    };
  });
  // Protein, carbs and fat as three tiles, each with its share of the day's
  // calories drawn under it — split by CALORIES (macroSplit, the dashboard's
  // rule), and only over the macros some item actually carries. The share is
  // said in words only when every item carries all three: over a partial
  // record the split is of what was recorded, not of the day.
  const split = macroSplit(inn);
  const whole = raw.length > 0 && raw.every(r => ['protein_g', 'carbs_g', 'fat_g'].every(k => n(r[k]) != null));
  const tiles = m.food.macros.map(x => {
    const pct = split ? split[`${x.key}_pct`] : null;
    return {
      key: x.key, label: x.label, value: x.value, unit: x.unit,
      share: pct == null ? 0 : CLAMP(pct),
      share_label: whole && pct != null ? `${Math.round(pct)}% of kcal` : null,
    };
  });
  // Rings: the dashboard's verdict colours. Under a care flag the intake ring
  // goes — a ring filling toward a calorie ceiling is exactly the "at 80% of
  // target" message a flag silences — and every other ring stays: steps,
  // protein and the rest are record, not a push to eat less.
  // And a food ring with nothing behind it is not drawn: with no item
  // carrying calories (or protein) the day's sum is a zero that was never
  // there, and a ring at 0% would say the person ate nothing.
  const noFigure = g => (g.metric === 'calories' && !m.food.counted) || (g.metric === 'protein_g' && m.food.total.protein === '—');
  const goals = (read.goals || [])
    .filter(g => g && g.target != null && g.actual != null)
    .filter(g => !(m.flagged && g.metric === 'calories'))
    .filter(g => !noFigure(g));
  const targets = goals.slice(0, 4).map(g => {
    const a = goalFigure(g.actual, g.unit), t = goalFigure(g.target, g.unit);
    return {
      label: `${GOAL_LABEL[g.metric] || g.goal || g.metric}${g.cadence === 'weekly' ? ' this week' : ''}`,
      value: a.value,
      of: `of ${t.value}`,
      // A ceiling on a day still running is not "met" — it is where the day
      // stands against it, the read's own rule; passed is passed whenever.
      state: g.over && g.direction === 'at_most' ? 'over'
        : g.hit && !(m.partial && g.direction === 'at_most' && g.cadence !== 'weekly') ? 'met' : 'way',
      arc: CLAMP(g.percent),
    };
  });
  const flagged = m.flagged;
  return {
    v: 1, kind: 'day',
    badge: badge || (m.partial ? 'TODAY' : 'DAY'),
    date_label: m.partial ? `Today · ${dayName(m.date)}` : dayName(m.date),
    // A standing care flag: the human sentence, printed small at the foot of
    // the card (the header carries REVIEW), never a band across the day.
    // NO LINK. The dashboard has no review screen — the review is a sentence
    // to the assistant (review_intake_days) — so a "Review those days" button
    // landed on the top of the dashboard with nothing to review. The sentence
    // says what to tell the assistant instead; the card's one door stays.
    review: flagged ? {
      say: (read.flag_says || []).join(' ') || 'A care review stands on your record, so coaching is paused.',
      link: null,
      link_label: null,
    } : null,
    // On a reply nobody asked for, a flag withholds the net and what is left —
    // said once, in place of them.
    held: flagged && !explicit ? 'Net and what\'s left aren\'t shown while a review stands.' : null,
    just: just && Array.isArray(just.rows) && just.rows.length ? { caption: String(just.caption || 'Just logged'), rows: just.rows } : null,
    intake: {
      title: m.food.title,
      figure: m.food.headline ? m.food.headline.figure : null,
      unit: m.food.headline ? m.food.headline.unit : null,
      figure_missing: m.food.items.length && !m.food.counted ? 'not counted yet' : null,
      // Only beside a figure: an empty day draws no headline for it to mark.
      pill: m.food.items.length ? 'Estimated' : null,
      head: m.food.items.length ? { what: m.food.head.what, kcal: m.food.head.kcal } : null,
      tiles: tiles.length ? tiles : null,
      rows,
      more_label: folded ? `Show ${folded} earlier` : null,
      total: m.food.items.length
        ? { label: m.partial ? 'Total so far' : 'Total', kcal: m.food.total.kcal ?? 'not counted yet', unset: m.food.total.kcal == null, protein: m.food.total.protein, carbs: m.food.total.carbs, fat: m.food.total.fat }
        : null,
      empty: m.food.empty,
      captions: m.food.card_captions,
    },
    balance: {
      title: m.energy.title,
      rows: m.energy.rows.map(r => ({ label: r.label, kcal: r.kcal })),
      burn: m.energy.burn ? { label: m.energy.burn.label, kcal: m.energy.burn.kcal } : null,
      net: m.energy.net ? { label: m.energy.net.label, value: m.energy.net.value, tone: m.energy.net.tone } : null,
      missing: m.energy.missing,
    },
    notes: m.notes.map(x => ({ lead: x.lead, strong: x.strong, text: x.body })),
    targets: targets.length ? targets : null,
    targets_more: goals.length > 4 ? `${goals.length - 4} more in your record` : null,
    foot: m.foot,
    open: CARD_OPEN, open_label: 'Open your record',
  };
}

/**
 * The drawn card's view — pure.
 *
 * @param read      dayReadout(...) for the day
 * @param explicit  the person ASKED for the day (get_day, energy_balance,
 *                  brief, a log whose words asked) — under a care flag only an
 *                  asked-for read carries the net and the held target
 * @param badge     LOGGED / UPDATED / BRIEF; TODAY or DAY by default
 * @param fresh     ids of the rows this reply wrote — marked, never folded
 * @param just      { caption, rows: justRows(...) } — the write itself
 */
export function dayView(read, opts = {}) {
  return read ? viewOf(dayModel(read, { explicit: !!opts.explicit }), read, opts) : null;
}

/** The markdown and the drawn card from ONE model — a reply cannot carry one without the other. */
export function cardParts(read, opts = {}) {
  if (!read) return null;
  const m = dayModel(read, { explicit: !!opts.explicit });
  return { markdown: dayMarkdown(m), view: viewOf(m, read, opts) };
}

/** The burn as the card words it — its label and its figure — or null. */
export function burnPhrase(read) {
  const m = dayModel(read);
  return m?.energy?.burn ? { label: m.energy.burn.label, kcal: m.energy.burn.kcal } : null;
}

// How the card is to be shown — one sentence, shared by every reply that
// carries it, so the instruction cannot drift between tools. It opens with the
// TABLE, because the default in doubt is the table: a model cannot see whether
// a host drew Wrought's card, and a ChatGPT still holding the tool list from
// before the card existed never draws one. The panel is the exception, and
// only when the host has said so — skipping the table on a guess leaves
// somebody with neither. Where the panel IS drawn, pasting the table under it
// shows every figure twice, which is the cheaper of the two failures.
export const DAY_CARD_NOTE = 'SHOW day_card EXACTLY AS WRITTEN — it is the layout the person asked to keep: the day\'s calories as the headline, the Food / Calories table with each item and the total, the protein, carbs and fat line, then the energy balance. Put it after your first line, as markdown, unchanged: never rebuild it, reorder it, drop a row, add a row or a figure of your own, or turn any number into a range. If more than one reply this turn carries a day_card for the same day, show only the LATEST one, once. ONE EXCEPTION: if the host has told you that Wrought\'s own card was drawn for THIS reply (a dark WROUGHT panel with this day on it), that panel is the layout — do not paste day_card under it as well; give the reply\'s say line (on a write it opens "Logged in Wrought") and then only what the panel does not show, never a figure that differs from it. If you were not told, no panel was drawn: show day_card. ';
