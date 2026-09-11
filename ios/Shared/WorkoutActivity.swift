#if os(iOS)
import ActivityKit
import Foundation

struct WorkoutActivity: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var round: Int
        var rounds: Int
        var phase: String
        var paused: Bool
        var remaining: Int
        var endsAt: Date
    }
    var name: String
}
#endif
