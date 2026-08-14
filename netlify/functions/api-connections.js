// netlify/functions/api-connections.js
// Which assistants are connected to this account, and cutting one off.
//
// authorize.html has always told people "revoke it any time from the dashboard".
// There was no such thing on the dashboard. A promise a product makes on its own
// consent screen and does not keep is worse than never making it — that screen
// is the one moment somebody is deciding whether to trust this with their health
// record.
//
// It also answers a question that turns out to be genuinely confusing: the
// connector inside ChatGPT holds its own long-lived token, which is a completely
// separate thing from being signed in at wrought.fit in a browser. Both are
// "logged in", neither implies the other, and there was nowhere to see either.

import { supabase, getAuthUser } from './lib/wrought.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

// A redirect URI is what a client actually is. The client_name it registered is
// self-reported and can say anything.
function nameFor(client) {
  const uris = (client?.redirect_uris || []).join(' ');
  if (/openai|chatgpt/i.test(uris)) return 'ChatGPT';
  if (/anthropic|claude/i.test(uris)) return 'Claude';
  if (client?.client_name) return String(client.client_name).slice(0, 60);
  try { return new URL((client?.redirect_uris || [])[0]).hostname.replace(/^www\./, ''); }
  catch { return 'An assistant'; }
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!supabase) return json(500, { error: 'server_not_configured' });

  const user = await getAuthUser(event);
  if (!user) return json(401, { error: 'sign_in_required' });

  if (event.httpMethod === 'GET') {
    const now = Date.now();
    const { data: tokens } = await supabase.from('wrought_oauth_tokens')
      .select('client_id, scope, expires_at, created_at')
      .eq('user_id', user.id).order('created_at', { ascending: false });

    const ids = [...new Set((tokens || []).map(t => t.client_id).filter(Boolean))];
    const { data: clients } = ids.length
      ? await supabase.from('wrought_oauth_clients')
          .select('client_id, client_name, redirect_uris').in('client_id', ids)
      : { data: [] };
    const byId = new Map((clients || []).map(c => [c.client_id, c]));

    // One row per client, not per token. A client that refreshed forty times is
    // one connection, and showing forty is how a security screen becomes noise
    // nobody reads.
    const seen = new Map();
    for (const t of (tokens || [])) {
      const live = new Date(t.expires_at).getTime() > now;
      const cur = seen.get(t.client_id);
      if (!cur) {
        seen.set(t.client_id, {
          client_id: t.client_id,
          name: nameFor(byId.get(t.client_id)),
          // Rows come back newest first, so the first one seen is the newest.
          // An access token is short-lived and only reissued when the assistant
          // actually calls, which makes this the closest thing to "last used"
          // available without a migration.
          last_token_at: t.created_at,
          expires_at: t.expires_at,
          active: live,
        });
      } else {
        // The OLDEST row is when this connection began; keep walking down.
        cur.connected_at = t.created_at;
        if (live && !cur.active) { cur.active = true; cur.expires_at = t.expires_at; }
      }
    }

    const list = [...seen.values()];
    for (const c of list) if (!c.connected_at) c.connected_at = c.last_token_at;
    const active = list.filter(c => c.active);

    // HAS AN ASSISTANT EVER ACTUALLY WRITTEN TO THIS ACCOUNT.
    //
    // "Connected" and "doing anything" are different facts, and the gap
    // between them is invisible: an assistant can hold a perfectly good token
    // and never call a tool, which looks — from the dashboard — exactly like
    // an assistant that is not connected at all, and exactly like a product
    // that is broken. "Hey Jim bro, which account am I on?" answered with
    // "your ChatGPT Plus account", from the model's own context, with no tool
    // touched. Nothing on either screen could tell that apart from a fork.
    //
    // Every event the connector writes carries source 'agent'. The newest one
    // is the last time this account heard from an assistant at all.
    const { data: lastWrite } = await supabase.from('wrought_events')
      .select('created_at, summary').eq('user_id', user.id).eq('source', 'agent')
      .order('created_at', { ascending: false }).limit(1);

    return json(200, {
      connections: list,
      active: active.length,
      last_write: lastWrite?.[0]?.created_at || null,
      last_write_was: lastWrite?.[0]?.summary || null,
      // The three states, named, because they need completely different fixes
      // and look identical from outside.
      state: !active.length ? 'nothing_connected'
           : !lastWrite?.length ? 'connected_never_written'
           : 'working',
      // Said plainly, because the difference is not obvious and the confusion is
      // reasonable: the connector's token IS a login, just not this browser's.
      note: 'An assistant holds its own token. That is a separate login from this browser — signing out here does not disconnect it, and connecting it does not sign you in here.',
      say: active.length
        ? `${active.length} assistant${active.length === 1 ? '' : 's'} connected: ${active.map(c => c.name).join(', ')}.`
        : 'No assistant is connected to this account right now.',
    });
  }

  if (event.httpMethod === 'DELETE' || event.httpMethod === 'POST') {
    let body = {}; try { body = JSON.parse(event.body || '{}'); } catch { /* defaults fine */ }

    // Scoped to the caller on every arm, so a guessed client_id can never cut
    // off somebody else's assistant.
    const del = table => {
      const q = supabase.from(table).delete().eq('user_id', user.id);
      return body.client_id ? q.eq('client_id', body.client_id) : q;
    };

    // Access AND refresh, or the assistant simply mints a new access token on
    // its next call and the revoke looks like it silently failed.
    await Promise.all([
      del('wrought_oauth_tokens'),
      del('wrought_oauth_refresh'),
      del('wrought_oauth_codes'),
    ]);

    return json(200, {
      ok: true,
      say: body.client_id
        ? 'Disconnected. That assistant will ask you to sign in again the next time it tries.'
        : 'Every assistant disconnected. Reconnect from inside whichever one you use.',
      note: 'Nothing you logged is touched. This only removes the assistant\'s permission to reach it.',
    });
  }

  return json(405, { error: 'method_not_allowed' });
};
