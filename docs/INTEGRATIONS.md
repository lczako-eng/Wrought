# Getting the stats out of everything

The ask was "Apple Watch and Samsung watch and Oura and Nike Run — anything to
take the stats." This is the honest map of what that actually requires, because
the obvious plan (build fifteen integrations) is both enormous and unnecessary.

## The finding

**FORGE does not need fifteen integrations. It needs two doors.**

Apple Health and Android's Health Connect are *already aggregators*. Nike Run
Club, Strava, Peloton, Oura, Whoop, Samsung Health, Fitbit, Zwift and most of the
rest already write into whichever one is on the user's phone. Reading those two
doors properly picks up dozens of apps on day one — no partnerships, no API
keys, no approval queues, no per-vendor maintenance.

So the setup conversation is one question — *what phone do you carry?* — and one
connection. Not eight.

```
Nike Run Club ─┐
Strava ────────┤
Peloton ───────┼──▶ Apple Health ──┐
Oura ──────────┤    (iPhone)       │
Whoop ─────────┘                   ├──▶ POST /ingest ──▶ FORGE
                                   │
Samsung Health ┐                   │
Fitbit ────────┼──▶ Health Connect ┘
Google Fit ────┤    (Android)
Nike / Strava ─┘
```

## The two doors

Both are **push**: the data lives on the device and leaves only if the device
sends it. This is a platform design decision, not a gap we can engineer around.
There is no entitlement, no partner tier and no price at which a server reads an
Apple Watch directly. Every "Apple Health integration" you have ever used is
this underneath; most of them just do not say so.

| | Apple Health | Health Connect |
|---|---|---|
| Platform | iPhone / Apple Watch | Android 14+ (built in), earlier via Play Store |
| Sender | iOS Shortcut, or Health Auto Export app | Health Sync, Tasker, or Macrodroid |
| Auth | Bearer key from `forge_ingest_keys` | same |
| Endpoint | `POST /ingest` | same |

Both accept the same body:

```json
{
  "source": "apple_health",
  "metrics":  [{ "metric": "steps", "value": 8412, "unit": "count", "measured_at": "..." }],
  "workouts": [{ "kind": "Run", "minutes": 32, "distance_km": 5.4, "occurred_at": "..." }]
}
```

`metrics` are samples; `workouts` are sessions and land in the training log next
to the lifts. Both are idempotent — a phone that fires the automation twice does
not double anybody's sleep.

## Everything else

| Source | Mode | Status | Reality |
|---|---|---|---|
| **Apple Health** | push | **live** | The iPhone door. |
| **Health Connect** | push | **live** | The Android door. |
| Strava | pull | planned | Best-documented API in the category. Worth doing directly for per-split pace, which the phone does not keep. |
| Oura | pull | planned | Direct gets sleep staging and readiness; the phone only receives a single sleep number. |
| Whoop | pull | planned | Strain and recovery have no Apple Health equivalent. |
| Withings | pull | planned | **Highest-value pull.** A scale that reports itself fixes the number people most reliably stop logging by hand. |
| Fitbit | pull | planned | Reaches us through Health Connect today. |
| Garmin | pull | planned | Requires acceptance into their developer programme — a review, not a signup. |
| Polar | pull | planned | AccessLink API. |
| **Nike Run Club** | push | aggregated | **No public API since 2018, for anybody.** Through the phone is the only route that exists. Not a workaround. |
| **Samsung Health** | push | aggregated | Own API partner-gated for years. Health Connect carries the same data and is open. |
| Peloton | push | aggregated | Writes to both doors. Nothing to build. |

`status` is deliberately blunt. A status field that lies to spare someone's
feelings makes every support conversation worse:

- **live** — works today
- **aggregated** — no direct link exists, but it feeds a door that works today
- **planned** — real API exists, our developer app is not registered yet

The registry in `netlify/functions/lib/providers.js` is the single source for
this. It drives the `connect_device` MCP tool *and* the website, so the
assistant and the page can never drift into telling a user two different stories
about the same device.

## Adding a device

Usually a few lines, not a new service — because whatever it is, it is already
writing into one of the two doors. The work is teaching `METRIC_ALIASES` in
`ingest.js` its spelling of a quantity we already understand:

```js
stepsrecord: 'steps',                      // Health Connect
hkquantitytypeidentifierstepcount: 'steps', // Apple
com_samsung_health_step_count: 'steps',     // Samsung
```

Unit conversion happens once, at the door. Storage is metric, minutes and kcal.
The one to be careful with is distance: Strava and Health Connect send metres,
Apple sends miles or kilometres depending on region. Getting metres wrong turns
a 5k into a 5000km run, which at least fails visibly — the mile/kilometre mix-up
is the quiet one that would just make everybody 60% faster. Both are covered by
tests.

## What to build next, in order

1. **Withings** — a self-reporting scale removes the most-abandoned manual entry.
2. **Strava** — biggest population, best API, and a webhook means a run lands
   seconds after it finishes rather than at the nightly push.
3. **Oura / Whoop** — sleep and recovery depth the phone does not carry.
4. Garmin and Polar — real, but the approval queue makes them last.
