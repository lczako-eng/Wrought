import ActivityKit
import UIKit

@MainActor
final class WorkoutLiveActivity {
    private var activity: Activity<WorkoutActivity>?
    private var lastUpdate = Date.distantPast
    private var lastPhase = ""
    func receive(_ data: [String: Any]) {
        guard let running = data["running"] as? Bool else { return }
        if !running {
            if let current = activity { Task { await current.end(nil, dismissalPolicy: .immediate) } }
            activity = nil; return
        }
        guard let round = data["round"] as? Int, let rounds = data["rounds"] as? Int,
              let remaining = data["remaining"] as? Int, let phase = data["phase"] as? String else { return }
        let paused = data["paused"] as? Bool ?? false
        let key = "\(round)-\(phase)-\(paused)"
        guard key != lastPhase || Date().timeIntervalSince(lastUpdate) >= 5 else { return }
        lastPhase = key; lastUpdate = Date()
        let state = WorkoutActivity.ContentState(round: round, rounds: rounds, phase: phase, paused: paused,
                                                  remaining: remaining, endsAt: Date().addingTimeInterval(Double(remaining)))
        let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(12))
        if let current = activity { Task { await current.update(content) } }
        else if UIApplication.shared.applicationState == .active && ActivityAuthorizationInfo().areActivitiesEnabled {
            // Never enable activities for the user or claim a background request succeeded.
            activity = try? Activity.request(attributes: WorkoutActivity(name: data["name"] as? String ?? "WROUGHT"), content: content)
        }
    }
}
