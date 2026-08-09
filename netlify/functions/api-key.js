// netlify/functions/api-key.js
// Mint and revoke device ingest keys from the web.
//
// The MCP tool connect_device can do this too, but somebody setting up a
// Shortcut is already holding their phone and looking at a browser — making
// them go back to a chat window to get the key is a small cruelty.

import { supabase, getAuthUser, newToken, hashToken } from './lib/wrought.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

// Plain English rather than a timestamp. "4 minutes ago" tells somebody their
// Shortcut works; "2026-08-09T23:04:11Z" makes them do arithmetic.
function minutesWord(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'seconds ago';
  if (m === 1) return 'a minute ago';
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!supabase) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'server_not_configured' }) };

  const user = await getAuthUser(event);
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'sign_in_required' }) };

  // List — hashes only, never a plaintext key. There is no way to recover one.
  //
  // It also answers the question somebody actually has at eleven at night with a
  // half-built Shortcut: DID ANYTHING ARRIVE? Setting this up blind and finding
  // out tomorrow is how people give up on it tonight.
  if (event.httpMethod === 'GET') {
    const [{ data: keys }, { data: recent }, { count: total }] = await Promise.all([
      supabase.from('wrought_ingest_keys')
        .select('id, label, last_used_at, revoked, created_at')
        .eq('user_id', user.id).eq('revoked', false)
        .order('created_at', { ascending: false }),
      supabase.from('wrought_metrics')
        .select('metric, value, unit, measured_at, source, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false }).limit(40),
      supabase.from('wrought_metrics')
        .select('id', { count: 'exact', head: true }).eq('user_id', user.id),
    ]);

    const rows = recent || [];
    const landed = rows[0]?.created_at || null;
    // What actually came through, deduplicated by metric — "steps, sleep,
    // resting hr" is the sentence somebody needs, not forty rows.
    const kinds = [...new Set(rows.map(r => r.metric))];

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        keys: keys || [],
        received: {
          ever: total || 0,
          last_at: landed,
          minutes_ago: landed ? Math.max(0, Math.round((Date.now() - new Date(landed).getTime()) / 60000)) : null,
          metrics: kinds,
          sources: [...new Set(rows.map(r => r.source))],
          sample: rows.slice(0, 8).map(r => ({
            metric: r.metric, value: r.value, unit: r.unit,
            measured_at: r.measured_at, source: r.source,
          })),
        },
        say: total
          ? `${total} reading${total === 1 ? '' : 's'} received${landed ? `, most recently ${minutesWord(Date.now() - new Date(landed).getTime())}` : ''}.`
          : 'Nothing has arrived yet. Run the Shortcut once by hand and refresh this.',
      }),
    };
  }

  if (event.httpMethod === 'POST') {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch { /* defaults are fine */ }

    if (body.revoke_id) {
      await supabase.from('wrought_ingest_keys')
        .update({ revoked: true }).eq('id', body.revoke_id).eq('user_id', user.id);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ revoked: true }) };
    }

    const token = newToken();
    const { error } = await supabase.from('wrought_ingest_keys').insert([{
      user_id: user.id,
      token_hash: hashToken(token),
      label: String(body.label || 'Apple Health').slice(0, 60),
    }]);
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };

    await supabase.from('wrought_connections').upsert(
      { user_id: user.id, provider: 'apple_health', mode: 'push', status: 'active' },
      { onConflict: 'user_id,provider' });

    // The one and only time this string exists outside the caller's screen.
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ key: token, label: body.label || 'Apple Health' }) };
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'method_not_allowed' }) };
};
