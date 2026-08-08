// netlify/functions/oauth-token.js
// Token endpoint — authorization_code and refresh_token grants.
//
// This is where the PKCE verifier is actually checked, and where "sign in once"
// becomes true: the refresh token means the connector renews quietly forever
// and the user never sees a login screen again after the first one.

import { supabase, hashToken, newToken } from './lib/wrought.js';
import { createHash } from 'node:crypto';

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

  if (grant === 'authorization_code') return exchangeCode(body);
  if (grant === 'refresh_token')      return refresh(body);
  return fail(400, 'unsupported_grant_type', `Unsupported grant_type: ${grant}`);
};

async function exchangeCode(body) {
  const { code, code_verifier, client_id, redirect_uri } = body;
  if (!code || !code_verifier) return fail(400, 'invalid_request', 'code and code_verifier are required.');

  const { data: row } = await supabase.from('wrought_oauth_codes')
    .select('*').eq('code_hash', hashToken(code)).maybeSingle();

  if (!row) return fail(400, 'invalid_grant', 'Unknown or already-redeemed code.');
  if (row.used) return fail(400, 'invalid_grant', 'This code has already been used.');
  if (new Date(row.expires_at).getTime() < Date.now()) return fail(400, 'invalid_grant', 'Code expired.');
  if (client_id && client_id !== row.client_id) return fail(400, 'invalid_grant', 'client_id mismatch.');
  if (redirect_uri && redirect_uri !== row.redirect_uri) return fail(400, 'invalid_grant', 'redirect_uri mismatch.');

  // The PKCE check. Whoever redeems the code must prove they are the same party
  // that requested it, by producing the verifier whose hash was registered up
  // front — an intercepted code is worthless without it.
  const expected = createHash('sha256').update(code_verifier).digest('base64url');
  if (expected !== row.code_challenge) return fail(400, 'invalid_grant', 'PKCE verification failed.');

  // Burn the code before issuing anything, so a replay in flight loses the race.
  await supabase.from('wrought_oauth_codes').update({ used: true }).eq('code_hash', row.code_hash);

  return issueTokens(row.user_id, row.client_id, row.scope || 'wrought');
}

async function refresh(body) {
  const { refresh_token, client_id } = body;
  if (!refresh_token) return fail(400, 'invalid_request', 'refresh_token is required.');

  const { data: row } = await supabase.from('wrought_oauth_refresh')
    .select('*').eq('token_hash', hashToken(refresh_token)).maybeSingle();

  if (!row || row.revoked) return fail(400, 'invalid_grant', 'Unknown or revoked refresh token.');
  if (new Date(row.expires_at).getTime() < Date.now()) return fail(400, 'invalid_grant', 'Refresh token expired.');
  if (client_id && row.client_id && client_id !== row.client_id) return fail(400, 'invalid_grant', 'client_id mismatch.');

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
