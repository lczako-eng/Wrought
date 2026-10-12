// test/fakedb/supabase.mjs
// An in-memory stand-in for @supabase/supabase-js — permissive on purpose.
// It implements the query-builder calls the tools make (select, insert,
// upsert with its conflict target, update, delete, the comparison filters,
// not / ilike / contains / overlaps, order, limit, range, single) over plain
// arrays in globalThis.__FAKEDB.tables; any builder method it does not know
// is accepted and ignored, and any table it has never seen is empty. It is
// for running a tool's reply shape end to end in the harness and the
// simulator — never a model of Postgres: no constraints beyond an upsert's
// own conflict target, no RLS, no types.
//
// Sign-ins: `store.users` maps a user id to { id, email } for
// auth.admin.getUserById, and `store.jwts` maps a bearer string to a user for
// auth.getUser — so an OAuth grant row or a session token resolves the way
// the real service would. `store.queries` counts every query run, so the
// simulator can say how many round trips a reply cost.
const store = globalThis.__FAKEDB || (globalThis.__FAKEDB = { tables: {}, seq: 1000 });
store.users ||= {};
store.jwts ||= {};
store.queries ||= 0;
const T = name => (store.tables[name] ||= []);

// The column defaults the schema files declare, applied on insert the way
// Postgres would — a session row written with no status IS active there, and
// a fake that left it null would report bugs the real database never has.
const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const DEFAULTS = {
  wrought_profile: () => ({ timezone: 'America/Toronto', units: 'metric', bluntness: 'honest', push_enabled: true, track: 'general', morning_minute: 0, brief_minute: 0, midday_minute: 0, morning_opens: 'app', updated_at: now() }),
  wrought_events: () => ({ occurred_at: now(), detail: {}, source: 'agent', estimated: false }),
  wrought_goals: () => ({ direction: 'at_least', cadence: 'daily', active: true }),
  wrought_eating_window: () => ({ opens_at: '11:00', closes_at: '19:00', active: true, strictness: 'soft' }),
  wrought_connections: () => ({ mode: 'push', status: 'active' }),
  wrought_ingest_keys: () => ({ label: 'Apple Health', revoked: false }),
  wrought_briefs: () => ({ kind: 'evening', facts: {} }),
  wrought_memory: () => ({ category: 'general', confidence: 0.85, source: 'agent', active: true }),
  wrought_oauth_clients: () => ({ grant_types: ['authorization_code', 'refresh_token'], scope: 'wrought' }),
  wrought_oauth_codes: () => ({ challenge_method: 'S256', used: false }),
  wrought_oauth_tokens: () => ({ scope: 'wrought' }),
  wrought_oauth_refresh: () => ({ scope: 'wrought', revoked: false }),
  wrought_routines: () => ({ kind: 'strength', tier: 'intermediate', exercises: [], times_used: 0, active: true, updated_at: now() }),
  wrought_sessions: () => ({ kind: 'strength', plan: [], cursor_index: 0, status: 'active', started_at: now() }),
  wrought_sets: () => ({ logged_at: now() }),
  wrought_push_subs: () => ({ failures: 0 }),
  wrought_blocks: () => ({ goal: 'general', tier: 'intermediate', plan: {}, status: 'active' }),
  wrought_photos: () => ({ pose: 'front' }),
  wrought_memberships: () => ({ plan: 'free', status: 'active', started_on: today(), updated_at: now() }),
  wrought_codes: () => ({ plan: 'trial', days: 30, max_uses: 1, used_count: 0, active: true }),
  wrought_alerts: () => ({ active: true }),
  wrought_places: () => ({ kind: 'gym', equipment: [], times_used: 0, active: true }),
};
const fresh = (table, p) => ({ id: String(store.seq++), created_at: now(), ...(DEFAULTS[table] ? DEFAULTS[table]() : {}), ...p });

// The schema's unique indexes, enforced the way Postgres does: a NULL in any
// column never conflicts, a partial index only covers the rows its WHERE
// admits, and a violation rejects the whole statement with 23505. Without
// them, a retry the real database refuses would land twice here and look
// like a bug — and code that never handles 23505 would never be caught.
const low = v => (typeof v === 'string' ? v.toLowerCase() : v);
const UNIQUE = {
  wrought_events: [{ cols: ['user_id', 'source', 'source_ref'] }],
  wrought_metrics: [{ cols: ['user_id', 'source', 'metric', 'measured_at'] }],
  wrought_connections: [{ cols: ['user_id', 'provider'] }],
  wrought_briefs: [{ cols: ['user_id', 'local_date', 'kind'] }],
  wrought_routines: [{ cols: ['user_id', 'name'], lower: ['name'], where: r => r.active !== false }],
  wrought_sessions: [{ cols: ['user_id'], where: r => r.status === 'active' }],
  wrought_push_subs: [{ cols: ['endpoint'] }],
  wrought_blocks: [{ cols: ['user_id'], where: r => r.status === 'active' }],
  wrought_photos: [{ cols: ['user_id', 'local_date', 'pose'] }],
  wrought_alerts: [{ cols: ['user_id', 'kind'], where: r => r.active !== false && r.kind !== 'custom' }],
  wrought_places: [{ cols: ['user_id', 'name'], lower: ['name'], where: r => r.active !== false }],
  wrought_sets: [{ cols: ['user_id', 'client_id'] }],
  wrought_profile: [{ cols: ['user_id'] }],
};
function violation(table, row, rows, except = null) {
  for (const ix of UNIQUE[table] || []) {
    if (ix.cols.some(c => row[c] == null)) continue;
    if (ix.where && !ix.where(row)) continue;
    const key = r => ix.cols.map(c => ((ix.lower || []).includes(c) ? low(r[c]) : r[c]));
    const k = JSON.stringify(key(row));
    if (rows.some(r => r !== except && !ix.cols.some(c => r[c] == null) && (!ix.where || ix.where(r)) && JSON.stringify(key(r)) === k)) {
      return { message: `duplicate key value violates unique constraint "${table}_${ix.cols.join('_')}"`, code: '23505' };
    }
  }
  return null;
}

const likeRe = p => new RegExp('^' + String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
const listOf = v => (Array.isArray(v) ? v : typeof v === 'string' ? v.replace(/^\(|\)$/g, '').split(',').map(s => s.trim().replace(/^"|"$/g, '')) : []);

function builder(table) {
  const st = { op: 'select', filters: [], order: [], limit: null, offset: 0, single: null, payload: null, head: false, conflict: null, ignoreDup: false };
  const run = () => {
    store.queries += 1;
    const rows = T(table);
    const match = r => st.filters.every(f => f(r));
    let data = null;
    if (st.op === 'insert') {
      const ins = st.payload.map(p => fresh(table, p));
      for (let i = 0; i < ins.length; i++) {
        const v = violation(table, ins[i], [...rows, ...ins.slice(0, i)]);
        if (v) return { data: null, error: v };
      }
      rows.push(...ins);
      data = ins;
    } else if (st.op === 'upsert') {
      // The conflict target decides which existing row a payload replaces;
      // with none named, the primary key does, as in Postgres.
      const keys = (st.conflict || 'id').split(',').map(s => s.trim());
      data = [];
      for (const p of st.payload) {
        const hit = keys.every(k => p[k] !== undefined) ? rows.find(r => keys.every(k => String(r[k]) === String(p[k]))) : null;
        if (hit) {
          if (st.ignoreDup) continue;
          Object.assign(hit, p);
          data.push(hit);
        } else {
          const row = fresh(table, p);
          const v = violation(table, row, rows);
          if (v) return { data: null, error: v };
          rows.push(row);
          data.push(row);
        }
      }
    } else if (st.op === 'update') {
      data = rows.filter(match);
      for (const r of data) {
        const v = violation(table, { ...r, ...st.payload }, rows, r);
        if (v) return { data: null, error: v };
      }
      data.forEach(r => Object.assign(r, st.payload));
    } else if (st.op === 'delete') {
      data = rows.filter(match);
      store.tables[table] = rows.filter(r => !match(r));
    } else {
      data = rows.filter(match);
      for (const [c, asc] of st.order.slice().reverse()) {
        data = data.slice().sort((a, b) => {
          const x = a[c], y = b[c];
          if (x == null && y == null) return 0;
          if (x == null) return asc ? -1 : 1;
          if (y == null) return asc ? 1 : -1;
          return (x > y ? 1 : x < y ? -1 : 0) * (asc ? 1 : -1);
        });
      }
      if (st.offset) data = data.slice(st.offset);
      if (st.limit != null) data = data.slice(0, st.limit);
    }
    let copy = JSON.parse(JSON.stringify(data));
    if (st.cols && Array.isArray(copy)) copy = copy.map(r => Object.fromEntries(st.cols.map(([alias, col]) => [alias, r[col] === undefined ? null : r[col]])));
    if (st.single === 'single') return { data: copy[0] ?? null, error: copy.length ? null : { message: 'no rows', code: 'PGRST116' } };
    if (st.single === 'maybe') return { data: copy[0] ?? null, error: null };
    return { data: st.head ? null : copy, error: null, count: copy.length };
  };
  const add = f => { st.filters.push(f); return proxy; };
  const api = {
    select(cols, opts = {}) {
      if (opts && opts.head) st.head = true;
      // A plain column list is honoured, as PostgREST does: code that reads a
      // column it never selected gets undefined here exactly as it would live.
      if (typeof cols === 'string' && cols.trim() && cols.trim() !== '*' && !/[()]/.test(cols)) {
        st.cols = cols.split(',').map(c => c.trim()).filter(Boolean).map(c => (c.includes(':') ? c.split(':') : [c, c]));
      }
      return proxy;
    },
    insert(p) { st.op = 'insert'; st.payload = Array.isArray(p) ? p : [p]; return proxy; },
    upsert(p, opts = {}) { st.op = 'upsert'; st.payload = Array.isArray(p) ? p : [p]; st.conflict = opts.onConflict || null; st.ignoreDup = !!opts.ignoreDuplicates; return proxy; },
    update(p) { st.op = 'update'; st.payload = p; return proxy; },
    delete() { st.op = 'delete'; return proxy; },
    eq: (c, v) => add(r => String(r[c]) === String(v)),
    neq: (c, v) => add(r => String(r[c]) !== String(v)),
    in: (c, a) => { const s = new Set((a || []).map(String)); return add(r => s.has(String(r[c]))); },
    gte: (c, v) => add(r => r[c] != null && r[c] >= v),
    lte: (c, v) => add(r => r[c] != null && r[c] <= v),
    gt: (c, v) => add(r => r[c] != null && r[c] > v),
    lt: (c, v) => add(r => r[c] != null && r[c] < v),
    is: (c, v) => add(r => (v === null ? r[c] == null : r[c] === v)),
    not(c, op, v) {
      if (op === 'is') return add(r => (v === null ? r[c] != null : r[c] !== v));
      if (op === 'in') { const s = new Set(listOf(v).map(String)); return add(r => !s.has(String(r[c]))); }
      if (op === 'eq') return add(r => String(r[c]) !== String(v));
      return proxy;
    },
    ilike: (c, p) => { const re = likeRe(p); return add(r => re.test(String(r[c] ?? ''))); },
    like: (c, p) => { const re = likeRe(p); return add(r => re.test(String(r[c] ?? ''))); },
    contains: (c, v) => add(r => {
      const x = r[c];
      if (Array.isArray(v)) return Array.isArray(x) && v.every(i => x.includes(i));
      if (v && typeof v === 'object') return x && typeof x === 'object' && Object.entries(v).every(([k, y]) => JSON.stringify(x[k]) === JSON.stringify(y));
      return false;
    }),
    overlaps: (c, v) => add(r => Array.isArray(r[c]) && listOf(v).some(i => r[c].includes(i))),
    order(c, o = {}) { st.order.push([c, o.ascending !== false]); return proxy; },
    limit(n) { st.limit = n; return proxy; },
    range(a, b) { st.offset = a; st.limit = b - a + 1; return proxy; },
    single() { st.single = 'single'; return proxy; },
    maybeSingle() { st.single = 'maybe'; return proxy; },
    then(res, rej) { try { return Promise.resolve(run()).then(res, rej); } catch (e) { return Promise.reject(e).then(res, rej); } },
  };
  const proxy = new Proxy(api, { get(t, k) { if (k in t) return t[k]; if (typeof k === 'symbol') return undefined; return () => proxy; } });
  return proxy;
}

export function createClient() {
  const admin = new Proxy({
    getUserById: async (id) => (store.users[id] ? { data: { user: JSON.parse(JSON.stringify(store.users[id])) }, error: null } : { data: { user: null }, error: { message: 'User not found', status: 404 } }),
    listUsers: async () => ({ data: { users: JSON.parse(JSON.stringify(Object.values(store.users))) }, error: null }),
    deleteUser: async (id) => { delete store.users[id]; return { data: {}, error: null }; },
  }, { get: (t, k) => (k in t ? t[k] : (k === 'mfa' ? { listFactors: async () => ({ data: { factors: [] }, error: null }) } : async () => ({ data: { user: null, factors: [] }, error: null }))) });
  return {
    from: t => builder(t),
    rpc: async () => ({ data: null, error: null }),
    auth: {
      admin,
      getUser: async (token) => (store.jwts[token] ? { data: { user: JSON.parse(JSON.stringify(store.jwts[token])) }, error: null } : { data: { user: null }, error: { message: 'no session', status: 401 } }),
    },
    storage: new Proxy({}, { get: () => () => new Proxy({}, { get: () => async () => ({ data: null, error: null }) }) }),
  };
}
export default { createClient };
