// netlify/functions/lib/membership.js
// What a membership actually DOES.
//
// A revoke button that changes a column and nothing else is theatre, so this is
// the one place that decides whether somebody gets through — and the rules are
// deliberately narrow, because the failure mode here is locking a person out of
// their own health record.
//
// THE DEFAULT IS PERMISSIVE. No membership row means free and active. A missing
// row, a failed lookup, a table that has not been migrated yet: all of those
// let the request through. The only thing that blocks is an operator explicitly
// revoking somebody, and that is a deliberate act with a name attached.
//
// AN EXPIRED TRIAL DOES NOT BLOCK. It drops to free. Ending a trial by taking
// away access to a year of somebody's own training is not a business model, it
// is a hostage situation — and it would break the promise on /privacy.html that
// the record is theirs.
//
// EXPORT ALWAYS WORKS. Even revoked, even lapsed. A hub you cannot leave is a
// trap, and that has to stay true on the worst day of the relationship rather
// than only the good ones.

import { supabase } from './wrought.js';

export const PLANS = {
  free:  { label: 'Free',       detail: 'Everything works. This is not a crippled tier.' },
  trial: { label: 'Trial',      detail: 'Time limited, then it drops back to free.' },
  pro:   { label: 'Pro',        detail: 'Paid.' },
  comp:  { label: 'Complimentary', detail: 'Given by the operator. Does not expire unless dated.' },
};

// Endpoints that must answer for a revoked account, no exceptions.
export const ALWAYS_ALLOWED = ['api-export', 'api-profile', 'api-connections', 'api-status'];

const CACHE = new Map();          // user_id -> { entry, until }
const TTL_MS = 60 * 1000;

export function forgetMembership(userId) { CACHE.delete(userId); }

export async function membershipFor(userId) {
  const hit = CACHE.get(userId);
  if (hit && hit.until > Date.now()) return hit.entry;

  let row = null;
  try {
    const { data, error } = await supabase.from('wrought_memberships')
      .select('plan, status, started_on, expires_on, source').eq('user_id', userId).maybeSingle();
    // A missing table means migration 011 has not run. That must read as
    // "everybody is on free", not as "nobody may use the product".
    if (error && !/does not exist|schema cache/i.test(error.message || '')) throw error;
    row = data || null;
  } catch {
    return { plan: 'free', status: 'active', expires_on: null, lapsed: false, unknown: true };
  }

  const today = new Date().toISOString().slice(0, 10);
  const lapsed = !!(row?.expires_on && row.expires_on < today);

  const entry = {
    plan: lapsed ? 'free' : (row?.plan || 'free'),
    // The plan they were on before it ran out, so the UI can say "your trial
    // ended" rather than pretending it never happened.
    was: lapsed ? row.plan : null,
    status: row?.status || 'active',
    started_on: row?.started_on || null,
    expires_on: row?.expires_on || null,
    source: row?.source || null,
    lapsed,
    days_left: row?.expires_on && !lapsed
      ? Math.max(0, Math.round((new Date(row.expires_on) - new Date(today)) / 86400000))
      : null,
  };

  CACHE.set(userId, { entry, until: Date.now() + TTL_MS });
  return entry;
}

// The gate. `surface` is the function name asking.
export async function allowed(userId, surface) {
  if (ALWAYS_ALLOWED.includes(surface)) return { ok: true };

  const m = await membershipFor(userId);
  if (m.status !== 'revoked') return { ok: true, membership: m };

  return {
    ok: false,
    membership: m,
    error: 'membership_revoked',
    // Said without euphemism, and pointing at the two things that still work.
    // Somebody cut off from a health product needs to know their record is not
    // gone and that they can take it with them.
    message: 'This account has been suspended. Your record has not been touched and you can still export all of it from the dashboard. Reply to the address on wrought.fit if you think this is wrong.',
  };
}

export function planSummary(m) {
  const p = PLANS[m.plan] || PLANS.free;
  if (m.status === 'revoked') return 'Suspended. Your record is intact and export still works.';
  if (m.lapsed) return `Your ${m.was} ended — back on free, and nothing was lost.`;
  if (m.days_left != null) return `${p.label}, ${m.days_left} day${m.days_left === 1 ? '' : 's'} left.`;
  return p.label === 'Free' ? 'Free. Everything works.' : p.label;
}

// Codes people can actually read out. No 0/O or 1/I, because somebody will read
// one down a phone and a code that cannot be dictated is a support ticket.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeCode(prefix = 'WROUGHT') {
  let body = '';
  for (let i = 0; i < 8; i++) {
    body += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    if (i === 3) body += '-';
  }
  return `${String(prefix).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10)}-${body}`;
}
