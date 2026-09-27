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
  // How much of the day the burn covers, decided once (burnSpan) and shared
  // with the receipt and the card, so the three never make different calls
  // about whether a net can be given.
  const span = burnSpan({ balance, day, partial });
  const cav = netCaveat(span, { partial, training: n(balance?.training_burn) || 0 });

  // ── IN ────────────────────────────────────────────────────────────────────
  const food = (day.log || []).filter(e => e.type === 'food' || e.type === 'drink');
  // Every item with ALL of its numbers, and the total in the same shape —
  // "a total always of everything you've eaten and broken down." macroLine
  // is the one renderer, shared with the log confirmation and the receipt.
  const inn = {
    total: n(day.food?.calories) || 0,
    protein_g: n(day.food?.protein_g) || 0, carbs_g: n(day.food?.carbs_g) || 0, fat_g: n(day.food?.fat_g) || 0,
    // Null when no item carries them, never a zero standing in — the day's
    // sums start at zero, so the day's own figure cannot say.
    ...Object.fromEntries(['sugar_g', 'fibre_g', 'sat_fat_g'].map(k => [k, food.some(e => n(e[k]) != null) ? n(day.food?.[k]) : null])),
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
      ? `NET — nothing eaten is logged yet, so there is no in-versus-out; ${!cav.show ? cav.why
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
    net: cav.show ? (receipt?.net ?? null) : null,
    // What the burn covers — the card reads this rather than deciding again.
    burn: { half: span.half, resting_whole: span.restingWhole, watch_so_far: span.watchSoFar, short: span.short, at: span.at, net_shown: cav.show, ...(cav.show ? {} : { net_why: cav.why }) },
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
      (receipt?.out && !cav.show ? `There is NO NET today: ${cav.why}. Say so and never work one out yourself. ` : '') +
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
const cell = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim();
const grams = v => (n(v) == null ? '—' : `${money(v)}g`);
// Every clock on the card reads the same way: "17:00" off the log becomes
// "5:00pm", like the watch's "as of 6:01pm" beside it.
const clock = at => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at || ''));
  if (!m) return at || '';
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]}${h < 12 ? 'am' : 'pm'}`;
};
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayName = iso => {
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

export function dayCard(read, { explicit = false } = {}) {
  if (!read) return null;
  const partial = !!read.partial;
  const inn = read.in || { items: [], total: 0 };
  const items = inn.items || [];
  const counted = items.some(it => n(it.calories) != null);
  const has = k => items.some(it => n(it[k]) != null);
  const flagged = !!read.flagged;
  const out = [];

  // ── What was eaten ──────────────────────────────────────────────────────
  out.push(`**${partial ? 'Today\'s calorie breakdown so far' : `Calorie breakdown · ${dayName(read.date)}`}**`, '');
  if (items.length) {
    out.push('| Food | kcal | Protein | Carbs | Fat |', '|---|---:|---:|---:|---:|');
    for (const it of items) {
      out.push(`| ${cell(`${it.what}${it.at ? ` (${clock(it.at)})` : ''}`)} | ${n(it.calories) == null ? 'not counted yet' : money(it.calories)} | ${grams(it.protein_g)} | ${grams(it.carbs_g)} | ${grams(it.fat_g)} |`);
    }
    out.push(`| **Total** | **${counted ? money(inn.total) : 'not counted yet'}** | **${has('protein_g') ? grams(inn.protein_g) : '—'}** | **${has('carbs_g') ? grams(inn.carbs_g) : '—'}** | **${has('fat_g') ? grams(inn.fat_g) : '—'}** |`, '');
    // Captions, each its own paragraph so no renderer runs them together.
    const bare = items.filter(it => n(it.protein_g) == null || n(it.carbs_g) == null || n(it.fat_g) == null).length;
    if (bare) out.push(bare === items.length
      ? '— means that figure is not on the item yet.'
      : `— means that figure is not on the item yet: ${bare} of ${items.length} items ${bare === 1 ? 'has' : 'have'} none, so those totals count only the items that carry them.`, '');
    // Sugar, fibre and saturated fat — only the ones some item carries. The
    // day's sums start at zero, so a figure no item holds is a zero that was
    // never there; it is left out, and a partial one says so.
    const extra = [['sugar_g', 'sugar'], ['fibre_g', 'fibre'], ['sat_fat_g', 'saturated fat']]
      .filter(([k]) => has(k))
      .map(([k, label]) => `${label} ${money(inn[k])}g${items.every(it => n(it[k]) != null) ? '' : ' (only the items that carry it)'}`);
    if (extra.length) out.push(`${extra.join(' · ').replace(/^./, c => c.toUpperCase())}.`, '');
    if (inn.without_calories) out.push(`${inn.without_calories} item${inn.without_calories === 1 ? ' has' : 's have'} no calories on ${inn.without_calories === 1 ? 'it' : 'them'} yet, so the real total is higher.`, '');
  } else {
    out.push(partial ? 'Nothing eaten is logged yet today.' : 'Nothing eaten was logged this day.', '');
  }

  // ── The energy balance ──────────────────────────────────────────────────
  out.push(`**${partial ? 'Today\'s estimated energy balance' : 'Estimated energy balance'}**`, '');
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
    out.push('| | kcal |', '|---|---:|');
    if (counted) out.push(`| Eaten | ${money(inn.total)} |`);
    for (const l of read.out.lines || []) {
      const said = /^resting/i.test(l.what) ? '' : /^training/i.test(l.what) ? (trainSaid ? ` (${trainSaid})` : '') : ` (${workLabel(read, train)})`;
      out.push(`| ${cell(`${l.what}${said}`)} | ${money(l.calories)} |`);
    }
    const counts = `resting${train > 0 ? ' and training' : ''} only`;
    const projected = read.out.projected || (src === 'logged' && levelWon(read));
    const burnLabel = halfBurn
      ? (partial && src === 'awaiting_device' ? `Burn counted so far — ${counts}` : `Burn counted — ${counts}`)
      : restingPart
        ? `Burn counted so far — the watch's resting figure only up to ${at || 'its last send'}`
        : watchSoFar
          ? (at ? `Burn so far — resting for the whole day, the watch as of ${at}` : 'Burn so far')
          : short ? `Burn — the watch only as of ${at || 'its last send'}`
          : partial ? `Burn for the whole day${projected ? ', projected' : ''}` : `Burn${projected ? ', projected' : ''}`;
    out.push(`| **${burnLabel}** | **${money(read.out.total)}** |`);
    // NO NET off nothing eaten, off a half burn, or — unprompted — under a
    // care flag. Each is a number that reads as a deficit (or a surplus) the
    // person has not run.
    const net = n(read.net);
    if (net != null && burn.net_shown !== false && counted && n(inn.total) > 0 && !halfBurn && !restingPart && (!flagged || explicit)) {
      out.push(`| **Net${partial ? ' so far' : ''}** | **${net < 0 ? `${money(-net)} down` : net > 0 ? `${money(net)} over` : 'level'}** |`);
    }
    out.push('');
    // The reason, in the read's own words — never a second wording here.
    if (burn.net_shown === false && counted && n(inn.total) > 0) {
      // "Yet" only where the rest of the burn is coming — a watch still to
      // send, a basal still accruing. Nothing measuring the day never will.
      notes.push(`No net${partial && (src === 'awaiting_device' || restingPart) ? ' yet' : ''}: ${burn.net_why}.`);
    }
    if (short) notes.push(`The watch stopped reporting for this day at ${at || 'before midnight'}, so the evening is missing from the burn: the real burn is higher${net != null ? ' and the real net further down' : ''}.`);
    for (const s of read.set_aside || []) {
      // Said once already, under the food table.
      if (/you ate (has|have) no calories/.test(s)) continue;
      notes.push(`Not added: ${s.replace(/log it with log_activity instead/, 'say so and it goes in as work instead')}`);
    }
  } else {
    const miss = read.out_missing || [];
    out.push(`Calories out isn't known yet${miss.length ? ` — it needs ${miss.join(' and ')}` : ''}.`, '');
  }
  // A shift with no figure yet is on the record and counts for nothing —
  // said, never left off the card.
  for (const w of (read.work || []).filter(x => x.calories == null)) {
    notes.push(`${w.what}${w.hours ? ` (${w.hours}h on task)` : ''}: not priced yet — it needs a recent weigh-in.`);
  }

  const mv = read.moved || {};
  if (mv.steps != null) {
    const when = mv.fresh?.at && !mv.fresh.final ? `, as of ${mv.fresh.at}` : mv.fresh?.final ? ', full day' : '';
    notes.push(`Steps: **${money(mv.steps)}** (watch${when})`);
  }
  // What is left — and under a care flag the held line only on a read the
  // person ASKED for; an unprompted reply never carries the held target.
  if (read.left?.short && (!read.left.withheld || explicit)) {
    const uncounted = !read.left.withheld && inn.without_calories
      ? ` Plus ${inn.without_calories} item${inn.without_calories === 1 ? '' : 's'} with no calories yet, so ${read.left.over ? 'the real figure over is higher' : 'the real figure left is lower'}.`
      : '';
    notes.push(`${read.left.over ? 'Target' : 'Left'}: ${read.left.short}${uncounted}`);
  }
  if (read.week?.say) notes.push(`Week: ${read.week.say}`);
  // A list, so a strict markdown renderer keeps each on its own line.
  for (const x of notes) out.push(`- ${x}`);
  if (notes.length) out.push('');
  out.push(`_Every figure is an estimate.${!partial ? ''
    : !read.out || halfBurn ? ' The day isn\'t over: the food is only what\'s logged so far.'
    : restingPart ? ' The day isn\'t over: the burn and the food are only what\'s in so far.'
    : watchSoFar ? ` The day isn't over: resting is the whole day, the watch's part${at ? ` is as of ${at}` : ' is only what it has sent'}, and the food is only what's logged so far.`
    : ' The day isn\'t over: the burn is the whole day, the food is only what\'s logged so far.'}_`);

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// How the card is to be shown — one sentence, shared by every reply that
// carries it, so the instruction cannot drift between tools.
export const DAY_CARD_NOTE = 'SHOW day_card EXACTLY AS WRITTEN — it is the layout the person asked to keep: the food table with each item\'s calories and macros and the totals, then the energy balance. Put it after your first line, as markdown, unchanged: never rebuild it, reorder it, drop a row, add a row or a figure of your own, or turn any number into a range. If more than one reply this turn carries a day_card for the same day, show only the LATEST one, once. ';
