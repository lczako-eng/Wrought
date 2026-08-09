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
import { membershipFor, makeCode, forgetMembership, PLANS } from './lib/membership.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

  // ── Actions ──
  if (event.httpMethod === 'POST') return act(event, user);

  // ── The people ──
  // Emails, dates and counts. Never a meal, a weight, a set or a symptom — see
  // the note at the top of this file for why that line does not move.
  if ((event.queryStringParameters || {}).view === 'people') return people();
  if ((event.queryStringParameters || {}).view === 'codes') return codes();

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


// ── Who is here ─────────────────────────────────────────────────────────────
// The operator's list. What it deliberately CANNOT include: anything somebody
// logged. Not a summary of it, not a "top food", not a weight trend. Counts and
// dates only, because "how many entries" is how you tell whether the product is
// working and "what were the entries" is somebody's medical history.

const PAGE = 200;

async function people() {
  const { data: list, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: PAGE });
  if (error) return json(500, { error: error.message });
  const users = list?.users || [];

  // One pass over recent activity rather than a count query per person, which
  // would be a query storm the moment this has real users.
  const [{ data: events }, { data: members }] = await Promise.all([
    supabase.from('wrought_events').select('user_id, local_date')
      .order('local_date', { ascending: false }).limit(20000),
    supabase.from('wrought_memberships').select('*'),
  ]);

  const counts = new Map();
  const lastSeen = new Map();
  for (const e of (events || [])) {
    counts.set(e.user_id, (counts.get(e.user_id) || 0) + 1);
    if (!lastSeen.has(e.user_id)) lastSeen.set(e.user_id, e.local_date);
  }
  const byUser = new Map((members || []).map(m => [m.user_id, m]));
  const today = localDateFor('America/Toronto');

  return json(200, {
    people: users.map(u => {
      const m = byUser.get(u.id) || null;
      const lapsed = !!(m?.expires_on && m.expires_on < today);
      return {
        id: u.id,
        email: u.email || null,
        joined: u.created_at ? u.created_at.slice(0, 10) : null,
        last_sign_in: u.last_sign_in_at ? u.last_sign_in_at.slice(0, 10) : null,
        // Metadata about the record, never the record.
        entries: counts.get(u.id) || 0,
        last_logged: lastSeen.get(u.id) || null,
        plan: lapsed ? 'free' : (m?.plan || 'free'),
        status: m?.status || 'active',
        expires_on: m?.expires_on || null,
        note: m?.note || null,
      };
    }),
    total: users.length,
    truncated: users.length >= PAGE,
    plans: PLANS,
    privacy: 'Emails, dates, plans and how MUCH somebody logged. Never what they logged — no food, weight, training or symptom is reachable through this endpoint, by design.',
  });
}

async function codes() {
  const { data } = await supabase.from('wrought_codes')
    .select('*').order('created_at', { ascending: false }).limit(100);
  return json(200, {
    codes: (data || []).map(c => ({
      code: c.code, plan: c.plan, days: c.days,
      used: c.used_count, max_uses: c.max_uses,
      expires_on: c.expires_on, active: c.active, note: c.note,
      created: c.created_at?.slice(0, 10) || null,
      spent: c.used_count >= c.max_uses,
    })),
    note: 'Codes are stored as they read, because they are meant to be handed out. The limit is the use count and the expiry, not secrecy.',
  });
}

async function act(event, admin) {
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad_json' }); }

  // ── Make a code ──
  if (body.action === 'make_code') {
    const plan = ['trial', 'pro', 'comp'].includes(body.plan) ? body.plan : 'trial';
    const days = Math.min(Math.max(parseInt(body.days, 10) || 30, 1), 3650);
    const uses = Math.min(Math.max(parseInt(body.max_uses, 10) || 1, 1), 10000);
    const code = makeCode(body.prefix || 'WROUGHT');

    const { error } = await supabase.from('wrought_codes').insert([{
      code, plan, days, max_uses: uses,
      expires_on: body.expires_on || null,
      note: body.note ? String(body.note).slice(0, 200) : null,
      created_by: admin.id,
    }]);
    if (error) {
      const missing = /does not exist|schema cache/i.test(error.message || '');
      return json(500, {
        error: missing ? 'migration_011_not_run' : 'could_not_create',
        message: missing ? 'Run schema/011_wrought_membership.sql in Supabase.' : error.message,
      });
    }
    return json(200, { ok: true, code, plan, days, max_uses: uses, say: `${code} — ${days} days of ${plan}, ${uses} use${uses === 1 ? '' : 's'}.` });
  }

  if (body.action === 'kill_code') {
    if (!body.code) return json(400, { error: 'code_required' });
    await supabase.from('wrought_codes').update({ active: false }).eq('code', body.code);
    return json(200, { ok: true, say: 'Code deactivated. Anybody who already redeemed it keeps what they were given.' });
  }

  // ── Change somebody's membership ──
  if (body.action === 'set_membership') {
    if (!body.user_id) return json(400, { error: 'user_id_required' });

    // An operator cutting themselves off is a locked door with the key inside.
    if (body.user_id === admin.id && body.status === 'revoked') {
      return json(400, { error: 'cannot_revoke_yourself',
        message: 'You would be locking yourself out. Use another admin account if this is deliberate.' });
    }

    const patch = { user_id: body.user_id, updated_at: new Date().toISOString() };
    if (body.plan) {
      if (!PLANS[body.plan]) return json(400, { error: 'unknown_plan' });
      patch.plan = body.plan;
    }
    if (body.status) {
      if (!['active', 'revoked'].includes(body.status)) return json(400, { error: 'unknown_status' });
      patch.status = body.status;
    }
    if ('expires_on' in body) patch.expires_on = body.expires_on || null;
    if ('note' in body) patch.note = body.note ? String(body.note).slice(0, 200) : null;
    patch.source = 'manual';

    const { error } = await supabase.from('wrought_memberships').upsert(patch, { onConflict: 'user_id' });
    if (error) {
      const missing = /does not exist|schema cache/i.test(error.message || '');
      return json(500, {
        error: missing ? 'migration_011_not_run' : 'could_not_save',
        message: missing ? 'Run schema/011_wrought_membership.sql in Supabase.' : error.message,
      });
    }

    forgetMembership(body.user_id);
    return json(200, {
      ok: true,
      say: body.status === 'revoked'
        ? 'Suspended. Their record is untouched and export still works for them — that does not change.'
        : 'Saved.',
    });
  }

  return json(400, { error: 'unknown_action' });
}
