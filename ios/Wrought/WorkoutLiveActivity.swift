import ActivityKit
import UIKit

@MainActor
final class WorkoutLiveActivity {
    /// How long after the phase it last showed has ended an activity may sit
    /// before it is taken as abandoned. The Watch updates it every few seconds
    /// while in touch, so this much silence means the workout ended out of
    /// reach or the process that started it is gone — and ActivityKit would
    /// otherwise leave it on the lock screen for hours.
    private static let grace: TimeInterval = 10 * 60
    private var activity: Activity<WorkoutActivity>?
    private var lastUpdate = Date.distantPast
    private var lastPhase = ""

    /// At launch and on every return to the foreground. A relaunched process
    /// holds no handle, so it adopts the activity already on the lock screen
    /// instead of requesting a second one; anything abandoned, or a duplicate,
    /// is ended at once.
    func adoptExisting() {
        let now = Date()
        var kept: Activity<WorkoutActivity>?
        for existing in Activity<WorkoutActivity>.activities {
            if existing.activityState == .ended || existing.activityState == .dismissed { continue }
            let abandoned = now > existing.content.state.endsAt.addingTimeInterval(Self.grace)
            if abandoned || kept != nil {
                Task { await existing.end(nil, dismissalPolicy: .immediate) }
            } else {
                kept = existing
            }
        }
        activity = kept
    }

    func receive(_ data: [String: Any]) {
        guard let running = data["running"] as? Bool else { return }
        if !running {
            // Every activity, not only the one this process holds: after a
            // relaunch it holds none, and the one on the lock screen stayed.
            for existing in Activity<WorkoutActivity>.activities {
                Task { await existing.end(nil, dismissalPolicy: .immediate) }
            }
            activity = nil; lastPhase = ""; return
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
        // Swiped away or ended by the system: updating it does nothing, so it
        // is let go and, in the foreground, a fresh one is asked for below.
        if let current = activity, current.activityState == .ended || current.activityState == .dismissed {
            activity = nil
        }
        if let current = activity { Task { await current.update(content) } }
        else if UIApplication.shared.applicationState == .active && ActivityAuthorizationInfo().areActivitiesEnabled {
            // Never enable activities for the user or claim a background request succeeded.
            activity = try? Activity.request(attributes: WorkoutActivity(name: data["name"] as? String ?? "WROUGHT"), content: content)
        }
    }
}
