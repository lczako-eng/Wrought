// netlify/functions/api-merge.js
// Bringing two accounts back into one.
//
// The situation this exists for is ordinary and will keep happening: somebody
// signs in at wrought.fit with Google, and ChatGPT sends them through the
// connector under a different address. Two accounts, one person, and a training
// history split down the middle with neither half telling the truth.
//
// Linking an identity prevents it, and that is the path the dashboard pushes.
// This is the repair for when the split already happened.
//
// The whole safety argument: the caller must prove control of BOTH accounts.
// Never an email and never a user id — an email is guessable and a user id sits
// inside every JWT, so either alone would turn this into a way to hoover up a
// stranger's health record.
//
// Two proofs are accepted for the second account, and they are equivalent:
//
//   a live session token — they signed into it, here, just now; or
//   a code from the ASSISTANT signed into it — which is holding a token for
//   that account, so it can vouch for it.
//
// The second exists because the first is unavailable to exactly the person who
// needs this most: somebody locked out of the other account, whose reset email
// is not arriving. Their assistant is still signed in and still working, and
// that is a better proof of current control than a password they set once.

import { supabase, getAuthUser } from './lib/wrought.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (!supabase) return json(500, { error: 'server_not_configured' });

  // Token one: the Authorization header. This is the account that survives —
  // the one the person is signed into and looking at.
  const keeper = await getAuthUser(event);
  if (!keeper) return json(401, { error: 'sign_in_required' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'bad_json' }); }

  // Proof two, in either of two forms. Both establish the same thing — that
  // whoever is asking controls the other account as well — and neither is an
  // email address, because an email is guessable and would turn this endpoint
  // into a way to hoover up a stranger's health record.
  let other = null;

  const code = String(body.code || '').trim();
  if (code) {
    // A code minted by the assistant, which is holding a live token for that
    // account. That is proof of control more current than any password, and it
    // is the only proof available to somebody who cannot get a reset email.
    const { data: claimedId, error: claimErr } = await supabase.rpc('wrought_claim_link_code', { p_code: code });
    if (claimErr) {
      const missing = /could not find the function|does not exist/i.test(claimErr.message || '');
      return json(500, {
        error: missing ? 'migration_012_not_run' : 'code_check_failed',
        message: missing
          ? 'The linking table is not installed. Run schema/012_wrought_link_codes.sql in Supabase.'
          : claimErr.message,
      });
    }
    if (!claimedId) {
      return json(400, {
        error: 'bad_code',
        message: 'That code is wrong, already used, or older than ten minutes. Ask your assistant to link the account again for a fresh one.',
      });
    }
    const { data } = await supabase.auth.admin.getUserById(claimedId);
    other = data?.user || null;
    if (!other) return json(400, { error: 'other_account_missing' });
  } else {
    const otherToken = String(body.other_token || '').trim();
    if (!otherToken) {
      return json(400, {
        error: 'other_account_proof_required',
        message: 'Either the other account\'s password, or a code from the assistant signed into it. Merging needs proof you control both.',
      });
    }
    const { data: otherData, error: otherErr } = await supabase.auth.getUser(otherToken);
    other = otherErr ? null : otherData?.user;
    if (!other) return json(401, { error: 'other_account_not_verified' });
  }

  if (other.id === keeper.id) {
    return json(400, {
      error: 'same_account',
      message: 'Those are already the same account — nothing to merge.',
    });
  }

  const { data, error } = await supabase.rpc('wrought_merge_accounts', {
    keep: keeper.id,
    absorb: other.id,
  });

  if (error) {
    // A missing function means migration 006 has not been run. Say which, because
    // "could not merge" sends somebody hunting through the wrong things.
    const missing = /could not find the function|does not exist/i.test(error.message || '');
    return json(500, {
      error: missing ? 'migration_006_not_run' : 'merge_failed',
      message: missing
        ? 'The merge function is not installed. Run schema/006_wrought_identity.sql in Supabase.'
        : error.message,
    });
  }

  // The absorbed account is now empty, and an empty duplicate is not harmless —
  // it is the same fork waiting to happen again. Sign in through that door next
  // week and you are staring at a blank record for the second time. Deleting it
  // also frees its Apple or Google identity, so it can be attached to the
  // account that survived and become one more way in rather than a rival.
  //
  // Every row was moved a moment ago inside a transaction, so there is nothing
  // left for the cascade to take. If this fails the merge still stands.
  let freed = true;
  try {
    const { error: delErr } = await supabase.auth.admin.deleteUser(other.id);
    if (delErr) freed = false;
  } catch { freed = false; }

  const m = data || {};
  const total = ['events', 'metrics', 'sets', 'sessions', 'routines', 'goals', 'memory', 'briefs']
    .reduce((sum, k) => sum + (Number(m[k]) || 0), 0);

  return json(200, {
    ok: true,
    kept: keeper.email || keeper.id,
    absorbed: other.email || other.id,
    other_account_removed: freed,
    moved: m,
    // The connector detail matters more than the row counts. Somebody who has
    // just merged wants to know whether they have to go and reconnect ChatGPT,
    // and the answer is no.
    say: total
      ? `Moved ${total} record${total === 1 ? '' : 's'} across. ${other.email || 'That account'} is now empty, and anything already connected to it writes here instead.`
      : `Nothing to move — ${other.email || 'that account'} had no history. It is linked to this one now.`,
    note: 'Duplicates were dropped, not doubled: a row that both accounts already held stays one row.',
  });
};
