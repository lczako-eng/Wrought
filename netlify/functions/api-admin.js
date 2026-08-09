// netlify/functions/api-admin.js
// The operator's view.
//
// What this deliberately does NOT do: show one named person's food, training,
// weight or symptoms. Being the administrator of a health product is not a
// licence to read the health data in it, and the moment an admin screen can
// display somebody's log, every promise on the privacy page becomes a matter of
// trusting whoever holds the password. Row level security already stops the
// browser doing it; this endpoint refuses to do it on the server too.
//
// So it answers operational questions only — how many people, how much is being
// logged, is it growing, is anything broken — and answers them in aggregate.
//
// Who counts as an administrator is set by WROUGHT_ADMIN_EMAILS, a comma
// separated list, checked against the email on the verified session. Not a
// column somebody could set on themselves, and not a flag in a token.

import { supabase, getAuthUser, localDateFor, addDays } from './lib/wrought.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

export function isAdmin(email) {
  const list = String(process.env.WROUGHT_ADMIN_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return false;
  return list.includes(String(email || '').trim().toLowerCase());
}

const countIn = async (table, filter = q => q) => {
  const { count } = await filter(
    supabase.from(table).select('*', { count: 'exact', head: true })
  );
  return count ?? 0;
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!supabase) return json(500, { error: 'server_not_configured' });

  const user = await getAuthUser(event);
  if (!user) return json(401, { error: 'sign_in_required' });

  // A non-admin gets the same answer whether or not admins exist — no hint that
  // there is a door here at all.
  if (!isAdmin(user.email)) return json(403, { error: 'not_an_administrator' });

  const today = localDateFor('America/Toronto');
  const week = addDays(today, -6);
  const month = addDays(today, -29);

  const [
    people, events, sets, sessions, metrics,
    eventsWeek, eventsMonth, activeWeek, connections, keys,
  ] = await Promise.all([
    countIn('wrought_profile'),
    countIn('wrought_events'),
    countIn('wrought_sets'),
    countIn('wrought_sessions'),
    countIn('wrought_metrics'),
    countIn('wrought_events', q => q.gte('local_date', week)),
    countIn('wrought_events', q => q.gte('local_date', month)),
    supabase.from('wrought_events')
      .select('user_id').gte('local_date', week).limit(20000)
      .then(r => new Set((r.data || []).map(x => x.user_id)).size),
    countIn('wrought_connections'),
    countIn('wrought_ingest_keys', q => q.eq('revoked', false)),
  ]);

  return json(200, {
    administrator: user.email,
    people,
    active_7d: activeWeek,
    // The number that actually matters: not signups, but whether anybody is
    // still logging a week later.
    retention_note: people
      ? `${activeWeek} of ${people} logged something in the last 7 days.`
      : 'No accounts yet.',
    logged: {
      events, events_7d: eventsWeek, events_30d: eventsMonth,
      sets, sessions, device_metrics: metrics,
    },
    devices: { connections, active_ingest_keys: keys },
    say: `${people} account${people === 1 ? '' : 's'}, ${activeWeek} active this week, ${events} things logged all time.`,
    privacy: 'Aggregates only. No individual food, training, weight or symptom data is reachable through this endpoint, by design.',
  });
};
