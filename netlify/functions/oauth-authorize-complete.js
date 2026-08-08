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
// minted somewhere the client cannot forge one.

import { supabase, hashToken, newToken } from './lib/forge.js';

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

  if (!access_token || !client_id || !redirect_uri || !code_challenge) {
    return { statusCode: 400, headers: CORS,
      body: JSON.stringify({ error: 'invalid_request', error_description: 'Missing required parameters.' }) };
  }
  if ((code_challenge_method || 'S256') !== 'S256') {
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

  // An open redirect here would hand somebody else's authorization code to an
  // attacker's server, so the URI must match one the client registered.
  const { data: client } = await supabase.from('forge_oauth_clients')
    .select('client_id, redirect_uris').eq('client_id', client_id).maybeSingle();

  if (!client) {
    return { statusCode: 400, headers: CORS,
      body: JSON.stringify({ error: 'invalid_client', error_description: 'Unknown client.' }) };
  }
  if (!client.redirect_uris.includes(redirect_uri)) {
    return { statusCode: 400, headers: CORS,
      body: JSON.stringify({ error: 'invalid_grant', error_description: 'redirect_uri does not match this client.' }) };
  }

  const code = newToken();
  const { error } = await supabase.from('forge_oauth_codes').insert([{
    code_hash: hashToken(code),
    client_id,
    user_id: userData.user.id,
    redirect_uri,
    code_challenge,
    challenge_method: 'S256',
    expires_at: new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString(),
  }]);

  if (error) {
    return { statusCode: 500, headers: CORS,
      body: JSON.stringify({ error: 'server_error', error_description: error.message }) };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ code }) };
};
