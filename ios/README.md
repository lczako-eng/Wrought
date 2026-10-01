# WROUGHT for iPhone — the statistics house

The founder's spec, verbatim: *"the AI is basically the thing that's working
it, but the app is the statistics house... the same stuff on the website is on
the app, but everything's ran through the GTP."*

So this app is three things and refuses to be more:

1. **The same screens the website serves** — `wrought.fit/app.html`, live, in a
   native shell. Not a rebuilt copy: a second window onto the same record, so
   the app and the site can never disagree, and a dashboard fix ships to both
   in one deploy with no App Store release.
2. **The HealthKit courier.** Steps, distance (walking, running and cycling
   summed), active energy, exercise minutes, resting heart rate, weight, last
   night's sleep — and **every workout the watch recorded**, carrying its own
   HealthKit uuid so resending a week can never double a run. Native
   statistics queries return Apple's own deduplicated daily totals — the number on the watch face — which an entire
   evening of Shortcuts archaeology proved unreachable any other way. It
   registers background delivery, so the phone wakes it when new data lands
   and the record fills in by itself.
3. **No chat.** Capture and coaching live in the connected AI, by doctrine.

It also carries the **Apple Watch round coach** and its lock-screen Live
Activity, from build 13 — see `docs/WATCH_COACH.md`. Three targets, one
upload: `Wrought` (the iPhone app), `WroughtWatch` and `WroughtWidgets`, the
last two embedded in the first.

## Build it (once, ~10 minutes)

1. On the MacBook: clone the repo, open `ios/Wrought.xcodeproj` in Xcode 16+.
2. Select each target — **Wrought**, **WroughtWatch**, **WroughtWidgets** —
   → **Signing & Capabilities**, and check the **Team** is the account the
   project already names (the same US$99 account as Sign in with Apple).
   **Never change a bundle id.** The iPhone app is `fit.wrought.app`, the
   Watch app names it as its companion, and the Watch and widget ids are built
   on it: change one and the three stop matching and the upload is refused;
   change all of them and App Store Connect sees a different app from the one
   on TestFlight. `npm test` checks the three still match.
3. Confirm **HealthKit** shows under Capabilities on **Wrought** (with
   background delivery) and on **WroughtWatch** — the entitlements files
   already declare it.
4. Plug in the iPhone → pick it as the run destination → press **Run**.
   First run on a device needs Settings → General → VPN & Device Management →
   trust your developer certificate.

## First run on the phone

1. The website loads. Sign in with **email + password** — the door that works
   fully in-app. Google refuses
   to sign anybody in inside an app's web view (its policy, not a bug), so
   inside the app its button is gone and one line says so, and a Google
   sign-in page is never loaded. Apple's button stays; whether Apple's own
   sign-in page completes inside the app has not been checked on a device.
2. A card sits at the bottom: **Connect Apple Health**. Tap it, approve the
   Health sheet.
3. Done. It sends today's numbers immediately — check the Log tab — and from
   then on the phone wakes the app hourly-ish to send fresh totals. The server
   keeps one total per metric per day (newest claim wins), so resends and
   overlapping senders can never double a day.

## Hands-free — "hey Siri, gym bro"

Nothing to set up. Build, run once, and the phrases are registered by iOS.

Say any of these with the phone locked, in a pocket:

| Say | What happens |
|---|---|
| *"Hey Siri, gym bro, what's the damage"* | Siri reads the day back — roughly in, roughly out, where the week stands |
| *"Hey Siri, gym bro, hit me"* | Same |
| *"Hey Siri, gym bro, log this"* | Siri says "go on", you talk, it saves what you said |
| *"Hey Siri, tell gym bro"* | Same |

**"Gym bro" works because the app answers to it.** Every Siri phrase has to
contain the app's name, so `ios/Info.plist` declares exactly three alternative
names: **Gym Bro**, **Jim Bro** (what dictation makes of it half the time) and
**Broski**. Three is Apple's limit: a fourth builds and archives, then App
Store Connect refuses the upload with **ITMS-90626** — twice already, a build
number each time. A new nickname means one of these goes.

Nothing opens and nothing asks for Face ID — that is the whole point. The
trade-off is deliberate: what a locked phone can reach is appending to the log
and hearing a one-line summary, nothing that deletes or reads the record out.

**What Siri cannot do is work out calories.** There is no model on the phone
end, so a dictated sentence is stored word for word and Siri says so. The next
time you talk to ChatGPT it reads those back and fills in the numbers itself —
that is why this needs no API key. If Siri mishears ("burrito" → "burrata"),
the Log tab is where you catch it, same as always.

If it says *"open Wrought once to connect it"*, the device key is missing —
launch the app, sign in, and it mints one.

### If a phrase does not match

Siri matches these literally. Two fallbacks that are more reliable in a loud
gym anyway:

- **Back Tap** — Settings → Accessibility → Touch → Back Tap → Double Tap →
  pick the Wrought shortcut. Double-tap the back of the phone.
- **Action Button** (iPhone 15 Pro and later) — Settings → Action Button →
  Shortcut → Wrought.

## Archive and upload build 13

The repo carries the version and build for all three targets — 1.0 (13) —
and `npm test` fails if they disagree, so nothing is typed into Xcode.

1. `git pull` on `main`, then open `ios/Wrought.xcodeproj`. If the pull
   refuses because of local changes to `project.pbxproj` (Xcode writes build
   numbers there), discard them — `git checkout -- ios/Wrought.xcodeproj` — and
   pull again: the repo's numbers are the ones to build.
2. Confirm all three targets show **Version 1.0, Build 13** (each target →
   General → Identity). **Do not change build numbers in Xcode's UI** — it
   edits one target at a time and leaves the Watch and the widget behind. If
   one is wrong, the repo is wrong: fix it there, in one edit.
3. Scheme **Wrought**, destination **Any iOS Device (arm64)**, then
   **Product › Archive**. Archive only the **Wrought** scheme — it builds the
   Watch app and the widget and embeds them. Xcode also creates `WroughtWatch`
   and `WroughtWidgets` schemes; never archive or upload those on their own.
   Before uploading, check the Watch's privacy manifest made it into the
   archive: in the Organizer, right-click the archive › **Show in Finder** ›
   right-click the `.xcarchive` › **Show Package Contents**, and look for
   `Products/Applications/Wrought.app/Watch/WroughtWatch.app/PrivacyInfo.xcprivacy`.
   If it is missing, do not upload — App Store Connect would refuse it
   (ITMS-91053) and the build number would be spent. Select
   `WroughtWatch/PrivacyInfo.xcprivacy` in Xcode, tick **WroughtWatch** under
   *Target Membership* in the File inspector, and archive again.
4. In the Organizer: **Distribute App › App Store Connect › Upload** (in
   Xcode 16 the Upload choice can sit under **Custom**). If a step offers to
   **manage the version and build number**, keep the repo's — untick it — so
   what uploads is 13. Step 5 checks it either way.
5. When processing finishes, open the build in **TestFlight** and read two
   things off it: the build number (**13**) and **Apple Watch: Yes**. That
   page, not the repo and not the archive, is what shipped. Now move
   `public/app-info.json` to what TestFlight shows — build 13 and its date —
   with a release note saying the Watch app is in the build and not yet tested
   on a wrist. It describes what is **released**; the harness accepts the
   project being exactly one build ahead of it while an upload is pending, and
   nothing else. If TestFlight shows another number, set the project to it too.
6. Install it from TestFlight on the iPhone — once Netlify's published
   deploy is the `main` you built from. Build 13 forgets a device key the
   server refuses, and it is the server's half of this change that answers a
   key it could not check (a database blip) with 503 rather than a refusal.
   The Watch app comes with it; if it does not appear on the Watch, open the
   iPhone's **Watch** app › Available Apps › Wrought › **Install**.
7. Run the **8-step wrist test** in `docs/WATCH_COACH.md` on the phone and the
   Watch.
8. When it passes, change the release note in `public/app-info.json` to say
   so. The next upload moves every `CURRENT_PROJECT_VERSION` to 14, in one
   edit.

## How the key handshake works

The app never asks for a password. It reads the signed-in session from the
page it is framing, mints a device key from `/api-key` with that session, and
keeps the key in the Keychain beside the account it was minted for. As pages
load, as the app comes forward, before a send the page asks for and before a
send Health wakes in the foreground, that account is compared with the one on
screen, and a different one gets a key of its own. A background wake cannot
ask the page, so a switch made just before one is caught at the next check. A
key from build 12 or earlier has no account on file and is replaced once. The
silent-fork lesson, applied to a new surface.

A key the server refuses (`invalid_key`) is forgotten and the connect card
comes back; a key the server could not check — a database blip — is kept, and
the send is tried again later.

## Deliberately not here (yet)

- **A custom wake word** — impossible, not unbuilt. Only Siri gets one on iOS;
  hotword detection lives on a coprocessor Apple exposes to nothing, and an app
  holding the mic open in the background gets suspended, burns the battery and
  fails review. "Hey Siri, gym bro" is the real ceiling.
- **A back-and-forth conversation with Siri** — the intents are one question,
  one answer. Conversation stays in ChatGPT, where the connector lives.
- **APNs push** — the nightly verdict on the lock screen. Needs a server-side
  sender (same hand-rolled `.p8` JWT pattern as Apple sign-in, same developer
  account) and a token registration endpoint. Until then notifications come
  from wrought.fit added to the Home Screen from Safari, and the page inside
  the app says so.
- Any screen the website does not have. The website is the source of truth for
  what the product looks like.

## Honest caveats

- Written off-device: this code has been reviewed but **not compiled** — this
  repo's toolchain has no Xcode. Expect at worst small syntax fixes on first
  build; the architecture is deliberately boring so that surprises stay small.
  Build 13's Swift, on the iPhone and the Watch alike, was written the same way.
- App Store (not TestFlight) will also want Apple Watch screenshots and an
  in-app way to delete the account — see `docs/WATCH_COACH.md`. Neither is in
  build 13.
- App Store review: apps that are "just a website" get rejected (guideline
  4.2). HealthKit background delivery and (soon) native push are the genuine
  native functionality that makes this pattern approvable. Health apps also
  draw privacy scrutiny — `/privacy.html`, labelled estimates and the export
  endpoint are exactly what reviewers want pointed at.
