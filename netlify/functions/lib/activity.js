// netlify/functions/lib/activity.js
// The third burn — work, and everything else that is not training.
//
// (wrought.js does not import this file, so the dependency runs one way only.)
//
// The founder's ask, after a shift: "today I worked at the Petting Zoo. It's
// very hard work so I wanna make sure that captures it."
//
// He found a genuine hole. Calories out had exactly two sources: a resting burn
// for a body lying still, and a watch's active energy for a body moving. With
// no watch, a static activity multiplier stood in for the entire day — one
// number that cannot tell a Tuesday at a desk from a Saturday hauling feed. So
// the single biggest expenditure in a lot of people's weeks was either invisible
// or averaged into a setting they picked once, months ago.
//
// The arithmetic is the Compendium of Physical Activities' MET values, which is
// the same table every exercise physiologist and every fitness app is using
// underneath. That matters for the estimates doctrine: this is a published
// reference figure, not a language model's guess at what a petting zoo costs.
// It is still an estimate and is labelled one every single time.
//
// TWO THINGS THAT WOULD SILENTLY DOUBLE THE NUMBER, both handled here:
//
//   1. MET values are GROSS — they include the resting cost of those hours,
//      which the daily resting burn is already charging for. Adding them raw on
//      top of a full-day BMR bills those hours twice. So everything below is
//      NET: (MET - 1), the cost ABOVE simply existing.
//   2. A watch that measured the day has already counted the shift, because the
//      shift is where the steps and the heart rate came from. When a device
//      reported, a logged activity is kept as a record and adds nothing — the
//      measurement wins, exactly as it does everywhere else in this codebase.

import { withEffectiveTypes } from './wrought.js';

// Occupational and daily-life METs. Curated rather than exhaustive, on the same
// principle as the movement library: a list you can ask a question of beats a
// list you scroll. Values are the Compendium's, rounded — the third decimal of
// a MET is false precision next to "roughly how many hours were you at it".
export const ACTIVITIES = [
  // Work — the whole reason this file exists
  { key: 'animal_care',   met: 4.3, say: 'animal care',            match: /petting zoo|zoo|animal|farm|stable|kennel|barn|livestock|horse|feeding animals/i },
  { key: 'construction',  met: 5.5, say: 'construction work',      match: /construction|building site|labour|labor|bricklay|concrete|scaffold/i },
  { key: 'roofing',       met: 6.0, say: 'roofing',                match: /roofing|roofer/i },
  { key: 'forestry',      met: 8.0, say: 'forestry',               match: /forestry|logging|chainsaw|tree work|arborist/i },
  { key: 'landscaping',   met: 4.5, say: 'landscaping',            match: /landscap|groundskeep|lawn|mowing|hedge/i },
  { key: 'warehouse',     met: 4.0, say: 'warehouse work',         match: /warehouse|picking|packing|loading|forklift|stockroom|shelf stack|stacking shelves/i },
  { key: 'removals',      met: 5.8, say: 'moving furniture',       match: /removals|moving house|moving furniture|house move|carrying boxes/i },
  { key: 'mechanic',      met: 4.0, say: 'mechanical work',        match: /mechanic|garage work|car repair|auto repair/i },
  { key: 'trades',        met: 3.5, say: 'trade work',             match: /plumb|electric|carpent|joiner|welding|fitter|hvac/i },
  { key: 'decorating',    met: 3.3, say: 'painting and decorating', match: /painting|decorating|wallpaper|plaster/i },
  { key: 'kitchen',       met: 3.0, say: 'kitchen work',           match: /kitchen|chef|line cook|catering|dishwash/i },
  { key: 'hospitality',   met: 2.8, say: 'bar and waiting work',   match: /bar work|bartend|waiting tables|waitress|waiter|server shift|barista/i },
  { key: 'healthcare',    met: 3.0, say: 'healthcare work',        match: /nurs|carer|caregiv|care home|paramedic|orderly|hospital shift/i },
  { key: 'retail',        met: 2.5, say: 'retail work',            match: /retail|shop floor|till|cashier|serving customers|store shift/i },
  { key: 'delivery',      met: 3.0, say: 'delivery work',          match: /delivery|courier|postal|mail route|dropping parcels/i },
  { key: 'factory',       met: 3.0, say: 'factory work',           match: /factory|assembly line|production line|manufactur/i },
  { key: 'cleaning_work', met: 3.5, say: 'cleaning work',          match: /cleaning shift|janitor|custodian|housekeep/i },
  { key: 'teaching',      met: 2.5, say: 'teaching',               match: /teaching|classroom|lecturing|coaching kids/i },
  { key: 'driving',       met: 2.0, say: 'driving',                match: /driving|truck|lorry|taxi|uber|bus route/i },
  { key: 'desk',          met: 1.5, say: 'desk work',              match: /desk|office|computer|admin|meetings|zoom|sat at a desk/i },

  // Life — the other half of the day nobody counts either
  { key: 'gardening',     met: 3.8, say: 'gardening',              match: /garden|weeding|planting|digging|allotment/i },
  { key: 'diy',           met: 3.5, say: 'DIY',                    match: /diy|home repair|renovat|flat pack|fixing the/i },
  { key: 'housework',     met: 3.0, say: 'housework',              match: /housework|hoover|vacuum|mopping|tidying|laundry|chores/i },
  { key: 'shopping',      met: 2.3, say: 'shopping',               match: /shopping|groceries|supermarket/i },
  { key: 'childcare',     met: 2.8, say: 'looking after children',  match: /childcare|kids|toddler|baby|school run|playground/i },
  { key: 'dog_walking',   met: 3.0, say: 'walking the dog',        match: /dog walk|walking the dog|walked the dog/i },
  { key: 'snow',          met: 5.3, say: 'clearing snow',          match: /shovel|snow|driveway/i },
  { key: 'standing',      met: 2.0, say: 'standing work',          match: /standing|on my feet|stood up all/i },
  { key: 'walking',       met: 3.5, say: 'walking',                match: /walk|on foot|hiking|hike/i },
];

// The fallback when nothing matches, chosen BY THE PERSON rather than guessed.
// Somebody who did a job this list has never heard of can still say how hard it
// was, and their answer about their own day beats anything inferred from a job
// title. Refusing outright would be the wrong call here — the alternative to a
// classified estimate is not a better number, it is the shift going unrecorded.
export const EFFORTS = {
  light:    { met: 2.3, say: 'light work — mostly on your feet, not much lifting' },
  moderate: { met: 3.8, say: 'moderate work — steady, some carrying' },
  hard:     { met: 5.5, say: 'hard work — lifting and carrying most of it' },
  very_hard:{ met: 7.0, say: 'very hard work — heavy and constant' },
};

export function matchActivity(text = '') {
  const s = String(text).trim();
  if (!s) return null;
  return ACTIVITIES.find(a => a.match.test(s)) || null;
}

/**
 * What a stretch of work actually cost, above simply existing.
 *
 * `hours` is hours ON TASK, not the length of the shift. Nobody works at their
 * job's MET value through their lunch break, and an eight-hour shift billed as
 * eight hours of labour is how this number stops being believable. The tool
 * asks for it that way, and the person answering knows the difference.
 */
export function activityBurn({ text = '', hours = null, effort = null, weightKg = null } = {}) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) {
    return { known: false, why: 'hours', say: 'How long were you actually at it? Roughly is fine — hours on task, not counting breaks.' };
  }
  if (h > 18) {
    return { known: false, why: 'hours', say: 'That is more hours than a day holds. What was it really?' };
  }

  const hit = matchActivity(text);
  const chosen = effort && EFFORTS[effort] ? EFFORTS[effort] : null;
  const met = hit ? hit.met : chosen ? chosen.met : null;

  if (met == null) {
    return {
      known: false, why: 'effort',
      say: 'I do not have that job in the table. Was it light, moderate, hard or very hard going? Your read on your own day beats anything I would guess from the job title.',
      options: Object.keys(EFFORTS),
    };
  }

  // NET, not gross. The resting burn is already charging for these hours, so
  // only the cost ABOVE lying there belongs here. Getting this wrong is the
  // single easiest way to invent a thousand calories nobody spent.
  const kcal = weightKg
    ? Math.round((met - 1) * Number(weightKg) * h * 1.05)
    : null;

  return {
    known: true,
    label: hit ? hit.say : chosen.say,
    key: hit ? hit.key : `effort_${effort}`,
    met,
    hours: Math.round(h * 10) / 10,
    kcal,
    matched: !!hit,
    estimated: true,
    say: kcal == null
      ? `${hit ? hit.say : chosen.say}, ${Math.round(h * 10) / 10}h — recorded, but the calories need a recent weight before they can be worked out.`
      : `${hit ? hit.say : chosen.say}, ${Math.round(h * 10) / 10}h — roughly ${kcal} kcal on top of resting. An estimate from a standard effort table, not a measurement.`,
  };
}

/**
 * A day's worth of logged activity, summed.
 *
 * Capped, and the cap is said out loud rather than applied quietly. Past about
 * one and a half times a resting burn, a day of logged work has stopped being a
 * figure anybody should plan a diet against — and silently handing back 3,000
 * calories of "other" would let somebody eat to a number they invented by
 * over-reporting hours. Saying it was capped keeps the log honest AND the
 * arithmetic sane.
 */
export function activityTotal(events = [], restingKcal = null) {
  // Promoted first: a shift stored as a note because the database has not been
  // taught 'activity' yet is still a shift, and counting it zero is exactly the
  // failure this whole file exists to end.
  const rows = withEffectiveTypes(events)
    .filter(e => e.event_type === 'activity')
    .map(e => ({
      summary: e.summary,
      kcal: Number(e.detail?.kcal) || 0,
      hours: Number(e.detail?.hours) || null,
      label: e.detail?.label || null,
    }));

  const raw = rows.reduce((a, r) => a + r.kcal, 0);
  const ceiling = restingKcal ? Math.round(restingKcal * 1.5) : null;
  const capped = ceiling != null && raw > ceiling;

  return {
    entries: rows,
    count: rows.length,
    kcal: capped ? ceiling : Math.round(raw),
    raw_kcal: Math.round(raw),
    capped,
    say: !rows.length ? null
      : capped
        ? `${rows.length} thing${rows.length === 1 ? '' : 's'} logged, adding up to about ${Math.round(raw)} — held at ${ceiling}, because past that it stops being a number worth planning against.`
        : `${rows.map(r => r.summary).join('; ')} — roughly ${Math.round(raw)} kcal, estimated.`,
  };
}
