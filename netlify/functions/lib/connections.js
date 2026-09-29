// netlify/functions/lib/connections.js
// Which connections reach this record, computed — never guessed.
//
// 27 September, 11:58pm. The founder said a McDouble and 150g of Hickory
// Sticks; ChatGPT read Wrought through one of its three connections, got a
// perfectly good reply, and then answered "Wrought is showing three
// identically named connections, and I couldn't verify which is your active
// account. I haven't logged them yet." The third time that exact refusal had
// reached him. The host's own rule was doing it: with two or more connected
// accounts ChatGPT puts an account picker (link_id) on every tool and asks
// before a write whenever the intended account is "not clear from the user's
// request or conversation".
//
// The server can make it clear, and only the server can: the ChatGPT connector
// is ONE registered client, and whether every live connection on it signs in
// to one Wrought record is a question about two tables. So it is answered on
// every call, in the reply the model reads — the one surface that reaches
// ChatGPT without a Refresh — and it weakens the moment the evidence does.
//
// Pure functions, plus I/O that always takes the database as a parameter, so
// the harness runs every branch against an in-memory table. This file does not
// import lib/wrought.js, so there is no import cycle.

import { createHash } from 'node:crypto';

export const ACCESS_TTL_MS    = 30 * 86_400_000;   // = oauth-token.js ACCESS_TTL_SECONDS * 1000 (pinned by test)
export const REFRESH_TTL_MS   = 365 * 86_400_000;  // = oauth-token.js REFRESH_TTL_SECONDS * 1000
// wrought_oauth_gc keeps expired access rows seven days, and ChatGPT renews
// lazily — the founder's two renewals landed 1.5h and 3.3h after expiry — so a
// connection whose access token lapsed yesterday is still one ChatGPT holds.
export const IN_USE_GRACE_MS  = 7 * 86_400_000;
export const FACTS_TIMEOUT_MS = 1200;
export const FACTS_CACHE_MS   = 30_000;
// A client's own registration is written once and never edited, so what it
// says about itself — its redirect address, and so whether it is ChatGPT's —
// is remembered far longer than the proof built on it. Its PEERS are not:
// a second registration can appear at any time, and a proof that did not see
// it would say "nobody else" about a connector somebody else just joined.
export const TOPOLOGY_CACHE_MS = 10 * 60_000;
// There is deliberately NO profile nickname here. "Same Wrought record on
// every connection" was true when ChatGPT read it and false the day a second
// account signed in through the same connector — and ChatGPT keeps the label
// it read, so the one sentence hiding a fork would be the server's own. The
// identical profile id already lets ChatGPT match the connections.

/**
 * The opaque profile id ChatGPT's account list matches connections by. Here
 * rather than in mcp.js so the reply block and the profile tool can never
 * carry two different ids for one person.
 */
export function profileIdFor(userId) {
  return createHash('sha256').update(`wrought-profile:${userId}`).digest('hex').slice(0, 32);
}

/**
 * Which grant a call came through, attached to the user WITHOUT becoming part
 * of it: non-enumerable, so JSON.stringify(user) and {...user} never carry it
 * into a reply, a log line or a row. Five characters of the token's hash — the
 * same prefix the server logs read — never the hash itself.
 */
export function withVia(user, row, hash) {
  if (!user || typeof user !== 'object') return user;
  Object.defineProperty(user, 'via', {
    value: Object.freeze({ kind: 'oauth', client_id: row?.client_id || null, grant: String(hash || '').slice(0, 5) }),
    enumerable: false,
    // Configurable so a second call on one object redefines rather than
    // throws — inside getAuthUser a throw is a 503 on every call.
    configurable: true,
  });
  return user;
}

/** The value, or null on a rejection or when it takes longer than `ms`. */
export function within(promise, ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    Promise.resolve(promise).then(
      v => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

/**
 * THE CONNECTIONS CHATGPT ACTUALLY HOLDS — pure.
 *
 * A sign-in is a refresh chain: every renewal revokes the old refresh row and
 * issues a new pair in the same instant. So a chain is a live, unrevoked
 * refresh row, and it is IN USE when an access token on the same client was
 * issued in that same instant and has not been gone for longer than the grace.
 * The instant is read off the lifetimes the token endpoint stamps (expiry
 * minus TTL), never off created_at, which is the database's clock rather than
 * the endpoint's and drifts by a few hundred milliseconds between the rows.
 *
 * The founder's account on 28 September: nine unrevoked refresh rows, three in
 * use. Counting the nine said "signed in 9 separate times" beside a ChatGPT
 * holding three.
 */
export function chainsInUse({ tokens = [], refresh = [], now = Date.now(), graceMs = IN_USE_GRACE_MS } = {}) {
  const out = [];
  for (const r of (refresh || [])) {
    if (!r || r.revoked === true) continue;
    const rExp = Date.parse(r.expires_at);
    if (!(rExp > now)) continue;
    const issued = rExp - REFRESH_TTL_MS;
    const t = (tokens || []).find(x => x && x.client_id === r.client_id &&
      Math.abs((Date.parse(x.expires_at) - ACCESS_TTL_MS) - issued) < 1000 &&
      Date.parse(x.expires_at) > now - graceMs);
    if (!t) continue;
    out.push({
      client_id: r.client_id || null,
      issued_at: new Date(issued).toISOString(),
      access_live: Date.parse(t.expires_at) > now,
    });
  }
  return out;
}

// Per container: client id → { at, value: { uris, chatgpt } }.
const topoCache = new Map();

/**
 * WHAT A CLIENT SAYS ABOUT ITSELF — read-only, never throws, remembered ten
 * minutes. One query, and after the first call none: for a client that is not
 * ChatGPT's and sent no account picker, this is the whole cost of the check.
 *
 * @returns {{ uris: string[], chatgpt: boolean } | null}
 */
export async function connectorTopology(db, clientId, { timeoutMs = FACTS_TIMEOUT_MS } = {}) {
  const hit = topoCache.get(clientId);
  if (hit && Date.now() - hit.at < TOPOLOGY_CACHE_MS) return hit.value;
  try {
    const { data: client, error } = await db.from('wrought_oauth_clients')
      .select('redirect_uris').eq('client_id', clientId).abortSignal(AbortSignal.timeout(timeoutMs)).maybeSingle();
    if (error) return null;
    const uris = Array.isArray(client?.redirect_uris) ? client.redirect_uris.filter(Boolean) : [];
    const value = { uris, chatgpt: /openai|chatgpt/i.test(uris.join(' ')) };
    topoCache.set(clientId, { at: Date.now(), value });
    return value;
  } catch {
    return null;
  }
}

/** What is already known about a client, never a query — for a reply the proof missed. */
export function knownTopology(clientId) {
  const hit = clientId ? topoCache.get(clientId) : null;
  return hit && Date.now() - hit.at < TOPOLOGY_CACHE_MS ? hit.value : null;
}

/**
 * THE PROOF — read-only, bounded, never throws.
 *
 * The unit is the CONNECTOR, read fresh on every proof. One record is proven only
 * when nobody else holds a live grant on any of its clients; the foreign
 * probes ask for a single client_id and nothing else, so a stranger's id,
 * email or number never enters this process.
 *
 * @returns {{ client_ids: string[], chatgpt: boolean, in_use: number, one_record: true|false|null } | null}
 *   null when the caller's own rows could not be read. one_record is false
 *   when anybody else is signed in, null when that could not be checked.
 */
export async function connectorProof(db, userId, clientId, { now = Date.now(), timeoutMs = FACTS_TIMEOUT_MS, topology = null } = {}) {
  try {
    const sig = () => AbortSignal.timeout(timeoutMs);
    const nowIso = new Date(now).toISOString();
    const topo = topology || await connectorTopology(db, clientId, { timeoutMs });
    if (!topo) return null;
    const { uris, chatgpt } = topo;

    // The connector: every registered client sharing this one's redirect
    // address (a ChatGPT plugin's connections share one registration; the
    // trace logs the client, so a split would show). Read fresh every proof.
    let ids = [clientId];
    if (uris.length) {
      const { data: peers, error: pErr } = await db.from('wrought_oauth_clients')
        .select('client_id').overlaps('redirect_uris', uris).abortSignal(sig());
      if (pErr) return null;
      ids = [...new Set([clientId, ...(peers || []).map(p => p?.client_id).filter(Boolean)])];
    }

    // A probe that rejects outright is read as the error it is, never as an
    // empty answer and never as the whole check failing for the wrong reason.
    const settle = q => Promise.resolve(q).then(r => r, e => ({ data: null, error: e || new Error('failed') }));
    const [mineTok, mineRef, otherTok, otherRef] = await Promise.all([
      db.from('wrought_oauth_tokens').select('client_id, expires_at')
        .eq('user_id', userId).in('client_id', ids)
        .gt('expires_at', new Date(now - IN_USE_GRACE_MS).toISOString()).abortSignal(sig()),
      db.from('wrought_oauth_refresh').select('client_id, expires_at')
        .eq('user_id', userId).in('client_id', ids).eq('revoked', false)
        .gt('expires_at', nowIso).abortSignal(sig()),
      db.from('wrought_oauth_tokens').select('client_id')
        .in('client_id', ids).neq('user_id', userId).gt('expires_at', nowIso).limit(1).abortSignal(sig()),
      db.from('wrought_oauth_refresh').select('client_id')
        .in('client_id', ids).neq('user_id', userId).eq('revoked', false)
        .gt('expires_at', nowIso).limit(1).abortSignal(sig()),
    ].map(settle));
    if (!mineTok || !mineRef || mineTok.error || mineRef.error) return null;

    const in_use = chainsInUse({ tokens: mineTok.data || [], refresh: mineRef.data || [], now }).length;
    // A query that failed is never read as "nobody else": only two probes
    // that ran and came back empty prove one record.
    const foreign = (otherTok?.data?.length || 0) + (otherRef?.data?.length || 0);
    const one_record = foreign > 0 ? false
      : (!otherTok || !otherRef || otherTok.error || otherRef.error) ? null
      : true;
    return { client_ids: ids, chatgpt, in_use, one_record };
  } catch {
    return null;
  }
}

// Per container. A foreign sign-in inside the last thirty seconds reads as not
// yet seen — the one staleness this accepts, for no round trip at all on most
// calls rather than three.
const factsCache = new Map();
export function _resetConnectionFacts() { factsCache.clear(); topoCache.clear(); }

/**
 * What the reply says about this call's connection, or null — for a session
 * JWT (the website), no database, or a lookup that failed or took longer than
 * FACTS_TIMEOUT_MS with nothing known about the connector.
 *
 * Only a PROOF is cached — one_record true or false. A check that could not
 * finish is never remembered, so one database blink costs one reply the
 * strong form, not thirty seconds of them. When the check fails on a
 * connector already known to be ChatGPT's, the answer says so with the count
 * unknown, so the reply still names this record rather than going silent.
 *
 * A client that is not ChatGPT's and sent no account picker stops after the
 * topology: nothing it could be told would be shown.
 */
export async function connectionFacts(db, user, opts = {}) {
  if (!db || user?.via?.kind !== 'oauth' || !user.via.client_id) return null;
  const clientId = user.via.client_id;
  const key = `${user.id}|${clientId}`;
  const hit = factsCache.get(key);
  if (hit && Date.now() - hit.at < FACTS_CACHE_MS) return hit.value;

  const timeoutMs = opts.timeoutMs ?? FACTS_TIMEOUT_MS;
  const base = { profile_id: profileIdFor(user.id), record: user.email || null };
  const run = async () => {
    const topo = await connectorTopology(db, clientId, { timeoutMs });
    if (!topo) return null;
    if (!topo.chatgpt && !opts.linkId) return { ...base, in_use: null, one_record: null, chatgpt: false };
    const proof = await connectorProof(db, user.id, clientId, { ...opts, timeoutMs, topology: topo });
    if (!proof) return { ...base, in_use: null, one_record: null, chatgpt: topo.chatgpt };
    return { ...base, in_use: proof.in_use, one_record: proof.one_record, chatgpt: proof.chatgpt };
  };
  let value = await within(run(), timeoutMs);
  if (!value) {
    const known = knownTopology(clientId);
    return known?.chatgpt ? { ...base, in_use: null, one_record: null, chatgpt: true } : null;
  }
  if (value.one_record === true || value.one_record === false) factsCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * THE LINE THAT MAKES THE ACCOUNT CLEAR — pure.
 *
 * Built when ChatGPT sent an account picker with the call, or when the server
 * can see this connector holds two or more connections. Never a count: a count
 * goes stale the moment the founder disconnects the extras, and a stale number
 * read back to him is exactly the doubt this line exists to end. The strong
 * form ("the intended account is clear") rides only on a proof; everything
 * else names this record and says a different email is a different account.
 */
export function connectedAccountsBlock(user, facts, { linkId = false } = {}) {
  if (!user) return null;
  // A ChatGPT connector whose count could not be read still gets the line:
  // only one KNOWN to hold a single connection has nothing to settle.
  const several = facts?.chatgpt && (facts.in_use == null || facts.in_use >= 2);
  if (!(linkId || several)) return null;
  const pid = profileIdFor(user.id);
  const email = user.email || null;
  const label = email || `profile id ${pid}`;
  if (facts?.one_record === true) {
    return {
      one_record: true, record: email, profile_id: pid,
      fact: `Checked on the server in the last thirty seconds: every connection signed in through this Wrought connector writes to one Wrought record, ${label}, and no other Wrought account is signed in through it.`,
      note: 'So every connected Wrought account (link_id) offered here is this same record, and the intended account is clear: a write still owed goes through the link_id this reply came from, ONE time in total — never once per connection — without asking which. A write this reply already confirms is done: never repeat it.',
    };
  }
  return {
    one_record: null, record: email, profile_id: pid,
    fact: `This connection writes to the Wrought record ${label}${email ? ` (profile id ${pid})` : ''}.`,
    note: `A connected Wrought account showing ${email ? 'that email or ' : ''}profile id ${pid} is this same record: a write still owed goes through the link_id this reply came from, one time in total, never once per connection. One showing a different email is a different Wrought account: use the one matching the account they use at wrought.fit, and name it in half a clause on the first write. A write this reply already confirms is done: never repeat it.`,
  };
}

/** The block as the reply's FIRST key, never over one a tool wrote itself. */
export function stampConnected(out, block) {
  if (!block || !out || typeof out !== 'object' || Array.isArray(out)) return out;
  if (out.connected_accounts !== undefined) return out;
  return { connected_accounts: block, ...out };
}

/**
 * What the Account panel says when one assistant holds more than one
 * connection — pure. Counted from connections IN USE and said as what
 * WROUGHT has seen, never as what ChatGPT holds: ChatGPT's disconnect never
 * reaches this server, so a connection removed there keeps counting here
 * until its access token lapses and the grace runs out — up to about five
 * weeks. A count stated as ChatGPT's present fact would tell him to do again,
 * for a month, the thing he has just done. Names the one path he can see:
 * Settings → Plugins → Wrought → Connection. Never "delete two Wroughts":
 * there is one Wrought there, and uninstalling it is how the day gets lost.
 */
export function copiesNote({ name, inUse, oneRecord, email } = {}) {
  if (!(inUse >= 2)) return null;
  const who = name || 'An assistant';
  const label = email || 'this account';
  const lapse = 'One you disconnect there keeps counting here until it lapses — up to about five weeks — so if that page already lists one account, you are done.';
  if (oneRecord === true && /chatgpt/i.test(who)) {
    return `Wrought has seen ${inUse} ChatGPT connections in use recently, and every one signs in to this record (${label}); no other Wrought account is signed in through it, so they are identical and any one is the right one to keep. While ChatGPT holds more than one, it may stop to ask which account before a log. To stop that: in ChatGPT open Settings → Plugins → Wrought → Connection, keep one account and disconnect the others, then choose Refresh on that page. ${lapse} Never uninstall Wrought or use Connect another account. Until then nothing is lost: each one logs here. Disconnect below signs every connection out at once.`;
  }
  const chatgpt = /chatgpt/i.test(who);
  return `Wrought has seen ${inUse} ${chatgpt ? 'ChatGPT ' : name ? `${name} ` : ''}connections in use recently, signed in to this record (${label}). Any other Wrought showing there is a separate sign-in this page cannot see — ask it "what account am I on" to check it logs here. To tidy up: ${chatgpt ? `in ChatGPT open Settings → Plugins → Wrought → Connection, keep the one signed in as ${label} and disconnect the rest, then choose Refresh on that page. ${lapse}` : 'remove the extras in its own settings and keep one.'} Disconnect below signs every connection out at once.`;
}
