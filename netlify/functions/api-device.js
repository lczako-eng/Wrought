// netlify/functions/api-device.js
// Connecting, disconnecting and syncing the direct-API devices.
//
//   GET  /api/device            → what can be connected, and what already is
//   GET  /api/device/connect    → sends the user off to the provider
//   GET  /api/device/callback   → they come back here; tokens get stored
//   POST /api/device/sync       → pull whatever is new
//
// These are a fidelity upgrade and not the entry price — Apple Health and
// Health Connect remain the answer to "how do I connect my watch", because two
// doors pick up dozens of apps with no partnerships and no keys. This is for
// the handful worth pulling at higher resolution.
//
// Tokens live in wrought_connections, which no browser client can select from —
// only the service role reads that table. A provider access token is a key to
// somebody's health record on a third party's servers, and it must never be
// reachable from a page.

import { supabase, getAuthUser, getProfile, localDateFor, addDays } from './lib/wrought.js';
import { PULL, PULL_PROVIDERS, connectUrl, exchangeCode, refreshToken, fetchMetrics, credentialsFor } from './lib/pull.js';
import crypto from 'node:crypto';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const site = () => (process.env.WROUGHT_SITE_URL || 'https://wrought.fit').replace(/\/$/, '');

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!supabase) return json(500, { error: 'server_not_configured' });

  const path = (event.path || '').replace(/\/$/, '');
  const q = event.queryStringParameters || {};

  // The callback is the one route the provider itself hits, arriving with no
  // Authorization header — the user is identified by the signed state instead.
  if (path.endsWith('/callback')) return callback(q);

  const user = await getAuthUser(event);
  if (!user) return json(401, { error: 'sign_in_required' });

  if (path.endsWith('/connect')) return connect(user, q);
  if (path.endsWith('/sync')) return sync(user, q);

  if (event.httpMethod === 'DELETE') {
    let body = {}; try { body = JSON.parse(event.body || '{}'); } catch { /* fine */ }
    if (!body.provider) return json(400, { error: 'provider_required' });
    await supabase.from('wrought_connections')
      .delete().eq('user_id', user.id).eq('provider', body.provider);
    return json(200, { ok: true, say: `${body.provider} disconnected. Everything it already sent stays.` });
  }

  // The list. Says out loud which providers the operator has actually
  // registered, because "connect Oura" that leads to somebody else's error page
  // is worse than a greyed-out button with a reason on it.
  const { data: conns } = await supabase.from('wrought_connections')
    .select('provider, mode, status, last_sync_at, external_user_id').eq('user_id', user.id);
  const have = new Map((conns || []).map(c => [c.provider, c]));

  return json(200, {
    providers: PULL_PROVIDERS.map(id => {
      const c = have.get(id);
      return {
        id, name: PULL[id].name,
        available: !!credentialsFor(id),
        connected: !!c,
        last_sync: c?.last_sync_at || null,
        why_not: credentialsFor(id) ? null
          : `Not registered yet — needs ${PULL[id].idEnv} and ${PULL[id].secretEnv}.`,
      };
    }),
    note: 'These are a fidelity upgrade. Apple Health or Health Connect already covers most of this with nothing to register.',
  });
};

// ── The round trip ──────────────────────────────────────────────────────────
// state carries the user id and is SIGNED. An unsigned state would let anybody
// craft a callback that attaches their own provider account to somebody else's
// WROUGHT record — which reads as an integration bug and is actually a way to
// write into a stranger's health log.

function signState(userId, provider) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const payload = `${userId}.${provider}.${Date.now()}`;
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${mac}`;
}

function readState(state) {
  try {
    const [b, mac] = String(state).split('.');
    const payload = Buffer.from(b, 'base64url').toString('utf8');
    const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const want = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    // Constant time, because a comparison that returns early on the first wrong
    // byte is a comparison somebody can measure their way past.
    if (mac.length !== want.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;

    const [userId, provider, ts] = payload.split('.');
    // Ten minutes. Long enough for a slow OAuth screen, short enough that a
    // state left in a browser history is useless.
    if (Date.now() - Number(ts) > 10 * 60 * 1000) return null;
    return { userId, provider };
  } catch { return null; }
}

function connect(user, q) {
  const provider = String(q.provider || '');
  if (!PULL[provider]) return json(400, { error: 'unknown_provider' });

  const out = connectUrl(provider, { site: site(), state: signState(user.id, provider) });
  if (out.error) return json(400, out);
  return json(200, { url: out.url, say: `Opening ${PULL[provider].name}.` });
}

async function callback(q) {
  const html = (title, msg) => ({
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    body: `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WROUGHT</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#14110F;color:#F4EFE9;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
text-align:center;padding:28px}h1{font-family:Rockwell,"Roboto Slab",Georgia,serif;font-size:24px;margin:0}
p{color:#9A8D84;font-size:14px;margin:10px 0 0}a{color:#F26419}</style>
<div><h1>${title}</h1><p>${msg}</p><p><a href="/app.html">Back to your dashboard</a></p></div>`,
  });

  if (q.error) return html('Not connected', 'The provider declined the connection. Nothing changed.');

  const st = readState(q.state);
  if (!st) return html('That link expired', 'Start the connection again from your dashboard.');
  if (!q.code) return html('Not connected', 'No authorization code came back.');

  const tok = await exchangeCode(st.provider, { code: q.code, site: site() });
  if (tok.error) return html('Not connected', `Could not finish: ${tok.error}.`);

  const { error } = await supabase.from('wrought_connections').upsert({
    user_id: st.userId,
    provider: st.provider,
    mode: 'pull',
    status: 'active',
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: tok.expires_at,
    external_user_id: tok.external_id ? String(tok.external_id) : null,
    scopes: tok.scope || null,
  }, { onConflict: 'user_id,provider' });

  if (error) return html('Not connected', 'Could not save the connection.');
  return html(`${PULL[st.provider].name} connected`, 'It will start filling in from here. Nothing you logged by hand is touched.');
}

// ── Sync ────────────────────────────────────────────────────────────────────

async function liveToken(conn) {
  const fresh = conn.expires_at && new Date(conn.expires_at).getTime() > Date.now() + 60_000;
  if (fresh) return conn.access_token;
  if (!conn.refresh_token) return null;

  const t = await refreshToken(conn.provider, conn.refresh_token);
  if (t.error) return null;

  await supabase.from('wrought_connections').update({
    access_token: t.access_token,
    // Some providers rotate the refresh token and some do not. Keeping the old
    // one when none comes back is the difference between a connection that
    // lasts and one that dies quietly in a fortnight.
    refresh_token: t.refresh_token || conn.refresh_token,
    expires_at: t.expires_at,
  }).eq('user_id', conn.user_id).eq('provider', conn.provider);

  return t.access_token;
}

async function sync(user, q) {
  const profile = await getProfile(user.id);
  const today = localDateFor(profile.timezone);
  const since = q.since || addDays(today, -30);

  const { data: conns } = await supabase.from('wrought_connections')
    .select('*').eq('user_id', user.id).eq('mode', 'pull');
  const wanted = q.provider ? (conns || []).filter(c => c.provider === q.provider) : (conns || []);
  if (!wanted.length) return json(200, { synced: 0, say: 'Nothing to sync — no direct connections.' });

  const report = [];
  let total = 0;

  for (const conn of wanted) {
    const token = await liveToken(conn);
    if (!token) {
      await supabase.from('wrought_connections')
        .update({ status: 'expired', last_error: 'refresh failed — needs reconnecting' })
        .eq('user_id', user.id).eq('provider', conn.provider);
      report.push({ provider: conn.provider, error: 'needs_reconnect' });
      continue;
    }

    let rows = [];
    try { rows = await fetchMetrics(conn.provider, token, { since }); }
    catch (e) { report.push({ provider: conn.provider, error: e.message }); continue; }

    if (rows.length) {
      // Straight into the same table the Shortcut writes to, with source_ref
      // set, so the existing unique index does the deduplication and syncing
      // twice cannot double anybody's steps.
      const payload = rows.map(r => ({
        user_id: user.id,
        metric: r.metric, value: r.value, unit: r.unit,
        measured_at: r.measured_at,
        local_date: localDateFor(profile.timezone, new Date(r.measured_at)),
        source: r.source, source_ref: r.source_ref,
      }));
      const { error } = await supabase.from('wrought_metrics')
        .upsert(payload, { onConflict: 'user_id,source,metric,measured_at', ignoreDuplicates: true });
      if (error) { report.push({ provider: conn.provider, error: error.message }); continue; }
    }

    await supabase.from('wrought_connections').update({
      last_sync_at: new Date().toISOString(), status: 'active', last_error: null,
    }).eq('user_id', user.id).eq('provider', conn.provider);

    total += rows.length;
    report.push({ provider: conn.provider, rows: rows.length });
  }

  return json(200, {
    synced: total,
    since,
    detail: report,
    say: total
      ? `Pulled ${total} reading${total === 1 ? '' : 's'} in.`
      : 'Nothing new since the last sync.',
    note: 'Duplicates are dropped on the way in — syncing twice cannot double a day.',
  });
}
