// netlify/functions/oauth-authorize-complete.js
// Second half of the authorization step.
//
// authorize.html signs the human in with Supabase in the browser, then posts
// the resulting session JWT here along with the OAuth request parameters. This
// function verifies the JWT server-side, checks the redirect_uri really belongs
// to the registered client, and mints a single-use authorization code.
//
// The split exists because the sign-in must happen in a browser (that is where
// the password manager and the existing session live) but the code must be
// minted somewhere the client cannot wrought one.

import { supabase, hashToken, newToken, mfaSatisfied } from './lib/wrought.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const CODE_TTL_SECONDS = 300;   // deliberately short — it is redeemed immediately

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'invalid_request' }) };
  }
  if (!supabase) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'server_error' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid_request' }) }; }

  const { access_token, client_id, redirect_uri, code_challenge, code_challenge_method } = body;

  if (!access_token || !client_id || !redirect_uri) {
    return { statusCode: 400, headers: CORS,
      body: JSON.stringify({ error: 'invalid_request', error_description: 'Missing required parameters.' }) };
  }
  if (code_challenge && (code_challenge_method || 'S256') !== 'S256') {
    return { statusCode: 400, headers: CORS,
      body: JSON.stringify({ error: 'invalid_request', error_description: 'Only S256 is supported.' }) };
  }

  // Who is this, really? The browser says it has a session; only Supabase can
  // confirm it, and this is where that gets checked rather than trusted.
  const { data: userData, error: userErr } = await supabase.auth.getUser(access_token);
  if (userErr || !userData?.user) {
    return { statusCode: 401, headers: CORS,
      body: JSON.stringify({ error: 'access_denied', error_description: 'Not signed in.' }) };
  }

  // Two-factor has to hold HERE above everywhere else. The token minted below
  // outlives this browser session and is what ChatGPT presents on every call
  // afterwards, and ChatGPT has no way to ask for a code. If a password alone
  // could reach this line, "connect your assistant" would be a permanent
  // bypass of the second factor rather than a use of it.
  if (!(await mfaSatisfied(userData.user, access_token))) {
    return { statusCode: 401, headers: CORS,
      body: JSON.stringify({ error: 'mfa_required',
        error_description: 'Enter the code from your authenticator app to finish connecting.' }) };
  }

  // An open redirect here would hand somebody else's authorization code to an
  // attacker's server, so the URI must match one the client registered.
  const client = await loadClient(client_id);

  if (!client) {
    return { statusCode: 400, headers: CORS,
      body: JSON.stringify({ error: 'invalid_client', error_description: 'Unknown client.' }) };
  }
  if (!client.redirect_uris.includes(redirect_uri)) {
    return { statusCode: 400, headers: CORS,
      body: JSON.stringify({ error: 'invalid_grant', error_description: 'redirect_uri does not match this client.' }) };
  }

  // NO CHALLENGE IS ONLY ALLOWED FOR A CLIENT THAT CAN KEEP A SECRET. A public
  // client without PKCE is an intercepted code away from somebody else's
  // record; a confidential one proves itself at the token endpoint instead,
  // and the code is marked so the token endpoint demands exactly that.
  if (!code_challenge && !client.client_secret_hash) {
    return { statusCode: 400, headers: CORS,
      body: JSON.stringify({ error: 'invalid_request', error_description: 'code_challenge is required for a public client.' }) };
  }

  const code = newToken();
  const { error } = await supabase.from('wrought_oauth_codes').insert([{
    code_hash: hashToken(code),
    client_id,
    user_id: userData.user.id,
    redirect_uri,
    code_challenge: code_challenge || CONFIDENTIAL_MARK,
    challenge_method: code_challenge ? 'S256' : 'none',
    expires_at: new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString(),
  }]);

  if (error) {
    return { statusCode: 500, headers: CORS,
      body: JSON.stringify({ error: 'server_error', error_description: error.message }) };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ code }) };
};

// The stored challenge for a code minted to a confidential client — no PKCE,
// so the token endpoint checks the client secret instead. The column is NOT
// NULL and the token endpoint keys off this exact value.
export const CONFIDENTIAL_MARK = 'confidential:client_secret';

// The client row, with its secret hash where 028 has run and without it where
// it has not — a select naming a column PostgREST does not know rejects the
// whole query, and a connect that dies because a migration is pending is the
// 017 lesson in the one place it would lock everybody out at once.
export async function loadClient(clientId) {
  const withSecret = await supabase.from('wrought_oauth_clients')
    .select('client_id, redirect_uris, client_secret_hash').eq('client_id', clientId).maybeSingle();
  if (!withSecret.error) return withSecret.data;
  const { data } = await supabase.from('wrought_oauth_clients')
    .select('client_id, redirect_uris').eq('client_id', clientId).maybeSingle();
  return data ? { ...data, client_secret_hash: null } : null;
}
