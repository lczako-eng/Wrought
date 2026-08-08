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
