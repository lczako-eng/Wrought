// netlify/functions/brief-nightly.js
// The verdict arrives without being asked for.
//
// This is the difference between a tool and a habit. A brief you have to
// remember to request is one you request twice and then forget exists. A brief
// that turns up at ten o'clock is the thing you end the day with.
//
// Runs HOURLY, not nightly, which looks wrong until you remember that "10pm"
// is a different instant for every user. The function wakes up every hour and
// serves only the people for whom it is currently 22:00 where they stand — the
// same reason local_date is stored rather than derived.
//
// Delivery is deliberately plural. MCP cannot push: the protocol is strictly
// request/response, the client calls us and we can never call the client, so
// there is no path from here into a ChatGPT notification. Anyone who tells you
// otherwise is describing something else. What actually reaches a phone:
//
//   1. The nightly push a user's own Shortcut already makes — /ingest hands the
//      brief back in its response and the Shortcut shows it. Zero new
//      infrastructure, works the day they set the watch up.
//   2. Email, from here.
//   3. Web push to an installed PWA — the proper answer, and the next build.

import {
  supabase, openai, localDateFor, localMinutesFor, addDays,
  getProfile, getGoals, getMemory, humanDuration,
  dayFacts, rangeFacts, summariseRange, scoreGoals, careFlags, writeVerdict,
} from './lib/wrought.js';
import { sendPush, vapidConfigured } from './lib/push.js';
import { plainBrief } from './lib/voice.js';
import { energyBalance, weekSoFar, goalsToSet } from './lib/training.js';
import { dueAlerts } from './lib/alerts.js';
import { morningBrief, middayBrief, morningDue, morningLink } from './lib/morning.js';

const SEND_HOUR = 22;

// Everyone who has logged anything in the last fortnight. A dormant account
// does not need a nightly email about a week that did not happen.
async function activeUsers() {
  const since = addDays(new Date().toISOString().slice(0, 10), -14);
  const { data } = await supabase.from('wrought_events')
    .select('user_id').gte('local_date', since).limit(5000);
  return [...new Set((data || []).map(r => r.user_id))];
}

// The brief is generated and stored regardless of whether it can be delivered.
// Then it is waiting the moment they open any AI and ask — and the delivery
// channels are a bonus rather than a dependency.
export async function buildBriefFor(userId, now = new Date()) {
  const profile = await getProfile(userId);
  const date = localDateFor(profile.timezone, now);

  const [goals, memory, day, range] = await Promise.all([
    getGoals(userId), getMemory(userId),
    dayFacts(userId, profile, date),
    rangeFacts(userId, profile, addDays(date, -29), date),
  ]);

  const summary = summariseRange(range, profile);
  const flags   = careFlags(range, profile);

  const facts = {
    date, kind: 'evening', units: profile.units,
    food: day.food, training: day.training, body: day.body, device: day.device,
    thirty_days: {
      adherence_pct: summary.adherence_pct,
      calories_avg: summary.calories_avg,
      protein_avg: summary.protein_avg,
      training_days: summary.training_days,
      sleep_avg: summary.sleep_avg_minutes ? humanDuration(summary.sleep_avg_minutes) : null,
      weight: summary.weight,
      neglected_muscles: summary.matrix.neglected,
    },
    streak: { current: summary.current_streak, longest: summary.longest_streak },
    goals: scoreGoals(goals, day, summary, profile),
  };

  let verdict = await writeVerdict({ facts, profile, goals, memory, flags, kind: 'evening' });
  let written = !!verdict;

  // WITHOUT A KEY THIS CHANNEL WAS SIMPLY DEAD. writeVerdict returns null with
  // no OPENAI_API_KEY, the send loop skipped on a null verdict, and so the one
  // surface that can genuinely speak first never spoke — silently, and for
  // exactly the reason the founder did not want to pay for a key in the first
  // place. The computed version is not as good as the written one. It is
  // enormously better than nothing, and it is facts rather than opinion.
  if (!verdict) {
    const bal = energyBalance({
      profile, weightKg: day.body.weight_kg,
      caloriesIn: day.food.calories,
      activeCalories: day.device.active_calories,
      foodEstimated: day.food.estimated,
      workouts: day.training.entries,
      activities: day.activity.entries,
      deviceResting: day.device.resting_calories,
    });
    verdict = plainBrief({ facts, flags, balance: bal });
  }

  if (verdict && written) {
    await supabase.from('wrought_briefs').upsert(
      { user_id: userId, local_date: date, kind: 'evening', facts, verdict },
      { onConflict: 'user_id,local_date,kind' });
  }

  return { date, facts, verdict, flags, profile, logged: day.logged };
}

// Email is the one channel that needs nothing installed and no permission
// granted. Resend if it is configured; otherwise the brief is still stored and
// still there when they ask for it.
async function email(to, subject, text) {
  if (!process.env.RESEND_API_KEY || !to) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.WROUGHT_FROM_EMAIL || 'Wrought <brief@wrought.fit>',
        to, subject,
        text: `${text}\n\n—\nwrought.fit`,
      }),
    });
    return res.ok;
  } catch { return false; }
}

// The lock screen, which is the reason the PWA is worth installing. Nothing
// here composes a sentence: the verdict was computed already, and a notification
// that phrased things its own way could disagree with the brief it came from.
async function push(userId, profile, out) {
  return deliver(userId, profile, {
    title: 'WROUGHT',
    // First sentence only. A lock screen truncates anyway, and a verdict cut
    // mid-clause reads as harsher than it is.
    body: firstSentence(out.verdict),
    tag: `wrought-${out.date}`,
    url: '/app.html',
  });
}

// One sender for every kind of notification this product has. The nightly read
// and a rule somebody set by talking are the same act from the phone's point of
// view, and two copies of the dead-subscription clean-up is how one of them
// quietly stops working.
async function deliver(userId, profile, message) {
  if (!vapidConfigured()) return 0;
  if (profile.push_enabled === false) return 0;

  const { data: subs } = await supabase.from('wrought_push_subs')
    .select('endpoint, p256dh, auth').eq('user_id', userId);
  if (!subs?.length) return 0;

  const results = await Promise.all(subs.map(s => sendPush(s, message)));

  const dead = subs.filter((_, i) => results[i].gone).map(s => s.endpoint);
  if (dead.length) {
    await supabase.from('wrought_push_subs').delete().eq('user_id', userId).in('endpoint', dead);
  }
  const live = subs.filter((_, i) => results[i].ok).map(s => s.endpoint);
  if (live.length) {
    await supabase.from('wrought_push_subs')
      .update({ last_sent_at: new Date().toISOString(), failures: 0 }).in('endpoint', live);
  }
  return results.filter(r => r.ok).length;
}

function firstSentence(text) {
  const t = String(text || '').trim();
  const cut = t.search(/[.!?](\s|$)/);
  const one = cut > 0 ? t.slice(0, cut + 1) : t;
  return one.length > 160 ? `${one.slice(0, 157)}\u2026` : one;
}

// ── The rules somebody set by talking ─────────────────────────────────────
//
// This is the half that answers "can you not just tell it to push whatever I
// want". The assistant wrote a row; this reads it every hour and sends. It is
// deliberately separate from the nightly brief: the brief is one considered
// read of the day, and these are short, specific and set by the person.
//
// EVERYTHING IT DECIDES ON IS COMPUTED ELSEWHERE. dueAlerts is pure and takes
// the same dayFacts, energyBalance, careFlags and weekSoFar the dashboard and
// the brief use, so a notification and the screen can never quote two
// different numbers for the same afternoon.
// THE MORNING BRIEFING.
//
// A door must be correct before the SQL runs — the 015 lesson, and the sharpest
// version of it is that naming a column PostgREST does not know about makes it
// reject the WHOLE query. So 019 is probed once per container rather than
// assumed, and until it exists the morning brief is simply off. Off is also the
// default WITH the migration, so an un-migrated database behaves exactly like
// an account that has not asked for one: nothing breaks, nothing lies, and the
// evening read is untouched either way.
let morningReady = null;
async function morningColumnsExist() {
  if (morningReady !== null) return morningReady;
  const { error } = await supabase.from('wrought_profile')
    .select('morning_hour', { head: true }).limit(1);
  morningReady = !error;
  return morningReady;
}

let middayReady = null;
async function middayColumnsExist() {
  if (middayReady !== null) return middayReady;
  const { error } = await supabase.from('wrought_profile')
    .select('midday_hour', { head: true }).limit(1);
  middayReady = !error;
  return middayReady;
}

// The founder's second check-in: where the day stands while there is still an
// afternoon to act on it. Same guards as the morning — probed columns, once a
// day, stamped only on success, a failure here never costs the evening read.
async function runMidday(userId, profile, now) {
  if (!(await middayColumnsExist())) return 0;

  const date = localDateFor(profile.timezone, now);
  const minutes = localMinutesFor(profile.timezone, now);

  const { data: m } = await supabase.from('wrought_profile')
    .select('midday_hour, midday_minute, midday_sent_on')
    .eq('user_id', userId).maybeSingle();

  if (!morningDue({
    hour: Math.floor(minutes / 60), minute: minutes % 60,
    morningHour: m?.midday_hour, morningMinute: m?.midday_minute ?? 0,
    sentOn: m?.midday_sent_on, today: date,
  })) return 0;

  const { data: mo } = await supabase.from('wrought_profile')
    .select('morning_opens').eq('user_id', userId).maybeSingle()
    .then(r => (r.error ? { data: null } : r), () => ({ data: null }));

  const [day, recent, goals] = await Promise.all([
    dayFacts(userId, profile, date),
    rangeFacts(userId, profile, addDays(date, -29), date),
    getGoals(userId),
  ]);
  const flags = careFlags(recent, profile);
  const scored = scoreGoals(goals, day, summariseRange(recent, profile), profile);

  const out = middayBrief({ facts: day, flags, scored });
  if (!out?.text) return 0;

  const sent = await deliver(userId, profile, {
    title: 'WROUGHT',
    body: out.text,
    tag: `wrought-midday-${date}`,
    url: out.only ? '/app.html' : morningLink(mo?.morning_opens, 'midday'),
  });
  if (sent) {
    await supabase.from('wrought_profile')
      .update({ midday_sent_on: date }).eq('user_id', userId);
  }
  return sent ? 1 : 0;
}

async function runMorning(userId, profile, now) {
  if (!(await morningColumnsExist())) return 0;

  const date = localDateFor(profile.timezone, now);
  const minutes = localMinutesFor(profile.timezone, now);

  // Read the three morning columns on their own. profile came from getProfile,
  // which does not select them — and adding them there would put every caller
  // in the product behind this migration for no benefit.
  // morning_opens is selected DEFENSIVELY, apart from the scheduling columns:
  // it arrived one migration later (020), and naming a column PostgREST does
  // not know about rejects the whole query — so a database holding 019 but not
  // 020 would lose the entire morning brief for the sake of a link preference.
  // The fallback is the dashboard, which every account verifiably has.
  const { data: m } = await supabase.from('wrought_profile')
    .select('morning_hour, morning_minute, morning_sent_on')
    .eq('user_id', userId).maybeSingle();
  const { data: mo } = await supabase.from('wrought_profile')
    .select('morning_opens').eq('user_id', userId).maybeSingle()
    .then(r => (r.error ? { data: null } : r), () => ({ data: null }));

  if (!morningDue({
    hour: Math.floor(minutes / 60), minute: minutes % 60,
    morningHour: m?.morning_hour, morningMinute: m?.morning_minute ?? 0,
    sentOn: m?.morning_sent_on, today: date,
  })) return 0;

  // Everything here comes from the same computed facts the dashboard and the
  // connector read. Nothing in this file does arithmetic — a third mouth
  // relaying numbers computed once, which is the doctrine everywhere else.
  const [day, recent, goals, dueRoutine] = await Promise.all([
    dayFacts(userId, profile, date),
    rangeFacts(userId, profile, addDays(date, -29), date),
    getGoals(userId),
    // The workout most due — the longest-rested active routine, which is the
    // same answer end_session gives for "what's next". Blocks are not consulted
    // here yet; when they are, the block's own next session must win, and the
    // note in morningBrief's line stays true either way.
    supabase.from('wrought_routines')
      .select('name, est_minutes')
      .eq('user_id', userId).eq('active', true)
      .order('last_used_on', { ascending: true, nullsFirst: true })
      .limit(1).maybeSingle().then(r => r.data || null),
  ]);
  const yesterday = recent.days.find(d => d.date === addDays(date, -1)) || null;

  const flags = careFlags(recent, profile);
  const week = weekSoFar(recent.days, { today: date, target: profile.train_days || null });

  // The same call buildBriefFor makes, so the morning and the evening cannot
  // quote two different burns for the same day.
  const balance = energyBalance({
    profile, weightKg: day.body.weight_kg,
    caloriesIn: day.food.calories,
    activeCalories: day.device.active_calories,
    foodEstimated: day.food.estimated,
    workouts: day.training.entries,
    activities: day.activity.entries,
    deviceResting: day.device.resting_calories,
  });

  // targets stays null on purpose: the morning states the GAP and never a
  // figure. A calorie number arriving unasked on a lock screen reads as a
  // decision already taken, which is the invented-2,600 failure with a
  // notification wrapped around it. set_goal is where a number gets committed.
  const out = morningBrief({
    facts: day, flags, balance, week, yesterday, planned: dueRoutine,
    goalsToSet: goalsToSet({ goals, targets: null, stepsAvg: null }),
  });
  // Nothing worth saying sends nothing. A morning nag is how a product gets
  // muted permanently, and muted never comes back on.
  if (!out) return 0;

  const sent = await deliver(userId, profile, {
    title: 'WROUGHT',
    body: out.text,
    tag: `wrought-morning-${date}`,
    // Tapping it opens the assistant with the day's opener pre-filled — the
    // one legal bridge across MCP's no-push rule, because the person's tap is
    // what carries the words. A care flag never rides it into a chat opener:
    // the flag IS the message, and the dashboard is where it is explained.
    url: out.only ? '/app.html' : morningLink(mo?.morning_opens),
  });

  // STAMPED ONLY ON SUCCESS, exactly like an alert's last_sent_on. Marking it
  // sent when nothing was delivered means the one morning a phone was off is
  // the morning the brief silently skips for good.
  if (sent) {
    await supabase.from('wrought_profile')
      .update({ morning_sent_on: date }).eq('user_id', userId);
  }
  return sent ? 1 : 0;
}

async function runAlerts(userId, profile, now) {
  const { data: rules } = await supabase.from('wrought_alerts')
    .select('id, kind, at_hour, threshold, text, days, active, last_sent_on, metric')
    .eq('user_id', userId).eq('active', true);
  if (!rules?.length) return 0;

  const date = localDateFor(profile.timezone, now);
  const minutes = localMinutesFor(profile.timezone, now);
  const hour = Math.floor(minutes / 60);

  // Cheap exit before any of the reads below: nothing is due this hour for
  // this person, so do not go and compute their day to find that out.
  const maybe = rules.some(r => r.last_sent_on !== date &&
    (r.at_hour == null || r.at_hour === hour));
  if (!maybe) return 0;

  const day = await dayFacts(userId, profile, date);
  const recent = await rangeFacts(userId, profile, addDays(date, -29), date);
  const goals = await getGoals(userId);
  const calGoal = goals.find(g => g.metric === 'calories' && g.cadence === 'daily');

  // A CARE FLAG OUTRANKS EVERYTHING and needs its own thirty days — read off
  // the same window the dashboard gives it, never off today alone.
  const flags = careFlags(recent, profile);

  const week = weekSoFar(recent.days, { today: date, target: profile.train_days || null });

  const lastWeigh = recent.days.filter(d => d.weight_kg != null).slice(-1)[0] || null;
  const lastWeighDays = lastWeigh
    ? Math.round((new Date(`${date}T00:00:00Z`) - new Date(`${lastWeigh.date}T00:00:00Z`)) / 86400000)
    : null;

  // Scored against the SAME function the dashboard rings are drawn from, so a
  // notification and the ring it refers to can never quote different numbers.
  const scored = scoreGoals(goals, day, summariseRange(recent, profile), profile);

  const due = dueAlerts({
    rules, day, scored,
    calorieTarget: calGoal?.target_value != null ? Number(calGoal.target_value) : null,
    week, lastWeighDays, flags,
    hour, weekday: new Date(`${date}T12:00:00Z`).getUTCDay(), date,
  });
  if (!due.length) return 0;

  let sent = 0;
  for (const a of due) {
    const n = await deliver(userId, profile, {
      title: a.title, body: a.body, tag: `wrought-alert-${a.kind}-${date}`, url: '/app.html',
    });
    // STAMPED ONLY WHEN IT ACTUALLY WENT. Marking it sent on a failed delivery
    // means the one day somebody's phone was off is the day the rule silently
    // skips, and they never find out.
    if (n > 0) {
      await supabase.from('wrought_alerts').update({ last_sent_on: date }).eq('id', a.id);
      sent += n;
    }
  }
  return sent;
}

export const handler = async () => {
  if (!supabase) return { statusCode: 500, body: 'not configured' };

  const now = new Date();
  const users = await activeUsers();

  let considered = 0, built = 0, mailed = 0, pushed = 0, skipped = 0, alerted = 0, morninged = 0;

  for (const userId of users) {
    const profile = await getProfile(userId);

    // Their own rules first, and independently of the brief hour — the whole
    // point is that these fire at hours the person chose. A failure here must
    // never cost somebody their nightly read, so it is caught on its own.
    try { alerted += await runAlerts(userId, profile, now); } catch { /* the brief still runs */ }

    // THE MORNING BRIEFING, which is a different message from the evening
    // verdict rather than the same one moved. It is checked first and on its
    // own: a failure composing the morning must not cost somebody the evening,
    // and vice versa — the same reason the alert pass above is caught alone.
    try { morninged += await runMorning(userId, profile, now); } catch { /* the evening still runs */ }
    try { morninged += await runMidday(userId, profile, now); } catch { /* the evening still runs */ }

    // Only the people for whom it is actually ten o'clock right now.
    // Their hour, not ours. Somebody who trains at five in the morning wants
    // the read at a different time than somebody who eats at nine at night, and
    // a notification at the wrong hour is how notifications get turned off for
    // good — after which they never come back on.
    const hour = Number.isInteger(profile.brief_hour) ? profile.brief_hour : SEND_HOUR;
    if (Math.floor(localMinutesFor(profile.timezone, now) / 60) !== hour) continue;
    considered++;

    const date = localDateFor(profile.timezone, now);
    const { data: existing } = await supabase.from('wrought_briefs')
      .select('id').eq('user_id', userId).eq('local_date', date).eq('kind', 'evening').maybeSingle();
    if (existing) { skipped++; continue; }              // already read today

    try {
      const out = await buildBriefFor(userId, now);
      // A day with nothing computable in it produces no line at all, and that
      // is the one case worth staying quiet for.
      if (!out.verdict) { skipped++; continue; }
      built++;

      // A day with nothing in it gets no email. "You logged nothing today" is
      // a nag, and a nightly nag is how a product gets muted forever.
      if (!out.logged) continue;

      const { data: auth } = await supabase.auth.admin.getUserById(userId);
      if (await email(auth?.user?.email, `Wrought — ${out.date}`, out.verdict)) mailed++;
      pushed += await push(userId, profile, out);
    } catch {
      skipped++;
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ users: users.length, at_send_hour: considered, built, mailed, pushed, alerted, morninged, skipped }),
  };
};
