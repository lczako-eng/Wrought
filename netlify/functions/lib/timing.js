// lib/timing.js
// When they eat — read off the clock on every entry, drawn as a picture,
// never graded.
//
// The founder: "you should use the GPT and other things to know WHEN you're
// eating. When you're saying 'Broski I just ate this', take the time — and if
// it's not correct, like you ate an hour ago and forgot, just tell it the
// time. Then we can use that on a chart, when you eat and all that."
//
// Three parts, and this file is the third. Every entry already carries a
// clock (occurred_at, or the time they said as time_hint). `log` now reads
// that clock back in the confirmation so a wrong one gets corrected on the
// spot, and amend_last takes a time. This turns the clocks into the read: the
// first and last meal of a typical day, the window between them, how much of
// the eating lands late, and the dots for the chart.
//
// NEVER GRADED. The eating-window doctrine already says a timetable is not a
// fast, and fasting is never scored; the same applies here. "31% of your
// calories after 8pm" is a fact about the record. "Too late" is an opinion
// nothing here is entitled to, and a chart that scolds is a chart that stops
// being opened. There is a test grepping the say for judgement words.
//
// THE CLOCK IS ONLY AS HONEST AS THE LOGGING. A meal filed at the minute it
// was mentioned, an hour after it was eaten, is an hour wrong on this chart
// — which is exactly why the confirmation now says the time back. The caveat
// rides every response.

const MEDIAN = arr => {
  const s = arr.filter(v => v != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

export const LATE_MINUTES = 20 * 60;   // 8pm in their own zone
const MIN_DAYS = 3;

export function clock(minutes) {
  if (minutes == null) return null;
  const h = Math.floor(minutes / 60) % 24, m = minutes % 60;
  const ap = h < 12 ? 'am' : 'pm';
  const hh = h % 12 || 12;
  return `${hh}:${String(m).padStart(2, '0')}${ap}`;
}

/**
 * @param days   rangeFacts days, each carrying meal_times [{at, kcal, summary}]
 * @returns { points, days_counted, first, last, window_minutes, late_share,
 *            by_hour, say, caveat }
 */
export function mealTiming(days = [], { today = null } = {}) {
  const withMeals = days.filter(d => Array.isArray(d.meal_times) && d.meal_times.length);
  const points = [];
  const firsts = [], lasts = [], spans = [];
  let lateKcal = 0, knownKcal = 0;
  const byHour = Array.from({ length: 24 }, () => 0);

  for (const d of withMeals) {
    const ts = d.meal_times;
    const first = ts[0].at, last = ts[ts.length - 1].at;
    // Today is still open — its last meal is not last yet. Its first meal
    // and its dots count; its span and its last do not.
    const open = today && d.date === today;
    firsts.push(first);
    if (!open) { lasts.push(last); spans.push(last - first); }
    for (const t of ts) {
      points.push({ date: d.date, at: t.at, clock: clock(t.at), kcal: t.kcal, summary: t.summary, type: t.type });
      if (t.kcal != null) {
        knownKcal += t.kcal;
        if (t.at >= LATE_MINUTES) lateKcal += t.kcal;
        byHour[Math.floor(t.at / 60) % 24] += t.kcal;
      }
    }
  }

  const first = MEDIAN(firsts);
  const last = MEDIAN(lasts);
  const window = MEDIAN(spans);
  const lateShare = knownKcal > 0 ? Math.round((lateKcal / knownKcal) * 100) : null;
  const counted = withMeals.length;

  const enough = counted >= MIN_DAYS;
  const say = !counted
    ? 'No meals with a time on them in this stretch.'
    : !enough
      ? `${counted} logged day${counted === 1 ? '' : 's'} — a pattern needs at least ${MIN_DAYS}.`
      : `First meal usually around ${clock(first)}${last != null ? `, last around ${clock(last)}` : ''}${
          window != null ? ` — about ${Math.round(window / 60 * 10) / 10}h from first to last` : ''}, over ${counted} logged days.${
          lateShare != null ? ` ${lateShare}% of logged calories landed after ${clock(LATE_MINUTES)}.` : ''}`;

  return {
    points,
    days_counted: counted,
    first_meal: first != null ? clock(first) : null,
    last_meal: last != null ? clock(last) : null,
    window_minutes: window,
    late_share_percent: lateShare,
    by_hour: byHour.map(v => Math.round(v)),
    enough,
    say,
    caveat: 'These are the clocks on the entries — the time said, or the minute it was filed. A meal logged an hour late sits an hour wrong here; correct the time when the confirmation reads it back. Recorded, not graded: there is no right hour to eat.',
  };
}
