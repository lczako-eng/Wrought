// scripts/seed-style-routines.mjs
// Emits idempotent SQL that seeds the twenty-one written sessions from
// lib/style_routines.js into one account's saved workouts. Run with the
// account's email; paste the output into the Supabase SQL editor (or apply
// through the connector). Re-running skips any name already on file.
//
//   node scripts/seed-style-routines.mjs you@example.com > seed.sql
import { STYLE_ROUTINES } from '../netlify/functions/lib/style_routines.js';
import { normaliseMovement } from '../netlify/functions/lib/training.js';

const email = process.argv[2];
if (!email) { console.error('usage: node scripts/seed-style-routines.mjs <email>'); process.exit(1); }
const q = s => "'" + String(s).replace(/'/g, "''") + "'";

for (const r of Object.values(STYLE_ROUTINES)) {
  const ex = JSON.stringify(r.exercises.map(e => normaliseMovement(e)));
  console.log(`insert into public.wrought_routines (user_id, name, kind, tier, exercises, equipment, est_minutes, notes)
select u.id, ${q(r.name)}, ${q(r.kind)}, ${q(r.tier)}, ${q(ex)}::jsonb, array[${r.equipment.map(q).join(',')}]::text[], ${r.est_minutes}, ${q(r.notes)}
from auth.users u where u.email = ${q(email)}
  and not exists (select 1 from public.wrought_routines x where x.user_id = u.id and x.active and lower(x.name) = lower(${q(r.name)}));`);
}
