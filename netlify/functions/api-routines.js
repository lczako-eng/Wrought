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
import { normaliseMovement } from './lib/training.js';
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

// ONE normaliser, shared with the save_routine tool — so a routine built on
// the website and one built by talking are indistinguishable afterwards, and
// a fixed classification bug is fixed at both doors at once.
//
// Loads pass THROUGH but cannot enter here: the Add box offers no load field,
// which is the doctrine (a weight typed into a plan is a guess with a text
// box around it) — but a load already stored by the tool must survive an
// unrelated edit, because "a save never silently deletes" applies to fields
// exactly as it applies to movements.
const shape = normaliseMovement;

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
    return (data || []).map(r => ({
      ...r,
      exercises: (r.exercises || []).map(shape),
      sets: (r.exercises || []).reduce((a, e) => a + (Number(e.sets) || 0), 0),
    }));
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
      exercises: (Array.isArray(body.exercises) ? body.exercises : []).map(shape).filter(e => e.name),
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
    const e = shape(body.exercise || {});
    if (!e.name) return bad(400, 'name_required', 'Name the movement.');
    // Same rule as the tool: a matching name updates in place rather than
    // creating a second row for the same lift.
    const list0 = (row.exercises || []).map(shape);
    const at = list0.findIndex(x => x.name.toLowerCase() === e.name.toLowerCase());
    const next = at >= 0 ? list0.map((x, i) => (i === at ? { ...x, ...e } : x)) : [...list0, e];
    const { error } = await supabase.from('wrought_routines')
      .update({ exercises: next, updated_at: new Date().toISOString() }).eq('id', row.id);
    if (error) return bad(400, error.message);
    return ok({ routines: await list() });
  }

  if (action === 'remove') {
    const at = Number(body.index);
    const list0 = (row.exercises || []).map(shape);
    if (!Number.isInteger(at) || at < 0 || at >= list0.length) return bad(400, 'bad_index');
    const next = list0.filter((_, i) => i !== at);
    const { error } = await supabase.from('wrought_routines')
      .update({ exercises: next, updated_at: new Date().toISOString() }).eq('id', row.id);
    if (error) return bad(400, error.message);
    return ok({ routines: await list(), removed: list0[at].name });
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
