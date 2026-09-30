import SwiftUI

struct WatchCoachView: View {
    @EnvironmentObject var coach: WatchCoach
    @State private var confirmEnd = false
    private let heat = Color(red: 0.95, green: 0.39, blue: 0.10)
    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                Text(coach.plan.name.uppercased()).font(.caption.bold()).foregroundStyle(heat)
                if coach.running {
                    Text(coach.paused ? "PAUSED" : "\(coach.position.phase == "rest" ? "RECOVER" : "ROUND") \(coach.position.round) / \(coach.plan.rounds)")
                        .font(.caption2.monospaced()).foregroundStyle(.secondary)
                    ZStack {
                        Circle().stroke(.white.opacity(0.1), lineWidth: 7)
                        Circle().trim(from: 0, to: CGFloat(coach.position.remaining) / CGFloat(max(1, coach.position.duration)))
                            .stroke(coach.position.phase == "rest" ? .blue : heat, style: StrokeStyle(lineWidth: 7, lineCap: .round))
                            .rotationEffect(.degrees(-90))
                        Text(String(format: "%d:%02d", coach.position.remaining / 60, coach.position.remaining % 60))
                            .font(.system(size: 44, weight: .bold, design: .rounded)).monospacedDigit().minimumScaleFactor(0.6)
                    }.frame(height: 125)
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let fresh = coach.heartDate.map { context.date.timeIntervalSince($0) < 15 } ?? false
                        HStack {
                            Label(fresh ? "\(Int(coach.heartRate ?? 0))" : "—", systemImage: "heart.fill").foregroundStyle(.red)
                            Spacer()
                            Text(coach.calories.map { "\(Int($0)) kcal ≈" } ?? "— kcal").foregroundStyle(.secondary)
                        }.font(.caption.monospacedDigit())
                    }
                    Button(coach.paused ? "Resume" : "Pause") { coach.togglePause() }.tint(heat)
                    Button("End workout", role: .destructive) { confirmEnd = true }.disabled(coach.busy)
                } else {
                    Picker("Activity", selection: $coach.plan.activity) {
                        Text("Boxing").tag("boxing")
                        Text("Intervals").tag("hiit")
                        Text("Strength").tag("strength")
                        Text("Indoor run").tag("running")
                    }.disabled(coach.busy)
                    // The same limits a plan is checked against, so a plan sent
                    // from the phone is never cut down by the next tap.
                    Stepper("\(coach.plan.rounds) rounds", value: $coach.plan.rounds, in: WorkoutPlan.roundsRange)
                    Stepper("Work: \(coach.plan.workSeconds / 60)m \(coach.plan.workSeconds % 60)s", value: $coach.plan.workSeconds, in: WorkoutPlan.workRange, step: 30)
                    Stepper("Rest: \(coach.plan.restSeconds)s", value: $coach.plan.restSeconds, in: WorkoutPlan.restRange, step: 15)
                    Button(coach.busy ? "Please wait…" : "Start workout") { Task { await coach.start() } }
                        .tint(heat).disabled(coach.busy || !coach.plan.valid)
                    if !coach.plan.valid {
                        Text(whyNotValid(coach.plan)).font(.caption2).foregroundStyle(heat)
                    }
                    Text(legend(coach.plan))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Text(coach.message).font(.caption2).foregroundStyle(.secondary)
            }.padding(.horizontal, 5).disabled(coach.busy)
        }
        .confirmationDialog("End and save this workout?", isPresented: $confirmEnd) {
            Button("End and save") { Task { await coach.finish() } }
        }
    }

    /// Why Start is greyed out, rather than a button that does nothing.
    private func whyNotValid(_ plan: WorkoutPlan) -> String {
        if plan.totalSeconds > WorkoutPlan.maxTotalSeconds {
            return "Over \(WorkoutPlan.maxTotalSeconds / 3600) hours in total, the longest the timer runs. Use fewer or shorter rounds."
        }
        return "This plan can't be started. Change the rounds, work or rest."
    }

    /// What the taps mean for THIS plan, by the rules the clock plays them:
    /// the warning only when the plan has one, and with no rest a round runs
    /// straight into the next on two taps, so three come once, at the end.
    private func legend(_ plan: WorkoutPlan) -> String {
        var lines: [String] = []
        if plan.warningSeconds > 0 && plan.workSeconds > plan.warningSeconds {
            lines.append("1 tap · \(plan.warningSeconds) seconds left")
        }
        if plan.restSeconds > 0 {
            lines.append("3 taps · round done")
            lines.append("2 taps · start round")
        } else {
            lines.append("2 taps · start round, no rest")
            lines.append("3 taps · workout done")
        }
        return lines.joined(separator: "\n")
    }
}
