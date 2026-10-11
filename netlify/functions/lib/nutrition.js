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
// which. Under a care flag there is no score at all — rating food is coaching.

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
export function mealScore(e = {}) {
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
  return {
    score, out_of: 10, parts,
    lifted_by: lifted, held_back_by: held,
    to_lift: toLift,
    say: `${score}/10 on what is in it.`
      + (lifted.length ? ` Strong: ${lifted.join('; ')}.` : '')
      + (held.length ? ` Holding it back: ${held.join('; ')}.` : '')
      + (toLift ? ` To lift it next time: ${toLift}.` : ' Nothing to lift — full marks on every part.'),
    basis: 'Wrought\'s meal score: protein, fibre, sugar and saturated fat against published guides, worked out from the estimated figures on the row. It rates what is in the food — never the amount, never the person.',
  };
}

/** What the model is told to do with a meal score — one sentence, kept with the scores. */
export const MEAL_SCORE_NOTE = 'RATE THE MEAL AS meal_score SAYS, in one or two lines and in the coach\'s register: the score out of 10, what made it strong, and the one thing in to_lift. Never a score of your own, never "good food" or "bad food", and never a word about the amount eaten or about their body — it rates what is in the food. A meal with no score yet names the figures it needs: estimate them (numbers, never ranges) and send them with structure_entries by id in this same turn; that reply carries the score.';

/**
 * Under a care flag the score is SOFTENED, never hidden. Silence here was
 * the first version, and the founder's own record showed what it costs: a
 * low-intake flag stands on his account, so he would have seen no score at
 * all — and a model asked "rate my meal" with nothing in front of it invents
 * one, with free advice attached. What a flag stops is the PUSH: so the score
 * and what is strong stand, and nothing that would lift it is said — every
 * swap a meal score suggests (the sugary part, the saturated fat) takes
 * calories away, which is the one direction a low-intake flag exists to stop.
 */
export const MEAL_SCORE_FLAG_NOTE = 'A CARE FLAG STANDS, so say ONLY the score out of 10 and what made it strong, as meal_score says — no swap, no advice, nothing to lift, nothing about cutting, replacing or skipping anything, never "good food" or "bad food", never a word about the amount or their body. A meal with no score yet names the figures it needs: estimate them and send them with structure_entries by id in this same turn.';

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
    const m = mealScore({ ...d, categories: d.categories });
    if (!flagged || m.score == null) return { id: r.id ?? null, summary: r.summary ?? null, ...m };
    return {
      id: r.id ?? null, summary: r.summary ?? null, ...m,
      held_back_by: [], to_lift: null, softened: true,
      say: `${m.score}/10 on what is in it.` + (m.lifted_by.length ? ` Strong: ${m.lifted_by.join('; ')}.` : ''),
    };
  });
}
