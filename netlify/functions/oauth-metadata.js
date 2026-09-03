// netlify/functions/oauth-metadata.js
// OAuth 2.1 discovery documents.
//
// Served by a function rather than as static files on purpose: extensionless
// files under /.well-known/ get an unreliable Content-Type from static hosting,
// and an MCP client that receives text/plain here fails discovery with a
// generic "could not connect" that tells you nothing. A function guarantees
// the header and the CORS.

import { SITE_URL } from './lib/wrought.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Protocol-Version',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=300',
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const base = process.env.URL || SITE_URL;
  const path = event.path || '';

  // Which document depends on which well-known path was asked for. Both are
  // routed here, because clients differ on which they fetch first.
  const isProtectedResource = path.includes('oauth-protected-resource');

  const body = isProtectedResource
    ? {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: ['wrought'],
        bearer_methods_supported: ['header'],
        resource_name: 'WROUGHT',
        resource_documentation: `${base}/connect.html`,
        // Some clients render the connector's badge from here rather than from
        // the handshake, so the mark is published in every place one might look.
        logo_uri: `${base}/icon-192.png`,
      }
    : {
        issuer: base,
        authorization_endpoint: `${base}/authorize.html`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        scopes_supported: ['wrought'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        // PKCE for public clients — a desktop app or a browser extension
        // cannot keep a client secret, so the challenge is the only thing
        // binding the code to whoever requested it. A confidential client (a
        // custom ChatGPT's Actions, run from OpenAI's servers) presents a
        // secret instead, and the token endpoint demands exactly one of the
        // two according to how the client registered.
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
        service_documentation: `${base}/connect.html`,
        op_policy_uri: `${base}/privacy.html`,
        op_tos_uri: `${base}/terms.html`,
        logo_uri: `${base}/icon-192.png`,
      };

  return { statusCode: 200, headers: CORS, body: JSON.stringify(body) };
};
