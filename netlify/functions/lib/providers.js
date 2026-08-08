// netlify/functions/lib/providers.js
// The device registry — every place a stat can come from, and the truth about
// how each one actually connects.
//
// The strategic point, which took a while to see and should not be forgotten:
//
//   WROUGHT does not need fifteen integrations. It needs TWO DOORS.
//
// Apple Health and Android's Health Connect are already aggregators. Nike Run
// Club, Strava, Peloton, Oura, Whoop, Samsung Health, Zwift and most of the
// rest already write into whichever one is on the user's phone. So supporting
// those two doors properly picks up dozens of apps for free, on day one,
// without a single partnership, API key or approval queue.
//
// Direct cloud APIs then exist for the handful worth pulling at higher
// fidelity than the phone bothers to store — Strava's per-run splits, Oura's
// sleep staging, Whoop's strain. Those are an upgrade, never the entry price.
//
// Two modes, and the difference is not cosmetic:
//   push — the data lives on a device and leaves only if the device sends it.
//          There is no server-side way in, at any price. Apple Health and
//          Health Connect are both this, permanently, by platform design.
//   pull — a real cloud API we can fetch from with the user's OAuth token.
//
// status is deliberately honest, because a status field that lies to spare
// somebody's feelings makes every support conversation worse:
//   live           — works today
//   aggregated     — no direct link, but it feeds a door that does work today
//   planned        — real API exists, our developer app is not registered yet

export const PROVIDERS = {
  // ── The two doors ─────────────────────────────────────────────────────────
  apple_health: {
    name: 'Apple Health',
    devices: 'Apple Watch, iPhone, and anything that writes to Health',
    mode: 'push',
    status: 'live',
    platform: 'ios',
    gives: ['steps', 'sleep_minutes', 'resting_hr', 'hrv', 'active_calories',
            'weight_kg', 'body_fat_pct', 'distance_km', 'vo2max', 'spo2', 'workouts'],
    // This sentence is the single most useful thing on the connect page.
    aggregates: ['Nike Run Club', 'Strava', 'Peloton', 'Oura', 'Whoop', 'Zwift',
                 'MyFitnessPal', 'Withings', 'Garmin Connect', 'Concept2'],
    how: 'A free iOS Shortcut, or the Health Auto Export app, posting to /ingest once a night.',
    why: 'Apple Health has no cloud API — no entitlement, no partner programme, no price at which a server can read an Apple Watch. The data lives on the phone and leaves only if the phone sends it. Every "Apple Health integration" you have ever used is this underneath.',
  },

  health_connect: {
    name: 'Health Connect',
    devices: 'Samsung Galaxy Watch, Pixel Watch, and every Android health app',
    mode: 'push',
    status: 'live',
    platform: 'android',
    gives: ['steps', 'sleep_minutes', 'resting_hr', 'hrv', 'active_calories',
            'weight_kg', 'body_fat_pct', 'distance_km', 'vo2max', 'spo2', 'workouts'],
    aggregates: ['Samsung Health', 'Google Fit', 'Nike Run Club', 'Strava',
                 'Peloton', 'Oura', 'Fitbit', 'Withings'],
    how: 'Health Connect is Android\'s on-device aggregator. An automation app (Tasker, Macrodroid) or Health Sync posts to /ingest on a schedule.',
    why: 'Same shape as Apple: on-device by design. Samsung Health\'s own cloud API is partner-gated and has been for years, so Health Connect is both the easier and the more complete route.',
  },

  // ── Direct cloud APIs — the fidelity upgrade ──────────────────────────────
  strava: {
    name: 'Strava',
    devices: 'Runs and rides from any watch that syncs to Strava',
    mode: 'pull',
    status: 'planned',
    gives: ['distance_km', 'active_minutes', 'active_calories', 'workouts'],
    how: 'OAuth, plus a webhook for new activities so a run lands within seconds of finishing.',
    why: 'The best-documented API in the whole category, and the only one that gives per-split pace rather than a daily total.',
    aggregated_via: 'apple_health',
  },
  oura: {
    name: 'Oura Ring',
    devices: 'Oura Ring gen 3 and 4',
    mode: 'pull',
    status: 'planned',
    gives: ['sleep_minutes', 'hrv', 'resting_hr', 'spo2', 'steps'],
    how: 'OAuth against the Oura v2 API.',
    why: 'Sleep staging and readiness are far richer than the single number Apple Health receives.',
    aggregated_via: 'apple_health',
  },
  whoop: {
    name: 'Whoop',
    devices: 'Whoop 4.0 and MG',
    mode: 'pull',
    status: 'planned',
    gives: ['sleep_minutes', 'hrv', 'resting_hr', 'active_calories', 'workouts'],
    how: 'OAuth against the Whoop developer API.',
    why: 'Strain and recovery scores have no Apple Health equivalent.',
    aggregated_via: 'apple_health',
  },
  fitbit: {
    name: 'Fitbit',
    devices: 'Fitbit trackers and Pixel Watch',
    mode: 'pull',
    status: 'planned',
    gives: ['steps', 'sleep_minutes', 'resting_hr', 'hrv', 'active_calories', 'weight_kg'],
    how: 'OAuth against the Fitbit Web API.',
    aggregated_via: 'health_connect',
  },
  garmin: {
    name: 'Garmin',
    devices: 'Forerunner, Fenix, Venu, Instinct',
    mode: 'pull',
    status: 'planned',
    gives: ['steps', 'sleep_minutes', 'resting_hr', 'hrv', 'vo2max', 'distance_km', 'workouts'],
    how: 'OAuth against the Garmin Health API — requires acceptance into their developer programme, which is a review, not a signup.',
    aggregated_via: 'apple_health',
  },
  withings: {
    name: 'Withings',
    devices: 'Body smart scales, sleep mats, blood pressure cuffs',
    mode: 'pull',
    status: 'planned',
    gives: ['weight_kg', 'body_fat_pct', 'resting_hr', 'sleep_minutes'],
    how: 'OAuth against the Withings API.',
    why: 'A scale that reports itself is the single highest-value connection here — bodyweight is the number people most reliably stop logging by hand.',
    aggregated_via: 'apple_health',
  },
  polar: {
    name: 'Polar',
    devices: 'Vantage, Grit, Ignite, H10 strap',
    mode: 'pull',
    status: 'planned',
    gives: ['sleep_minutes', 'resting_hr', 'hrv', 'active_calories', 'workouts'],
    how: 'OAuth against Polar AccessLink.',
    aggregated_via: 'apple_health',
  },

  // ── No public API, and never will have ────────────────────────────────────
  nike_run_club: {
    name: 'Nike Run Club',
    devices: 'The Nike app on any phone',
    mode: 'push',
    status: 'aggregated',
    gives: ['distance_km', 'active_minutes', 'workouts'],
    how: 'Nothing to connect. NRC writes every run into Apple Health or Health Connect, and WROUGHT reads it from there.',
    why: 'Nike closed its public API in 2018 and has shown no sign of reopening it. Going through the phone is not a workaround here — it is the only route that exists, for anybody.',
    aggregated_via: 'apple_health',
  },
  samsung_health: {
    name: 'Samsung Health',
    devices: 'Galaxy Watch, Galaxy Ring',
    mode: 'push',
    status: 'aggregated',
    gives: ['steps', 'sleep_minutes', 'resting_hr', 'active_calories', 'weight_kg', 'workouts'],
    how: 'Connect Health Connect on the phone. Samsung Health writes into it, and WROUGHT reads from there.',
    why: 'Samsung\'s own data API is partner-gated and has been closed to individual developers for years. Health Connect is the open door, and it carries the same data.',
    aggregated_via: 'health_connect',
  },
  peloton: {
    name: 'Peloton',
    devices: 'Bike, Tread, and the app',
    mode: 'push',
    status: 'aggregated',
    gives: ['active_minutes', 'active_calories', 'workouts'],
    how: 'Peloton writes to Apple Health and Health Connect. Nothing else to do.',
    aggregated_via: 'apple_health',
  },
};

// What a user can actually connect right now, versus what merely rides along.
export const LIVE_PROVIDERS = Object.entries(PROVIDERS)
  .filter(([, p]) => p.status === 'live').map(([k]) => k);

export const isPush = key => PROVIDERS[key]?.mode === 'push';

// The honest one-liner for any provider, used by the MCP tool and the web page
// so they can never drift into telling different stories.
export function providerSummary(key) {
  const p = PROVIDERS[key];
  if (!p) return null;
  const line =
    p.status === 'live'       ? `${p.name} — ready now. ${p.how}`
  : p.status === 'aggregated' ? `${p.name} — no direct connection exists, and none is needed: ${p.how}`
  :                             `${p.name} — has a real cloud API, but WROUGHT's developer app for it is not registered yet. In the meantime it reaches us through ${PROVIDERS[p.aggregated_via]?.name || 'the phone'}.`;
  return { key, ...p, say: line };
}

// Given what somebody actually wears, the shortest route to their numbers.
// Almost always "connect the phone" — which is the whole point.
export function recommendRoute(mentioned = []) {
  const wanted = mentioned.map(m => String(m).toLowerCase());
  // "watch" on its own is useless as a signal — every brand makes one, and
  // matching it sent every Galaxy Watch owner to the Apple door. Match the
  // platform, never the product category.
  const ios = wanted.some(w => /apple|iphone|ipad|\bios\b/.test(w));
  const android = wanted.some(w => /samsung|galaxy|android|pixel|wear ?os/.test(w));

  const door = android && !ios ? 'health_connect' : 'apple_health';
  return {
    door,
    say: `Connect ${PROVIDERS[door].name} and you get the lot in one go — it already collects ${PROVIDERS[door].aggregates.slice(0, 4).join(', ')} and the rest. One setup, not eight.`,
  };
}
