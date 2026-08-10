// WroughtApp.swift
// WROUGHT for iPhone — the statistics house.
//
// The founder's architecture, in his words: "the AI is basically the thing
// that's working it, but the app is the statistics house... the same stuff on
// the website is on the app, but everything's ran through the GTP."
//
// So this app is deliberately three things and nothing else:
//   1. The SAME screens the website serves, rendered live from wrought.fit —
//      never a rebuilt copy, so the two surfaces cannot drift and a dashboard
//      fix ships to both in one deploy with no App Store release.
//   2. The HealthKit courier — the one thing a website can never be. Native
//      statistics queries return Apple's own deduplicated daily totals (the
//      number on the watch face), which an evening of Shortcuts archaeology
//      proved are unreachable any other way.
//   3. (Next build) native push, so the nightly verdict lands on the lock
//      screen through APNs rather than web push.
//
// There is NO chat in this app, by doctrine. Capture and coaching live in the
// connected AI; this is where the record is looked at and where the body
// reports in.

import SwiftUI

@main
struct WroughtApp: App {
    @StateObject private var courier = HealthCourier()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(courier)
                .preferredColorScheme(.dark)   // the forge is dark; a white flash on launch reads as a glitch
        }
    }
}
