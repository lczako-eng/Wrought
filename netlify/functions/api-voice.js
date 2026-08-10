// netlify/functions/api-voice.js
// The hands-free door.
//
// iOS gives exactly one app a wake word and it is Siri's. Nothing else may
// listen in the background — so a custom "hey gym bro" cannot exist, and
// pretending otherwise would mean an app holding the microphone open, an orange
// dot burning all day, a flat battery and a rejected review. What CAN exist is
// an App Intent: "hey Siri, gym bro" wakes Siri, Siri dictates the sentence,
// and the transcription arrives HERE.
//
// Which means the phone needs a door it can knock on with the screen off, in a
// pocket, without unlocking. Three consequences, all of them load-bearing:
//
//   1. The bearer is the device key from wrought_ingest_keys, the same one the
//      HealthKit courier already holds — because a locked phone cannot run a
//      PKCE dance and cannot show a sign-in sheet. It is in the Keychain with
//      AfterFirstUnlock accessibility, which is precisely what makes a locked
//      dictation work at all.
//   2. Answers are SHORT. Speech cannot be skimmed or re-read; a paragraph read
//      aloud is worse than a sentence. lib/voice.js owns that shape.
//   3. Nothing here parses. There is no model at this end of the wire — the
//      sentence lands verbatim, marked source 'voice', and the connected AI
//      structures it in the next conversation. That keeps the founder's
//      objection answered: no API key is needed for this to work.
//
// This is an addition to the ways in, never a replacement. Nothing about the
// product requires the app, and nothing about the app requires this.

import {
  supabase, hashToken, getProfile, localDateFor, addDays,
  dayFacts, rangeFacts, careFlags, parseLog, insertEvents,
} from './lib/wrought.js';
import { energyBalance, weekSoFar } from './lib/training.js';
import { spokenBrief, spokenLog } from './lib/voice.js';
import { allowed } from './lib/membership.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const reply = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only', spoken: 'That did not go through.' });
  if (!supabase) return reply(500, { error: 'server_not_configured', spoken: 'Wrought is not set up yet.' });

  // Same key, same table, same revocation as /ingest. One credential on the
  // phone rather than two: a second secret is a second thing to leak and a
  // second thing somebody has to re-do when they reinstall.
  const auth = event.headers?.authorization || event.headers?.Authorization || '';
  if (!auth.startsWith('Bearer ')) return reply(401, { error: 'missing_key', spoken: 'Open Wrought once to connect it.' });

  const { data: key } = await supabase.from('wrought_ingest_keys')
    .select('id, user_id, revoked').eq('token_hash', hashToken(auth.slice(7).trim())).maybeSingle();
  if (!key || key.revoked) return reply(401, { error: 'invalid_key', spoken: 'Open Wrought once to reconnect it.' });

  const gate = await allowed(key.user_id, 'api-voice');
  if (!gate.ok) return reply(403, { error: gate.error, spoken: gate.message });

  let body;
  try {
    const raw = event.isBase64Encoded && event.body
      ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body || '{}');
    body = JSON.parse(raw);
  } catch {
    return reply(400, { error: 'invalid_json', spoken: 'That did not go through.' });
  }

  const profile = await getProfile(key.user_id);
  const today = localDateFor(profile.timezone);
  const action = String(body.action || 'brief').toLowerCase();

  try {
    if (action === 'log') {
      const text = String(body.text || '').trim();
      if (!text) return reply(400, { error: 'empty', spoken: 'I did not catch that.' });

      // parseLog falls back to a verbatim note when there is no key, which is
      // exactly the intended path here — not a degraded one.
      const { events, parsed } = await parseLog(text, profile);
      const written = await insertEvents(key.user_id, profile, events, { source: 'voice', rawInput: text });

      await supabase.from('wrought_ingest_keys')
        .update({ last_used_at: new Date().toISOString() }).eq('id', key.id);

      return reply(200, {
        ok: true,
        recorded: written.map(e => ({ id: e.id, type: e.event_type, summary: e.summary })),
        parsed,
        spoken: spokenLog({ written, parsed, text }),
      });
    }

    // The read. Computed here from the same functions the dashboard and the
    // brief use, so a spoken answer can never disagree with a screen.
    const [day, range] = await Promise.all([
      dayFacts(key.user_id, profile, today),
      rangeFacts(key.user_id, profile, addDays(today, -29), today),
    ]);

    let weightKg = day.body.weight_kg;
    if (weightKg == null) {
      const { data } = await supabase.from('wrought_events')
        .select('detail').eq('user_id', key.user_id).eq('event_type', 'weight')
        .order('occurred_at', { ascending: false }).limit(1);
      weightKg = data?.[0]?.detail?.value_kg ?? null;
    }

    const balance = energyBalance({
      profile, weightKg,
      caloriesIn: day.food.calories,
      activeCalories: day.device.active_calories,
      foodEstimated: day.food.estimated,
    });
    const flags = careFlags(range, profile);
    const week  = weekSoFar(range.days, { today, target: profile.train_days });

    await supabase.from('wrought_ingest_keys')
      .update({ last_used_at: new Date().toISOString() }).eq('id', key.id);

    return reply(200, {
      ok: true,
      date: today,
      ...(flags.length ? { care_flags: flags } : {}),
      spoken: spokenBrief({ day, balance, week, flags }),
    });
  } catch (err) {
    // Spoken, because this reply is going straight out of a speaker and a raw
    // stack trace read aloud in a gym helps nobody.
    return reply(500, { error: String(err.message || err), spoken: 'Something went wrong at my end.' });
  }
};
