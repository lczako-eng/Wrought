// netlify/functions/api-photos.js
// Progress photos: upload, list with dated comparison, delete.
//
// The scale is a bad instrument over months. It moves with salt, sleep and the
// hour of the day, and it cannot tell three kilos of muscle from three kilos of
// anything else. Two photographs eight weeks apart answer the question the
// number keeps getting wrong — and for somebody who has done everything right
// and watched a flat line, it is the only place the work becomes visible.
//
// Everything here is built around one rule: NOTHING EVER READS THE IMAGE. No
// body-fat estimate, no pose scoring, no analysis. A number invented from a
// photograph of somebody's torso would break the estimates-are-labelled
// doctrine exactly where it would do the most harm, and there is no honest
// version of it. This endpoint moves bytes and dates. That is all.
//
// The bucket is private. URLs handed back are signed and expire, so a link that
// leaks out of a screenshot or a chat log is dead within the hour.

import { supabase, getAuthUser, getProfile, localDateFor, daysBetween } from './lib/wrought.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const BUCKET = 'wrought-photos';
const SIGNED_TTL = 3600;                 // an hour is plenty to look at a page
const MAX_BYTES = 12 * 1024 * 1024;
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' };

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!supabase) return json(500, { error: 'server_not_configured' });

  const user = await getAuthUser(event);
  if (!user) return json(401, { error: 'sign_in_required' });

  if (event.httpMethod === 'GET') return list(user);

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad_json' }); }

  if (event.httpMethod === 'POST') return upload(user, body);

  if (event.httpMethod === 'DELETE') {
    const { data: row } = await supabase.from('wrought_photos')
      .select('id, path').eq('user_id', user.id).eq('id', body.id).maybeSingle();
    if (!row) return json(404, { error: 'not_found' });

    // The file first. A row deleted while its object survives leaves an
    // unreferenced photograph of somebody's body in storage forever, which is
    // the one direction this must never fail in.
    await supabase.storage.from(BUCKET).remove([row.path]);
    await supabase.from('wrought_photos').delete().eq('id', row.id);
    return json(200, { ok: true, say: 'Deleted, file and all.' });
  }

  return json(405, { error: 'method_not_allowed' });
};

async function upload(user, body) {
  const type = String(body.content_type || '').toLowerCase();
  if (!TYPES[type]) {
    return json(400, { error: 'unsupported_type', message: 'JPEG, PNG, WebP or HEIC.' });
  }

  const raw = String(body.data || '');
  const bytes = Buffer.from(raw, 'base64');
  if (!bytes.length) return json(400, { error: 'empty_file' });
  if (bytes.length > MAX_BYTES) {
    return json(413, { error: 'too_large', message: 'Under 12MB, please.' });
  }

  const profile = await getProfile(user.id);
  const date = body.local_date || localDateFor(profile.timezone);
  const pose = ['front', 'side', 'back', 'other'].includes(body.pose) ? body.pose : 'front';

  // Namespaced by user id, which is what the storage policy checks. A leaked
  // row id is then not enough to fetch anything.
  const path = `${user.id}/${date}-${pose}-${Date.now()}.${TYPES[type]}`;

  const { error: upErr } = await supabase.storage.from(BUCKET)
    .upload(path, bytes, { contentType: type, upsert: false });
  if (upErr) {
    const missing = /bucket not found|does not exist/i.test(upErr.message || '');
    return json(500, {
      error: missing ? 'bucket_missing' : 'upload_failed',
      message: missing
        ? 'The photo bucket does not exist. Run schema/009_wrought_photos.sql in Supabase.'
        : upErr.message,
    });
  }

  // One per pose per day. Replacing means the old FILE goes too — otherwise
  // every retake leaves an orphan nobody can see or delete.
  const { data: existing } = await supabase.from('wrought_photos')
    .select('id, path').eq('user_id', user.id).eq('local_date', date).eq('pose', pose).maybeSingle();
  if (existing) {
    await supabase.storage.from(BUCKET).remove([existing.path]);
    await supabase.from('wrought_photos').delete().eq('id', existing.id);
  }

  const { data: row, error } = await supabase.from('wrought_photos').insert([{
    user_id: user.id, path, local_date: date, pose,
    weight_kg: body.weight_kg != null ? Number(body.weight_kg) : await weightOn(user.id, date),
    note: body.note ? String(body.note).slice(0, 300) : null,
  }]).select('id, local_date, pose').single();

  if (error) {
    await supabase.storage.from(BUCKET).remove([path]);
    return json(500, { error: error.message });
  }

  return json(200, { ok: true, photo: row, say: `Saved, dated ${date}.` });
}

// What the scale said that day, so the pair can be labelled without asking.
async function weightOn(userId, date) {
  const { data } = await supabase.from('wrought_events')
    .select('detail').eq('user_id', userId).eq('event_type', 'weight')
    .lte('local_date', date).order('local_date', { ascending: false }).limit(1);
  const kg = data?.[0]?.detail?.weight_kg;
  return kg != null ? Number(kg) : null;
}

async function list(user) {
  const profile = await getProfile(user.id);
  const imperial = profile.units === 'imperial';
  const today = localDateFor(profile.timezone);

  const { data: rows } = await supabase.from('wrought_photos')
    .select('id, path, local_date, pose, weight_kg, note')
    .eq('user_id', user.id).order('local_date', { ascending: false }).limit(200);

  const photos = rows || [];
  if (!photos.length) {
    return json(200, {
      photos: [], comparison: null, units: profile.units,
      say: 'No photos yet. Same spot, same light, same time of day — the comparison is only worth anything if the conditions are.',
      note: 'Nothing here is ever analysed. No body composition is estimated from a photograph, by anything, ever.',
    });
  }

  // Signed and short-lived. A link that leaks out of a screenshot is dead
  // within the hour rather than being a permanent window into somebody's body.
  const { data: signed } = await supabase.storage.from(BUCKET)
    .createSignedUrls(photos.map(p => p.path), SIGNED_TTL);
  const urlFor = new Map((signed || []).map(s => [s.path, s.signedUrl]));

  const shaped = photos.map(p => ({
    id: p.id, date: p.local_date, pose: p.pose, note: p.note,
    weight: p.weight_kg == null ? null : (imperial ? Math.round(p.weight_kg * 22.046226) / 10 : p.weight_kg),
    days_ago: daysBetween(p.local_date, today),
    url: urlFor.get(p.path) || null,
  }));

  // The comparison: newest against the oldest of the SAME pose. A front shot
  // beside a side shot is not a comparison, it is two photographs.
  const byPose = new Map();
  for (const p of shaped) {
    if (!byPose.has(p.pose)) byPose.set(p.pose, []);
    byPose.get(p.pose).push(p);
  }
  let comparison = null;
  for (const [pose, list] of byPose) {
    if (list.length < 2) continue;
    const latest = list[0];
    const first = list[list.length - 1];
    const span = daysBetween(first.date, latest.date);
    if (!comparison || span > comparison.days_apart) {
      const dw = latest.weight != null && first.weight != null
        ? Math.round((latest.weight - first.weight) * 10) / 10 : null;
      comparison = {
        pose, then: first, now: latest,
        days_apart: span,
        weeks_apart: Math.round(span / 7),
        weight_change: dw,
        unit: imperial ? 'lb' : 'kg',
        // Deliberately flat. Not "look how far you have come", not a score.
        // A photograph of somebody's body is where this product is most capable
        // of being cruel, and the way to not be is to say nothing about it.
        say: dw != null
          ? `${Math.round(span / 7)} weeks apart, ${dw === 0 ? 'the same weight' : `${Math.abs(dw)}${imperial ? 'lb' : 'kg'} ${dw < 0 ? 'down' : 'up'}`}.`
          : `${Math.round(span / 7)} weeks apart.`,
      };
    }
  }

  return json(200, {
    photos: shaped,
    comparison,
    units: profile.units,
    expires_in: SIGNED_TTL,
    say: comparison
      ? `${photos.length} photo${photos.length === 1 ? '' : 's'}. The furthest apart are ${comparison.weeks_apart} weeks.`
      : `${photos.length} photo${photos.length === 1 ? '' : 's'}. Take another in a few weeks — one on its own compares to nothing.`,
    note: 'Nothing reads these images. No body composition is estimated from a photograph, by anything, ever.',
  });
}
