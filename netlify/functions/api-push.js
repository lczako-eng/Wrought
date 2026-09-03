// netlify/functions/api-push.js
// Registering a phone for the nightly read, and taking it off again.
//
// GET    → the VAPID public key, plus whether this account has any devices on.
//          The public key is public by definition; the browser needs it before
//          it can even ask for permission.
// POST   → store a subscription. Idempotent on endpoint, so re-subscribing on
//          the same phone updates rather than adding a second one.
// DELETE → remove one. A person turning notifications off must not have to
//          fight the product about it.

import { supabase, getAuthUser, getProfile } from './lib/wrought.js';
import { vapidPublicKey, vapidConfigured, sendPush } from './lib/push.js';
import { describeAlert } from './lib/alerts.js';
import { buildBriefFor, buildMiddayFor, buildMorningFor, eveningMessage } from './brief-nightly.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!supabase) return json(500, { error: 'server_not_configured' });

  const user = await getAuthUser(event);
  if (!user) return json(401, { error: 'sign_in_required' });

  // ── What can this account do right now ──
  if (event.httpMethod === 'GET') {
    const { data: subs } = await supabase.from('wrought_push_subs')
      .select('id, label, created_at, last_sent_at, failures').eq('user_id', user.id);
    const { data: prof } = await supabase.from('wrought_profile')
      .select('brief_hour, brief_minute, push_enabled, morning_hour, morning_minute, morning_sent_on, midday_hour, midday_minute, midday_sent_on, morning_opens')
      .eq('user_id', user.id).maybeSingle()
      .then(r => (r.error ? { data: null } : r), () => ({ data: null }));
    const { data: briefRows } = await supabase.from('wrought_briefs')
      .select('local_date, kind, facts').eq('user_id', user.id)
      .in('kind', ['morning', 'midday', 'evening'])
      .order('local_date', { ascending: false }).limit(12);
    // Tolerated rather than required: without migration 018 there are simply
    // no rules to show, and the notifications screen must not break for it.
    const { data: alertRows } = await supabase.from('wrought_alerts')
      .select('id, kind, at_hour, threshold, text, days, active, metric')
      .eq('user_id', user.id).eq('active', true)
      .order('created_at', { ascending: true });

    return json(200, {
      configured: vapidConfigured(),
      vapid_public_key: vapidPublicKey(),
      devices: (subs || []).map(s => ({
        id: s.id, label: s.label, added: s.created_at, last_sent: s.last_sent_at,
        failures: s.failures || 0,
      })),
      brief_hour: prof?.brief_hour ?? 20,
      brief_minute: prof?.brief_minute ?? 0,
      morning_hour: prof?.morning_hour ?? null,
      morning_minute: prof?.morning_minute ?? 0,
      midday_hour: prof?.midday_hour ?? null,
      midday_minute: prof?.midday_minute ?? 0,
      morning_opens: prof?.morning_opens || 'app',
      push_enabled: prof?.push_enabled !== false,
      checkins: checkinStatus(prof, briefRows || []),
      // The rules somebody set by TALKING, readable and switchable off from
      // the website too. Being able to see what is going to be sent, and stop
      // it in one tap, is the safety valve on the whole channel: somebody who
      // cannot find the off switch mutes the app instead, and a muted app
      // never comes back on. Read through the same describeAlert the tools
      // use, so the screen and the assistant cannot word a rule differently.
      alerts: (alertRows || []).map(describeAlert).filter(Boolean),
      note: vapidConfigured()
        ? null
        : 'Push keys are not set on this deploy. Run scripts/vapid.mjs and set WROUGHT_VAPID_PUBLIC and WROUGHT_VAPID_PRIVATE.',
    });
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad_json' }); }

  if (event.httpMethod === 'POST') {
    // A test send, so somebody can find out the notification works now rather
    // than at 22:00 tonight when it is too late to fix.
    if (body.test) {
      const { data: subs } = await supabase.from('wrought_push_subs')
        .select('endpoint, p256dh, auth').eq('user_id', user.id);
      if (!subs?.length) return json(400, { error: 'no_devices', message: 'No phone is registered yet.' });

      let message;
      let label = 'test';
      if (['morning', 'midday', 'evening'].includes(body.test)) {
        const profile = await getProfile(user.id);
        const built = body.test === 'morning'
          ? await buildMorningFor(user.id, profile)
          : body.test === 'midday'
            ? await buildMiddayFor(user.id, profile)
            : await buildBriefFor(user.id);
        message = body.test === 'evening' ? eveningMessage(built, profile.morning_opens) : built?.message;
        label = body.test;
        if (!message?.body) {
          return json(400, { error: 'nothing_to_preview', message: `There is not enough on the record for a ${label} brief yet.` });
        }
        message = { ...message, tag: `wrought-preview-${label}` };
      } else {
        message = {
          title: 'WROUGHT',
          body: 'Notifications are working. Your daily check-ins will arrive like this.',
          tag: 'wrought-test',
          url: '/app.html',
        };
      }

      const results = await Promise.all(subs.map(s => sendPush(s, message)));
      const sent = results.filter(r => r.ok).length;
      await dropGone(user.id, subs, results);
      return json(200, {
        sent, tried: subs.length,
        say: sent ? `Sent today's ${label} to ${sent} device${sent === 1 ? '' : 's'}.` : 'Could not deliver to any device.',
        detail: results.map(r => ({ status: r.status, reason: r.reason || null })),
      });
    }

    // Settings, not a subscription.
    const settings = ['brief_hour', 'brief_minute', 'morning_hour', 'morning_minute',
      'midday_hour', 'midday_minute', 'morning_opens', 'push_enabled'];
    if (settings.some(k => body[k] !== undefined)) {
      const patch = { user_id: user.id };
      for (const key of ['brief_hour', 'morning_hour', 'midday_hour']) {
        if (body[key] === undefined) continue;
        if (body[key] === null) {
          if (key !== 'brief_hour') { patch[key] = null; continue; }
          return json(400, { error: 'bad_hour', field: key });
        }
        const h = Number(body[key]);
        if (!Number.isInteger(h) || h < 0 || h > 23) return json(400, { error: 'bad_hour', field: key });
        patch[key] = h;
      }
      for (const key of ['brief_minute', 'morning_minute', 'midday_minute']) {
        if (body[key] === undefined) continue;
        const m = Number(body[key]);
        if (m !== 0 && m !== 30) return json(400, { error: 'bad_minute', field: key });
        patch[key] = m;
      }
      if (body.morning_opens !== undefined) {
        if (!['app', 'chatgpt', 'claude'].includes(body.morning_opens)) {
          return json(400, { error: 'bad_destination' });
        }
        patch.morning_opens = body.morning_opens;
      }
      if (body.push_enabled !== undefined) patch.push_enabled = !!body.push_enabled;
      const { error } = await supabase.from('wrought_profile').upsert(patch, { onConflict: 'user_id' });
      if (error) return json(500, { error: error.message });
      return json(200, { ok: true, ...patch, say: 'Saved.' });
    }

    const { endpoint, keys, label } = body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return json(400, { error: 'bad_subscription', message: 'endpoint, keys.p256dh and keys.auth are all required.' });
    }

    const { error } = await supabase.from('wrought_push_subs').upsert({
      user_id: user.id,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      label: label || null,
      failures: 0,
    }, { onConflict: 'endpoint' });

    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, say: 'This phone will get your daily check-ins.' });
  }

  if (event.httpMethod === 'DELETE' && body.alert_id) {
    // Off is one tap and never a question. Same doctrine as dropping a goal:
    // a reminder somebody wants gone was set wrong, and asking them to justify
    // it is how the whole channel gets muted instead of one rule.
    const { error } = await supabase.from('wrought_alerts')
      .update({ active: false }).eq('user_id', user.id).eq('id', String(body.alert_id));
    if (error) return json(500, { error: 'not_stopped', say: error.message });
    return json(200, { ok: true, stopped: body.alert_id });
  }

  if (event.httpMethod === 'DELETE') {
    const q = supabase.from('wrought_push_subs').delete().eq('user_id', user.id);
    // Scoped to the caller either way, so a guessed id cannot unregister
    // somebody else's phone.
    const { error } = body.endpoint ? await q.eq('endpoint', body.endpoint)
      : body.id ? await q.eq('id', body.id)
      : await q;
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, say: 'Removed.' });
  }

  return json(405, { error: 'method_not_allowed' });
};

function checkinStatus(profile, rows) {
  const latest = {};
  for (const row of rows || []) {
    if (!latest[row.kind]) latest[row.kind] = row;
  }
  const time = (hour, minute = 0) => hour == null
    ? null
    : `${String(hour).padStart(2, '0')}:${String(minute || 0).padStart(2, '0')}`;
  const build = (kind, hour, minute, legacySent = null) => {
    const row = latest[kind];
    const delivered = row?.facts?._delivery?.push || null;
    return {
      kind,
      time: time(hour, minute),
      destination: profile?.morning_opens || 'app',
      last_sent_on: delivered?.sent_on || legacySent || null,
      last_sent_at: delivered?.sent_at || null,
      last_message: delivered ? { title: delivered.title, body: delivered.body, url: delivered.url } : null,
    };
  };
  return [
    build('morning', profile?.morning_hour, profile?.morning_minute, profile?.morning_sent_on),
    build('midday', profile?.midday_hour, profile?.midday_minute, profile?.midday_sent_on),
    build('evening', profile?.brief_hour ?? 20, profile?.brief_minute),
  ];
}

// A subscription the browser has thrown away — uninstalled, permission revoked,
// data cleared — is gone for good. Retrying it nightly forever is how a send
// job gets slower every month for no reason.
async function dropGone(userId, subs, results) {
  const dead = subs.filter((_, i) => results[i]?.gone).map(s => s.endpoint);
  if (!dead.length) return;
  await supabase.from('wrought_push_subs').delete().eq('user_id', userId).in('endpoint', dead);
}
