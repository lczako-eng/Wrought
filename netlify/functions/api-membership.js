// netlify/functions/api-membership.js
// What plan am I on, and redeeming a code.
//
// The member's half of the membership system. Deliberately small, and honest
// about the one thing people always wonder: what happens when it runs out.
// Nothing. It drops to free and every row they ever logged is still there.

import { supabase, getAuthUser } from './lib/wrought.js';
import { membershipFor, planSummary, forgetMembership, PLANS } from './lib/membership.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!supabase) return json(500, { error: 'server_not_configured' });

  const user = await getAuthUser(event);
  if (!user) return json(401, { error: 'sign_in_required' });

  if (event.httpMethod === 'GET') {
    const m = await membershipFor(user.id);
    return json(200, {
      plan: m.plan,
      status: m.status,
      expires_on: m.expires_on,
      days_left: m.days_left,
      lapsed: m.lapsed,
      say: planSummary(m),
      plans: PLANS,
      // The sentence that matters more than any of the above.
      note: 'Whatever happens to a plan, the record is yours. Nothing is deleted when one ends, and export works from the dashboard at any time — including if this account is ever suspended.',
    });
  }

  if (event.httpMethod === 'POST') {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad_json' }); }

    const code = String(body.code || '').trim();
    if (!code) return json(400, { error: 'code_required' });

    // One transaction in the database, because a code with one use left can
    // otherwise be spent twice by two people pressing at the same moment.
    const { data, error } = await supabase.rpc('wrought_redeem_code', {
      p_code: code, p_user: user.id,
    });

    if (error) {
      const missing = /could not find the function|does not exist/i.test(error.message || '');
      return json(500, {
        error: missing ? 'migration_011_not_run' : 'redeem_failed',
        message: missing
          ? 'The membership tables are not installed. Run schema/011_wrought_membership.sql in Supabase.'
          : error.message,
      });
    }

    if (!data?.ok) {
      // Each one says which of the several ordinary reasons it was, because
      // "invalid code" for six different situations is how somebody retypes a
      // perfectly good code four times.
      const says = {
        no_such_code:     'No code like that. Check the letters — there are no zeroes or ones in them.',
        code_inactive:    'That code has been switched off.',
        code_expired:     'That code has expired.',
        code_used_up:     'That code has been used as many times as it allows.',
        already_redeemed: 'You have already used that one.',
      };
      return json(400, { error: data?.error || 'redeem_failed', message: says[data?.error] || 'Could not redeem that code.' });
    }

    forgetMembership(user.id);
    return json(200, {
      ok: true, plan: data.plan, expires_on: data.expires_on, days: data.days,
      say: `${PLANS[data.plan]?.label || data.plan} until ${data.expires_on}.`,
    });
  }

  return json(405, { error: 'method_not_allowed' });
};
