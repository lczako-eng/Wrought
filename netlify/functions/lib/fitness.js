// netlify/functions/lib/fitness.js
// Where your engine stands, the zones you train it in, and how to raise it.
//
// The founder, under a ChatGPT reply that drew VO2 max tiers and five
// heart-rate zones in colour: "your VO2 and other vitals — show you where you
// are; your coach on there should be encouraging to do better, and how to
// train to optimise that." ChatGPT drew it from its own memory. Here every
// figure is computed, and every reference is named.
//
// THE REFERENCE IS PUBLISHED, NOT IMPRESSIONED. VO2 max by age and sex is
// read against the FRIEND registry's treadmill reference standards (Kaminsky
// et al., Mayo Clinic Proceedings 2015) — the 10th, 25th, 50th, 75th and 90th
// percentiles of laboratory-measured VO2 max in adults without heart disease.
// This file's copy of that table was taken from published reproductions that
// agree with each other number for number; the medians at both ends of the
// age range (men 48.0 and 24.4, women 37.6 and 18.3) match the paper's own
// abstract. This product's own doctrine names exactly this as the one
// defensible "how fit am I for my age" figure — and calls it what it is: a
// percentile against a reference population, never a "fitness age".
//
// NOTHING HERE IS MEDICAL. VO2 max and heart rate are training signals —
// never a diagnosis, never "your heart", never a reassurance. A watch's VO2
// max is itself an estimate, and the reference was measured on a treadmill
// in a lab, so the level is approximate and is said to be.
//
// THE COACH ONLY EVER OFFERS. The plan fits inside the stamina sessions they
// committed to; with no commitment it is offered, never set. A care flag
// silences it — coaching stops — and a strained recovery read means easy
// work only this week. Nothing here ever becomes a reason to push harder.

// FRIEND 2015, treadmill, mL/kg/min: [10th, 25th, 50th, 75th, 90th].
export const VO2_NORMS = {
  male: {
    20: [32.1, 40.1, 48.0, 55.2, 61.8],
    30: [30.2, 35.9, 42.4, 49.2, 56.5],
    40: [26.8, 31.9, 37.8, 45.0, 52.1],
    50: [22.8, 27.1, 32.6, 39.7, 45.6],
    60: [19.8, 23.7, 28.2, 34.5, 40.3],
    70: [17.1, 20.4, 24.4, 30.4, 36.6],
  },
  female: {
    20: [23.9, 30.5, 37.6, 44.7, 51.3],
    30: [20.9, 25.3, 30.2, 36.1, 41.4],
    40: [18.8, 22.1, 26.7, 32.4, 38.4],
    50: [17.3, 19.9, 23.4, 27.6, 32.0],
    60: [14.6, 17.2, 20.0, 23.8, 27.0],
    70: [13.6, 15.6, 18.3, 20.8, 23.1],
  },
};
export const VO2_SOURCE = 'FRIEND registry treadmill reference standards (Kaminsky et al., Mayo Clinic Proceedings, 2015)';

// The levels, by percentile band. Plain words — "low" rather than "poor",
// because it is a reading of a number, never of a person.
export const VO2_LEVELS = ['Low', 'Below average', 'Above average', 'High', 'Very high'];

const round1 = v => Math.round(v * 10) / 10;
const fmt1 = v => (Number.isInteger(round1(v)) ? `${round1(v)}.0` : `${round1(v)}`);

/** Age in whole years from a birth year and an ISO date. */
export function ageFrom(birthYear, today) {
  const y = Number(String(today || '').slice(0, 4));
  const b = Number(birthYear);
  return Number.isFinite(y) && Number.isFinite(b) && b > 1900 && b <= y ? y - b : null;
}

export const sexKey = s => (/^m(ale)?$|^man$/i.test(String(s || '').trim()) ? 'male' : /^f(emale)?$|^woman$/i.test(String(s || '').trim()) ? 'female' : null);

/**
 * Where a VO2 max sits for the person's age and sex. Pure. Null when any of
 * the three is missing — the level is never guessed.
 */
export function vo2Standing({ vo2, age, sex } = {}) {
  const v = Number(vo2);
  const s = sexKey(sex);
  if (!Number.isFinite(v) || v <= 0 || !Number.isFinite(age) || !s) return null;
  const decade = Math.min(70, Math.max(20, Math.floor(age / 10) * 10));
  const [p10, p25, p50, p75, p90] = VO2_NORMS[s][decade];
  const cuts = [p25, p50, p75, p90];
  const idx = cuts.filter(c => v >= c).length;
  const level = VO2_LEVELS[idx];
  const percentile = v < p10 ? 'below the 10th percentile'
    : v < p25 ? 'between the 10th and 25th percentile'
    : v < p50 ? 'between the 25th and 50th percentile'
    : v < p75 ? 'between the 50th and 75th percentile'
    : v < p90 ? 'between the 75th and 90th percentile'
    : 'at or above the 90th percentile';
  const group = `${s === 'male' ? 'men' : 'women'} ${decade}–${decade + 9}${age < 20 ? ' (the youngest group in the reference)' : age >= 80 ? ' (the oldest group in the reference)' : ''}`;
  const ladder = VO2_LEVELS.map((label, i) => ({
    label,
    from: i === 0 ? null : cuts[i - 1],
    to: i === VO2_LEVELS.length - 1 ? null : cuts[i],
  }));
  const next = idx < VO2_LEVELS.length - 1 ? { label: VO2_LEVELS[idx + 1], at: cuts[idx], gap: round1(cuts[idx] - v) } : null;
  // Where the marker sits on a five-band ladder drawn in equal widths: the
  // band, plus how far through it — held 0–100 here so a picture draws a
  // share and never works one out.
  const lo = idx === 0 ? Math.min(v, p10) - 4 : cuts[idx - 1];
  const hi = idx === VO2_LEVELS.length - 1 ? Math.max(v, p90) + 6 : cuts[idx];
  const through = Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1)));
  const position = Math.round(((idx + through) / VO2_LEVELS.length) * 1000) / 10;
  return {
    vo2: round1(v), unit: 'ml/kg/min', level, percentile, group, median: p50,
    ladder, next, position,
    // The reading alone, for a reply that must not count anybody towards a
    // next rung (a care flag).
    level_say: `VO2 max ${fmt1(v)} — ${level.toLowerCase()} for ${group}, ${percentile}; the middle for your group is ${fmt1(p50)}.`,
    say: `VO2 max ${fmt1(v)} — ${level.toLowerCase()} for ${group}, ${percentile}; the middle for your group is ${fmt1(p50)}.`
      + (next ? ` The next level, ${next.label.toLowerCase()}, starts at ${fmt1(next.at)}: ${fmt1(next.gap)} to go.` : ' The top level for your group.'),
    source: VO2_SOURCE,
  };
}

/**
 * A VO2 max stated in so many words — "my VO2 max is 31.4", "vo2max 33",
 * "cardio fitness 31" — read off the sentence. Pure. Null unless the number
 * sits right after the name and reads like a watch's figure (10–90): a
 * percentage ("VO2 max up 10%") is a change, never a reading, and nothing is
 * ever inferred from a sentence that does not name one.
 */
export function vo2FromWords(text) {
  const m = String(text || '').match(/\b(?:v\.?\s?o\.?\s?2(?:\s?max)?|cardio\s+fitness)\b[^\d%]{0,25}?(\d{2}(?:[.,]\d)?)(?!\d)\s*(%|percent)?/i);
  if (!m || m[2]) return null;
  const v = Number(m[1].replace(',', '.'));
  return Number.isFinite(v) && v >= 10 && v <= 90 ? Math.round(v * 10) / 10 : null;
}

/** Tanaka, Monahan & Seals (2001): 208 − 0.7 × age — better validated than 220 − age. */
export const maxHeartRate = age => (Number.isFinite(age) ? Math.round(208 - 0.7 * age) : null);

// Five zones as shares of the estimated maximum. Percentages of maximum
// rather than of heart-rate reserve on purpose: for somebody building a base
// they sit lower, and an easy day that is genuinely easy is the safe error.
export const ZONES = [
  { zone: 1, name: 'Recovery', lo: 0.5, use: 'warm-ups, cool-downs and the easiest days' },
  { zone: 2, name: 'Aerobic base', lo: 0.6, use: 'long, steady, conversational work that builds the engine' },
  { zone: 3, name: 'Tempo', lo: 0.7, use: 'steady and hard, talking in short sentences' },
  { zone: 4, name: 'Threshold', lo: 0.8, use: 'intervals, where VO2 max is pushed up' },
  { zone: 5, name: 'Maximum', lo: 0.9, use: 'short all-out efforts, little and rarely' },
];

/** The five zones in beats a minute. Pure. */
export function hrZones({ age } = {}) {
  const max = maxHeartRate(age);
  if (!max) return null;
  const los = ZONES.map(z => Math.round(z.lo * max));
  const zones = ZONES.map((z, i) => ({
    zone: z.zone, name: z.name, use: z.use,
    lo: los[i], hi: i < ZONES.length - 1 ? los[i + 1] - 1 : max,
    // How long its bar is drawn, held 0–100.
    share: Math.round(((i < ZONES.length - 1 ? los[i + 1] - 1 : max) / max) * 1000) / 10,
  }));
  return {
    max, basis: `estimated maximum ${max} bpm (208 − 0.7 × age ${age}, Tanaka et al. 2001)`,
    zones,
    note: 'Estimated from age, not measured. Your watch may draw its own zones from your resting heart rate; they sit a little higher.',
  };
}

/** Which zone a heart rate sits in. Pure. */
export function placeHeartRate(z, bpm) {
  const b = Math.round(Number(bpm));
  if (!z || !Number.isFinite(b) || b <= 0) return null;
  if (b < z.zones[0].lo) return { bpm: b, zone: 0, say: `${b} bpm is below Zone 1 — easier than recovery pace.` };
  const hit = z.zones.find(x => b >= x.lo && b <= x.hi) || z.zones[z.zones.length - 1];
  return { bpm: b, zone: hit.zone, say: `${b} bpm is Zone ${hit.zone}, ${hit.name.toLowerCase()} (${hit.lo}–${hit.hi} bpm): ${hit.use}.`
    + (b > z.max ? ` It is above the estimated maximum of ${z.max}; estimates are averages and plenty of people sit above theirs.` : '') };
}

/**
 * How to raise it, fitted inside their own week. Pure.
 * @param {{ standing, zones, cardioPerWeek, readiness, flags }} a
 */
export function vo2Plan({ standing = null, zones = null, cardioPerWeek = null, readiness = null, flags = [] } = {}) {
  if (Array.isArray(flags) && flags.length) {
    // Said, with its way out, never left silent: a flag that fired on
    // half-logged days clears when those days are named as half-logged.
    return { paused: true, say: 'The training plan is paused while a care flag stands — coaching stops until it clears. If some of those days were only half logged, say which, and the record is read again. The readings above are still yours.' };
  }
  if (!zones) return null;
  const z2 = zones.zones[1], z4 = zones.zones[3];
  const committed = Number.isFinite(Number(cardioPerWeek)) && Number(cardioPerWeek) > 0 ? Math.round(Number(cardioPerWeek)) : null;
  const n = committed || 3;
  const strained = readiness?.state === 'strained';
  const base = !standing || standing.level === 'Low' || standing.level === 'Below average';
  const easy = { what: 'Zone 2', how: `${base ? '30–45' : '40–60'} min at ${z2.lo}–${z2.hi} bpm — a brisk incline walk, an easy bike or a slow jog; you can still talk` };
  const fourByFour = { what: 'Interval session (4 × 4)', how: `4 minutes at ${z4.lo}–${z4.hi} bpm, 3 minutes easy walking between, four times — warm up ten minutes first` };
  let sessions;
  if (strained) {
    sessions = [{ ...easy, times: Math.min(n, 2) }];
  } else if (base) {
    sessions = [{ ...easy, times: n }];
  } else {
    sessions = n >= 2 ? [{ ...easy, times: n - 1 }, { ...fourByFour, times: 1 }] : [{ ...fourByFour, times: 1 }];
  }
  const lines = sessions.map(s => `${s.times} × ${s.what}: ${s.how}`);
  return {
    paused: false,
    phase: strained ? 'easy' : base ? 'base' : 'build',
    sessions,
    then: strained ? 'Recovery reads strained, so this week is easy work only — the intervals wait for a better week.'
      : base ? `After three to four weeks of that, make one of them a 4 × 4 — ${fourByFour.how}.` : null,
    offered: !committed && !strained,
    say: (strained ? 'Recovery reads strained, so this week is easy work only: ' : base ? 'Build the base first: ' : 'To push it up: ')
      + lines.join('; ') + '.'
      + (base && !strained ? ` After three to four weeks of that, make one of them a 4 × 4 — ${fourByFour.how}.` : '')
      + (!committed && !strained ? ` That is ${n} a week, offered rather than set — say the word and it goes on your plan.` : ''),
    why: 'Steady Zone 2 builds the base; the 4 × 4 is the interval session behind the classic VO2 max study (Helgerud et al., 2007), where eight weeks raised it by about 7%.',
  };
}

/** The coach's line: encouraging, and only ever about what the record shows. Pure. */
export function fitnessCoachLine({ standing = null, trend = null, plan = null } = {}) {
  if (plan?.paused) return null;
  const bits = [];
  if (trend && trend.trend === 'up') bits.push(`VO2 max is up on last month (${trend.month_avg} against ${trend.prior_avg}) — the work is landing.`);
  else if (trend && trend.trend === 'flat') bits.push(`VO2 max has held at ${trend.month_avg} — this is the stretch where the intervals earn their keep.`);
  if (standing?.next) bits.push(`${fmtGap(standing.next.gap)} from ${standing.next.label.toLowerCase()}, and VO2 max is one of the most trainable numbers you have.`);
  else if (standing) bits.push('The top level for your age — the job now is keeping it there.');
  if (!standing) bits.push('Tell me the VO2 max your watch shows and it goes against your age group.');
  return bits.join(' ') || null;
}
const fmtGap = g => `${fmt1(g)}`;

// The one sentence a ChatGPT reply with a picture swaps out — kept apart so
// the swap is a string replace and never a rewrite of the rest of the rule.
export const FITNESS_CARD_SHOW = 'SHOW fitness_card EXACTLY AS WRITTEN after your first line — where their VO2 max stands for their age and sex, their five heart-rate zones, and the plan.';

export const FITNESS_NOTE = FITNESS_CARD_SHOW + ' Then say coach_line in the coach\'s register: encouraging, about what the record shows, never about their body. Every figure here is computed — never a level, a zone, a maximum heart rate or a session of your own, and never a range you rounded to. NOTHING IS MEDICAL: VO2 max and heart rate are training signals, never "your heart", never a diagnosis, never a reassurance; a number that worries them is a doctor\'s question. A watch\'s VO2 max is itself an estimate and the reference was measured in a lab — say the level is approximate. The plan is OFFERED unless they already committed stamina sessions; it goes on their plan only on a yes (set_plan). Under a care flag the plan is paused: say so, plainly, once, and offer the review once — if the flagged days were only half logged, review_intake_days with the days they name re-reads it; never infer which days yourself.';

export const FITNESS_PICTURE_NOTE = 'SHOW card_image straight after your first line: it is fitness_card itself — the ladder, the zones and the plan — drawn in Wrought\'s colours. Copy that line EXACTLY AS WRITTEN, on its own line, as markdown: never alter, shorten or explain the address, never put it in a code block, and do NOT also paste fitness_card or rebuild any of it in text — under it, never a figure that differs from it.';

/**
 * The resting heart rate as one flat line: a reading and its direction, never
 * "the wrong direction" — on this card it is context for the engine, not a
 * verdict. Pure. `m` is markerRead's output for resting_hr.
 */
export function restingLine(m) {
  if (!m || m.missing || m.latest == null) return null;
  if (m.trend === 'not_enough' || m.month_avg == null) return `Resting heart rate ${fmt1(m.latest)} bpm, the latest reading — a trend needs a month on each side.`;
  return `Resting heart rate ${fmt1(m.month_avg)} bpm this month, ${m.trend === 'flat' ? 'flat on' : `${m.trend === 'up' ? 'up' : 'down'} ${Math.abs(m.pct)}% on`} last month.`;
}

// ── The card ────────────────────────────────────────────────────────────────
// One view, two renderers: the markdown table every chat can show, and the
// picture (lib/cardimage.js) for the ChatGPT that cannot draw Wrought's own
// card. Every leaf is a string; the only numbers are shares held 0–100.

const LADDER_TONES = ['quiet', 'amber', 'temper', 'moss', 'moss-deep'];
const ZONE_TONES = ['quiet', 'moss', 'temper', 'amber', 'heat'];

/** The view the fitness card is drawn from. Pure. */
export function fitnessView({ standing = null, zones = null, placed = null, plan = null, resting = null, coachLine = null, missing = null } = {}) {
  const vo2 = standing ? {
    title: 'VO2 max · where you stand',
    figure: fmt1(standing.vo2), unit: standing.unit, level: standing.level, pill: 'Estimate',
    group: standing.group.charAt(0).toUpperCase() + standing.group.slice(1),
    percentile: standing.percentile,
    ladder: standing.ladder.map((b, i) => ({
      label: b.label,
      range: b.from == null ? `under ${fmt1(b.to)}` : b.to == null ? `${fmt1(b.from)}+` : `${fmt1(b.from)}–${fmt1(b.to)}`,
      tone: LADDER_TONES[i], current: b.label === standing.level,
    })),
    marker: standing.position,
    // Under a care flag the ladder stays — it is their reading — but nothing
    // counts them towards the next rung: that is the push a flag stops.
    next: plan?.paused ? null : standing.next ? `${standing.next.label} starts at ${fmt1(standing.next.at)} — ${fmt1(standing.next.gap)} to go.` : 'The top level for your group.',
  } : { title: 'VO2 max · where you stand', missing: missing || 'No VO2 max on file yet.' };
  return {
    v: 1, kind: 'fitness', badge: 'FITNESS',
    vo2,
    zones: zones ? {
      title: 'Heart-rate zones',
      basis: `Maximum about ${zones.max} bpm, estimated from age`,
      rows: zones.zones.map((z, i) => ({
        label: `Zone ${z.zone} · ${z.name}`, range: `${z.lo}–${z.hi} bpm`, use: z.use,
        share: z.share, tone: ZONE_TONES[i], here: !!placed && placed.zone === z.zone,
      })),
      placed: placed ? placed.say : null,
      placed_label: placed ? `${placed.bpm} bpm` : null,
    } : null,
    plan: !plan ? null : plan.paused ? { title: 'Training plan', paused: plan.say } : {
      title: plan.phase === 'easy' ? 'This week — easy only' : 'This week, to raise it',
      rows: plan.sessions.map(x => ({ times: `${x.times} ×`, what: x.what, how: x.how })),
      then: plan.then,
      offered: plan.offered ? 'Offered, not set — say yes and it goes on your plan.' : null,
    },
    resting,
    coach: coachLine,
    foot: 'VO2 max and heart rate are training signals, never a diagnosis. Levels: FRIEND registry (2015), approximate for a watch\'s estimate.',
  };
}

const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** The same card as markdown — what every chat can show. Pure. */
export function fitnessMarkdown(v) {
  if (!v || v.kind !== 'fitness') return '';
  const out = [`**${v.vo2.title}**`, ''];
  if (v.vo2.missing) out.push(v.vo2.missing, '');
  else {
    out.push(`### ${v.vo2.figure} ${v.vo2.unit} — ${v.vo2.level}`, `${v.vo2.group} · ${v.vo2.percentile}`, '');
    out.push('| Level | VO2 max |', '|---|---:|');
    for (const b of v.vo2.ladder) out.push(`| ${b.current ? `**${cell(b.label)} ← you**` : cell(b.label)} | ${cell(b.range)} |`);
    out.push('');
    if (v.vo2.next) out.push(`**Next:** ${v.vo2.next}`, '');
  }
  if (v.zones) {
    out.push(`**${v.zones.title}** — ${v.zones.basis}`, '', '| Zone | Heart rate | For |', '|---|---|---|');
    for (const z of v.zones.rows) out.push(`| ${z.here ? `**${cell(z.label)} ← ${cell(v.zones.placed_label)}**` : cell(z.label)} | ${cell(z.range)} | ${cell(z.use)} |`);
    out.push('');
    if (v.zones.placed) out.push(v.zones.placed, '');
  }
  if (v.plan) {
    out.push(`**${v.plan.title}**`, '');
    if (v.plan.paused) out.push(v.plan.paused, '');
    else {
      for (const r of v.plan.rows) out.push(`- **${r.times} ${r.what}:** ${r.how}`);
      if (v.plan.then) out.push(`- ${v.plan.then}`);
      if (v.plan.offered) out.push(`- ${v.plan.offered}`);
      out.push('');
    }
  }
  if (v.resting) out.push(`_${v.resting}_`, '');
  out.push(`_${v.foot}_`);
  return out.join('\n');
}
