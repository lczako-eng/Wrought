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
import { energyBalance } from './lib/training.js';

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
  if (!vapidConfigured()) return 0;
  if (profile.push_enabled === false) return 0;

  const { data: subs } = await supabase.from('wrought_push_subs')
    .select('endpoint, p256dh, auth').eq('user_id', userId);
  if (!subs?.length) return 0;

  const message = {
    title: 'WROUGHT',
    // First sentence only. A lock screen truncates anyway, and a verdict cut
    // mid-clause reads as harsher than it is.
    body: firstSentence(out.verdict),
    tag: `wrought-${out.date}`,
    url: '/app.html',
  };

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

export const handler = async () => {
  if (!supabase) return { statusCode: 500, body: 'not configured' };

  const now = new Date();
  const users = await activeUsers();

  let considered = 0, built = 0, mailed = 0, pushed = 0, skipped = 0;

  for (const userId of users) {
    const profile = await getProfile(userId);
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
    body: JSON.stringify({ users: users.length, at_send_hour: considered, built, mailed, pushed, skipped }),
  };
};
