// netlify/functions/api-profile.js
// The profile, readable and editable from the web.
//
// Everything here was already reachable through the assistant via set_profile.
// That is the right way to CAPTURE these — five facts, asked once, in passing,
// never as an opener — but it was the only way to CHECK them, and "what does it
// think my height is" had no answer anybody could go and read. A memory product
// that cannot show you what it remembers is asking for trust it has not earned.
//
// So this screen is a place to LOOK, not a form to fill in. Nothing is required
// and nothing is asked for at signup.

import { supabase, getAuthUser, getProfile, localDateFor, insertEvents, lbToKg, sayWeight } from './lib/wrought.js';
import { ACTIVITY } from './lib/training.js';
import { STYLES, styleFrom } from './lib/design.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const BUCKET = 'wrought-avatars';
const SIGNED_TTL = 3600;
const MAX_BYTES = 4 * 1024 * 1024;
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' };

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

// Free text in the user's own words, but bounded — an unbounded string on a
// column the assistant also writes to is how a prompt ends up in a database.
const text = (v, max = 200) => (v == null || v === '' ? null : String(v).slice(0, max));
const num = (v, lo, hi) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : undefined;   // undefined = reject
};
const list = v => (Array.isArray(v) ? v.map(x => String(x).slice(0, 60)).filter(Boolean).slice(0, 20) : null);

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!supabase) return json(500, { error: 'server_not_configured' });

  const user = await getAuthUser(event);
  if (!user) return json(401, { error: 'sign_in_required' });

  if (event.httpMethod === 'GET') return read(user);

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad_json' }); }

  if (event.httpMethod === 'DELETE') return dropAvatar(user);
  if (event.httpMethod === 'POST') {
    return body.avatar ? putAvatar(user, body) : save(user, body);
  }
  return json(405, { error: 'method_not_allowed' });
};

async function avatarUrl(profile) {
  if (!profile.avatar_path) return null;
  const { data } = await supabase.storage.from(BUCKET)
    .createSignedUrl(profile.avatar_path, SIGNED_TTL);
  return data?.signedUrl || null;
}

async function read(user) {
  const p = await getProfile(user.id);

  // Which sign-ins reach this account, so the profile screen and the Ways In
  // panel cannot tell two different stories.
  const ways = (user.identities || []).map(i => i.provider);
  const admins = String(process.env.WROUGHT_ADMIN_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

  return json(200, {
    account: {
      email: user.email || null,
      ways_in: ways,
      // Named in an environment variable, never a column somebody could set on
      // themselves and never a flag in a token.
      administrator: admins.includes(String(user.email || '').trim().toLowerCase()),
      since: user.created_at || null,
    },
    profile: {
      display_name: p.display_name || null,
      avatar_url: await avatarUrl(p),
      timezone: p.timezone,
      units: p.units,
      bluntness: p.bluntness,
      height_cm: p.height_cm,
      birth_year: p.birth_year,
      sex: p.sex,
      activity_level: p.activity_level || null,
      // The standing coach — a STYLES key, or null for the plain trainer.
      coach_style: p.coach_style && STYLES[p.coach_style] ? p.coach_style : null,
      training_age: p.training_age,
      train_days: p.train_days,
      equipment: p.equipment || [],
      dietary: p.dietary || [],
      notes: p.notes,
      configured: p._exists,
    },
    // What each one is FOR, so a settings screen is not a row of unexplained
    // dropdowns. The activity multipliers in particular decide whether "calories
    // out" counts a working day as zero.
    activity_options: Object.entries(ACTIVITY).map(([id, a]) => ({
      id, multiplier: a.mult, detail: a.say,
    })),
    today: localDateFor(p.timezone),
    note: 'Nothing here is required. Blank means WROUGHT does not know it and will say so rather than guessing.',
  });
}

async function save(user, body) {
  const patch = { user_id: user.id, updated_at: new Date().toISOString() };
  const bad = [];

  const set = (key, value, label) => {
    if (value === undefined) { bad.push(label || key); return; }
    if (value !== null || key in body) patch[key] = value;
  };

  if ('display_name' in body)  patch.display_name  = text(body.display_name, 80);
  if ('sex' in body)           patch.sex           = text(body.sex, 40);
  if ('training_age' in body)  patch.training_age  = text(body.training_age, 60);
  if ('notes' in body)         patch.notes         = text(body.notes, 2000);
  if ('equipment' in body)     patch.equipment     = list(body.equipment);
  if ('dietary' in body)       patch.dietary       = list(body.dietary);

  if ('timezone' in body) {
    // Verified against the platform rather than trusted. A bad timezone files
    // every late-night snack under the wrong day and quietly corrupts the brief.
    const tz = String(body.timezone || '');
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); patch.timezone = tz; }
    catch { bad.push('timezone'); }
  }
  if ('units' in body) {
    if (['metric', 'imperial'].includes(body.units)) patch.units = body.units;
    else bad.push('units');
  }
  if ('bluntness' in body) {
    // Honoured exactly. This is the user's setting, not a suggestion.
    if (['gentle', 'honest', 'brutal'].includes(body.bluntness)) patch.bluntness = body.bluntness;
    else bad.push('bluntness');
  }
  if ('activity_level' in body) {
    const v = body.activity_level;
    if (v == null || v === '' || v in ACTIVITY) patch.activity_level = v || null;
    else bad.push('activity_level');
  }
  // THE STANDING COACH, from the Trainer-styles panel. A style key, or null
  // to go back to the plain trainer. Validated against the same list the
  // tools use — a stored key nothing recognises would coach nobody.
  if ('coach_style' in body) {
    const v = body.coach_style;
    if (v == null || v === '') patch.coach_style = null;
    else if (styleFrom(String(v))) patch.coach_style = styleFrom(String(v));
    else bad.push('coach_style');
  }

  if ('height_cm' in body)  set('height_cm',  num(body.height_cm, 50, 260), 'height');
  if ('birth_year' in body) set('birth_year', num(body.birth_year, 1900, new Date().getFullYear()), 'birth year');
  if ('train_days' in body) set('train_days', num(body.train_days, 0, 14), 'training days');

  // A WEIGH-IN IS NOT A PROFILE FIELD, and until now the website had no way to
  // record one at all. That was a hole rather than a preference: resting burn
  // needs height, birth year AND a recent weight, so somebody could fill in
  // every box on this screen and still be told "calories out needs a recent
  // weigh-in" with nowhere on the site to give it one. The assistant could do
  // it; the website could not. So it is accepted here and written where it
  // belongs — as an event on the log, dated, exactly as log_weight writes it.
  let weighed = null;
  if ('weight' in body && body.weight !== '' && body.weight != null) {
    const raw = Number(body.weight);
    const unit = body.weight_unit === 'lb' ? 'lb' : 'kg';
    if (!Number.isFinite(raw) || raw <= 0) bad.push('weight');
    else {
      const kg = unit === 'lb' ? lbToKg(raw) : Math.round(raw * 100) / 100;
      // Bounds wide enough for every real person and tight enough that a
      // fat-fingered 8400 does not become a resting burn nobody can explain.
      if (kg < 20 || kg > 400) bad.push('weight');
      else weighed = kg;
    }
  }

  if (bad.length) {
    return json(400, { error: 'bad_values', fields: bad, message: `Could not read: ${bad.join(', ')}.` });
  }

  const { error } = await supabase.from('wrought_profile').upsert(patch, { onConflict: 'user_id' });
  if (error) {
    // Name the migration. Every other endpoint here does, and a raw Postgres
    // "column does not exist" sends somebody reading the wrong file.
    const missing = /column .*(display_name|avatar_path).* does not exist/i.test(error.message || '');
    const noCoach = /column .*coach_style.* does not exist/i.test(error.message || '');
    return json(500, {
      error: missing ? 'migration_010_not_run' : noCoach ? 'migration_026_not_run' : 'save_failed',
      message: missing
        ? 'The profile columns are not installed. Run schema/010_wrought_profile_web.sql in Supabase.'
        : noCoach
        ? 'The standing-coach column is not installed. Run schema/026_wrought_coach.sql in Supabase.'
        : error.message,
    });
  }

  if (weighed != null) {
    const p = await getProfile(user.id);
    try {
      await insertEvents(user.id, p, [{
        event_type: 'weight',
        summary: sayWeight(weighed, p.units),
        detail: { value_kg: weighed },
        estimated: false,
      }], { source: 'web' });
    } catch (err) {
      // The profile itself saved. Say which half did not, rather than a flat
      // failure that sends somebody re-entering their height.
      return json(500, { error: 'weight_not_saved', message: `Your details saved, but the weigh-in did not: ${err.message}` });
    }
  }

  return json(200, {
    ok: true,
    weighed_kg: weighed,
    say: weighed != null ? 'Saved, and the weigh-in is on the log.' : 'Saved.',
  });
}

async function putAvatar(user, body) {
  const type = String(body.content_type || '').toLowerCase();
  if (!TYPES[type]) return json(400, { error: 'unsupported_type', message: 'JPEG, PNG, WebP or HEIC.' });

  const bytes = Buffer.from(String(body.avatar || ''), 'base64');
  if (!bytes.length) return json(400, { error: 'empty_file' });
  if (bytes.length > MAX_BYTES) return json(413, { error: 'too_large', message: 'Under 4MB, please.' });

  const path = `${user.id}/avatar-${Date.now()}.${TYPES[type]}`;
  const { error: upErr } = await supabase.storage.from(BUCKET)
    .upload(path, bytes, { contentType: type, upsert: false });
  if (upErr) {
    const missing = /bucket not found|does not exist/i.test(upErr.message || '');
    return json(500, {
      error: missing ? 'bucket_missing' : 'upload_failed',
      message: missing
        ? 'The avatar bucket does not exist. Run schema/010_wrought_profile_web.sql in Supabase.'
        : upErr.message,
    });
  }

  const previous = (await getProfile(user.id)).avatar_path;
  const { error } = await supabase.from('wrought_profile')
    .upsert({ user_id: user.id, avatar_path: path, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) {
    await supabase.storage.from(BUCKET).remove([path]);
    return json(500, { error: error.message });
  }

  // The old file goes AFTER the new one is recorded. The other order leaves a
  // profile pointing at nothing if the write fails.
  if (previous && previous !== path) await supabase.storage.from(BUCKET).remove([previous]);

  const { data } = await supabase.storage.from(BUCKET).createSignedUrl(path, SIGNED_TTL);
  return json(200, { ok: true, avatar_url: data?.signedUrl || null, say: 'Picture updated.' });
}

async function dropAvatar(user) {
  const p = await getProfile(user.id);
  if (p.avatar_path) await supabase.storage.from(BUCKET).remove([p.avatar_path]);
  await supabase.from('wrought_profile')
    .upsert({ user_id: user.id, avatar_path: null, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  return json(200, { ok: true, say: 'Picture removed, file and all.' });
}
