# WROUGHT for iPhone — the statistics house

The founder's spec, verbatim: *"the AI is basically the thing that's working
it, but the app is the statistics house... the same stuff on the website is on
the app, but everything's ran through the GTP."*

So this app is three things and refuses to be more:

1. **The same screens the website serves** — `wrought.fit/app.html`, live, in a
   native shell. Not a rebuilt copy: a second window onto the same record, so
   the app and the site can never disagree, and a dashboard fix ships to both
   in one deploy with no App Store release.
2. **The HealthKit courier.** Native statistics queries return Apple's own
   deduplicated daily totals — the number on the watch face — which an entire
   evening of Shortcuts archaeology proved unreachable any other way. It
   registers background delivery, so the phone wakes it when new data lands
   and the record fills in by itself.
3. **No chat.** Capture and coaching live in the connected AI, by doctrine.

## Build it (once, ~10 minutes)

1. On the MacBook: clone the repo, open `ios/Wrought.xcodeproj` in Xcode 16+.
2. Select the **Wrought** target → **Signing & Capabilities** → pick your
   **Team** (the same US$99 account as Sign in with Apple). Bundle id is
   `fit.wrought.app`; change it if Apple says it is taken.
3. Confirm **HealthKit** (with background delivery) shows under Capabilities —
   the entitlements file already declares it.
4. Plug in the iPhone → pick it as the run destination → press **Run**.
   First run on a device needs Settings → General → VPN & Device Management →
   trust your developer certificate.

## First run on the phone

1. The website loads. Sign in with **email + password**. (Google and Apple
   sign-in refuse to run inside embedded web views — that is their policy, not
   a bug. Same account either way; the password door works fully in-app.)
2. A card sits at the bottom: **Connect Apple Health**. Tap it, approve the
   Health sheet.
3. Done. It sends today's numbers immediately — check the Log tab — and from
   then on the phone wakes the app hourly-ish to send fresh totals. The server
   keeps one total per metric per day (newest claim wins), so resends and
   overlapping senders can never double a day.

## How the key handshake works

The app never asks for a password. It reads the signed-in session from the
page it is framing, mints a device key from `/api-key` with that session —
so the courier can only ever feed the account on screen — and keeps the key in
the Keychain. The silent-fork lesson, applied to a new surface.

## Deliberately not here (yet)

- **APNs push** — the nightly verdict on the lock screen. Needs a server-side
  sender (same hand-rolled `.p8` JWT pattern as Apple sign-in, same developer
  account) and a token registration endpoint. Next native build.
- **Widgets** — after push.
- Any screen the website does not have. The website is the source of truth for
  what the product looks like.

## Honest caveats

- Written off-device: this code has been reviewed but **not compiled** — this
  repo's toolchain has no Xcode. Expect at worst small syntax fixes on first
  build; the architecture is deliberately boring so that surprises stay small.
- App Store review: apps that are "just a website" get rejected (guideline
  4.2). HealthKit background delivery and (soon) native push are the genuine
  native functionality that makes this pattern approvable. Health apps also
  draw privacy scrutiny — `/privacy.html`, labelled estimates and the export
  endpoint are exactly what reviewers want pointed at.
