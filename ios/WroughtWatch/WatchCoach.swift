import Foundation
import HealthKit
import WatchKit
import WatchConnectivity
import Combine

@MainActor
final class WatchCoach: NSObject, ObservableObject {
    @Published var plan = WorkoutPlan.boxing
    @Published var position = RoundClock(plan: .boxing).position(elapsed: 0)
    @Published var running = false
    @Published var paused = false
    @Published var busy = false
    @Published var heartRate: Double?
    @Published var heartDate: Date?
    @Published var calories: Double?
    @Published var message = "Choose your rounds or send a plan from WROUGHT on iPhone."
    private let health = HKHealthStore()
    private var workout: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?
    private var timer: Timer?
    private var pulseTask: Task<Void, Never>?
    private var startedUptime: TimeInterval = 0
    private var elapsedBeforePause: TimeInterval = 0
    private var lastPosition: RoundClock.Position?
    private var finishing = false
    private var finishedAt: Date?
    private var pendingPlan: WorkoutPlan?
    private var elapsed: TimeInterval { elapsedBeforePause + (running && !paused ? ProcessInfo.processInfo.systemUptime - startedUptime : 0) }

    override init() {
        super.init()
        if let data = UserDefaults.standard.data(forKey: "workoutPlan"),
           let saved = try? JSONDecoder().decode(WorkoutPlan.self, from: data), saved.valid { plan = saved }
        position = RoundClock(plan: plan).position(elapsed: 0)
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func start() async {
        guard !running, !busy, plan.valid else { return }
        busy = true
        defer { busy = false }
        do {
            let hr = HKQuantityType.quantityType(forIdentifier: .heartRate)!
            let energy = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned)!
            try await health.requestAuthorization(toShare: [HKObjectType.workoutType(), energy], read: [hr, energy])
            let config = HKWorkoutConfiguration()
            switch plan.activity {
            case "hiit": config.activityType = .highIntensityIntervalTraining
            case "strength": config.activityType = .traditionalStrengthTraining
            case "running": config.activityType = .running
            default: config.activityType = .boxing
            }
            config.locationType = .indoor
            let session = try HKWorkoutSession(healthStore: health, configuration: config)
            let live = session.associatedWorkoutBuilder()
            session.delegate = self
            live.delegate = self
            live.dataSource = HKLiveWorkoutDataSource(healthStore: health, workoutConfiguration: config)
            workout = session
            builder = live
            let now = Date()
            session.startActivity(with: now)
            try await live.beginCollection(at: now)
            elapsedBeforePause = 0
            startedUptime = ProcessInfo.processInfo.systemUptime
            heartRate = nil; heartDate = nil; calories = nil
            running = true; paused = false; finishing = false; finishedAt = nil; lastPosition = nil
            message = "Watch controls the workout."
            tick()
            timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.tick() }
            }
        } catch {
            workout?.end(); builder?.discardWorkout(); workout = nil; builder = nil
            message = "Could not start: \(error.localizedDescription)"
        }
    }

    func togglePause() {
        guard running, !finishing, !busy else { return }
        if paused {
            startedUptime = ProcessInfo.processInfo.systemUptime
            paused = false; workout?.resume()
        } else {
            elapsedBeforePause = elapsed
            paused = true; workout?.pause(); pulseTask?.cancel()
        }
        publish()
    }

    private func tick() {
        guard running, !paused, !finishing else { return }
        let clock = RoundClock(plan: plan)
        let next = clock.position(elapsed: elapsed)
        let cue = clock.cue(from: lastPosition, to: next)
        position = next
        if cue > 0 { pulse(cue) }
        if lastPosition != next { publish() }
        lastPosition = next
        if next.phase == "complete" {
            // Keep the workout entitlement active until all three final taps play.
            // The saved collection still ends at the actual round boundary.
            finishedAt = Date().addingTimeInterval(-max(0, elapsed - Double(plan.totalSeconds)))
            timer?.invalidate(); timer = nil; busy = true
            Task { await pulseTask?.value; await finish() }
        }
    }

    private func pulse(_ count: Int) {
        pulseTask?.cancel()
        pulseTask = Task { @MainActor in
            for index in 0..<count {
                guard !Task.isCancelled else { return }
                WKInterfaceDevice.current().play(.click)
                if index < count - 1 { try? await Task.sleep(nanoseconds: 450_000_000) }
            }
        }
    }

    func finish() async {
        guard running, !finishing else { return }
        finishing = true; busy = true
        let partial = position.phase != "complete"
        elapsedBeforePause = elapsed
        running = false; paused = false
        timer?.invalidate(); timer = nil
        if partial { pulseTask?.cancel() }
        message = "Saving to Apple Health…"
        workout?.end()
        do {
            try await builder?.endCollection(at: finishedAt ?? Date())
            let saved = try await builder?.finishWorkout()
            guard saved != nil else { throw NSError(domain: "Wrought", code: 1, userInfo: [NSLocalizedDescriptionKey: "No workout receipt returned."]) }
            message = partial ? "Partial workout saved to Apple Health." : "Workout saved to Apple Health."
            message += " WROUGHT imports it through your connected iPhone."
        } catch { message = "Save failed: \(error.localizedDescription). Check Apple Health before trying again." }
        builder = nil; workout = nil; busy = false
        publish()
        if let next = pendingPlan { pendingPlan = nil; accept(next) }
    }

    private func accept(_ next: WorkoutPlan) {
        guard next.valid else { return }
        if running || busy { pendingPlan = next; return }
        plan = next
        position = RoundClock(plan: next).position(elapsed: 0)
        if let data = try? JSONEncoder().encode(next) { UserDefaults.standard.set(data, forKey: "workoutPlan") }
        message = "Plan received. Start when you are ready."
    }

    private func publish() {
        guard WCSession.default.isReachable else { return }
        var data: [String: Any] = ["type": "workoutState", "name": plan.name, "phase": position.phase,
                                  "round": position.round, "rounds": plan.rounds, "remaining": position.remaining,
                                  "duration": position.duration, "running": running, "paused": paused,
                                  "timestamp": Date().timeIntervalSince1970 * 1000, "message": message]
        if let hr = heartRate, let date = heartDate { data["heartRate"] = hr; data["heartTimestamp"] = date.timeIntervalSince1970 * 1000 }
        if let energy = calories { data["calories"] = energy }
        WCSession.default.sendMessage(data, replyHandler: nil, errorHandler: { _ in })
    }
}

extension WatchCoach: HKWorkoutSessionDelegate, HKLiveWorkoutBuilderDelegate {
    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didChangeTo toState: HKWorkoutSessionState, from fromState: HKWorkoutSessionState, date: Date) {
        Task { @MainActor in
            guard self.running, !self.finishing else { return }
            if toState == .paused && !self.paused {
                self.elapsedBeforePause = self.elapsed; self.paused = true; self.pulseTask?.cancel(); self.publish()
            } else if toState == .running && self.paused {
                self.startedUptime = ProcessInfo.processInfo.systemUptime; self.paused = false; self.publish()
            } else if toState == .ended { await self.finish() }
        }
    }
    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        Task { @MainActor in
            self.timer?.invalidate(); self.pulseTask?.cancel()
            self.running = false; self.busy = false
            self.message = "Workout interrupted: \(error.localizedDescription). Check Apple Health for your record."
            self.publish()
        }
    }
    nonisolated func workoutBuilderDidCollectEvent(_ workoutBuilder: HKLiveWorkoutBuilder) {}
    nonisolated func workoutBuilder(_ workoutBuilder: HKLiveWorkoutBuilder, didCollectDataOf collectedTypes: Set<HKSampleType>) {
        Task { @MainActor in
            for type in collectedTypes {
                guard let quantity = type as? HKQuantityType, let stats = workoutBuilder.statistics(for: quantity) else { continue }
                if quantity.identifier == HKQuantityTypeIdentifier.heartRate.rawValue,
                   let value = stats.mostRecentQuantity()?.doubleValue(for: HKUnit.count().unitDivided(by: .minute())) {
                    self.heartRate = value; self.heartDate = stats.mostRecentQuantityDateInterval()?.end
                }
                if quantity.identifier == HKQuantityTypeIdentifier.activeEnergyBurned.rawValue {
                    self.calories = stats.sumQuantity()?.doubleValue(for: .kilocalorie())
                }
            }
            self.publish()
        }
    }
}

extension WatchCoach: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        if let data = session.receivedApplicationContext["plan"] as? Data { receive(data) }
    }
    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        if let data = applicationContext["plan"] as? Data { receive(data) }
    }
    nonisolated private func receive(_ data: Data) {
        guard let plan = try? JSONDecoder().decode(WorkoutPlan.self, from: data), plan.valid else { return }
        Task { @MainActor in self.accept(plan) }
    }
}
