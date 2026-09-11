import SwiftUI

@main
struct WroughtWatchApp: App {
    @StateObject private var coach = WatchCoach()
    var body: some Scene {
        WindowGroup { WatchCoachView().environmentObject(coach).preferredColorScheme(.dark) }
    }
}
