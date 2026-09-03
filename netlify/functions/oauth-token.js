// netlify/functions/oauth-token.js
// Token endpoint — authorization_code and refresh_token grants.
//
// This is where the PKCE verifier is actually checked, and where "sign in once"
// becomes true: the refresh token means the connector renews quietly forever
// and the user never sees a login screen again after the first one.

import { supabase, hashToken, newToken } from './lib/wrought.js';
import { CONFIDENTIAL_MARK, loadClient } from './oauth-authorize-complete.js';
import { createHash, timingSafeEqual } from 'node:crypto';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const ACCESS_TTL_SECONDS  = 60 * 60 * 24 * 30;        // 30 days
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 365;       // a year

const fail = (status, error, description) => ({
  statusCode: status, headers: CORS,
  body: JSON.stringify({ error, ...(description ? { error_description: description } : {}) }),
});

// Token endpoints accept form encoding; some clients send JSON anyway.
function parseBody(event) {
  const raw = event.isBase64Encoded && event.body
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : (event.body || '');
  const ct = (event.headers?.['content-type'] || event.headers?.['Content-Type'] || '').toLowerCase();
  if (ct.includes('application/json')) {
    try { return JSON.parse(raw || '{}'); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return fail(405, 'invalid_request');
  if (!supabase) return fail(500, 'server_error');

  const body = parseBody(event);
  const grant = body.grant_type;
  // A confidential client's credentials ride in the body (client_secret_post)
  // or in a Basic header (client_secret_basic); ChatGPT uses either.
  const creds = clientCredentials(event, body);

  if (grant === 'authorization_code') return exchangeCode(body, creds);
  if (grant === 'refresh_token')      return refresh(body, creds);
  return fail(400, 'unsupported_grant_type', `Unsupported grant_type: ${grant}`);
};

function clientCredentials(event, body) {
  const h = event.headers?.authorization || event.headers?.Authorization || '';
  if (/^Basic /i.test(h)) {
    try {
      const [id, secret] = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8').split(':');
      return { client_id: decodeURIComponent(id || ''), client_secret: decodeURIComponent(secret || '') };
    } catch { /* fall through to the body */ }
  }
  return { client_id: body.client_id || null, client_secret: body.client_secret || null };
}

// Does this secret belong to this client? Constant-time on the hashes, and a
// client with no secret on file can never pass — a public client cannot turn
// itself confidential by guessing.
function secretMatches(client, secret) {
  if (!client?.client_secret_hash || !secret) return false;
  const a = Buffer.from(hashToken(String(secret)));
  const b = Buffer.from(String(client.client_secret_hash));
  return a.length === b.length && timingSafeEqual(a, b);
}

async function exchangeCode(body, creds) {
  const { code, code_verifier, redirect_uri } = body;
  const client_id = body.client_id || creds.client_id;
  if (!code) return fail(400, 'invalid_request', 'code is required.');

  const { data: row } = await supabase.from('wrought_oauth_codes')
    .select('*').eq('code_hash', hashToken(code)).maybeSingle();

  if (!row) return fail(400, 'invalid_grant', 'Unknown or already-redeemed code.');
  if (row.used) return fail(400, 'invalid_grant', 'This code has already been used.');
  if (new Date(row.expires_at).getTime() < Date.now()) return fail(400, 'invalid_grant', 'Code expired.');
  if (client_id && client_id !== row.client_id) return fail(400, 'invalid_grant', 'client_id mismatch.');
  if (redirect_uri && redirect_uri !== row.redirect_uri) return fail(400, 'invalid_grant', 'redirect_uri mismatch.');

  if (row.code_challenge === CONFIDENTIAL_MARK) {
    // A CODE MINTED TO A CONFIDENTIAL CLIENT. No verifier exists; the party
    // redeeming it proves itself with the secret registered for that client.
    // Whoever holds the code without the secret gets nothing — the same
    // property PKCE gives a public client, held by a different key.
    const client = await loadClient(row.client_id);
    if (!secretMatches(client, creds.client_secret)) {
      return fail(401, 'invalid_client', 'Client authentication failed.');
    }
  } else {
    // The PKCE check. Whoever redeems the code must prove they are the same party
    // that requested it, by producing the verifier whose hash was registered up
    // front — an intercepted code is worthless without it.
    if (!code_verifier) return fail(400, 'invalid_request', 'code_verifier is required.');
    const expected = createHash('sha256').update(code_verifier).digest('base64url');
    if (expected !== row.code_challenge) return fail(400, 'invalid_grant', 'PKCE verification failed.');
  }

  // Burn the code before issuing anything, so a replay in flight loses the race.
  await supabase.from('wrought_oauth_codes').update({ used: true }).eq('code_hash', row.code_hash);

  return issueTokens(row.user_id, row.client_id, row.scope || 'wrought');
}

async function refresh(body, creds) {
  const { refresh_token } = body;
  const client_id = body.client_id || creds.client_id;
  if (!refresh_token) return fail(400, 'invalid_request', 'refresh_token is required.');

  const { data: row } = await supabase.from('wrought_oauth_refresh')
    .select('*').eq('token_hash', hashToken(refresh_token)).maybeSingle();

  if (!row || row.revoked) return fail(400, 'invalid_grant', 'Unknown or revoked refresh token.');
  if (new Date(row.expires_at).getTime() < Date.now()) return fail(400, 'invalid_grant', 'Refresh token expired.');
  if (client_id && row.client_id && client_id !== row.client_id) return fail(400, 'invalid_grant', 'client_id mismatch.');

  // A confidential client renews with its secret, every time. A stolen
  // refresh token from a GPT is worthless without it.
  if (row.client_id) {
    const client = await loadClient(row.client_id);
    if (client?.client_secret_hash && !secretMatches(client, creds.client_secret)) {
      return fail(401, 'invalid_client', 'Client authentication failed.');
    }
  }

  // Rotation: the old refresh token dies with the request that used it, so a
  // stolen one is good for at most a single use before the real client's next
  // renewal invalidates it.
  await supabase.from('wrought_oauth_refresh').update({ revoked: true }).eq('token_hash', row.token_hash);

  return issueTokens(row.user_id, row.client_id, row.scope || 'wrought');
}

async function issueTokens(userId, clientId, scope) {
  const accessToken  = newToken();
  const refreshToken = newToken();
  const now = Date.now();

  const { error } = await supabase.from('wrought_oauth_tokens').insert([{
    token_hash: hashToken(accessToken),
    user_id: userId, client_id: clientId, scope,
    expires_at: new Date(now + ACCESS_TTL_SECONDS * 1000).toISOString(),
  }]);
  if (error) return fail(500, 'server_error', error.message);

  const { error: rErr } = await supabase.from('wrought_oauth_refresh').insert([{
    token_hash: hashToken(refreshToken),
    user_id: userId, client_id: clientId, scope,
    expires_at: new Date(now + REFRESH_TTL_SECONDS * 1000).toISOString(),
  }]);
  if (rErr) return fail(500, 'server_error', rErr.message);

  return {
    statusCode: 200, headers: CORS,
    body: JSON.stringify({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: refreshToken,
      scope,
    }),
  };
}
