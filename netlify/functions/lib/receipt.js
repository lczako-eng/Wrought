// lib/receipt.js
// The day as a receipt: every line with its own number, both sides, and the
// subtraction at the bottom.
//
// The founder, after logging four hours at the petting zoo and being told only
// that it was "logged as activity": "it should tell me everything, not just —
// I should see what those four hours of calories are worth against what's on
// there, and it should be kind of a receipt of everything, each calories for
// each. Be more specific."
//
// He is right, and it is the same argument he has now made three times: about
// the day card ("one steak's up to the right and the pizza's to the left"),
// about the conversation ("give the individual calories as well, not just a
// total"), and now about the OTHER SIDE OF THE SUBTRACTION. Every one of those
// was the same complaint — a total with nothing beside it is unauditable — and
// until now only the eating half had ever been itemised. The burn was three
// summed figures and a sentence, on the one product whose whole pitch is that
// it does the subtraction honestly.
//
// THE RULE THAT MAKES THIS SAFE: THE LINES ADD UP TO THE TOTAL, EXACTLY.
// A receipt whose rows do not sum to its own total is worse than no receipt —
// it is a screen arguing with itself, and the person reading it is right to
// stop believing both numbers. So the three OUT lines are the counted figures
// straight off energyBalance, never recomputed here, and what each is MADE OF
// hangs underneath as its inputs rather than as more lines.
//
// AND WHAT WAS SET ASIDE IS SAID. The burn deliberately takes the larger of a
// logged shift and a watch's day rather than their sum — adding them counts
// the same hours twice. That is correct and it is invisible: somebody who
// logged four hours and sees a figure smaller than their arithmetic will
// conclude the log was ignored. So the receipt names what was not counted and
// why, every time it happens. Silence there is how a correct number loses an
// argument it should win.

const n = v => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
const money = v => n(v).toLocaleString();

/**
 * @param day      dayFacts() for the date
 * @param balance  energyBalance() output, or null/unknown
 * @param date     the local date it covers
 */
export function dayReceipt({ day = null, balance = null, date = null, today = null } = {}) {
  if (!day) return null;

  // A DAY STILL RUNNING IS NOT A FINISHED SUBTRACTION.
  //
  // The rule already written for the dashboard hero, and it applies here for
  // exactly the same reason: the resting burn is a WHOLE DAY's figure, so at
  // 7pm against 330 eaten the net reads "4,603 down" — which is a fact about
  // the day being incomplete, not a reading of it. And it errs in the
  // dangerous direction: an overstated deficit is the number that tells
  // somebody to eat less than they need.
  //
  // It is still SHOWN, because hiding a number somebody asked for is its own
  // kind of dishonesty. It is labelled.
  const partial = !!(today && (date || day.date) === today);

  // ── IN ────────────────────────────────────────────────────────────────────
  // Straight off the stored rows, so a figure here is what the record holds
  // rather than what anybody meant to write.
  const inLines = (day.log || [])
    .filter(e => e.type === 'food' || e.type === 'drink')
    .map(e => ({
      at: e.at, what: e.summary,
      calories: e.calories,
      protein_g: e.protein_g, carbs_g: e.carbs_g, fat_g: e.fat_g,
      estimated: e.estimated,
      ...(e.calories == null ? { counts_as: 0, why: 'no calories on it, so it adds nothing to the total' } : {}),
    }));

  const inn = {
    lines: inLines,
    total: n(day.food?.calories),
    protein_g: n(day.food?.protein_g),
    carbs_g: n(day.food?.carbs_g),
    fat_g: n(day.food?.fat_g),
    items: inLines.length,
    without_calories: n(day.food?.meals_uncounted),
    estimated: !!day.food?.estimated,
  };

  if (!balance?.known) {
    return {
      date: date || day.date,
      in: inn,
      out: null,
      net: null,
      partial,
      say: receiptSay(inn, null, null, partial),
      note: 'Only the eating half can be shown — calories out needs the missing profile facts before the subtraction means anything. Say so rather than presenting the intake alone as if it were the whole picture.',
    };
  }

  // ── OUT ───────────────────────────────────────────────────────────────────
  // Three lines, and they are the COUNTED figures. What each is made of hangs
  // underneath as `of`, never as further lines, because the inputs do not
  // always sum to the counted figure and pretending otherwise is the lie this
  // whole file exists to avoid.
  const t = balance.training_detail || {};
  const a = balance.logged_activity || {};

  const outLines = [
    {
      what: 'Resting',
      calories: n(balance.resting_burn),
      note: balance.resting_source === 'device'
        ? 'your watch\'s own basal figure for today'
        : 'estimated from your height, weight, age and sex — the whole day, not what has been spent so far',
    },
    {
      what: 'Training',
      calories: n(balance.training_burn),
      ...(t.entries?.length ? { of: t.entries.map(e => ({
        what: e.summary, minutes: e.minutes, calories: e.kcal,
        ...(e.source === 'uncounted' ? { counts_as: 0, why: e.why } : { from: e.source }),
      })) } : {}),
      ...(balance.training_burn === 0 && !t.entries?.length ? { note: 'nothing logged' } : {}),
    },
    {
      what: 'Work and moving about',
      calories: n(balance.other_burn),
      ...(a.entries?.length ? { of: a.entries.map(e => ({
        what: e.summary, hours: e.hours, calories: n(e.kcal),
      })) } : {}),
      note: otherNote(balance, a),
    },
  ];

  const out = {
    lines: outLines,
    total: n(balance.calories_out),
    // A receipt whose rows do not sum to its own total is a screen arguing
    // with itself. Carried explicitly so the harness can hold it and so a
    // future change that breaks it is caught rather than shipped.
    lines_sum: outLines.reduce((s, l) => s + l.calories, 0),
    source: balance.active_source,
    projected: !!balance.other_projected,
  };

  // What was logged and deliberately NOT added. Never silent.
  const setAside = [];
  if (balance.active_source === 'logged_over_device' || balance.active_source === 'device') {
    if (a.raw_kcal) {
      setAside.push(balance.active_source === 'device'
        ? `The work you logged comes to about ${money(a.raw_kcal)} on its own, but your watch counted more for the whole day, so its figure is the one used. They are not added together — that would count the same hours twice.`
        : `Your watch's figure for the day is lower than the work you logged, so the logged figure is the one used. They are not added — that would count the same hours twice.`);
    }
  }
  if (a.capped) {
    setAside.push(`The logged work adds up to about ${money(a.raw_kcal)}; it is held at ${money(a.kcal)}, because past 1.5× your resting burn it stops being a number worth planning against.`);
  }
  // THE CLAMP, NAMED. A session whose own figure is larger than everything the
  // watch measured all day has almost certainly not been seen by the watch —
  // most often because it is not a session at all but a shift filed as one.
  // Either way the person is looking at a row that says one number and a total
  // that moved by another, and until this line existed nothing explained the
  // gap.
  if (balance.training_clamped) {
    const c = balance.training_clamped;
    setAside.push(
      ((t.entries || []).length === 1
        ? `The session logged today comes to about ${money(c.own)} on its own, `
        : `The sessions logged today come to about ${money(c.own)} between them, `) +
      `but your watch measured ${money(c.counted)} moving for the WHOLE day — a session cannot be more than that, so ${money(c.counted)} is what is counted. ` +
      `If that was work rather than training, log it with log_activity instead: work is priced from hours on task and is not capped by what the watch saw.`);
  }
  const uncounted = (t.entries || []).filter(e => e.source === 'uncounted');
  if (uncounted.length) {
    setAside.push(`${uncounted.map(e => `"${e.summary}"`).join(' and ')} ${uncounted.length === 1 ? 'is' : 'are'} counting nothing — ${uncounted[0].why}.`);
  }
  if (inn.without_calories) {
    setAside.push(`${inn.without_calories} thing${inn.without_calories === 1 ? '' : 's'} you ate ${inn.without_calories === 1 ? 'has' : 'have'} no calories on ${inn.without_calories === 1 ? 'it' : 'them'}, so the real intake is higher than the total below.`);
  }

  const net = inn.total - out.total;

  return {
    date: date || day.date,
    in: inn,
    out,
    net,
    direction: balance.direction,
    projected_kg_per_week: balance.projected_kg_per_week,
    partial,
    ...(partial ? { partial_note:
      'Today is not over. The burn is the WHOLE day\'s figure while the food is only what has been logged so far, so the net will close up as they eat — it is not a deficit they have actually run.' } : {}),
    ...(setAside.length ? { set_aside: setAside } : {}),
    estimated: true,
    say: receiptSay(inn, out, net, partial),
    note:
      'READ THIS OUT AS A RECEIPT, line by line, not as a summary. Every line keeps its own number and the two totals go underneath, ' +
      (partial ? 'SAY THAT TODAY IS NOT OVER whenever you quote the net: the burn is a whole-day figure and the food is only what has been logged so far, so a large-looking deficit is the day being incomplete rather than a deficit they have run. Never let it stand as a finished number — an overstated deficit is the one that tells somebody to eat less than they need. ' : '') +
      'then the net. Do not round them differently, do not add them up yourself, and do not drop the lines and quote only the totals — ' +
      'the whole point is that they can be checked one at a time. ' +
      (setAside.length ? 'Say what was set aside and why — a correct figure that looks smaller than their own arithmetic reads as the log having been ignored. ' : '') +
      'Every figure here is an estimate and is said to be one.',
  };
}

function otherNote(balance, a) {
  switch (balance.active_source) {
    case 'logged':             return 'from the work you logged, plus the rest of the day at the sedentary floor';
    case 'logged_over_device': return 'from the work you logged — higher than your watch\'s figure, so this is the one counted';
    case 'device':             return 'from your watch, which already includes the hours you were at work';
    case 'activity_level':     return 'projected from your activity level — nothing measured this, so it is the same number all day';
    case 'awaiting_device':    return 'nothing counted yet — your watch has not sent today and nothing is projected';
    case 'training_only':      return 'nothing is counting the rest of your day, so the real figure is higher';
    default:                   return 'nothing is counting your movement, so the real figure is higher and the deficit smaller than it looks';
  }
}

// The receipt as something a person can hear or read straight through. Composed
// here, like every other number in this server, so the model relays rather than
// arranges.
function receiptSay(inn, out, net, partial = false) {
  const lines = [];

  lines.push(`IN — ${money(inn.total)}${inn.items ? '' : ' (nothing logged)'}`);
  for (const l of inn.lines) {
    lines.push(`  ${l.what} — ${l.calories == null ? 'no calories on it' : money(l.calories)}`);
  }

  if (!out) {
    lines.push('OUT — not known yet (needs your height, weight and birth year)');
    return lines.join('\n');
  }

  lines.push(`OUT — ${money(out.total)}`);
  for (const l of out.lines) {
    lines.push(`  ${l.what} — ${money(l.calories)}`);
    for (const o of l.of || []) {
      const how = o.hours ? `${o.hours}h` : o.minutes ? `${o.minutes} min` : null;
      lines.push(`    ${o.what}${how ? ` (${how})` : ''} — ${money(o.calories)}`);
    }
  }

  lines.push((net < 0 ? `NET — ${money(Math.abs(net))} down`
            : net > 0 ? `NET — ${money(net)} over`
            : 'NET — level')
    + (partial ? ' so far — the burn is the whole day, the food is only what is logged yet' : ''));
  return lines.join('\n');
}
