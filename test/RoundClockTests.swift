import Foundation
@main struct RoundClockTests {
    static func main() {
        let plan = WorkoutPlan.boxing, clock = RoundClock(plan: .boxing)
        precondition(plan.valid && plan.totalSeconds == 1860)
        precondition(clock.cue(from: nil, to: clock.position(elapsed: 0)) == 2)
        precondition(clock.cue(from: clock.position(elapsed: 149), to: clock.position(elapsed: 150)) == 1)
        precondition(clock.cue(from: clock.position(elapsed: 150), to: clock.position(elapsed: 151)) == 0)
        precondition(clock.cue(from: clock.position(elapsed: 179), to: clock.position(elapsed: 180)) == 3)
        precondition(clock.cue(from: clock.position(elapsed: 239), to: clock.position(elapsed: 240)) == 2)
        precondition(clock.position(elapsed: 1860).phase == "complete")
        for count in 1...30 {
            let plan = WorkoutPlan(name: "Boxing", rounds: count, workSeconds: 60, restSeconds: 30, warningSeconds: 30)
            let clock = RoundClock(plan: plan)
            var last: RoundClock.Position?, counts = [0,0,0,0]
            for second in 0...plan.totalSeconds {
                let next = clock.position(elapsed: Double(second))
                counts[clock.cue(from: last, to: next)] += 1
                last = next
            }
            precondition(counts[1] == count && counts[2] == count && counts[3] == count)
        }
        let data = try! JSONEncoder().encode(plan)
        precondition(try! JSONDecoder().decode(WorkoutPlan.self, from: data) == plan)
        print("Swift RoundClock: exact 1/3/2 sequences, all 30 round counts, final completion and wire format passed.")
    }
}
