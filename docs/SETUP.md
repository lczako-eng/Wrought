# Setup — everything the operator has to switch on

Ordered so the product works after step 3 and gets better after that. Nothing
below step 3 blocks anybody from using WROUGHT.

---

## 1. Supabase — the migrations, in order

SQL editor, one at a time, top to bottom:

| File | What stops working without it |
|---|---|
| `001_wrought_core.sql` | everything |
| `002_wrought_oauth.sql` | "Sign in with Wrought" inside ChatGPT and Claude |
| `003_wrought_training.sql` | sessions, sets, routines, progression |
| `004_wrought_fasting.sql` | `log_fast` |
| `005_wrought_activity.sql` | activity level → calories out counts a working day as zero |
| `006_wrought_identity.sql` | merging two accounts back into one |
| `007_wrought_push.sql` | notifications, and the per-user send hour |
| `008_wrought_blocks.sql` | multi-week programmes |
| `009_wrought_photos.sql` | progress photos, and the private bucket they live in |

Each endpoint that needs a missing migration says which one by name rather than
failing with something generic.

## 2. Supabase — Authentication

- **Providers → Email → Confirm email: OFF.** Otherwise signup still emails a
  link, which is the thing the password change removed.
- **Enable manual linking: ON.** Without it the Account screen cannot read or
  add sign-in methods.
- **Site URL:** `https://wrought.fit`
- **Redirect URLs:** add `https://wrought.fit/**`

Apple and Google sign-in are optional and covered in `SIGN_IN.md` (Google free,
Apple US$99/year).

## 3. Netlify — environment variables

| Variable | Needed for |
|---|---|
| `SUPABASE_URL` | everything — **no trailing slash**, or Kong answers "Invalid path specified in request URL" and nothing explains why |
| `SUPABASE_SERVICE_ROLE_KEY` | everything |
| `WROUGHT_SITE_URL` | `https://wrought.fit` — OAuth redirects are built from it |
| `WROUGHT_ADMIN_EMAILS` | the Admin tab. Comma separated |

And inject `window.WROUGHT_SUPABASE_URL` / `window.WROUGHT_SUPABASE_ANON` for
the pages.

**At this point the product works.** Everything below is optional.

---

## 4. Notifications

```
node scripts/vapid.mjs
```

Prints three values. Paste them into Netlify:

| Variable | |
|---|---|
| `WROUGHT_VAPID_PUBLIC` | public by definition — the browser is handed it |
| `WROUGHT_VAPID_PRIVATE` | signs the send. The one secret here |
| `WROUGHT_VAPID_SUBJECT` | `mailto:` address the push services contact |

**Generate once, ever.** Changing the pair invalidates every existing
subscription silently — nobody gets an error, notifications simply stop.

Then: Dashboard → Account → *Turn on notifications*, and *Send a test* so you
find out it works now rather than at 22:00 tonight.

`RESEND_API_KEY` separately enables the nightly email. Push and email are
independent; either alone is fine.

## 5. Direct device APIs

**Register none of these.** That is not a shortcut, it is the design.

Apple Health and Health Connect are already aggregators. Oura, Whoop, Fitbit,
Strava, Nike Run Club, Peloton, Garmin and Samsung Health all write into
whichever one is on the phone, so one Shortcut posting to `/ingest` picks up
dozens of apps on day one with no partnerships, no keys and no review queues.
The setup conversation is one question — *what phone do you carry?*

What a direct connection actually buys, when it buys anything:

- **Backfill.** The Shortcut sends what happens from now on. A direct API can
  fetch the last year.
- **No phone in the loop.** A scale that reports itself keeps reporting while
  the phone is flat or the Shortcut is broken.
- **Fields with no HealthKit equivalent** — Oura's sleep staging, Whoop's strain.

None of that is worth doing before the product has been used for a fortnight.
When it is worth doing, do them one at a time, in this order:

| Provider | Variables | Getting the app | Worth it when |
|---|---|---|---|
| **Withings** | `WITHINGS_CLIENT_ID` / `_SECRET` | Self-serve, instant | You own a Withings scale. Bodyweight is the number people most reliably stop logging by hand |
| **Strava** | `STRAVA_CLIENT_ID` / `_SECRET` | Self-serve, instant | You want per-split pace rather than a daily total |
| **Oura** | `OURA_CLIENT_ID` / `_SECRET` | Self-serve | Sleep staging matters to you |
| **Fitbit** | `FITBIT_CLIENT_ID` / `_SECRET` | Self-serve | Android and no Health Connect |
| **Whoop** | `WHOOP_CLIENT_ID` / `_SECRET` | Needs approval | Strain and recovery matter |
| Garmin | — | Acceptance into a programme, a review not a signup | Probably never — the door covers it |

Each is maybe ten minutes: create an app, paste the callback below, copy two
strings into Netlify.

Every one uses the same callback:

```
https://wrought.fit/api/device/callback?provider=<id>
```

Register that as the redirect URI with each provider. Until a provider's pair is
set, its button in the app says which variable is missing instead of sending
somebody to an error page.

## 6. Progress photos

Nothing beyond migration `009`, which creates the private bucket and its policy.
Confirm in Supabase → Storage that `wrought-photos` shows as **private**. If it
ever reads public, every object is one guessed path from the open internet.

---

## What is deliberately not here

- **No analytics or tracking script.** `/privacy.html` names every subprocessor
  and the list stays short enough to be worth reading.
- **No OpenAI key required.** The connected model does the structuring; the
  server does the arithmetic. `parseLog` and the emailed verdict are the only
  things that would use one, and both have a path that does not.
- **No sharing feature for photos.** Not now, not later.
