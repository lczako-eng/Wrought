import ActivityKit
import SwiftUI
import WidgetKit

@main struct WroughtWidgets: WidgetBundle {
    var body: some Widget { WorkoutWidget() }
}
struct WorkoutWidget: Widget {
    private let heat = Color(red: 0.95, green: 0.39, blue: 0.1)
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: WorkoutActivity.self) { context in
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Text("WROUGHT · \(context.attributes.name)").font(.caption.bold()).foregroundStyle(heat)
                    Text(context.isStale ? "Check your Watch" : "\(context.state.phase == "rest" ? "Recovery" : "Round") \(context.state.round) / \(context.state.rounds)")
                        .font(.headline)
                    Text(context.state.paused ? "Paused on Watch" : "Controlled from your Watch").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Countdown(state: context.state, stale: context.isStale).font(.system(size: 36, weight: .bold, design: .rounded))
            }.padding(20).activityBackgroundTint(Color(red: 0.08, green: 0.067, blue: 0.059))
                .activitySystemActionForegroundColor(.white)
                .widgetURL(URL(string: "wrought://workout"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Text(context.attributes.name).foregroundStyle(heat) }
                DynamicIslandExpandedRegion(.trailing) { Text("\(context.state.round)/\(context.state.rounds)").monospacedDigit() }
                DynamicIslandExpandedRegion(.center) { Countdown(state: context.state, stale: context.isStale).font(.title.bold()) }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(context.isStale ? "Open WROUGHT on your Watch" : context.state.paused ? "Paused" : context.state.phase == "rest" ? "Recover" : "Round in progress").font(.caption)
                }
            } compactLeading: { Image(systemName: "figure.boxing").foregroundStyle(heat) }
              compactTrailing: { Countdown(state: context.state, stale: context.isStale).frame(width: 48).font(.caption.monospacedDigit()) }
              minimal: { Text("\(context.state.round)").foregroundStyle(heat) }
              .widgetURL(URL(string: "wrought://workout"))
        }
    }
}
private struct Countdown: View {
    let state: WorkoutActivity.ContentState
    let stale: Bool
    var body: some View {
        if stale { Text("—") }
        else if state.paused { Text(String(format: "%d:%02d", state.remaining / 60, state.remaining % 60)).monospacedDigit() }
        else { Text(timerInterval: Date()...max(Date(), state.endsAt), countsDown: true, showsHours: false).monospacedDigit() }
    }
}
