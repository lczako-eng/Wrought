// netlify/functions/oauth-register.js
// Dynamic client registration (RFC 7591).
//
// MCP clients register themselves. There is no admin console where somebody
// adds "ChatGPT" by hand — ChatGPT arrives, posts its redirect URIs, and gets a
// client_id back. This endpoint is therefore open by design.
//
// By default it issues no client secret. These are public clients (desktop
// apps, browser extensions) which cannot keep one; PKCE does the binding.
//
// THE ONE EXCEPTION IS A CUSTOM CHATGPT. A GPT's Actions run from OpenAI's
// servers, which can keep a secret and do not do PKCE — they present a client
// id and secret at the token endpoint. A registration that asks for
// `token_endpoint_auth_method: "client_secret_post"` (or _basic) gets a
// secret back ONCE, stored hashed (028). A confidential client is not granted
// anything a public one is not: the person still signs in and authorises it,
// and every call still carries their own token.

import { supabase, newToken, hashToken } from './lib/wrought.js';
import { randomBytes } from 'node:crypto';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

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
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid_client_metadata' }) }; }

  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter(Boolean) : [];
  if (!redirectUris.length) {
    return { statusCode: 400, headers: CORS,
      body: JSON.stringify({ error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' }) };
  }

  const clientId = `wrought_${randomBytes(16).toString('hex')}`;

  const method = String(body.token_endpoint_auth_method || 'none');
  const confidential = method === 'client_secret_post' || method === 'client_secret_basic';
  const secret = confidential ? newToken() : null;

  const row = {
    client_id: clientId,
    client_name: String(body.client_name || 'MCP client').slice(0, 200),
    redirect_uris: redirectUris,
    grant_types: body.grant_types?.length ? body.grant_types : ['authorization_code', 'refresh_token'],
    scope: 'wrought',
    ...(secret ? { client_secret_hash: hashToken(secret) } : {}),
  };
  const { error } = await supabase.from('wrought_oauth_clients').insert([row]);

  if (error) {
    // A confidential registration on a database without 028 must not fall
    // back to a public client: a GPT handed a client with no secret would
    // fail at the token endpoint with nothing saying why.
    const missing = secret && /column .*client_secret_hash.* does not exist/i.test(error.message);
    return { statusCode: missing ? 501 : 500, headers: CORS,
      body: JSON.stringify({ error: missing ? 'confidential_clients_not_installed' : 'server_error',
        error_description: missing
          ? 'Confidential clients need schema/028_wrought_oauth_secret.sql run in Supabase first.'
          : error.message }) };
  }

  return {
    statusCode: 201,
    headers: CORS,
    body: JSON.stringify({
      client_id: clientId,
      // SHOWN ONCE. It is stored hashed and cannot be read back — register
      // again if it is lost.
      ...(secret ? { client_secret: secret } : {}),
      client_name: body.client_name || 'MCP client',
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: confidential ? method : 'none',
      scope: 'wrought',
    }),
  };
};
