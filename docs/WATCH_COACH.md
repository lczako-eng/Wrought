# WROUGHT round coach — release boundary

## Implemented in source

- Existing cover page unchanged. Dashboard performance surfaces use the existing dark/orange palette, animated trend paths, rounded cards and a prominent round-coach entrance.
- `/workout.html`: configurable rounds/work/recovery, browser sound cues, pause/resume, partial-completion receipt, reduced motion. It pauses when hidden rather than falsely promising iOS background execution. Browser completion hands a receipt to the user's assistant; it does not invent a saved workout.
- `prepare_rounds`: the connector returns a configured timer URL using the durations the person requested. It does not remotely start a Watch or claim a session was logged.
- Native watchOS 10+ target embedded in the iPhone source project, which is now 1.0 (13) in all six configurations. **Not in the shipped TestFlight build — 1.0 (12) reports `Apple Watch: No`.** Build 13 is the upload meant to carry it; until TestFlight shows 13 with `Apple Watch: Yes`, it has not shipped. Watch owns an `HKWorkoutSession` and `HKLiveWorkoutBuilder`; reads HR and estimated active energy; saves one workout into HealthKit. Existing iPhone HealthCourier observes workouts and imports their stable HealthKit UUIDs through the existing idempotent ingest path. No second writer is added.
- 1 click at 30 seconds remaining, 3 at work end, 2 at next work start. No trailing rest. Rounds at/below the warning duration do not play a redundant warning. With no rest a round runs straight into the next on 2 clicks and the 3 come once, at the end; the Watch's legend is built from the plan on it, so it says so. Clicks are spaced 450 ms, not fired simultaneously. Haptics briefly interrupt HR collection on Apple Watch; readings are never interpolated to hide this.
- `WatchConnectivity` transfers a validated plan from a trusted HTTPS main frame on wrought.fit. It carries no credentials. Incoming plans queue until the current workout has finished, and are then added after the save message rather than written over it. A plan the Watch already shows, or the last one it took (WatchConnectivity replays it on every launch), is not announced again and never undoes an edit made on the Watch; edits there are kept across launches. The steppers use the same limits every surface checks a plan against.
- Start asks Apple Health for permission and reads the answer: without permission to save workouts it does not start, and says where to allow it.
- A session HealthKit fails on its own (another workout app, the system) is finished, not abandoned: the part done is saved — or, under 30 seconds in, discarded — and the message says which. Apple Health is only named as holding a workout after HealthKit confirmed the save. A failure landing while Start is still setting up fails the start; the clock never runs against it.
- The workout's closing state is sent live and also queued with `transferUserInfo`, so an iPhone out of reach at the end still hears it and ends the Live Activity.
- The Watch app carries `PrivacyInfo.xcprivacy` declaring the two required-reason APIs it calls (UserDefaults, CA92.1; system uptime for the round clock, 35F9.1). The iPhone app and the widget call none, so they carry no manifest; `npm test` reads each target's sources and fails if that changes.
- Native lock-screen / Dynamic Island Live Activity reflects Watch round state. It is read-only: pause/end stay on Watch. Stale telemetry is explicitly marked, not projected indefinitely.

## Build 13 — what it fixes

Nothing below has been compiled: there is no Xcode where it was written. The founder archives it on the Mac (`ios/README.md`, *Archive and upload build 13*), and the wrist test below is what proves it.

**On the Watch**
- A workout HealthKit fails on its own is saved (or, under 30 seconds, discarded) and says which, instead of being dropped with a message pointing at a record that was never written. A failure during setup fails the start.
- Start reads whether saving workouts is allowed before it begins, and says where to allow it.
- The closing state is queued (`transferUserInfo`) as well as sent live, so the Live Activity ends even when the iPhone was out of reach.
- A plan from the phone waits for the workout, adds to the save message rather than replacing it, and a replayed plan is not news; Watch edits persist; steppers hold the limits the plan is checked against; Start says why it is off; the tap legend follows the plan (rest 0 included).
- `PrivacyInfo.xcprivacy`: the first build containing the Watch app is the first to call UserDefaults and system uptime, which App Store Connect refuses undeclared (ITMS-91053). Declared with CA92.1 and 35F9.1; tracking false.

**On the iPhone**
- The page's `alert`, `confirm` and `prompt` are shown (a `WKUIDelegate`). Without one WebKit answered every confirm as Cancel without showing it, so Sign out, Remove, Delete, Log as work, revoke, turning off two-factor and deleting a photo were dead buttons in the app.
- Apple Health read permission is asked again, in the foreground, whenever iOS says there is something never asked — so a type added since the first grant, or lost on a reinstall, is not silently sent as nothing.
- The device key is forgotten when the server refuses it and re-minted when the account on screen changes, so the courier and Siri follow the signed-in account.
- The Watch session starts at launch, not when the web view first draws; the Live Activity picks up and clears what an earlier launch left.
- Google's sign-in page is never loaded in the web view (Google refuses embedded web views and leaves no way back); the camera usage string exists for the page's photo inputs; the Health write string describes the bundle, Watch included.

**On the page, inside the app** (served from wrought.fit, so no build is needed for these)
- The Google button is hidden with one line saying to use email and password; Link and Prove-it-with-Google go the same way.
- Notifications say they come from wrought.fit added to the Home Screen from Safari, never "Share, then Add to Home Screen" in an app with no Share button.
- Export says to use wrought.fit in Safari, where the download works.

## Not a verified native release

An unsigned Xcode build is NOT an installed app, TestFlight upload, App Store release, or physical haptic test.

**This warning was right, and the website contradicted it.** `app-info.json`'s release note claimed build 1.1 (8) "adds the Apple Watch round coach" while the build anyone could install was 1.0 (12), which TestFlight reports as having no Watch app at all — and the homepage, the dashboard manual and the connect page all printed that note. The harness test comparing `app-info.json` to the Xcode project passed throughout, because both were wrong together. **When the native version is in question, read TestFlight, not the repo.**

No download URL is fabricated: the public link lives in App Store Connect, and the homepage renders no button rather than a dead one.

## Physical acceptance test (required before native distribution)

1. Sign/build all three targets with the existing team's entitlements and install the paired iPhone/Watch apps. Authorize Health access yourself.
2. Send 8 × 180s / 60s from the iPhone page. Check Watch receipt; starting requires a Watch button press.
3. Test 1/3/2 cue recognition during movement, with wrist down and screen asleep. Test VoiceOver and reduced motion. Confirm the cue timing at the boundary, not merely the animation.
4. Disconnect/lock iPhone. Watch must continue locally. Reconnect and verify the web telemetry resumes without starting a duplicate timer.
5. Pause near each boundary, resume, end early; only performed elapsed time is saved. Receive another plan mid-workout: current timing must not change.
6. Stop another workout / deny Health permissions / interrupt WROUGHT: errors must be visible. Force-quit recovery is not implemented and must not be claimed.
7. Finish. Verify exactly one HealthKit workout, one WROUGHT session after courier sync, and its inclusion in the evening brief. No fabricated HR, calorie total or full-session completion.
8. Verify Live Activity on a real locked iPhone/Dynamic Island, its stale state when Watch disconnects, and removal at workout end.

## Before an App Store submission (not needed for TestFlight)

- **Apple Watch screenshots.** Once the binary contains a watchOS app, the App Store version needs Watch screenshots. Take at least one during the physical test — the round ring mid-round — and keep it for the submission. (App Store Connect is expected to block *Add for Review* until they are there — the exact rule was not readable from here. It costs no build number either way, and TestFlight does not ask for them.)
- **In-app account deletion — still open, not done in build 13.** App Store Review Guideline 5.1.1(v): an app that lets people create an account must let them start deleting it in the app. The framed page creates accounts, and deletion today is an email to the founder (`/privacy.html`, *Delete everything*) — while the same page's summary says the account can be deleted "without asking us". It needs a *Delete account* on the Account tab that confirms once and calls an authenticated endpoint running the cascade delete, and the privacy page saying one thing. The confirm it would need now works in the app.

## Still outside this delivered slice

- Automatic strength set/rep completion and per-exercise Watch progression; use the existing Trainer interface for set logging.
- Converting all 21 methodology templates into audited multiweek programmes; existing blocks/progression remain in place, not newly certified by this release.
- Outdoor GPS/elevation, punch power, technique recognition, autonomous medical coaching.
- Wear OS / third-party ring live control; historical ingest is not a live wearable controller.
- Native force-quit session recovery and remote pause/end from the lock screen.

## Reproducible checks

`npm test` includes the existing offline suite and the shared JS interval tests.

`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun swiftc ios/Shared/WorkoutPlan.swift test/RoundClockTests.swift -o /tmp/wrought-round-tests && /tmp/wrought-round-tests`

`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -project ios/Wrought.xcodeproj -scheme Wrought -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build`

The browser integration was unavailable in this Codex session. Source checks and HTTP checks are not a substitute for the required 390px visual/device review.
