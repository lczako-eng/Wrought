// netlify/functions/lib/places.js
// Where somebody trains, as a record.
//
// The founder: "when you're doing a workout — you could do it manually as
// well, like 'I'm going for a walk at the park'. But if there's a new gym and
// it recognises that you're working out somewhere else, it should add a new
// gym. Some of that coach should be ready in there, because I've added a few
// gyms already."
//
// He had added them — to ChatGPT, which said it saved them and wrote nothing.
// The memory table on his account holds zero gyms. Free text in memory is a
// place the model has to parse back each time and a save nobody can check;
// this is one row per place with a kind and a kit list, referenced by name
// from sessions and workouts.
//
// THREE RULES:
//   - A PLACE MENTIONED IS A PLACE RECORDED. "at the park", "at GoodLife on
//     Main", "the hotel gym" — the first time a name is said it becomes a row.
//     Nobody opens a settings screen to add a gym.
//   - A NEW GYM IS ASKED FOR ITS KIT ONCE, in one clause, and never blocks
//     the session. Until the kit is known the session is built for the main
//     gym's equipment and SAYS so — building blind is the failure the founder
//     named ("never build a plan around a machine the photos did not show").
//   - AN OUTDOOR PLACE IS NEVER ASKED FOR KIT. The park has no rack. A walk
//     at the park is a workout with a place, full stop.

import { supabase } from './wrought.js';

export const PLACE_KINDS = ['gym', 'home', 'outdoor', 'travel', 'other'];

const OUTDOOR = /\b(park|trail|track|beach|street|road|outside|outdoors|field|pitch|lake|river|woods|forest|hill|mountain|neighbou?rhood|block|loop|path)\b/i;
const HOME = /\b(home|house|garage|basement|spare room|flat|apartment|backyard|back yard|garden)\b/i;
const TRAVEL = /\b(hotel|motel|resort|cruise|airbnb|cottage|cabin|holiday|vacation|work gym|office gym)\b/i;

/** What kind of place a name describes. Pure. */
export function kindFor(name) {
  const s = String(name || '');
  if (TRAVEL.test(s)) return 'travel';
  if (HOME.test(s)) return 'home';
  if (OUTDOOR.test(s)) return 'outdoor';
  return 'gym';
}

/** "at the park", "at GoodLife", "in the garage" → the place. Pure. Null when
 *  the words name no place. */
export function placeFromWords(text) {
  const s = String(text || '');
  const m = s.match(/\b(?:at|in|down|around|round)\s+(?:the\s+)?([A-Z][\w'&.-]*(?:\s+[A-Z][\w'&.-]*){0,3}|park|trail|track|beach|gym|garage|basement|hotel gym|home gym|home|house|pool|field|pitch|woods|lake)\b/);
  if (!m) return null;
  return cleanName(m[1]);
}

export function cleanName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').replace(/^(the|a|my)\s+/i, '').slice(0, 80);
}

function same(a, b) {
  const x = cleanName(a).toLowerCase(), y = cleanName(b).toLowerCase();
  return x === y || (x.length > 3 && y.includes(x)) || (y.length > 3 && x.includes(y));
}

// A door must be correct before the SQL runs. Probed once per container;
// without 024 every reader answers empty and every writer reports it.
let _hasPlaces = null;
export async function placesCanBeStored() {
  if (_hasPlaces !== null) return _hasPlaces;
  const { error } = await supabase.from('wrought_places').select('id').limit(1);
  _hasPlaces = !error;
  return _hasPlaces;
}
let _hasSessionPlace = null;
export async function sessionsCanCarryPlace() {
  if (_hasSessionPlace !== null) return _hasSessionPlace;
  const { error } = await supabase.from('wrought_sessions').select('place').limit(1);
  _hasSessionPlace = !error;
  return _hasSessionPlace;
}
export function _resetPlaceProbes(v = null) { _hasPlaces = v; _hasSessionPlace = v; }

export async function listPlaces(userId) {
  if (!await placesCanBeStored()) return [];
  const { data } = await supabase.from('wrought_places')
    .select('id, name, kind, equipment, notes, times_used, last_used_on')
    .eq('user_id', userId).eq('active', true)
    .order('last_used_on', { ascending: false, nullsFirst: false });
  return data || [];
}

/**
 * Find the place a name refers to, or create it.
 * Returns { place, created, ask_kit, say } — or { unavailable: true } without 024.
 * `equipment`, when given, is written onto the place (new or existing).
 */
export async function resolvePlace(userId, name, { equipment = null, kind = null, notes = null } = {}) {
  const clean = cleanName(name);
  if (!clean) return null;
  if (!await placesCanBeStored()) return { unavailable: true, name: clean };

  const all = await listPlaces(userId);
  let place = all.find(p => same(p.name, clean)) || null;
  let created = false;

  const kit = Array.isArray(equipment)
    ? equipment.map(x => String(x).trim().toLowerCase().slice(0, 60)).filter(Boolean).slice(0, 40)
    : typeof equipment === 'string' && equipment.trim()
      ? equipment.split(/,|;|\band\b/).map(x => x.trim().toLowerCase()).filter(Boolean).slice(0, 40)
      : null;

  if (!place) {
    const k = PLACE_KINDS.includes(kind) ? kind : kindFor(clean);
    const row = { user_id: userId, name: clean, kind: k, equipment: kit || [], notes: notes || null };
    const { data, error } = await supabase.from('wrought_places').insert([row]).select('id, name, kind, equipment, notes, times_used, last_used_on').single();
    if (error) return { error: error.message, name: clean };
    place = data; created = true;
  } else if (kit || (kind && PLACE_KINDS.includes(kind)) || notes) {
    const patch = {};
    if (kit) patch.equipment = kit;
    if (kind && PLACE_KINDS.includes(kind)) patch.kind = kind;
    if (notes) patch.notes = notes;
    const { data } = await supabase.from('wrought_places').update(patch).eq('id', place.id)
      .select('id, name, kind, equipment, notes, times_used, last_used_on').single();
    if (data) place = data;
  }

  // A gym with no kit on file is asked ONCE, in one clause. An outdoor place
  // never is — the park has no rack.
  const needsKit = ['gym', 'home', 'travel'].includes(place.kind) && !(place.equipment || []).length;
  return {
    place, created, ask_kit: needsKit,
    say: created
      ? `${place.name} added as a ${place.kind === 'outdoor' ? 'place' : place.kind}${needsKit ? ' — what have they got there?' : ''}.`
      : `At ${place.name}.`,
  };
}

/** The equipment a session at this place should be built for. */
export function placeEquipment(place, profile = {}) {
  if (!place) return profile.equipment || null;
  if (place.kind === 'outdoor') return ['bodyweight only'];
  if ((place.equipment || []).length) return place.equipment;
  return profile.equipment || null;
}

export async function bumpPlace(placeId, today) {
  if (!placeId || !await placesCanBeStored()) return;
  const { data } = await supabase.from('wrought_places').select('times_used').eq('id', placeId).maybeSingle();
  await supabase.from('wrought_places')
    .update({ times_used: (data?.times_used || 0) + 1, last_used_on: today })
    .eq('id', placeId);
}

/**
 * Move a `place` named on a client event into its detail, creating the place
 * on the way. The stray top-level key is removed so insertEvents never sees a
 * field it does not store. Returns the places touched, for the reply.
 */
export async function applyPlaces(userId, events = [], today = null) {
  const touched = [];
  for (const e of events) {
    if (!e || e.place == null) continue;
    const name = e.place; delete e.place;
    if (e.event_type !== 'workout') continue;
    const r = await resolvePlace(userId, name);
    e.detail = { ...(e.detail || {}), place: r?.place?.name || cleanName(name) };
    if (r?.place) { touched.push(r); if (today) await bumpPlace(r.place.id, today); }
  }
  return touched;
}
