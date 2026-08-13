// netlify/functions/api-routines.js
// Saved workouts, editable from the website.
//
// The founder: "in each workout it should have a slider like you can delete it
// or a button to add — make it stylish like the orange, but you could slide it
// like an iPhone on and off... I can create it both on there and on AI."
//
// Both doors, and that is the point rather than a convenience. Building a
// routine by talking is the fast way and it is how most of them will get made;
// but a routine is a LIST, and a list is the one thing a screen is genuinely
// better at than a conversation. Taking one movement out of the middle by
// voice means naming it exactly and hoping; on a screen it is a tap. Neither
// door is the real one — they write the same rows.
//
// THE RULES THAT MATTER HERE:
//
// - A SAVE NEVER SILENTLY DELETES, same as the tool. Every write here is an
//   explicit, named action: add one, remove one, rename, retire. There is no
//   path that replaces the exercise list as a side effect of something else.
// - RETIRING IS NOT DELETING. `active: false` keeps the routine and its
//   history — what somebody used to run is part of the record, exactly like a
//   retired goal. Only an explicit delete removes the row.
// - NO LOADS. A routine has never carried a working weight and must not start
//   here: loads come from `progressionCall` against real history, or as an
//   effort. A weight typed into a plan is a guess with a text box around it.

import { getAuthUser, supabase } from './lib/wrought.js';
import { normaliseMovement, readMovement } from './lib/training.js';
import { allowed } from './lib/membership.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const ok  = body => ({ statusCode: 200, headers: CORS, body: JSON.stringify(body) });
const bad = (code, error, say) => ({ statusCode: code, headers: CORS, body: JSON.stringify({ error, say }) });

// READ and WRITE are deliberately different functions, and conflating them was
// a real bug: `readMovement` retires the old 3×8 default on TIMED movements so
// the screen does not show a rep scheme nobody chose — but running that on the
// way IN rewrites the stored data of anybody who genuinely programmed a
// treadmill as intervals, as a side effect of adding an unrelated movement.
// The judgement belongs on the way out only.
//
// Loads pass THROUGH but cannot enter here: the Add box offers no load field,
// which is the doctrine (a weight typed into a plan is a guess with a text box
// around it) — but a load already stored by the tool survives, because "a save
// never silently deletes" applies to FIELDS exactly as it applies to movements.

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!supabase) return bad(500, 'server_not_configured');

  const user = await getAuthUser(event);
  if (!user) return bad(401, 'sign_in_required');

  const gate = await allowed(user.id, 'api-routines');
  if (!gate.ok) return { statusCode: 402, headers: CORS, body: JSON.stringify(gate) };

  const list = async () => {
    const { data } = await supabase.from('wrought_routines')
      .select('id, name, kind, tier, exercises, notes, est_minutes, times_used, last_used_on, active')
      .eq('user_id', user.id)
      .order('active', { ascending: false })
      .order('last_used_on', { ascending: false, nullsFirst: false });
    // THE COUNT IS OF WHAT IS SHOWN. Counting the RAW rows while displaying
    // the read shape made the badge and the list disagree about the same
    // routine: an incline treadmill walk stored with the old 3×8 default
    // renders as "—" (readMovement retires the artifact) and was still being
    // counted as three sets, so a workout showing one 3×8 movement claimed six
    // sets. A number on a screen that contradicts the rows underneath it is
    // worse than no number — it makes somebody doubt the rows.
    return (data || []).map(r => {
      const shown = (r.exercises || []).map(readMovement);
      return {
        ...r,
        exercises: shown,
        // Only what is actually IN the session. A movement taken out still
        // shows on the list — that is the whole point of taking it out rather
        // than deleting it — but counting its sets would make the badge
        // promise work nobody is going to do.
        sets: shown.filter(e => !e.off).reduce((a, e) => a + (Number(e.sets) || 0), 0),
        off_count: shown.filter(e => e.off).length,
      };
    });
  };

  if (event.httpMethod === 'GET') return ok({ routines: await list() });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return bad(400, 'bad_json'); }
  const action = String(body.action || '');

  // Everything below writes, so every path names the routine it is touching
  // and nothing operates on "the current one".
  const id = body.id ? String(body.id) : null;
  const load = async () => {
    if (!id) return null;
    const { data } = await supabase.from('wrought_routines')
      .select('*').eq('id', id).eq('user_id', user.id).maybeSingle();
    return data;
  };

  if (action === 'create') {
    const name = String(body.name || '').trim();
    if (!name) return bad(400, 'name_required', 'Give it a name first.');
    const { error } = await supabase.from('wrought_routines').insert([{
      user_id: user.id, name: name.slice(0, 120),
      kind: body.kind || 'strength',
      tier: body.tier || 'intermediate',
      exercises: (Array.isArray(body.exercises) ? body.exercises : []).map(e => normaliseMovement(e)).filter(e => e.name),
      notes: body.notes ? String(body.notes).slice(0, 4000) : null,
      est_minutes: Number(body.est_minutes) || null,
      active: true,
    }]);
    if (error) return bad(400, error.message);
    return ok({ routines: await list(), say: `Saved "${name}".` });
  }

  const row = await load();
  if (!row) return bad(404, 'not_found', 'That workout is not on file.');

  if (action === 'add') {
    const name = String(body.exercise?.name || '').trim();
    if (!name) return bad(400, 'name_required', 'Name the movement.');

    // STORED MOVEMENTS ARE NEVER RE-SHAPED. They are written back exactly as
    // they were read, so adding calf raises cannot rewrite the treadmill.
    const list0 = Array.isArray(row.exercises) ? row.exercises : [];
    const at = list0.findIndex(x => String(x.name || '').toLowerCase() === name.toLowerCase());

    // A matching name updates IN PLACE and only in the fields supplied — a
    // fully-defaulted object spread over a stored movement blanks its minutes,
    // detail, cue and load for the sake of changing its reps.
    const next = at >= 0
      ? list0.map((x, i) => (i === at ? { ...x, ...normaliseMovement(body.exercise, { partial: true }) } : x))
      : [...list0, normaliseMovement(body.exercise)];
    const { error } = await supabase.from('wrought_routines')
      .update({ exercises: next, updated_at: new Date().toISOString() }).eq('id', row.id);
    if (error) return bad(400, error.message);
    return ok({ routines: await list() });
  }

  // IN OR OUT OF THE WORKOUT — the reversible half of removing.
  //
  // "Give me the ability to swipe the ones I want on the workout or not, so add
  // and remove as need be." Sliding a movement away used to DELETE it, which
  // makes the gesture something to be careful with — and a gesture people are
  // careful with is one they stop using. This keeps the row, its detail, its
  // cue and its place in the order, and simply takes it out of the session.
  // Sliding the other way puts it back.
  //
  // Retire-then-delete, one level down from the routine switch, and for the
  // same reason: what somebody used to run is part of the record.
  if (action === 'bench') {
    const at = Number(body.index);
    const list0 = Array.isArray(row.exercises) ? row.exercises : [];
    if (!Number.isInteger(at) || at < 0 || at >= list0.length) return bad(400, 'bad_index');
    const next = list0.map((e, i) => (i === at ? { ...e, off: !e.off } : e));
    const { error } = await supabase.from('wrought_routines')
      .update({ exercises: next, updated_at: new Date().toISOString() }).eq('id', row.id);
    if (error) return bad(400, error.message);
    return ok({ routines: await list(), off: !!next[at].off, moved: next[at].name || 'that movement' });
  }

  if (action === 'remove') {
    const at = Number(body.index);
    // Raw, again: taking one movement out must not rewrite the others.
    const list0 = Array.isArray(row.exercises) ? row.exercises : [];
    if (!Number.isInteger(at) || at < 0 || at >= list0.length) return bad(400, 'bad_index');
    const next = list0.filter((_, i) => i !== at);
    const { error } = await supabase.from('wrought_routines')
      .update({ exercises: next, updated_at: new Date().toISOString() }).eq('id', row.id);
    if (error) return bad(400, error.message);
    return ok({ routines: await list(), removed: list0[at].name || 'that movement' });
  }

  if (action === 'update') {
    const patch = { updated_at: new Date().toISOString() };
    if (body.name != null)  patch.name = String(body.name).trim().slice(0, 120);
    if (body.notes != null) patch.notes = String(body.notes).slice(0, 4000) || null;
    if (body.kind != null)  patch.kind = body.kind;
    if (body.est_minutes !== undefined) patch.est_minutes = Number(body.est_minutes) || null;
    if (!patch.name && body.name != null) return bad(400, 'name_required', 'A workout needs a name.');
    const { error } = await supabase.from('wrought_routines').update(patch).eq('id', row.id);
    if (error) return bad(400, error.message);
    return ok({ routines: await list() });
  }

  // THE SLIDER. Retiring keeps the routine and everything it has been used
  // for — what somebody used to run is part of the record, the same reasoning
  // as a retired goal. It just stops being offered.
  if (action === 'toggle') {
    const { error } = await supabase.from('wrought_routines')
      .update({ active: !row.active, updated_at: new Date().toISOString() }).eq('id', row.id);
    if (error) return bad(400, error.message);
    return ok({ routines: await list(), active: !row.active });
  }

  if (action === 'delete') {
    const { error } = await supabase.from('wrought_routines').delete().eq('id', row.id);
    if (error) return bad(400, error.message);
    return ok({ routines: await list(), deleted: row.name });
  }

  return bad(400, 'unknown_action', 'Nothing to do.');
};
