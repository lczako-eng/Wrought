// netlify/functions/lib/athlete.js
// The athlete track — the performance sensors read as trends, the tests kept
// as bests, and the one thing worth working on this week.
//
// The founder: "as a trainer for competitive sports, that should have a
// version where we take more sensors — VO2 max, sprint time and stuff like
// that. This should have a plan to build you like a super athlete, and your
// reminders should reflect all this: you should be working out five times a
// week, these are the ones I recommend you work on. It should analyse."
//
// WHAT THIS IS. Everything the watch already sends — VO2 max, resting heart
// rate, HRV, one-minute heart-rate recovery, walking heart rate, the six-minute
// walk — plus the tests a person can only run and tell you about: a 40 m
// sprint, a vertical jump, a 5k. Read against THEIR OWN record, as trends,
// and turned into at most three recommendations, each with its evidence.
//
// WHAT IT IS NOT, and every line below holds to it:
//   - NOT A DIAGNOSIS. VO2 max, HRV and resting heart rate are training
//     signals. A falling HRV is a reason to train lighter this week, never a
//     word about a heart. Nothing here names a condition, and the caution
//     rides every response.
//   - NEVER INVENTS A NUMBER. A marker with no samples is said to be missing
//     and HOW it arrives (a watch through Apple Health; a test you log). A
//     recommended commitment is OFFERED — five a week, split — and set only
//     when the person says yes.
//   - RECOVERY ONLY EVER SOFTENS. The recovery recommendation is "lighter this
//     week", never "push through". Same rule as readiness.
//   - TRENDS BEAT DAYS. A marker's trend is this month against last month,
//     needing samples on both sides; one reading is a reading, not a trend.

import { supabase } from './wrought.js';

const num = v => (v == null || v === '' ? null : Number(v));
const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/** The rows the read needs — every athlete metric since `fromDate`. One query. */
export async function athleteRows(userId, fromDate) {
  const { data } = await supabase.from('wrought_metrics')
    .select('metric, value, unit, local_date, measured_at')
    .eq('user_id', userId).in('metric', ATHLETE_METRICS)
    .gte('local_date', fromDate).order('local_date', { ascending: true });
  return data || [];
}

// The device markers, and which direction is the good one.
export const MARKERS = {
  vo2max:       { say: 'VO2 max', unit: 'ml/kg/min', better: 'higher', how: 'arrives from Apple Health or Health Connect — a watch estimates it on outdoor walks and runs' },
  resting_hr:   { say: 'resting heart rate', unit: 'bpm', better: 'lower', how: 'arrives nightly from a watch' },
  hrv:          { say: 'HRV', unit: 'ms', better: 'higher', how: 'arrives nightly from a watch' },
  hr_recovery:  { say: 'heart-rate recovery (1 min)', unit: 'bpm', better: 'higher', how: 'arrives from a watch after a recorded workout' },
  walking_hr:   { say: 'walking heart rate', unit: 'bpm', better: 'lower', how: 'arrives from a watch' },
  six_min_walk: { say: 'six-minute walk', unit: 'm', better: 'higher', how: 'arrives from Apple Health' },
};

// The tests only a person can run. Logged with log_test, kept as bests.
export const TESTS = {
  sprint_40m_s:     { say: '40 m sprint', unit: 's', better: 'lower', how: 'log it: "40 m sprint 5.2 seconds"' },
  sprint_100m_s:    { say: '100 m sprint', unit: 's', better: 'lower', how: 'log it: "100 m in 13.1"' },
  run_1mile_s:      { say: 'mile', unit: 's', better: 'lower', how: 'log it: "mile in 7:40"' },
  run_5k_s:         { say: '5k', unit: 's', better: 'lower', how: 'log it: "5k in 24:10"' },
  vertical_jump_cm: { say: 'vertical jump', unit: 'cm', better: 'higher', how: 'log it: "vertical jump 58 cm"' },
  broad_jump_cm:    { say: 'broad jump', unit: 'cm', better: 'higher', how: 'log it: "broad jump 240 cm"' },
  beep_test_level:  { say: 'beep test', unit: 'level', better: 'higher', how: 'log it: "beep test 11.4"' },
  plank_hold_s:     { say: 'plank hold', unit: 's', better: 'higher', how: 'log it: "plank 2 minutes"' },
};

export const ATHLETE_METRICS = [...Object.keys(MARKERS), ...Object.keys(TESTS)];

export const NOT_MEDICAL = 'VO2 max, HRV, resting and recovery heart rate are training signals read as trends against your own record — never a diagnosis, never a clinical reading. A number that worries you is a question for a doctor, not for this.';

function fmt(v, unit) {
  if (v == null) return '—';
  if (unit === 's') {
    if (v >= 60) { const m = Math.floor(v / 60), s = Math.round(v - m * 60); return `${m}:${String(s).padStart(2, '0')}`; }
    return `${Math.round(v * 10) / 10} s`;
  }
  return `${Math.round(v * 10) / 10}${unit === 'level' ? '' : ' ' + unit}`;
}

/**
 * A device marker as a trend: this month against the month before.
 * Pure. `rows` are wrought_metrics rows for ONE metric.
 */
export function markerRead(name, rows = [], today) {
  const spec = MARKERS[name];
  if (!spec) return null;
  const sorted = [...rows].filter(r => num(r.value) != null).sort((a, b) => String(a.local_date).localeCompare(String(b.local_date)));
  if (!sorted.length) return { metric: name, say: spec.say, unit: spec.unit, missing: true, how: spec.how };
  const latest = sorted[sorted.length - 1];
  const cut30 = addDays(today, -30), cut60 = addDays(today, -60);
  const recent = sorted.filter(r => r.local_date > cut30).map(r => num(r.value));
  const prior = sorted.filter(r => r.local_date > cut60 && r.local_date <= cut30).map(r => num(r.value));
  const a = avg(recent), b = avg(prior);
  let trend = 'not_enough', pct = null;
  if (a != null && b != null && recent.length >= 3 && prior.length >= 3 && b !== 0) {
    pct = Math.round(((a - b) / Math.abs(b)) * 1000) / 10;
    trend = Math.abs(pct) < 2 ? 'flat' : pct > 0 ? 'up' : 'down';
  }
  const good = trend === 'flat' ? null : trend === 'not_enough' ? null
    : (spec.better === 'higher') === (trend === 'up');
  return {
    metric: name, say: spec.say, unit: spec.unit,
    latest: Math.round(num(latest.value) * 10) / 10, latest_on: latest.local_date,
    month_avg: a != null ? Math.round(a * 10) / 10 : null,
    prior_avg: b != null ? Math.round(b * 10) / 10 : null,
    samples: sorted.length, trend, pct, good,
    line: trend === 'not_enough'
      ? `${spec.say} ${fmt(num(latest.value), spec.unit)} (${sorted.length} reading${sorted.length === 1 ? '' : 's'} — a trend needs a month on each side).`
      : `${spec.say} ${fmt(a, spec.unit)} this month, ${trend === 'flat' ? 'flat on' : `${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}% from`} last month${good == null ? '' : good ? ' — the right direction' : ' — the wrong direction'}.`,
  };
}

/** A logged test as a best and a latest. Pure. */
export function testRead(name, rows = []) {
  const spec = TESTS[name];
  if (!spec) return null;
  const sorted = [...rows].filter(r => num(r.value) != null).sort((a, b) => String(a.local_date).localeCompare(String(b.local_date)));
  if (!sorted.length) return { test: name, say: spec.say, unit: spec.unit, missing: true, how: spec.how };
  const vals = sorted.map(r => num(r.value));
  const bestVal = spec.better === 'lower' ? Math.min(...vals) : Math.max(...vals);
  const best = sorted.find(r => num(r.value) === bestVal);
  const latest = sorted[sorted.length - 1];
  const lv = num(latest.value);
  const offBest = bestVal === 0 ? 0 : Math.round(Math.abs((lv - bestVal) / bestVal) * 1000) / 10;
  const isBest = lv === bestVal;
  return {
    test: name, say: spec.say, unit: spec.unit,
    best: bestVal, best_on: best.local_date, latest: lv, latest_on: latest.local_date,
    count: sorted.length, is_best: isBest, off_best_pct: offBest,
    line: isBest
      ? `${spec.say} ${fmt(lv, spec.unit)} on ${latest.local_date} — your best${sorted.length > 1 ? ` of ${sorted.length}` : ''}.`
      : `${spec.say} ${fmt(lv, spec.unit)} on ${latest.local_date}; best ${fmt(bestVal, spec.unit)} on ${best.local_date}.`,
  };
}

// The commitment an athlete track suggests. OFFERED, never set: five a week,
// two strength, two stamina, one speed or skill session (counted with
// stamina), five hours. Their number, once they say so.
export const ATHLETE_COMMITMENT = {
  strength_per_week: 2, cardio_per_week: 3, minutes_per_week: 300,
  say: 'Five sessions a week — two strength, two stamina, one speed or skill session — about five hours. Say yes to set it, or say your own numbers.',
};

/**
 * The read. Pure — every input is rows or numbers already computed elsewhere.
 *
 * @param rows     wrought_metrics rows for ATHLETE_METRICS over ~90 days
 * @param week     weekSoFar output (with commitment when one is set)
 * @param days     rangeFacts days over the last 28+ days (for consistency)
 * @param profile  the profile (track, sport, commitment columns)
 * @param today    local date
 */
export function athleteRead({ rows = [], week = null, days = [], profile = {}, today } = {}) {
  const byMetric = {};
  for (const r of rows) (byMetric[r.metric] ||= []).push(r);

  const markers = Object.keys(MARKERS).map(m => markerRead(m, byMetric[m] || [], today));
  const tests = Object.keys(TESTS).map(t => testRead(t, byMetric[t] || []));
  const present = markers.filter(m => !m.missing);
  const loggedTests = tests.filter(t => !t.missing);

  const c = week?.commitment || null;
  const recs = [];

  // 1. RECOVERY — only ever softens, and comes first because a week that
  //    should be lighter must not be told to add a stamina session.
  const hrv = markers.find(m => m.metric === 'hrv');
  const rhr = markers.find(m => m.metric === 'resting_hr');
  if ((hrv && hrv.trend === 'down' && Math.abs(hrv.pct) >= 8) || (rhr && rhr.trend === 'up' && Math.abs(rhr.pct) >= 5)) {
    const ev = [hrv?.trend === 'down' ? `HRV down ${Math.abs(hrv.pct)}% on last month` : null, rhr?.trend === 'up' ? `resting HR up ${Math.abs(rhr.pct)}% on last month` : null].filter(Boolean).join(', ');
    recs.push({ key: 'recovery', say: `Recovery: ${ev}. This week is lighter, not more — same movements, nothing near failure.`, why: ev, do: 'train lighter this week' });
  }

  // 2. ENGINE — the stamina side of the commitment, or a VO2 max that has
  //    stopped moving.
  const vo2 = markers.find(m => m.metric === 'vo2max');
  const staminaShort = c?.cardio && c.cardio.done < c.cardio.target;
  if (staminaShort || (vo2 && (vo2.trend === 'flat' || (vo2.trend === 'down')))) {
    const bits = [];
    if (staminaShort) bits.push(`${c.cardio.done} of ${c.cardio.target} stamina sessions this week`);
    if (vo2 && vo2.trend !== 'not_enough' && !vo2.missing) bits.push(vo2.trend === 'flat' ? `VO2 max flat on last month at ${vo2.month_avg}` : `VO2 max down ${Math.abs(vo2.pct)}% on last month`);
    if (bits.length) recs.push({ key: 'engine', say: `Engine: ${bits.join('; ')}. A steady stamina session moves it; intervals move it faster once the base is there.`, why: bits.join('; '), do: 'a stamina session' });
  }

  // 3. SPEED — no test in four weeks, or the latest well off the best.
  const speedTests = loggedTests.filter(t => /sprint|jump/.test(t.test));
  const stale = speedTests.length && speedTests.every(t => t.latest_on < addDays(today, -28));
  const offBest = speedTests.find(t => !t.is_best && t.off_best_pct >= 3);
  if (!speedTests.length) {
    recs.push({ key: 'speed', say: 'Speed: no sprint or jump test on record yet. Run one — a 40 m sprint or a vertical jump — and log it, then there is a number to move.', why: 'no test logged', do: 'log a sprint or jump test' });
  } else if (stale) {
    recs.push({ key: 'speed', say: `Speed: last test ${speedTests[0].latest_on}, over four weeks ago. Retest this week, then we know.`, why: 'test older than 28 days', do: 'retest' });
  } else if (offBest) {
    recs.push({ key: 'speed', say: `Speed: ${offBest.say} ${fmt(offBest.latest, offBest.unit)} against a best of ${fmt(offBest.best, offBest.unit)} — ${offBest.off_best_pct}% off. Fresh legs and a proper warm-up before the next attempt.`, why: `${offBest.off_best_pct}% off best`, do: 'a speed session, fresh' });
  }

  // 4. STRENGTH — the strength side of the commitment.
  if (c?.strength && c.strength.done < c.strength.target) {
    recs.push({ key: 'strength', say: `Strength: ${c.strength.done} of ${c.strength.target} sessions this week.`, why: 'strength sessions short', do: 'a strength session' });
  }

  // 5. CONSISTENCY — four weeks against the commitment, only when one exists.
  const target = num(profile.train_days);
  if (target && days.length >= 21) {
    const weeksSeen = Math.max(1, Math.round(days.length / 7));
    const sessions = days.reduce((a, d) => a + (d.sessions || 0), 0);
    const perWeek = Math.round((sessions / weeksSeen) * 10) / 10;
    if (perWeek < target * 0.75) {
      recs.push({ key: 'consistency', say: `Consistency: ${perWeek} sessions a week over the last ${weeksSeen} weeks against the ${target} you set. The plan is not wrong until it is kept; keep it two weeks, then we look at it.`, why: `${perWeek}/wk vs ${target}`, do: 'keep the week' });
    }
  }

  const top = recs[0] || null;
  const noCommitment = profile.strength_per_week == null && profile.cardio_per_week == null;

  return {
    track: profile.track || 'general',
    sport: profile.sport && profile.sport !== 'none' ? profile.sport : null,
    markers, tests,
    markers_present: present.length, tests_logged: loggedTests.length,
    recommendations: recs.slice(0, 3),
    top,
    ...(noCommitment ? { commitment_recommended: ATHLETE_COMMITMENT } : {}),
    say: top
      ? `Work on: ${top.say}`
      : present.length || loggedTests.length
        ? 'Nothing is behind — the week is on plan and the markers are moving the right way or holding.'
        : 'No performance markers on record yet. A watch through Apple Health sends VO2 max, resting HR, HRV and recovery on its own; a sprint or jump test is one sentence to log.',
    not_medical: NOT_MEDICAL,
    note: 'Say the top recommendation in one line with its evidence, then stop. Never call a marker good or bad about their heart — it is a training signal. Recovery only ever means lighter, never "push through". The recommended commitment is OFFERED: set it with set_plan only when they say yes or give their own numbers.',
  };
}

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Parse a spoken test result into seconds / cm / level. Pure. */
export function parseTestValue(test, raw) {
  const spec = TESTS[test];
  if (!spec) return null;
  const s = String(raw ?? '').trim();
  if (spec.unit === 's') {
    const mm = s.match(/(\d+)\s*[:m]\s*(\d{1,2})(?:\.\d+)?\s*s?/i);
    if (mm) return Number(mm[1]) * 60 + Number(mm[2]);
    const minOnly = s.match(/(\d+(?:\.\d+)?)\s*min/i);
    if (minOnly) return Math.round(Number(minOnly[1]) * 60);
    const n = s.match(/\d+(?:\.\d+)?/);
    return n ? Number(n[0]) : null;
  }
  if (spec.unit === 'cm') {
    const n = s.match(/(\d+(?:\.\d+)?)\s*(cm|in|inch|inches)?/i);
    if (!n) return null;
    const v = Number(n[1]);
    return /in/i.test(n[2] || '') ? Math.round(v * 2.54 * 10) / 10 : v;
  }
  const n = s.match(/\d+(?:\.\d+)?/);
  return n ? Number(n[0]) : null;
}
