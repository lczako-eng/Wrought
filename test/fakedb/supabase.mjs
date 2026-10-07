// test/fakedb/supabase.mjs
// An in-memory stand-in for @supabase/supabase-js — permissive on purpose.
// It implements the query-builder calls the tools make (select, insert,
// update, delete, the comparison filters, order, limit, single) over plain
// arrays in globalThis.__FAKEDB.tables; any builder method it does not know
// is accepted and ignored, and any table it has never seen is empty. It is
// for running a tool's reply shape end to end in the harness — never a model
// of Postgres: no constraints, no RLS, no types.
const store = globalThis.__FAKEDB || (globalThis.__FAKEDB = { tables: {}, seq: 1000 });
const T = name => (store.tables[name] ||= []);

function builder(table) {
  const st = { op: 'select', filters: [], order: [], limit: null, single: null, payload: null };
  const run = () => {
    const rows = T(table);
    const match = r => st.filters.every(f => f(r));
    let data = null;
    if (st.op === 'insert' || st.op === 'upsert') {
      const ins = st.payload.map(p => ({ id: String(store.seq++), created_at: new Date().toISOString(), ...p }));
      rows.push(...ins);
      data = ins;
    } else if (st.op === 'update') {
      data = rows.filter(match);
      data.forEach(r => Object.assign(r, st.payload));
    } else if (st.op === 'delete') {
      data = rows.filter(match);
      store.tables[table] = rows.filter(r => !match(r));
    } else {
      data = rows.filter(match);
      for (const [c, asc] of st.order.slice().reverse()) {
        data = data.slice().sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
      }
      if (st.limit != null) data = data.slice(0, st.limit);
    }
    const copy = JSON.parse(JSON.stringify(data));
    if (st.single === 'single') return { data: copy[0] ?? null, error: copy.length ? null : { message: 'no rows' } };
    if (st.single === 'maybe') return { data: copy[0] ?? null, error: null };
    return { data: copy, error: null, count: copy.length };
  };
  const add = f => { st.filters.push(f); return proxy; };
  const api = {
    select() { return proxy; },
    insert(p) { st.op = 'insert'; st.payload = Array.isArray(p) ? p : [p]; return proxy; },
    upsert(p) { st.op = 'upsert'; st.payload = Array.isArray(p) ? p : [p]; return proxy; },
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
    order(c, o = {}) { st.order.push([c, o.ascending !== false]); return proxy; },
    limit(n) { st.limit = n; return proxy; },
    range(a, b) { st.limit = b - a + 1; return proxy; },
    single() { st.single = 'single'; return proxy; },
    maybeSingle() { st.single = 'maybe'; return proxy; },
    then(res, rej) { try { return Promise.resolve(run()).then(res, rej); } catch (e) { return Promise.reject(e).then(res, rej); } },
  };
  const proxy = new Proxy(api, { get(t, k) { if (k in t) return t[k]; if (typeof k === 'symbol') return undefined; return () => proxy; } });
  return proxy;
}

export function createClient() {
  const quiet = new Proxy({}, { get: () => async () => ({ data: { user: null, factors: [] }, error: null }) });
  return {
    from: t => builder(t),
    rpc: async () => ({ data: null, error: null }),
    auth: { admin: quiet, getUser: async () => ({ data: { user: null }, error: { message: 'no session' } }) },
    storage: new Proxy({}, { get: () => () => new Proxy({}, { get: () => async () => ({ data: null, error: null }) }) }),
  };
}
export default { createClient };
