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
import UIKit

/// Arms the HealthKit observers at LAUNCH. When the watch saves an evening's
/// steps and the app has been swept away, HealthKit relaunches it in the
/// background with no window — so a query only ContentView creates never
/// exists for that wake, the update goes unanswered, and after three of those
/// HealthKit stops waking the app until it is opened again. The day stayed
/// short until morning.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        HealthCourier.shared.armAtLaunch()
        return true
    }
}

@main
struct WroughtApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var courier = HealthCourier.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(courier)
                .onOpenURL { WebViewStore.shared.openWorkout($0) }
                .preferredColorScheme(.dark)   // the forge is dark; a white flash on launch reads as a glitch
        }
    }
}
