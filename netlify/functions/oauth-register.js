// netlify/functions/oauth-register.js
// Dynamic client registration (RFC 7591).
//
// MCP clients register themselves. There is no admin console where somebody
// adds "ChatGPT" by hand — ChatGPT arrives, posts its redirect URIs, and gets a
// client_id back. This endpoint is therefore open by design.
//
// It issues no client secret. These are public clients (desktop apps, browser
// extensions) which cannot keep one; PKCE does the binding instead.

import { supabase } from './lib/wrought.js';
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

  const { error } = await supabase.from('wrought_oauth_clients').insert([{
    client_id: clientId,
    client_name: String(body.client_name || 'MCP client').slice(0, 200),
    redirect_uris: redirectUris,
    grant_types: body.grant_types?.length ? body.grant_types : ['authorization_code', 'refresh_token'],
    scope: 'wrought',
  }]);

  if (error) {
    return { statusCode: 500, headers: CORS,
      body: JSON.stringify({ error: 'server_error', error_description: error.message }) };
  }

  return {
    statusCode: 201,
    headers: CORS,
    body: JSON.stringify({
      client_id: clientId,
      client_name: body.client_name || 'MCP client',
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'wrought',
    }),
  };
};
