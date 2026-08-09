// netlify/functions/lib/pull.js
// The direct cloud APIs — Withings, Strava, Oura, Whoop, Fitbit.
//
// These are a FIDELITY UPGRADE, never the entry price. Apple Health and Health
// Connect already pick up dozens of apps on day one with no partnerships and no
// keys, and that stays the answer to "how do I connect my watch". This is for
// the handful worth pulling at higher resolution, and for the one case the two
// doors genuinely cannot serve: a scale that reports itself.
//
// WITHINGS FIRST, and the ordering is not arbitrary. Bodyweight is the number
// people most reliably stop logging by hand — it is the one measurement that
// requires standing somewhere specific at a specific time — so a scale that
// reports itself removes the most-abandoned manual entry in the product. Strava
// second, because it is the best-documented API in the category and the only
// one giving per-split pace rather than a daily total.
//
// Every provider here needs an OAuth app registered by the operator. Nothing in
// this file works without those credentials, and each one says so by name
// rather than failing with a generic error — see connectUrl().

const env = k => process.env[k] || null;

// Each provider is four things: where to send the user, where to swap the code,
// what to fetch, and how to turn its answer into our metric rows. Anything
// provider-specific lives here so ingest and the sync function stay generic.
export const PULL = {
  withings: {
    name: 'Withings',
    authorize: 'https://account.withings.com/oauth2_user/authorize2',
    token: 'https://wbsapi.withings.net/v2/oauth2',
    scope: 'user.metrics',
    idEnv: 'WITHINGS_CLIENT_ID',
    secretEnv: 'WITHINGS_CLIENT_SECRET',
    // Withings puts the OAuth action in the body rather than using the standard
    // grant shape, which is the sort of thing that costs an afternoon.
    tokenBody: ({ code, redirect, id, secret }) => new URLSearchParams({
      action: 'requesttoken', grant_type: 'authorization_code',
      client_id: id, client_secret: secret, code, redirect_uri: redirect,
    }),
    refreshBody: ({ token, id, secret }) => new URLSearchParams({
      action: 'requesttoken', grant_type: 'refresh_token',
      client_id: id, client_secret: secret, refresh_token: token,
    }),
    readToken: j => (j.body || j),
  },
  strava: {
    name: 'Strava',
    authorize: 'https://www.strava.com/oauth/authorize',
    token: 'https://www.strava.com/oauth/token',
    scope: 'read,activity:read_all',
    idEnv: 'STRAVA_CLIENT_ID',
    secretEnv: 'STRAVA_CLIENT_SECRET',
    tokenBody: ({ code, redirect, id, secret }) => new URLSearchParams({
      client_id: id, client_secret: secret, code, grant_type: 'authorization_code', redirect_uri: redirect,
    }),
    refreshBody: ({ token, id, secret }) => new URLSearchParams({
      client_id: id, client_secret: secret, refresh_token: token, grant_type: 'refresh_token',
    }),
    readToken: j => j,
  },
  oura: {
    name: 'Oura',
    authorize: 'https://cloud.ouraring.com/oauth/authorize',
    token: 'https://api.ouraring.com/oauth/token',
    scope: 'daily heartrate workout personal',
    idEnv: 'OURA_CLIENT_ID',
    secretEnv: 'OURA_CLIENT_SECRET',
    tokenBody: ({ code, redirect, id, secret }) => new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: id, client_secret: secret,
    }),
    refreshBody: ({ token, id, secret }) => new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: token, client_id: id, client_secret: secret,
    }),
    readToken: j => j,
  },
  whoop: {
    name: 'Whoop',
    authorize: 'https://api.prod.whoop.com/oauth/oauth2/auth',
    token: 'https://api.prod.whoop.com/oauth/oauth2/token',
    scope: 'read:recovery read:sleep read:workout read:profile offline',
    idEnv: 'WHOOP_CLIENT_ID',
    secretEnv: 'WHOOP_CLIENT_SECRET',
    tokenBody: ({ code, redirect, id, secret }) => new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: id, client_secret: secret,
    }),
    refreshBody: ({ token, id, secret }) => new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: token, client_id: id, client_secret: secret,
      scope: 'offline',
    }),
    readToken: j => j,
  },
  fitbit: {
    name: 'Fitbit',
    authorize: 'https://www.fitbit.com/oauth2/authorize',
    token: 'https://api.fitbit.com/oauth2/token',
    scope: 'activity heartrate sleep weight profile',
    idEnv: 'FITBIT_CLIENT_ID',
    secretEnv: 'FITBIT_CLIENT_SECRET',
    // Fitbit wants the client pair in a Basic header rather than the body.
    basicAuth: true,
    tokenBody: ({ code, redirect, id }) => new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: id,
    }),
    refreshBody: ({ token }) => new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: token,
    }),
    readToken: j => j,
  },
};

export const PULL_PROVIDERS = Object.keys(PULL);

export function credentialsFor(provider) {
  const p = PULL[provider];
  if (!p) return null;
  const id = env(p.idEnv), secret = env(p.secretEnv);
  return id && secret ? { id, secret } : null;
}

export function redirectUri(provider, site) {
  return `${String(site || '').replace(/\/$/, '')}/api/device/callback?provider=${provider}`;
}

// Where to send somebody to say yes. Returns a reason rather than a URL when the
// operator has not registered the app — "not configured" pointing at the exact
// environment variable beats a redirect into somebody else's error page.
export function connectUrl(provider, { site, state }) {
  const p = PULL[provider];
  if (!p) return { error: 'unknown_provider' };
  const creds = credentialsFor(provider);
  if (!creds) {
    return {
      error: 'not_configured',
      message: `${p.name} is not registered yet. Set ${p.idEnv} and ${p.secretEnv} once the OAuth app exists.`,
    };
  }
  const u = new URL(p.authorize);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', creds.id);
  u.searchParams.set('redirect_uri', redirectUri(provider, site));
  u.searchParams.set('scope', p.scope);
  u.searchParams.set('state', state);
  return { url: u.toString() };
}

async function tokenCall(provider, body) {
  const p = PULL[provider];
  const creds = credentialsFor(provider);
  if (!creds) return { error: 'not_configured' };

  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (p.basicAuth) {
    headers.Authorization = `Basic ${Buffer.from(`${creds.id}:${creds.secret}`).toString('base64')}`;
  }

  const res = await fetch(p.token, { method: 'POST', headers, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { error: 'token_exchange_failed', detail: json.error_description || json.error || res.status };

  const t = p.readToken(json) || {};
  if (!t.access_token) return { error: 'no_access_token', detail: json };

  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token || null,
    // Strava returns an absolute expiry, everybody else a duration. Normalising
    // here means the refresh logic does not have to know which is which.
    expires_at: t.expires_at
      ? new Date(Number(t.expires_at) * 1000).toISOString()
      : new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000).toISOString(),
    scope: t.scope || null,
    external_id: t.userid || t.user_id || t.athlete?.id || null,
  };
}

export function exchangeCode(provider, { code, site }) {
  const p = PULL[provider];
  const creds = credentialsFor(provider);
  if (!p || !creds) return Promise.resolve({ error: 'not_configured' });
  return tokenCall(provider, p.tokenBody({
    code, redirect: redirectUri(provider, site), id: creds.id, secret: creds.secret,
  }));
}

export function refreshToken(provider, token) {
  const p = PULL[provider];
  const creds = credentialsFor(provider);
  if (!p || !creds) return Promise.resolve({ error: 'not_configured' });
  return tokenCall(provider, p.refreshBody({ token, id: creds.id, secret: creds.secret }));
}

// ── Reading the data ────────────────────────────────────────────────────────
// Each fetcher returns rows in the SAME shape /ingest already understands, so
// nothing downstream has to learn a fifth vocabulary and the dedupe indexes do
// their job without a special case.
//
//   { metric, value, unit, measured_at, source, source_ref }

const day = d => new Date(d).toISOString().slice(0, 10);

export async function fetchMetrics(provider, accessToken, { since }) {
  const get = async (url, headers = {}) => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, ...headers } });
    if (!res.ok) throw new Error(`${provider} ${res.status}`);
    return res.json();
  };

  if (provider === 'withings') {
    // meastype 1 = weight in kg, 6 = fat ratio. The API answers in value×10^unit
    // rather than a plain number, and forgetting that is a 71kg person weighing
    // seventy-one thousand.
    const body = new URLSearchParams({ action: 'getmeas', meastypes: '1,6', category: '1',
      startdate: String(Math.floor(new Date(since).getTime() / 1000)) });
    const res = await fetch('https://wbsapi.withings.net/measure', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const j = await res.json();
    const groups = j?.body?.measuregrps || [];
    return groups.flatMap(g => (g.measures || []).map(m => {
      const value = Number(m.value) * Math.pow(10, Number(m.unit));
      const metric = m.type === 1 ? 'weight_kg' : m.type === 6 ? 'body_fat_pct' : null;
      if (!metric) return null;
      return {
        metric, value: Math.round(value * 100) / 100,
        unit: metric === 'weight_kg' ? 'kg' : '%',
        measured_at: new Date(g.date * 1000).toISOString(),
        source: 'withings', source_ref: `withings:${g.grpid}:${m.type}`,
      };
    }).filter(Boolean));
  }

  if (provider === 'oura') {
    const [sleep, activity] = await Promise.all([
      get(`https://api.ouraring.com/v2/usercollection/daily_sleep?start_date=${day(since)}`),
      get(`https://api.ouraring.com/v2/usercollection/daily_activity?start_date=${day(since)}`),
    ]);
    const rows = [];
    for (const d of (sleep.data || [])) {
      if (d.contributors?.total_sleep != null && d.timestamp) {
        rows.push({ metric: 'sleep_score', value: d.score, unit: 'score',
          measured_at: d.timestamp, source: 'oura', source_ref: `oura:sleep:${d.day}` });
      }
    }
    for (const d of (activity.data || [])) {
      if (d.steps != null) {
        rows.push({ metric: 'steps', value: d.steps, unit: 'count',
          measured_at: d.timestamp, source: 'oura', source_ref: `oura:steps:${d.day}` });
      }
      if (d.active_calories != null) {
        rows.push({ metric: 'active_calories', value: d.active_calories, unit: 'kcal',
          measured_at: d.timestamp, source: 'oura', source_ref: `oura:active:${d.day}` });
      }
    }
    return rows;
  }

  if (provider === 'fitbit') {
    const d0 = day(since), d1 = day(Date.now());
    const [steps, weight] = await Promise.all([
      get(`https://api.fitbit.com/1/user/-/activities/steps/date/${d0}/${d1}.json`),
      get(`https://api.fitbit.com/1/body/log/weight/date/${d0}/${d1}.json`).catch(() => ({})),
    ]);
    const rows = (steps['activities-steps'] || []).map(x => ({
      metric: 'steps', value: Number(x.value), unit: 'count',
      measured_at: `${x.dateTime}T12:00:00Z`, source: 'fitbit', source_ref: `fitbit:steps:${x.dateTime}`,
    }));
    for (const w of (weight.weight || [])) {
      rows.push({ metric: 'weight_kg', value: Number(w.weight), unit: 'kg',
        measured_at: `${w.date}T${w.time || '12:00:00'}Z`, source: 'fitbit', source_ref: `fitbit:weight:${w.logId}` });
    }
    return rows;
  }

  if (provider === 'whoop') {
    const j = await get(`https://api.prod.whoop.com/developer/v1/recovery?start=${new Date(since).toISOString()}`);
    return (j.records || []).flatMap(r => {
      const s = r.score || {};
      const at = r.created_at;
      const out = [];
      if (s.resting_heart_rate != null) out.push({ metric: 'resting_hr', value: s.resting_heart_rate, unit: 'bpm', measured_at: at, source: 'whoop', source_ref: `whoop:rhr:${r.cycle_id}` });
      if (s.hrv_rmssd_milli != null) out.push({ metric: 'hrv', value: s.hrv_rmssd_milli, unit: 'ms', measured_at: at, source: 'whoop', source_ref: `whoop:hrv:${r.cycle_id}` });
      return out;
    });
  }

  if (provider === 'strava') {
    const after = Math.floor(new Date(since).getTime() / 1000);
    const acts = await get(`https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=100`);
    return (acts || []).flatMap(a => {
      const out = [];
      if (a.distance) out.push({ metric: 'distance_km', value: Math.round(a.distance / 10) / 100, unit: 'km', measured_at: a.start_date, source: 'strava', source_ref: `strava:dist:${a.id}` });
      if (a.moving_time) out.push({ metric: 'active_minutes', value: Math.round(a.moving_time / 60), unit: 'min', measured_at: a.start_date, source: 'strava', source_ref: `strava:min:${a.id}` });
      if (a.calories) out.push({ metric: 'active_calories', value: a.calories, unit: 'kcal', measured_at: a.start_date, source: 'strava', source_ref: `strava:kcal:${a.id}` });
      return out;
    });
  }

  return [];
}
