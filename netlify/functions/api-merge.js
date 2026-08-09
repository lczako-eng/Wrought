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
// The whole safety argument is in the first twenty lines of the handler: the
// caller must present a LIVE TOKEN FOR EACH ACCOUNT. Not an email, not a user
// id, not a code sent somewhere — proof, twice, that whoever is asking can
// currently sign into both. An email address would be guessable and a user id is
// visible in a JWT; either would turn this endpoint into a way to hoover up a
// stranger's health record. There is no version of this that takes one token.

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

  const otherToken = String(body.other_token || '').trim();
  if (!otherToken) {
    return json(400, {
      error: 'other_account_proof_required',
      message: 'Sign in to the other account as well. Merging needs proof you control both.',
    });
  }

  // Token two: proof for the account being emptied. Verified the same way and
  // against the same authority as the first.
  const { data: otherData, error: otherErr } = await supabase.auth.getUser(otherToken);
  const other = otherErr ? null : otherData?.user;
  if (!other) return json(401, { error: 'other_account_not_verified' });

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
