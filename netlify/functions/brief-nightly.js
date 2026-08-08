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

  const verdict = await writeVerdict({ facts, profile, goals, memory, flags, kind: 'evening' });

  if (verdict) {
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

export const handler = async () => {
  if (!supabase) return { statusCode: 500, body: 'not configured' };

  const now = new Date();
  const users = await activeUsers();

  let considered = 0, built = 0, mailed = 0, skipped = 0;

  for (const userId of users) {
    const profile = await getProfile(userId);
    // Only the people for whom it is actually ten o'clock right now.
    if (Math.floor(localMinutesFor(profile.timezone, now) / 60) !== SEND_HOUR) continue;
    considered++;

    const date = localDateFor(profile.timezone, now);
    const { data: existing } = await supabase.from('wrought_briefs')
      .select('id').eq('user_id', userId).eq('local_date', date).eq('kind', 'evening').maybeSingle();
    if (existing) { skipped++; continue; }              // already read today

    try {
      const out = await buildBriefFor(userId, now);
      if (!out.verdict) { skipped++; continue; }
      built++;

      // A day with nothing in it gets no email. "You logged nothing today" is
      // a nag, and a nightly nag is how a product gets muted forever.
      if (!out.logged) continue;

      const { data: auth } = await supabase.auth.admin.getUserById(userId);
      if (await email(auth?.user?.email, `Wrought — ${out.date}`, out.verdict)) mailed++;
    } catch {
      skipped++;
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ users: users.length, at_send_hour: considered, built, mailed, skipped }),
  };
};
