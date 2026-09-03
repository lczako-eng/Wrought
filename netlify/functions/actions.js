// netlify/functions/actions.js
// The same tools as plain HTTP, for a custom ChatGPT's Actions.
//
// WHY THIS EXISTS. Nearly every incident in the memory file is ChatGPT not
// calling a tool, or claiming a save it never made — and the cause is
// structural: ChatGPT does not reliably show the MCP instruction sheet to its
// model when WROUGHT is a pasted-in connector. A custom GPT is different. Its
// own Instructions box is read every turn, and its Actions are an OpenAPI
// document over ordinary HTTP. So the same server is exposed once more, here,
// as that document: one function, one operation per tool, the condensed
// instruction sheet served beside it so the GPT builder pastes it from the
// live server rather than from a copy that goes stale.
//
// NOTHING IS REIMPLEMENTED. Every operation is handleRpc's tools/call with
// the same auth, the same membership gate, the same handlers and the same
// result shape — the MCP server, reached by a different door. A tool result
// that carries `error` still answers 200 with that object as the body,
// because ChatGPT hides the body of a non-2xx and the whole point of the
// result's `say` and `note` is that the model reads them.
//
// THE THIRTY-OPERATION CAP. ChatGPT allows thirty operations per Action and
// three hundred characters per operation description. The daily tools get an
// operation each; everything else goes through `call_tool` with the tool name,
// and its description lists what it reaches. Descriptions are cut at the cap
// with the full text left on the MCP side untouched.

import { TOOLS, handleRpc } from './mcp.js';
import { getAuthUser, AuthUnavailable, SITE_URL } from './lib/wrought.js';
import { GPT_INSTRUCTIONS } from './lib/gpt_instructions.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const json = (statusCode, body, extra = {}) => ({
  statusCode, headers: { ...CORS, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body),
});

// The tools that get an operation of their own — the ones a day actually
// uses, in the order a day uses them. Twenty-nine, plus call_tool.
export const ACTION_TOOLS = [
  'get_profile', 'log', 'get_day', 'amend_last', 'undo_last', 'log_weight', 'log_activity',
  'structure_entries', 'energy_balance', 'brief', 'whats_next', 'progress',
  'suggest_workout', 'start_session', 'log_set', 'rack_note', 'session_status', 'end_session',
  'save_routine', 'list_routines', 'design_workout',
  'my_plan', 'set_plan', 'set_goal', 'set_profile', 'answer_setup', 'set_alert', 'remember', 'record_check',
];
export const MAX_OPERATIONS = 30;
export const MAX_DESCRIPTION = 300;

const cut = (s, n = MAX_DESCRIPTION) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
};

export function openapi(base = SITE_URL) {
  const byName = new Map(TOOLS.map(t => [t.name, t]));
  const paths = {};
  for (const name of ACTION_TOOLS) {
    const t = byName.get(name);
    if (!t) continue;
    paths[`/actions/${name}`] = {
      post: {
        operationId: name,
        summary: cut(t.title || name, 120),
        description: cut(t.description),
        requestBody: {
          required: false,
          content: { 'application/json': { schema: t.inputSchema || { type: 'object', properties: {} } } },
        },
        responses: { 200: { description: 'The tool result. Read say and note; an error field means it did not happen.',
          content: { 'application/json': { schema: { type: 'object' } } } } },
        security: [{ wrought_oauth: ['wrought'] }],
      },
    };
  }
  const rest = TOOLS.map(t => t.name).filter(n => !ACTION_TOOLS.includes(n));
  paths['/actions/call_tool'] = {
    post: {
      operationId: 'call_tool',
      summary: 'Any other WROUGHT tool by name',
      description: cut(`Calls any WROUGHT tool not listed as its own operation, by name, with its arguments. Reaches: ${rest.join(', ')}.`),
      requestBody: {
        required: true,
        content: { 'application/json': { schema: {
          type: 'object',
          properties: {
            tool: { type: 'string', enum: rest, description: 'The tool name.' },
            arguments: { type: 'object', description: 'The tool\'s arguments, as its MCP schema describes them.' },
          },
          required: ['tool'],
        } } },
      },
      responses: { 200: { description: 'The tool result.', content: { 'application/json': { schema: { type: 'object' } } } } },
      security: [{ wrought_oauth: ['wrought'] }],
    },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'WROUGHT',
      version: '1.0.0',
      description: 'The user\'s training and nutrition memory. Every figure is computed here and relayed; nothing is estimated by the model.',
    },
    servers: [{ url: base }],
    paths,
    components: {
      securitySchemes: {
        wrought_oauth: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: `${base}/authorize.html`,
              tokenUrl: `${base}/oauth/token`,
              refreshUrl: `${base}/oauth/token`,
              scopes: { wrought: 'Read and write your own WROUGHT record' },
            },
          },
        },
      },
    },
  };
}

function segment(event) {
  const p = String(event.path || '');
  const i = p.lastIndexOf('/actions/');
  if (i >= 0) return p.slice(i + '/actions/'.length).replace(/\/+$/, '');
  return p.split('/').filter(Boolean).pop() || '';
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const seg = segment(event);
  const base = process.env.URL || SITE_URL;

  if (event.httpMethod === 'GET') {
    if (seg === 'openapi.json') return json(200, openapi(base), { 'Cache-Control': 'public, max-age=300' });
    if (seg === 'instructions') {
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' }, body: GPT_INSTRUCTIONS };
    }
    return json(404, { error: 'not_found', say: 'GET /actions/openapi.json for the document, /actions/instructions for the sheet; POST /actions/<tool> to call one.' });
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let args = {};
  try {
    const raw = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body || '{}');
    args = raw.trim() ? JSON.parse(raw) : {};
  } catch { return json(400, { error: 'bad_json', say: 'The request body was not JSON.' }); }

  let name = seg, toolArgs = args;
  if (seg === 'call_tool') {
    name = String(args.tool || '');
    toolArgs = args.arguments && typeof args.arguments === 'object' ? args.arguments : {};
  }
  if (!name || !TOOLS.some(t => t.name === name)) {
    return json(404, { error: 'unknown_tool', tool: name, say: `No tool called "${name}".` });
  }

  // The same auth as the MCP door. A 401 is what makes ChatGPT open the
  // sign-in; a transient failure is 503, never a sign-in — "could not check"
  // is not "not signed in".
  let user;
  try { user = await getAuthUser(event); }
  catch (e) {
    if (e instanceof AuthUnavailable) return json(503, { error: 'unavailable', say: 'WROUGHT could not check the sign-in just now. Try once more.' }, { 'Retry-After': '3' });
    throw e;
  }
  if (!user) {
    return json(401, { error: 'sign_in_required', say: 'Sign in with WROUGHT to continue.' },
      { 'WWW-Authenticate': `Bearer realm="wrought", resource_metadata="${base}/.well-known/oauth-protected-resource"` });
  }

  const rpc = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: toolArgs } }, user);
  if (rpc && rpc.__unauthorized) return json(401, { error: 'sign_in_required' });
  if (rpc?.error) return json(200, { error: rpc.error.message || 'tool_failed' });
  const text = rpc?.result?.content?.[0]?.text;
  let out;
  try { out = text ? JSON.parse(text) : {}; } catch { out = { text }; }
  return json(200, out);
};
