import Foundation

// Wire format shared by the browser, iPhone and Watch. No guessed loads or calories.
struct WorkoutPlan: Codable, Equatable {
    var name: String
    var rounds: Int
    var workSeconds: Int
    var restSeconds: Int
    var warningSeconds: Int
    var activity: String = "boxing"
    static let boxing = WorkoutPlan(name: "Boxing", rounds: 8, workSeconds: 180, restSeconds: 60, warningSeconds: 30)
    var valid: Bool {
        !name.isEmpty && name.count <= 80 && (1...30).contains(rounds)
        && (10...1800).contains(workSeconds) && (0...600).contains(restSeconds)
        && (0...60).contains(warningSeconds)
        && ["boxing", "hiit", "strength", "running"].contains(activity)
        && rounds * workSeconds + (rounds - 1) * restSeconds <= 14400
    }
    var totalSeconds: Int { rounds * workSeconds + (rounds - 1) * restSeconds }
}

// Pure clock, tested without HealthKit. Repaint frequency never determines time.
struct RoundClock {
    let plan: WorkoutPlan
    struct Position: Equatable {
        var phase: String
        var round: Int
        var remaining: Int
        var duration: Int
        var key: String { "\(round)-\(phase)" }
    }
    func position(elapsed: TimeInterval) -> Position {
        let seconds = max(0, Int(elapsed.rounded(.down)))
        if seconds >= plan.totalSeconds {
            return Position(phase: "complete", round: plan.rounds, remaining: 0, duration: 0)
        }
        let cycle = plan.workSeconds + plan.restSeconds
        let round = seconds / cycle + 1
        let offset = seconds % cycle
        if offset < plan.workSeconds {
            return Position(phase: "work", round: round, remaining: plan.workSeconds - offset, duration: plan.workSeconds)
        }
        return Position(phase: "rest", round: round, remaining: cycle - offset, duration: plan.restSeconds)
    }
    // Never replay old cues after suspension. Only the current transition matters.
    func cue(from old: Position?, to new: Position) -> Int {
        if old?.key != new.key { return new.phase == "work" ? 2 : 3 }
        if new.phase == "work", plan.workSeconds > plan.warningSeconds,
           plan.warningSeconds > 0, new.remaining <= plan.warningSeconds,
           (old?.remaining ?? 0) > plan.warningSeconds { return 1 }
        return 0
    }
}
