import Foundation
import HealthKit
import WatchKit
import WatchConnectivity
import Combine

@MainActor
final class WatchCoach: NSObject, ObservableObject {
    private static let planKey = "workoutPlan"
    /// The last plan taken from the phone. WatchConnectivity hands its last
    /// application context back on every launch, and a plan already taken —
    /// perhaps changed on the Watch since — is not news.
    private static let receivedKey = "receivedPlan"
    /// A workout HealthKit stops sooner than this is discarded, not saved.
    private static let tooShortToKeep: TimeInterval = 30

    /// Kept whenever it changes, so a plan edited on the Watch survives a
    /// relaunch exactly as one sent from the phone does.
    @Published var plan = WorkoutPlan.boxing {
        didSet { if plan != oldValue, plan.valid { Self.store(plan, forKey: Self.planKey) } }
    }
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
    /// True from startActivity until beginCollection returns. A failure
    /// HealthKit reports in that window is held for start() to throw.
    private var starting = false
    private var startFailure: Error?
    private var elapsed: TimeInterval { elapsedBeforePause + (running && !paused ? ProcessInfo.processInfo.systemUptime - startedUptime : 0) }

    override init() {
        super.init()
        if let saved = Self.stored(forKey: Self.planKey) { plan = saved }
        position = RoundClock(plan: plan).position(elapsed: 0)
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    private static func store(_ plan: WorkoutPlan, forKey key: String) {
        if let data = try? JSONEncoder().encode(plan) { UserDefaults.standard.set(data, forKey: key) }
    }

    private static func stored(forKey key: String) -> WorkoutPlan? {
        guard let data = UserDefaults.standard.data(forKey: key),
              let saved = try? JSONDecoder().decode(WorkoutPlan.self, from: data), saved.valid else { return nil }
        return saved
    }

    func start() async {
        guard !running, !busy, plan.valid else { return }
        busy = true
        defer { busy = false; applyPendingPlan() }
        do {
            let hr = HKQuantityType.quantityType(forIdentifier: .heartRate)!
            let energy = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned)!
            let workouts = HKObjectType.workoutType()
            try await health.requestAuthorization(toShare: [workouts, energy], read: [hr, energy])
            // The request says it was asked, not what was answered. Without
            // permission to save a workout there is nothing to start.
            switch health.authorizationStatus(for: workouts) {
            case .sharingAuthorized:
                break
            case .notDetermined:
                message = "Wrought needs permission to save workouts to Apple Health. Tap Start workout to be asked again."
                return
            default:
                message = "Wrought isn't allowed to save workouts. On your iPhone: Settings › Privacy & Security › Health › Wrought, then turn on Workouts."
                return
            }
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
            startFailure = nil
            starting = true
            let now = Date()
            session.startActivity(with: now)
            try await live.beginCollection(at: now)
            starting = false
            // HealthKit can fail the session while beginCollection is still
            // running. That failure was held here, so the clock never runs
            // against a session that has already failed.
            if let failure = startFailure { throw failure }
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
            starting = false; startFailure = nil
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
        // This runs four times a second and every assignment redraws the
        // screen, so it is assigned only when it changes.
        if next != position { position = next }
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

    /// Ends the workout and saves what was done. `interruption` is a failure
    /// HealthKit reported on its own; the part already done is still saved
    /// (or, if it had barely begun, discarded), and the message says which.
    func finish(interruptedBy interruption: Error? = nil) async {
        guard running, !finishing else { return }
        finishing = true; busy = true
        let partial = position.phase != "complete"
        elapsedBeforePause = elapsed
        let done = elapsedBeforePause
        running = false; paused = false
        timer?.invalidate(); timer = nil
        if partial { pulseTask?.cancel() }
        // Held for the whole save: it finishes the builder this workout began,
        // never one a later Start put in its place.
        let session = workout
        let live = builder
        session?.end()
        let interrupted: String? = partial ? interruption.map { "Workout interrupted: \($0.localizedDescription)." } : nil
        if let interrupted = interrupted, done < Self.tooShortToKeep {
            live?.discardWorkout()
            message = "\(interrupted) It stopped under \(Int(Self.tooShortToKeep)) seconds in, so it was discarded, not saved."
        } else {
            message = "Saving to Apple Health…"
            do {
                try await live?.endCollection(at: finishedAt ?? Date())
                let saved = try await live?.finishWorkout()
                guard saved != nil else { throw NSError(domain: "Wrought", code: 1, userInfo: [NSLocalizedDescriptionKey: "No workout receipt returned."]) }
                if let interrupted = interrupted {
                    message = "\(interrupted) The part you did is saved to Apple Health."
                } else {
                    message = partial ? "Partial workout saved to Apple Health." : "Workout saved to Apple Health."
                }
                message += " WROUGHT imports it through your connected iPhone."
            } catch {
                let said = interrupted.map { "\($0) " } ?? ""
                message = "\(said)Save failed: \(error.localizedDescription). Apple Health did not confirm a saved workout."
            }
        }
        if workout === session { workout = nil }
        if builder === live { builder = nil }
        busy = false
        publish(closing: true)
        applyPendingPlan()
    }

    private func accept(_ next: WorkoutPlan) {
        guard next.valid else { return }
        if running || busy { pendingPlan = next; return }
        apply(next, appending: false)
    }

    /// Called wherever `busy` goes back to false. A plan the phone sent while
    /// the Watch was busy is taken now, and its line is added after what the
    /// Watch just said — a save result or a start failure — never over it.
    private func applyPendingPlan() {
        guard !running, !busy, let next = pendingPlan else { return }
        pendingPlan = nil
        apply(next, appending: true)
    }

    private func apply(_ next: WorkoutPlan, appending: Bool) {
        // Already what the Watch shows, or the context WatchConnectivity
        // replays on every launch — taken once, perhaps changed here since.
        // Neither is announced, and a replay never undoes an edit.
        if next == plan || next == Self.stored(forKey: Self.receivedKey) {
            Self.store(next, forKey: Self.receivedKey)
            return
        }
        Self.store(next, forKey: Self.receivedKey)
        plan = next
        position = RoundClock(plan: next).position(elapsed: 0)
        let line = "Plan received. Start when you are ready."
        message = appending ? "\(message) \(line)" : line
    }

    /// The workout's state for the phone. A live message is simply lost while
    /// the phone is out of reach, so the closing state is ALSO queued with
    /// transferUserInfo, which the system keeps and delivers once the phone
    /// can be reached. The phone handles both the same way and ignores a state
    /// older than one it already has, so a finished workout always ends the
    /// lock-screen Live Activity.
    private func publish(closing: Bool = false) {
        let link = WCSession.default
        guard link.activationState == .activated else { return }
        var data: [String: Any] = ["type": "workoutState", "name": plan.name, "phase": position.phase,
                                  "round": position.round, "rounds": plan.rounds, "remaining": position.remaining,
                                  "duration": position.duration, "running": running, "paused": paused,
                                  "timestamp": Date().timeIntervalSince1970 * 1000, "message": message]
        if let hr = heartRate, let date = heartDate { data["heartRate"] = hr; data["heartTimestamp"] = date.timeIntervalSince1970 * 1000 }
        if let energy = calories { data["calories"] = energy }
        if closing { link.transferUserInfo(data) }
        if link.isReachable { link.sendMessage(data, replyHandler: nil, errorHandler: { _ in }) }
    }

    /// HealthKit failed the session on its own — another workout app started,
    /// or the system stopped it. Never abandoned: what was done is saved, or
    /// discarded if it had barely begun, and the message says which.
    private func sessionFailed(_ failed: HKWorkoutSession, error: Error) async {
        guard failed === workout else { return }
        // Still inside start(): there is no running workout yet. start()
        // throws this failure itself once beginCollection returns.
        if starting { startFailure = error; return }
        guard running, !finishing else { return }
        await finish(interruptedBy: error)
    }
}

extension WatchCoach: HKWorkoutSessionDelegate, HKLiveWorkoutBuilderDelegate {
    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didChangeTo toState: HKWorkoutSessionState, from fromState: HKWorkoutSessionState, date: Date) {
        Task { @MainActor in
            guard workoutSession === self.workout, self.running, !self.finishing else { return }
            if toState == .paused && !self.paused {
                self.elapsedBeforePause = self.elapsed; self.paused = true; self.pulseTask?.cancel(); self.publish()
            } else if toState == .running && self.paused {
                self.startedUptime = ProcessInfo.processInfo.systemUptime; self.paused = false; self.publish()
            } else if toState == .ended { await self.finish() }
        }
    }
    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        Task { @MainActor in await self.sessionFailed(workoutSession, error: error) }
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
