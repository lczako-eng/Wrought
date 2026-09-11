# WROUGHT round coach — release boundary

## Implemented in source

- Existing cover page unchanged. The performance dashboard redesign was rejected and rolled back to the exact pre-release `8f651e3` dashboard. No new stylesheet or workout promotional panel remains on that shared website/iPhone surface. The separate round timer and native Watch code are retained, not represented as installed.
- `/workout.html`: configurable rounds/work/recovery, browser sound cues, pause/resume, partial-completion receipt, reduced motion. It pauses when hidden rather than falsely promising iOS background execution. Browser completion hands a receipt to the user's assistant; it does not invent a saved workout.
- `prepare_rounds`: the connector returns a configured timer URL using the durations the person requested. It does not remotely start a Watch or claim a session was logged.
- Native watchOS 10+ target embedded in iPhone 1.1 (8). Watch owns an `HKWorkoutSession` and `HKLiveWorkoutBuilder`; reads HR and estimated active energy; saves one workout into HealthKit. Existing iPhone HealthCourier observes workouts and imports their stable HealthKit UUIDs through the existing idempotent ingest path. No second writer is added.
- 1 click at 30 seconds remaining, 3 at work end, 2 at next work start. No trailing rest. Rounds at/below the warning duration do not play a redundant warning. Clicks are spaced 450 ms, not fired simultaneously. Haptics briefly interrupt HR collection on Apple Watch; readings are never interpolated to hide this.
- `WatchConnectivity` transfers a validated plan from a trusted HTTPS main frame on wrought.fit. It carries no credentials. Incoming plans queue until the current workout has finished.
- Native lock-screen / Dynamic Island Live Activity reflects Watch round state. It is read-only: pause/end stay on Watch. Stale telemetry is explicitly marked, not projected indefinitely.

## Not a verified native release

An unsigned Xcode build is NOT an installed app, TestFlight upload, App Store release, or physical haptic test. `app-info.json` marks the source build as requiring device testing. No download URL is fabricated.

## Physical acceptance test (required before native distribution)

1. Sign/build all three targets with the existing team's entitlements and install the paired iPhone/Watch apps. Authorize Health access yourself.
2. Send 8 × 180s / 60s from the iPhone page. Check Watch receipt; starting requires a Watch button press.
3. Test 1/3/2 cue recognition during movement, with wrist down and screen asleep. Test VoiceOver and reduced motion. Confirm the cue timing at the boundary, not merely the animation.
4. Disconnect/lock iPhone. Watch must continue locally. Reconnect and verify the web telemetry resumes without starting a duplicate timer.
5. Pause near each boundary, resume, end early; only performed elapsed time is saved. Receive another plan mid-workout: current timing must not change.
6. Stop another workout / deny Health permissions / interrupt WROUGHT: errors must be visible. Force-quit recovery is not implemented and must not be claimed.
7. Finish. Verify exactly one HealthKit workout, one WROUGHT session after courier sync, and its inclusion in the evening brief. No fabricated HR, calorie total or full-session completion.
8. Verify Live Activity on a real locked iPhone/Dynamic Island, its stale state when Watch disconnects, and removal at workout end.

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
