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

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!supabase) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'server_not_configured' }) };

  const user = await getAuthUser(event);
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'sign_in_required' }) };

  // List — hashes only, never a plaintext key. There is no way to recover one.
  if (event.httpMethod === 'GET') {
    const { data } = await supabase.from('wrought_ingest_keys')
      .select('id, label, last_used_at, revoked, created_at')
      .eq('user_id', user.id).eq('revoked', false)
      .order('created_at', { ascending: false });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ keys: data || [] }) };
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
