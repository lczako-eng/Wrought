// netlify/functions/api-export.js
// Everything, out, in one call.
//
// A hub you cannot leave is not a hub, it is a trap. The whole pitch here is
// "give us years of your life and we will remember it" — and the only thing
// that makes that a reasonable thing to ask is being able to take all of it
// back, any day, without asking anybody.
//
// So this is deliberately complete rather than convenient: every event, every
// set, every metric, every routine, every brief. Not a summary, not a report —
// the actual rows, in a shape another program can read.
//
// It is also the honest answer to the lock-in question, and it costs almost
// nothing to provide. Products that will not do this are telling you something.
//
//   GET /api/export              → JSON, everything
//   GET /api/export?format=csv   → a zip-less bundle of CSV sections
//   GET /api/export?table=sets   → one table, when that is all you wanted

import {
  getAuthUser, getProfile, localDateFor, supabase,
} from './lib/wrought.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
};

const TABLES = {
  events:   { table: 'wrought_events',   order: 'occurred_at' },
  sets:     { table: 'wrought_sets',     order: 'logged_at' },
  metrics:  { table: 'wrought_metrics',  order: 'measured_at' },
  sessions: { table: 'wrought_sessions', order: 'started_at' },
  routines: { table: 'wrought_routines', order: 'created_at' },
  goals:    { table: 'wrought_goals',    order: 'created_at' },
  memory:   { table: 'wrought_memory',   order: 'created_at' },
  briefs:   { table: 'wrought_briefs',   order: 'local_date' },
};

// Supabase caps a single select; a few years of a wearable pushing hourly is
// well past it, so everything pages until it runs dry.
async function fetchAll(table, order, userId) {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; from < 200000; from += PAGE) {
    const { data, error } = await supabase.from(table)
      .select('*').eq('user_id', userId)
      .order(order, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

// RFC 4180: quote anything containing a comma, quote or newline, and double up
// internal quotes. Objects become JSON in a cell rather than being flattened,
// because losing the structure would make the export lossy.
function csvCell(v) {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = [...rows.reduce((set, r) => {
    Object.keys(r).forEach(k => set.add(k));
    return set;
  }, new Set())];
  return [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n');
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!supabase) {
    return { statusCode: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
             body: JSON.stringify({ error: 'server_not_configured' }) };
  }

  const user = await getAuthUser(event);
  if (!user) {
    return { statusCode: 401, headers: { ...CORS, 'Content-Type': 'application/json' },
             body: JSON.stringify({ error: 'sign_in_required' }) };
  }

  const q = event.queryStringParameters || {};
  const wanted = q.table && TABLES[q.table] ? [q.table] : Object.keys(TABLES);
  const profile = await getProfile(user.id);
  const stamp = localDateFor(profile.timezone);

  const data = {};
  for (const name of wanted) {
    const { table, order } = TABLES[name];
    try { data[name] = await fetchAll(table, order, user.id); }
    catch { data[name] = []; }        // a missing table must not sink the export
  }

  // Tokens are never exported. forge_oauth_* and the ingest keys are
  // deliberately absent — they are credentials, not records, and the hashes
  // would be useless to the user and dangerous in a downloads folder.

  if (q.format === 'csv') {
    const sections = wanted.map(name =>
      `# ${name} (${data[name].length} rows)\n${toCsv(data[name])}`).join('\n\n\n');
    return {
      statusCode: 200,
      headers: {
        ...CORS,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="wrought-${stamp}.csv"`,
      },
      body: sections,
    };
  }

  return {
    statusCode: 200,
    headers: {
      ...CORS,
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="wrought-${stamp}.json"`,
    },
    body: JSON.stringify({
      exported_at: new Date().toISOString(),
      local_date: stamp,
      profile: {
        timezone: profile.timezone, units: profile.units,
        height_cm: profile.height_cm, birth_year: profile.birth_year,
        training_age: profile.training_age, equipment: profile.equipment,
        dietary: profile.dietary, bluntness: profile.bluntness,
      },
      counts: Object.fromEntries(wanted.map(k => [k, data[k].length])),
      note: 'Everything Wrought holds about you, minus credentials. Yours to take anywhere, any day, without asking.',
      ...data,
    }, null, 2),
  };
};
