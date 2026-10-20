// netlify/functions/lib/nutrition.js
// What you actually eat, at every altitude.
//
// A daily macro total is the least interesting nutrition number there is.
// Everybody has a bad Tuesday. What nobody can see without years of record is
// the shape: that sugar climbs every winter, that meat is in four meals out of
// five, that this year is running 200 calories a day above last one. Those are
// the numbers that change behaviour, and they only exist if something has been
// quietly adding up for long enough.
//
// Two things are counted differently on purpose:
//
//   MACROS are grams, summed. Estimated from described meals, so always
//   labelled as estimates — the credibility of the whole product dies the
//   first time a guess gets read out as a measurement.
//
//   CATEGORIES are counted in MEALS, never grams. "How much meat do I eat" is
//   answerable honestly as "meat was in 31 of your 44 logged meals"; it is not
//   answerable as "you ate 4.2kg of meat", because nobody described their
//   dinner precisely enough for that to be true. Counting occurrences is the
//   honest version of the question.

export const CATEGORIES = [
  'meat', 'fish', 'egg', 'dairy', 'vegetable', 'fruit',
  'grain', 'legume', 'nuts', 'fried', 'sweets', 'alcohol', 'ultra_processed',
];

const MACROS = ['calories', 'protein_g', 'carbs_g', 'sugar_g', 'fibre_g', 'fat_g', 'sat_fat_g'];

const num = v => (Number.isFinite(+v) ? +v : 0);

// Monday-start weeks, because a training week starts on Monday everywhere
// except a spreadsheet.
function weekKey(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
const monthKey = d => d.slice(0, 7);
const yearKey  = d => d.slice(0, 4);

function blank() {
  return { ...Object.fromEntries(MACROS.map(m => [m, 0])), meals: 0, days: new Set(), estimated: false };
}

function addTo(bucket, ev) {
  for (const m of MACROS) bucket[m] += num(ev.detail?.[m]);
  bucket.meals += 1;
  bucket.days.add(ev.local_date);
  if (ev.estimated) bucket.estimated = true;
}

function finish(bucket) {
  const days = bucket.days.size || 1;
  const out = { meals: bucket.meals, days_logged: bucket.days.size, estimated: bucket.estimated };
  for (const m of MACROS) {
    out[m] = Math.round(bucket[m]);
    out[`${m}_per_day`] = Math.round(bucket[m] / days);
  }
  return out;
}

// ── Totals at every altitude ────────────────────────────────────────────────

export function nutritionTotals(events, { today }) {
  const food = (events || []).filter(e => e.event_type === 'food' || e.event_type === 'drink');

  const thisWeek  = weekKey(today);
  const thisMonth = monthKey(today);
  const thisYear  = yearKey(today);

  const b = { day: blank(), week: blank(), month: blank(), year: blank(), all: blank() };

  for (const ev of food) {
    const d = ev.local_date;
    addTo(b.all, ev);
    if (yearKey(d)  === thisYear)  addTo(b.year, ev);
    if (monthKey(d) === thisMonth) addTo(b.month, ev);
    if (weekKey(d)  === thisWeek)  addTo(b.week, ev);
    if (d === today) addTo(b.day, ev);
  }

  return {
    today: finish(b.day),
    this_week: finish(b.week),
    this_month: finish(b.month),
    this_year: finish(b.year),
    all_time: finish(b.all),
    note: 'Macros are estimated from described meals. Report them as approximations, never as measurements.',
  };
}

// ── Composition — the "how much meat do I actually eat" question ────────────
// Counted in meals, because that is the only honest unit available.

export function composition(events, { since = null } = {}) {
  const food = (events || [])
    .filter(e => e.event_type === 'food' || e.event_type === 'drink')
    .filter(e => !since || e.local_date >= since);

  if (!food.length) {
    return { meals: 0, rows: [], say: 'Nothing logged in this stretch.' };
  }

  const counts = Object.fromEntries(CATEGORIES.map(c => [c, 0]));
  const dayHits = Object.fromEntries(CATEGORIES.map(c => [c, new Set()]));

  for (const ev of food) {
    const cats = Array.isArray(ev.detail?.categories) ? ev.detail.categories : [];
    for (const c of new Set(cats)) {
      if (c in counts) { counts[c] += 1; dayHits[c].add(ev.local_date); }
    }
  }

  const days = new Set(food.map(e => e.local_date)).size || 1;

  const rows = CATEGORIES
    .map(c => ({
      category: c,
      meals: counts[c],
      share_pct: Math.round((counts[c] / food.length) * 100),
      days: dayHits[c].size,
      days_pct: Math.round((dayHits[c].size / days) * 100),
    }))
    .filter(r => r.meals > 0)
    .sort((a, b) => b.meals - a.meals);

  const top = rows[0];
  return {
    meals: food.length,
    days_logged: days,
    rows,
    say: top
      ? `Across ${food.length} logged meals: ${rows.slice(0, 4).map(r => `${r.category.replace('_', ' ')} in ${r.share_pct}%`).join(', ')}.`
      : 'No food categories recorded yet.',
    note: 'These are counts of meals, not weights. "Meat in 71% of meals" is honest; "you ate 4kg of meat" would not be.',
  };
}

// ── The macro grid ──────────────────────────────────────────────────────────
// Same treatment as the training matrix: a week either hit protein or it did
// not, and the eye reads a row of cold cells faster than it reads a column of
// numbers. Sugar is the row people actually stare at.

const GRID_ROWS = [
  { key: 'calories',  label: 'Calories', better: 'mid'  },
  { key: 'protein_g', label: 'Protein',  better: 'high' },
  { key: 'carbs_g',   label: 'Carbs',    better: 'mid'  },
  { key: 'sugar_g',   label: 'Sugar',    better: 'low'  },
  { key: 'fibre_g',   label: 'Fibre',    better: 'high' },
  { key: 'fat_g',     label: 'Fat',      better: 'mid'  },
];

export function macroMatrix(events, { weeks = 12, today }) {
  const food = (events || []).filter(e => e.event_type === 'food' || e.event_type === 'drink');

  const byWeek = new Map();
  for (const ev of food) {
    const k = weekKey(ev.local_date);
    if (!byWeek.has(k)) byWeek.set(k, blank());
    addTo(byWeek.get(k), ev);
  }

  const keys = [...byWeek.keys()].sort().slice(-weeks);
  if (!keys.length) return { weeks: [], rows: [], say: 'No food logged yet.' };

  const perDay = keys.map(k => {
    const b = byWeek.get(k);
    const days = b.days.size || 1;
    return Object.fromEntries(MACROS.map(m => [m, b[m] / days]));
  });

  const rows = GRID_ROWS.map(spec => {
    const values = perDay.map(w => w[spec.key]);
    const present = values.filter(v => v > 0);
    if (!present.length) return null;

    const min = Math.min(...present), max = Math.max(...present);
    const avg = present.reduce((a, b2) => a + b2, 0) / present.length;

    return {
      ...spec,
      avg_per_day: Math.round(avg),
      min: Math.round(min), max: Math.round(max),
      // "mid" metrics get no favourable direction — calories are not good or
      // bad in themselves, so the shading is magnitude only and the row is
      // labelled as such rather than being quietly moralised.
      cells: keys.map((k, i) => ({
        week: k,
        value: Math.round(values[i]) || null,
        band: values[i] > 0 ? bandOf(values[i], min, max, spec.better) : null,
      })),
    };
  }).filter(Boolean);

  return {
    weeks: keys, rows,
    say: rows.length
      ? `${keys.length} weeks of food, averaged per day.`
      : 'No food logged yet.',
  };
}

function bandOf(value, min, max, better) {
  if (max - min < 1e-9) return 2;
  const t = (value - min) / (max - min);
  const scaled = better === 'low' ? 1 - t : t;      // 'mid' and 'high' both climb
  return Math.max(0, Math.min(4, Math.round(scaled * 4)));
}

// ── Year over year ──────────────────────────────────────────────────────────
// The number nobody can get anywhere else, and the one that only a memory
// makes possible: is this year actually different from last year?

export function yearOverYear(events, { today }) {
  const thisYear = +yearKey(today);
  const buckets = new Map();

  for (const ev of (events || [])) {
    if (ev.event_type !== 'food' && ev.event_type !== 'drink') continue;
    const y = +yearKey(ev.local_date);
    if (!buckets.has(y)) buckets.set(y, blank());
    addTo(buckets.get(y), ev);
  }

  const years = [...buckets.keys()].sort();
  const rows = years.map(y => ({ year: y, ...finish(buckets.get(y)) }));

  const now = rows.find(r => r.year === thisYear);
  const prev = rows.find(r => r.year === thisYear - 1);

  let comparison = null;
  if (now && prev && now.days_logged >= 30 && prev.days_logged >= 30) {
    const d = now.calories_per_day - prev.calories_per_day;
    const p = now.protein_g_per_day - prev.protein_g_per_day;
    comparison = {
      calories_per_day_change: d,
      protein_per_day_change: p,
      say: `This year is averaging roughly ${Math.abs(d)} calories a day ${d >= 0 ? 'above' : 'below'} last year, and ${Math.abs(p)}g of protein ${p >= 0 ? 'above' : 'below'}.`,
    };
  }

  return {
    rows, comparison,
    say: comparison?.say
      || (rows.length ? `${rows.length} year${rows.length === 1 ? '' : 's'} on record.`
                      : 'Nothing on record yet.'),
    note: rows.length < 2 || !comparison
      ? 'Not enough of a second year logged to compare against — this becomes the most valuable number here once it exists.'
      : null,
  };
}

// ── The meal score — what is IN the plate, out of ten ────────────────────────
// The founder, under a ChatGPT reply that called his lunch "good food, 8/10
// nutritionally": "I also wanna rate the food like this, exactly like this."
// A score a model makes up is the invented-number failure with a fraction on
// it, so the score is computed here, from the figures on the stored row, and
// the model relays it.
//
// FOUR PARTS, EACH AGAINST A PUBLISHED GUIDE, so every point can be argued
// with:
//   protein   — its share of the calories (10–35% is the Institute of
//               Medicine's range; 25%+ scores full)            3 points
//   fibre     — 14 g per 1,000 kcal (US Dietary Guidelines)     3 points
//   sugar     — under 10% of the calories (WHO); sugar that comes WITH whole
//               fruit and its fibre is not marked down          2 points
//   saturated — under 10% of the calories (US Dietary Guidelines,
//               WHO)                                            2 points
//
// WHAT IT NEVER SCORES. The amount: every part is a SHARE or a DENSITY, so a
// big plate and a small plate of the same food score the same — a meal is
// never marked down for being big, because "eat less" is the one instruction
// this product never gives. And the person: it rates what is in the food,
// never somebody for eating it, and it never calls food good or bad.
// A figure not on the row is not a zero: the score waits for it, and says
// which. Under a care flag the score is softened, never hidden (below).

const SCORE_FIG = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export const MEAL_SCORE_GUIDES = [
  'protein: its share of the calories — the Institute of Medicine range is 10–35%, and 25% or more scores full',
  'fibre: 14 g per 1,000 kcal — the US Dietary Guidelines figure',
  'sugar: under 10% of the calories (WHO) — sugar that comes with whole fruit and its fibre is not marked down',
  'saturated fat: under 10% of the calories (US Dietary Guidelines, WHO)',
];

/**
 * A meal's score out of 10 from the figures on its row, or the figures it is
 * waiting for. Pure.
 * @param {{calories, protein_g, sugar_g, fibre_g, sat_fat_g, categories?}} e
 */
export function mealScore(e = {}, { drink = false } = {}) {
  const kcal = SCORE_FIG(e.calories);
  const p = SCORE_FIG(e.protein_g), fi = SCORE_FIG(e.fibre_g), su = SCORE_FIG(e.sugar_g), sf = SCORE_FIG(e.sat_fat_g);
  const needs = [
    kcal == null || kcal <= 0 ? 'calories' : null,
    p == null ? 'protein' : null,
    fi == null ? 'fibre' : null,
    su == null ? 'sugar' : null,
    sf == null ? 'saturated fat' : null,
  ].filter(Boolean);
  if (needs.length) {
    return { score: null, needs, say: `No score yet — it needs ${needs.join(', ')} on the row.` };
  }
  // Too small to rate honestly: a splash of milk is not a meal.
  if (kcal < 50) return { score: null, needs: [], too_small: true, say: 'Too small to score — under 50 kcal.' };
  const cats = Array.isArray(e.categories) ? e.categories : [];
  // A share of the calories, held to 100: estimates that over-run the
  // calorie figure (39g of sugar on a 140 kcal row) must not print 111%.
  const share = (g, per) => Math.min(100, Math.round((g * per / kcal) * 100));
  const pct = g => share(g, 4);
  const satPct = share(sf, 9);
  const proteinPct = pct(p), sugarPct = pct(su);
  const fibrePer1000 = Math.round((fi / kcal) * 1000 * 10) / 10;

  const protein = proteinPct >= 25 ? 3 : proteinPct >= 15 ? 2 : proteinPct >= 10 ? 1 : 0;
  const fibre = fibrePer1000 >= 14 ? 3 : fibrePer1000 >= 8 ? 2 : fibrePer1000 >= 4 ? 1 : 0;
  // Whole fruit carries its sugar with its fibre; it is not free sugar.
  const fruitWithFibre = cats.includes('fruit') && fibre >= 2;
  const sugar = sugarPct <= 10 || fruitWithFibre ? 2 : sugarPct <= 20 ? 1 : 0;
  const sat = satPct <= 10 ? 2 : satPct <= 15 ? 1 : 0;
  const score = protein + fibre + sugar + sat;

  const parts = [
    { key: 'protein', points: protein, of: 3, figure: `${proteinPct}% of the calories from protein` },
    { key: 'fibre', points: fibre, of: 3, figure: `${fibrePer1000}g fibre per 1,000 kcal (guide: 14)` },
    { key: 'sugar', points: sugar, of: 2, figure: fruitWithFibre && sugarPct > 10 ? `sugar ${sugarPct}% of the calories, from whole fruit with its fibre` : `sugar ${sugarPct}% of the calories (guide: under 10)` },
    { key: 'saturated', points: sat, of: 2, figure: `saturated fat ${satPct}% of the calories (guide: under 10)` },
  ];
  const lifted = parts.filter(x => x.points === x.of).map(x => x.figure);
  const held = parts.filter(x => x.points < x.of).map(x => x.figure);
  // ONE thing that would lift it, aimed at the part furthest from its guide
  // (as a share of that part), sugar and saturated fat first on a tie — a
  // cola's problem is its sugar, not its protein. Always something to ADD or
  // swap — never "less" of anything, because nothing here tells anybody
  // to eat less.
  const ORDER = ['sugar', 'saturated', 'fibre', 'protein'];
  const gap = [...parts].sort((a, b) => ((b.of - b.points) / b.of) - ((a.of - a.points) / a.of)
    || ORDER.indexOf(a.key) - ORDER.indexOf(b.key))[0];
  const LIFT = {
    protein: 'protein alongside it — eggs, chicken, fish, Greek yogurt, beans',
    fibre: 'more fibre — vegetables, beans, fruit, or wholegrain in place of white',
    sugar: 'a swap for the sugary part — water or a diet drink, or a side with no added sugar',
    saturated: 'a leaner swap — leaner meat, or a side that is not fried, buttered or cheese-heavy',
  };
  const toLift = gap && gap.points < gap.of ? LIFT[gap.key] : null;
  const better = betterVersion({ score, parts }, { drink });
  return {
    score, out_of: 10, parts,
    lifted_by: lifted, held_back_by: held,
    to_lift: toLift,
    better,
    say: `${score}/10 on what is in it.`
      + (lifted.length ? ` Strong: ${lifted.join('; ')}.` : '')
      + (held.length ? ` Holding it back: ${held.join('; ')}.` : '')
      + (better ? ` ${better.say}` : ' Nothing to lift — full marks on every part.'),
    basis: 'Wrought\'s meal score: protein, fibre, sugar and saturated fat against published guides, worked out from the estimated figures on the row. It rates what is in the food — never the amount, never the person.',
  };
}

// ── A better version of the same meal ────────────────────────────────────────
// The founder, under a 6/10 shepherd's pie: "you should be using AI for
// similar foods that they could recommend that would be far better." The
// split is this file's oldest one. The SERVER says which part of the plate is
// holding the score back and what a better version could reach; the
// CONNECTED MODEL, which saw the meal and this server never does, names the
// version — "the same pie with lean turkey mince and peas through the
// filling". The score of the alternative is never the model's: it is "up to"
// what the missing points allow, computed here, and the model quotes it.
//
// Never a smaller plate and never "less": every line is something put in,
// put alongside, or a version of the same thing made another way. Two lines
// at most, and one for a drink — "more fibre" beside a cola is not a better
// cola. UNDER A CARE FLAG ONLY ADDITIONS ARE OFFERED. A swap (the sugary
// part, a leaner version) takes calories away, which is the one direction a
// low-intake flag exists to stop; something put alongside the same meal goes
// the other way. A flagged meal whose only gaps are swaps gets no line at all.

const BETTER = {
  sugar: { mode: 'swap', what: 'the sugary part swapped', eg: 'unsweetened, water or a diet drink, or fruit in place of a sweet' },
  saturated: { mode: 'swap', what: 'the same thing made leaner', eg: 'leaner mince or poultry, baked rather than fried, a topping or side that is not buttery or cheese-heavy' },
  fibre: { mode: 'add', what: 'more fibre through it', eg: 'vegetables or beans in it or alongside, or wholegrain in place of white',
    flagged: { what: 'vegetables, beans or fruit with it', eg: null } },
  protein: { mode: 'add', what: 'more protein in it or alongside', eg: 'eggs, chicken, fish, Greek yogurt, beans or lentils',
    flagged: { what: 'some protein with it', eg: 'eggs, chicken, fish, Greek yogurt or beans' } },
};
const BETTER_ORDER = ['sugar', 'saturated', 'fibre', 'protein'];

/**
 * The better version of a scored meal: which parts, in order, what each is
 * worth and the score it could reach. Additions only under a flag; one line
 * for a drink; null at full marks or with nothing it may say. Pure.
 */
export function betterVersion(m, { flagged = false, drink = false } = {}) {
  if (!m || m.score == null || !Array.isArray(m.parts)) return null;
  const allowed = x => !flagged || BETTER[x.key].mode === 'add';
  const ranked = m.parts
    .filter(x => x.points < x.of && BETTER[x.key])
    .sort((a, b) => ((b.of - b.points) / b.of) - ((a.of - a.points) / a.of)
      || BETTER_ORDER.indexOf(a.key) - BETTER_ORDER.indexOf(b.key));
  // A drink is judged by its own top gap only: a cola whose problem is its
  // sugar is not made better by vegetables beside it, flag or no flag.
  const gaps = drink ? ranked.slice(0, 1).filter(allowed) : ranked.filter(allowed).slice(0, 2);
  if (!gaps.length) return null;
  let at = m.score;
  const lifts = gaps.map(x => {
    const b = flagged ? BETTER[x.key].flagged : BETTER[x.key];
    at = Math.min(10, at + (x.of - x.points));
    return { part: x.key, mode: BETTER[x.key].mode, what: b.what, eg: b.eg, worth: x.of - x.points, up_to: at };
  });
  const lines = lifts.map((l, i) => `${l.what}${i ? ' as well' : ''}${l.eg ? ` (${l.eg})` : ''} — up to ${l.up_to}/10`);
  return {
    lifts, up_to: at, additions_only: flagged,
    say: `${flagged ? 'Added alongside the same meal' : 'A better version next time'}: ${lines.join('; ')}.`,
  };
}

/** What the model is told to do with a meal score — one sentence, kept with the scores. */
export const MEAL_SCORE_NOTE = 'RATE THE MEAL AS meal_score SAYS, in one or two lines and in the coach\'s register: the score out of 10, what made it strong and what is holding it back. Then ONE line from better: name one or two versions of WHAT THEY ACTUALLY ATE made the better way — you saw the meal, so be specific ("the same pie with lean turkey mince and peas through the filling"), a similar dish they would actually want rather than a lecture — each with the score better gives it ("up to 8/10"). Never a score or a figure of your own for the alternative, never a smaller plate, never "less", never calories saved — an option for next time, said once; and never "good food" or "bad food", and never a word about the amount eaten or about their body — it rates what is in the food. A meal with no score yet names the figures it needs: estimate them (numbers, never ranges) and send them with structure_entries by id in this same turn; that reply carries the score.';

/**
 * Under a care flag the score is SOFTENED, never hidden. Silence here was
 * the first version, and the founder's own record showed what it costs: a
 * low-intake flag stands on his account, so he would have seen no score at
 * all — and a model asked "rate my meal" with nothing in front of it invents
 * one, with free advice attached. What a flag stops is the push towards
 * LESS: so the score and what is strong stand, nothing holding it back is
 * listed, and no swap is offered — every swap (the sugary part, a leaner
 * version) takes calories away, the one direction a low-intake flag exists
 * to stop. Something ADDED alongside the same meal goes the other way, so
 * that, and only that, is the better version a flagged meal is given.
 */
export const MEAL_SCORE_FLAG_NOTE = 'A CARE FLAG STANDS, so say the score out of 10 and what made it strong, as meal_score says — and, only if better is there, ONE line naming something they could ADD alongside the same meal, specific to what they ate ("peas or a side salad with the pie"), with the score better gives it. Only additions: never a swap, never "in place of", never leaner or lighter, never anything to cut or skip, never a calorie figure; never "good food" or "bad food", never a word about the amount or their body. A meal with no score yet names the figures it needs: estimate them and send them with structure_entries by id in this same turn.';

/** The note that goes with a set of scores — the softened one under a flag. */
export const mealScoreNote = scores => (Array.isArray(scores) && scores.some(x => x.softened) ? MEAL_SCORE_FLAG_NOTE : MEAL_SCORE_NOTE);

/** The scores for the food and drink rows just written or read. A flag softens them; a flag state nobody read gives none. */
export function mealScores(rows = [], { flags = null } = {}) {
  // A flag state nobody could read is not "no flag": no score at all.
  if (!Array.isArray(flags)) return null;
  const food = rows.filter(r => r && (r.type === 'food' || r.type === 'drink' || r.event_type === 'food' || r.event_type === 'drink'));
  if (!food.length) return null;
  const flagged = flags.length > 0;
  return food.map(r => {
    const d = r.detail && typeof r.detail === 'object' ? r.detail : r;
    const drink = r.type === 'drink' || r.event_type === 'drink';
    const m = mealScore({ ...d, categories: d.categories }, { drink });
    if (!flagged || m.score == null) return { id: r.id ?? null, summary: r.summary ?? null, ...m };
    const better = betterVersion(m, { flagged: true, drink });
    return {
      id: r.id ?? null, summary: r.summary ?? null, ...m,
      held_back_by: [], to_lift: null, better, softened: true,
      say: `${m.score}/10 on what is in it.` + (m.lifted_by.length ? ` Strong: ${m.lifted_by.join('; ')}.` : '')
        + (better ? ` ${better.say}` : ''),
    };
  });
}

// ── What to have right now — options that know the person ───────────────────
// The founder, the same afternoon: "so I can give you other suggestions — you
// have a sweet tooth, give you other options. You can even take a picture of
// your fridge. It should know you personally, so it can come up with better
// options if you want something salty or whatever."
//
// Knowing somebody personally is the RECORD, not a guess: the foods they
// actually log, what each of them scored, and what they have told the
// assistant about their tastes. So the server hands over three things it can
// stand behind — what they are after (read off their words), their OWN foods
// that fit it and scored well, and what is remembered about how they eat —
// and the connected model, which can see a photograph of the fridge and this
// server never does, names the ideas. Nothing here prices an idea: only their
// own logged foods carry a score, because only those have figures on a row.
//
// A craving is answered with a better version of it, never with nothing.
// Under a care flag the options are only ever things to eat: no score, no
// figure, nothing lighter, nothing "instead".

const CRAVING_WORDS = {
  sweet: /\bsweet|sugar|dessert|chocolate|candy|candies|cake|cookie|biscuit|ice[- ]?cream|treat|pudding/i,
  salty: /\bsalt|savou?ry|chips|crisps|pretzel|popcorn/i,
  crunchy: /crunch|\bcrisp(y)?\b/i,
  creamy: /cream(y)?\b|chees(e|y)/i,
  filling: /starv|filling|\bfull\b|really hungry|so hungry|famished|proper meal|something big/i,
};

/** What they are after, read off their own words — never guessed. Pure. */
export function cravingFrom(text = '') {
  const t = String(text || '');
  return Object.keys(CRAVING_WORDS).filter(k => CRAVING_WORDS[k].test(t));
}

const FOOD_FITS = {
  sweet: /chocolate|yog(h)?urt|berr|fruit|apple|banana|grape|mango|orange|pear|peach|honey|ice ?cream|cookie|cake|muffin|smoothie|pudding|protein bar|granola|\bdates?\b|jam|pancake|waffle|oat|cereal|frozen yog/i,
  salty: /chip|crisp|pretzel|popcorn|\bnuts?\b|almond|peanut|cashew|pistachio|cheese|pickle|jerky|olive|cracker|pita|salted|seaweed|edamame|\beggs?\b|hot ?dog|sausage|bacon|ham\b|soup|ramen|fries/i,
  crunchy: /chip|crisp|pretzel|popcorn|\bnuts?\b|almond|peanut|cracker|apple|carrot|celery|granola|toast|pita|rice cake/i,
  creamy: /yog(h)?urt|cheese|cream|hummus|avocado|peanut butter|smoothie|pudding|cottage|skyr|shake/i,
};

const nameKey = s => String(s || '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Their own foods that fit what they are after. Unflagged: scored 7 or more,
 * the craving's fit first, then the score, then how often they have it.
 * Flagged: anything they eat that fits, by how often — no score, no figure.
 * Pure. @param rows food/drink events {summary, detail, local_date}
 */
export function ownOptions(rows = [], { want = [], flagged = false, limit = 3 } = {}) {
  const seen = new Map();
  for (const r of rows) {
    if (!r || (r.event_type !== 'food' && r.event_type !== 'drink')) continue;
    const d = r.detail && typeof r.detail === 'object' ? r.detail : {};
    const name = String(r.summary || '').trim();
    const key = nameKey(name);
    if (!key) continue;
    const m = mealScore({ ...d, categories: d.categories }, { drink: r.event_type === 'drink' });
    const p = SCORE_FIG(d.protein_g);
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, { name, times: 1, last: r.local_date || null, score: m.score, kcal: SCORE_FIG(d.calories), protein_g: p });
    } else {
      prev.times += 1;
      if (m.score != null && (prev.score == null || m.score > prev.score)) prev.score = m.score;
      if (r.local_date && (!prev.last || r.local_date > prev.last)) { prev.name = name; prev.last = r.local_date; prev.kcal = SCORE_FIG(d.calories); prev.protein_g = p; }
    }
  }
  const fits = o => want.filter(w => (w === 'filling' ? (o.protein_g ?? 0) >= 20 : FOOD_FITS[w]?.test(o.name))).length;
  const pool = [...seen.values()].filter(o => (flagged ? true : o.score != null && o.score >= 7) && (!want.length || fits(o) > 0));
  pool.sort((a, b) => fits(b) - fits(a)
    || (flagged ? 0 : (b.score ?? 0) - (a.score ?? 0))
    || b.times - a.times
    || String(b.last || '').localeCompare(String(a.last || '')));
  return pool.slice(0, limit).map(o => flagged
    ? { name: o.name, times: o.times, last: o.last }
    : { name: o.name, score: o.score, times: o.times, last: o.last, kcal: o.kcal });
}

// A taste, not a standing instruction: "I have a sweet tooth" is known, while
// "always log my food to Wrought" is about the record and is left out.
const TASTE = /\b(sweet|salt|snack|crav|hate|love|dislike|can'?t stand|allerg|intoleran|lactose|gluten|vegan|vegetarian|spicy|dairy|fish|meat|takeaway|cook)/i;
const NOT_TASTE = /\blog(s|ged|ging)?\b|wrought|\btotals?\b/i;

/**
 * The whole options read for "what can I have": what they are after, their
 * own foods that fit, and what is remembered about their tastes. Pure.
 */
export function optionsFor({ text = '', rows = [], memory = [], dietary = [], flagged = false } = {}) {
  const want = cravingFrom(text);
  const yours = ownOptions(rows, { want, flagged });
  const known = [
    ...(Array.isArray(dietary) && dietary.length ? [`Does not eat: ${dietary.join(', ')}`] : []),
    ...memory.filter(m => m && m.fact && !NOT_TASTE.test(m.fact) && (m.category === 'food' || TASTE.test(m.fact))).map(m => m.fact),
  ].slice(0, 6);
  const list = yours.map(o => (flagged || o.score == null ? o.name : `${o.name} (${o.score}/10)`)).join('; ');
  return {
    want, yours, known, additions_only: flagged,
    say: yours.length
      ? `${want.length ? `For something ${want.join(' and ')}, from` : 'From'} what you already eat${flagged ? '' : ' that scored well'}: ${list}.`
      : null,
    fridge: 'With a photo of their fridge, cupboard or a menu, choose only from what is in it — this server never sees the photo, and naming what is not there is a guess.',
  };
}

export const OPTIONS_NOTE = 'OPTIONS FOR RIGHT NOW: give two or three named options for what they want, in a short paragraph and in the coach\'s register — first anything in options.yours (their own food that scored well — say its score), then ideas of your own that fit options.want and everything in options.known (their tastes, what they do not eat). With a photo of their fridge, cupboard or a menu, choose ONLY from what is in it. Any calories for an idea of yours are "roughly"; never a meal score of your own — only options.yours carries scores. A craving is answered with a better version of it, never with nothing: never "just have water", "wait it out" or "brush your teeth" as the answer, and never a smaller amount framed as discipline. Nothing want-shaped in their words? One clause asking sweet or salty is fine — never a questionnaire. A taste they tell you — a sweet tooth, loves salty, hates fish, lactose — goes to remember (category preference) so the options are theirs next time.';

export const OPTIONS_FLAG_NOTE = 'OPTIONS, UNDER A CARE FLAG: name two or three things to eat that answer what they want — from options.yours first, then ideas that fit options.want and options.known; with a photo of their fridge, only what is in it. Options only: no score, no calorie figure, nothing lighter, never "instead", never a reason to wait or to have less. A taste they tell you goes to remember (category preference).';
