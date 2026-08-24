// HealthCourier.swift
// The reason this app exists as an app.
//
// HKStatisticsQuery returns Apple's OWN deduplicated totals — phone and watch
// reconciled, the literal number on the watch face. Shortcuts exposes only raw
// per-device samples, which is why a hand-built Shortcut counted one Sunday as
// 33,000 steps. This file is the fix: native statistics, background delivery,
// and a POST to the same /ingest door everything else uses.
//
// The server treats steps / active energy as daily totals that REPLACE their
// day (never stack), so sending on every wake is safe by design — the newest
// claim about today wins, however many times today gets claimed.

import Foundation
import HealthKit

@MainActor
final class HealthCourier: ObservableObject {
    enum State { case idle, working, connected, failed }

    @Published var state: State = .idle
    @Published var lastError: String?
    /// What the last send actually achieved, in one line. Not decoration — an
    /// absence of workouts and a silent app look exactly the same, and telling
    /// those two apart used to take a week.
    @Published var lastSync: String?

    private let store = HKHealthStore()
    private weak var web: WebViewStore?

    var statusLine: String {
        switch state {
        case .connected: return "Connected — your watch reports in on its own."
        case .failed:    return "Not connected yet."
        default:         return "Steps, distance, stand hours, exercise minutes, flights, burn, workouts, heart rate, HRV, VO2 max, weight and sleep — read the way the Health app reads them, sent to your record automatically."
        }
    }

    // ── Everything the watch actually keeps ─────────────────────────────
    //
    // The founder: "all the matrix that is captured by this watch should be on
    // that app — like times standing on your feet. There's so many things that
    // could be on there."
    //
    // Declared as tables rather than a wall of if-lets so that adding a metric
    // is one line in one place and the permission list can never drift out of
    // step with what is actually sent — a type read without permission returns
    // nothing at all, silently, which looks exactly like a person who does not
    // own that sensor.
    //
    // The split is between quantities that ADD UP over a day and readings that
    // are a point in time. Summing a heart rate is meaningless; taking the
    // latest step count throws the day away.

    struct Metric {
        let id: HKQuantityTypeIdentifier
        let name: String
        let unit: HKUnit
        let label: String
        var days: Int = 2          // how far back a latest-reading may look
        var round: Double = 1      // decimal places, as a power of ten
    }

    private static let hzPerMin = HKUnit.count().unitDivided(by: .minute())

    static let DAILY_TOTALS: [Metric] = [
        .init(id: .activeEnergyBurned, name: "active_calories", unit: .kilocalorie(), label: "kcal"),
        // Apple's own resting figure. Sent so it can sit BESIDE our estimate
        // rather than replace it — Apple derives it from height, weight and age
        // exactly as we do, so it is a second opinion, not a measurement.
        .init(id: .basalEnergyBurned, name: "resting_calories", unit: .kilocalorie(), label: "kcal"),
        .init(id: .appleExerciseTime, name: "active_minutes", unit: .minute(), label: "min"),
        .init(id: .appleStandTime, name: "stand_minutes", unit: .minute(), label: "min"),
        .init(id: .flightsClimbed, name: "flights", unit: .count(), label: "count"),
        .init(id: .distanceCycling, name: "distance_cycling_km", unit: .meterUnit(with: .kilo), label: "km", round: 100),
        .init(id: .distanceSwimming, name: "distance_swimming_km", unit: .meterUnit(with: .kilo), label: "km", round: 100),
        .init(id: .dietaryWater, name: "water_ml", unit: .literUnit(with: .milli), label: "mL"),
    ]

    static let LATEST_READINGS: [Metric] = [
        .init(id: .restingHeartRate, name: "resting_hr", unit: hzPerMin, label: "bpm"),
        .init(id: .walkingHeartRateAverage, name: "walking_hr", unit: hzPerMin, label: "bpm", days: 7),
        .init(id: .heartRateVariabilitySDNN, name: "hrv", unit: .secondUnit(with: .milli), label: "ms"),
        .init(id: .heartRateRecoveryOneMinute, name: "hr_recovery", unit: hzPerMin, label: "bpm", days: 14),
        .init(id: .vo2Max, name: "vo2max",
              unit: HKUnit(from: "ml/kg*min"), label: "ml/kg/min", days: 60, round: 10),
        .init(id: .respiratoryRate, name: "respiratory_rate", unit: hzPerMin, label: "count/min", days: 7, round: 10),
        // HealthKit hands percentages back as a FRACTION — 0.97, not 97. The
        // server converts anything at or under 1, but sending the honest
        // HealthKit unit means it converts once and cannot double up.
        .init(id: .oxygenSaturation, name: "spo2", unit: .percent(), label: "fraction", days: 7, round: 1000),
        .init(id: .bodyFatPercentage, name: "body_fat_pct", unit: .percent(), label: "fraction", days: 365, round: 1000),
        .init(id: .leanBodyMass, name: "lean_mass_kg", unit: .gramUnit(with: .kilo), label: "kg", days: 365, round: 100),
        .init(id: .bodyMassIndex, name: "bmi", unit: .count(), label: "count", days: 365, round: 10),
        .init(id: .waistCircumference, name: "waist_cm", unit: .meterUnit(with: .centi), label: "cm", days: 365, round: 10),
        // Gait. Recorded as trends against their own history and NEVER read
        // back as a clinical sign — Apple's steadiness ships with a fall-risk
        // label attached, and repeating that would be a diagnosis.
        .init(id: .walkingSpeed, name: "walking_speed",
              unit: HKUnit.meter().unitDivided(by: .second()), label: "m/s", days: 7, round: 100),
        .init(id: .walkingStepLength, name: "step_length", unit: .meterUnit(with: .centi), label: "cm", days: 7, round: 10),
        .init(id: .walkingAsymmetryPercentage, name: "walking_asymmetry", unit: .percent(), label: "fraction", days: 7, round: 1000),
        .init(id: .walkingDoubleSupportPercentage, name: "double_support", unit: .percent(), label: "fraction", days: 7, round: 1000),
        .init(id: .appleWalkingSteadiness, name: "steadiness", unit: .percent(), label: "fraction", days: 30, round: 1000),
        .init(id: .sixMinuteWalkTestDistance, name: "six_min_walk", unit: .meter(), label: "m", days: 60),
        .init(id: .stairAscentSpeed, name: "stair_speed",
              unit: HKUnit.meter().unitDivided(by: .second()), label: "m/s", days: 14, round: 100),
        .init(id: .environmentalAudioExposure, name: "sound_exposure", unit: .decibelAWeightedSoundPressureLevel(), label: "dBASPL", days: 2, round: 10),
    ]

    private var readTypes: Set<HKObjectType> {
        var t = Set<HKObjectType>()
        for id in Self.DAILY_TOTALS.map(\.id) + Self.LATEST_READINGS.map(\.id)
            + [HKQuantityTypeIdentifier.stepCount, .bodyMass, .heartRate, .distanceWalkingRunning] {
            if let q = HKObjectType.quantityType(forIdentifier: id) { t.insert(q) }
        }
        if let sleep = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) { t.insert(sleep) }
        // Stand hours and mindful minutes are CATEGORY samples, not quantities
        // — asking for them as quantities silently returns nothing, which is
        // the worst failure shape: permission granted, data never arrives.
        if let stand = HKObjectType.categoryType(forIdentifier: .appleStandHour) { t.insert(stand) }
        if let mind = HKObjectType.categoryType(forIdentifier: .mindfulSession) { t.insert(mind) }
        // The workouts themselves — a run is not a number, it is a session, and
        // it belongs in the training matrix next to the lifting.
        t.insert(HKObjectType.workoutType())
        return t
    }

    func attach(webView: WebViewStore) {
        web = webView
        if IngestClient.storedKey() != nil {
            state = .connected
            registerBackgroundDelivery()
            Task { await sendToday() }
        }
    }

    /// The whole handshake, in order, each step explaining itself on failure:
    /// session token from the page → device key minted → Health permission →
    /// first send → background delivery armed.
    func connect() async {
        guard HKHealthStore.isHealthDataAvailable() else {
            lastError = "This device has no Health data."
            state = .failed; return
        }
        state = .working
        lastError = nil

        // 1. The key. Minted with the SAME account the website is signed into,
        // read from the page itself — so the app can never feed a different
        // account than the one on screen. The silent-fork lesson, applied.
        if IngestClient.storedKey() == nil {
            guard let token = await web?.sessionToken() else {
                lastError = "Sign in on the page first — the app feeds the account you're signed into."
                state = .failed; return
            }
            do { try await IngestClient.mintKey(sessionToken: token) }
            catch {
                lastError = "Could not get a device key: \(error.localizedDescription)"
                state = .failed; return
            }
        }

        // 2. Permission. Apple shows the sheet once; a denial later is fixed in
        // Settings → Health → Data Access, and the error says so.
        do { try await store.requestAuthorization(toShare: [], read: readTypes) }
        catch {
            lastError = "Health access was not granted. Settings → Health → Data Access & Devices → Wrought."
            state = .failed; return
        }

        // 3. First send, so "did it work" is answered now, not at 11pm.
        await sendToday()

        // 4. From here the phone wakes this code itself when new data lands.
        registerBackgroundDelivery()
        state = .connected
    }

    // MARK: - Reading, the honest way

    private func todayInterval() -> (Date, Date) {
        let cal = Calendar.current
        return (cal.startOfDay(for: Date()), Date())
    }

    /// Deduplicated cumulative total for today — the watch-face number.
    private func total(_ id: HKQuantityTypeIdentifier, unit: HKUnit) async -> Double? {
        guard let type = HKQuantityType.quantityType(forIdentifier: id) else { return nil }
        let (start, end) = todayInterval()
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
        return await withCheckedContinuation { cont in
            let q = HKStatisticsQuery(quantityType: type, quantitySamplePredicate: predicate,
                                      options: .cumulativeSum) { _, stats, _ in
                cont.resume(returning: stats?.sumQuantity()?.doubleValue(for: unit))
            }
            store.execute(q)
        }
    }

    /// Most recent sample — for the point-in-time readings.
    private func latest(_ id: HKQuantityTypeIdentifier, unit: HKUnit, within days: Int) async -> (Double, Date)? {
        guard let type = HKQuantityType.quantityType(forIdentifier: id) else { return nil }
        let predicate = HKQuery.predicateForSamples(
            withStart: Calendar.current.date(byAdding: .day, value: -days, to: Date()), end: Date())
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
        return await withCheckedContinuation { cont in
            let q = HKSampleQuery(sampleType: type, predicate: predicate, limit: 1, sortDescriptors: [sort]) { _, samples, _ in
                guard let s = samples?.first as? HKQuantitySample else { return cont.resume(returning: nil) }
                cont.resume(returning: (s.quantity.doubleValue(for: unit), s.startDate))
            }
            store.execute(q)
        }
    }

    /// Hours today with at least a minute of standing in them — the blue ring.
    ///
    /// A category sample rather than a quantity, so no statistics query can
    /// reach it. Apple records one sample per hour with a stood/idle value;
    /// counting the stood ones IS the ring, which is why this is worth the
    /// separate code path rather than approximating it from stand minutes.
    private func standHoursToday() async -> Double? {
        guard let type = HKObjectType.categoryType(forIdentifier: .appleStandHour) else { return nil }
        let (start, end) = todayInterval()
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
        return await withCheckedContinuation { cont in
            let q = HKSampleQuery(sampleType: type, predicate: predicate,
                                  limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, _ in
                let stood = (samples as? [HKCategorySample] ?? [])
                    .filter { $0.value == HKCategoryValueAppleStandHour.stood.rawValue }.count
                cont.resume(returning: stood > 0 ? Double(stood) : nil)
            }
            store.execute(q)
        }
    }

    /// Minutes of mindful session logged today, summed from the intervals.
    private func mindfulMinutesToday() async -> Double? {
        guard let type = HKObjectType.categoryType(forIdentifier: .mindfulSession) else { return nil }
        let (start, end) = todayInterval()
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
        return await withCheckedContinuation { cont in
            let q = HKSampleQuery(sampleType: type, predicate: predicate,
                                  limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, _ in
                let mins = (samples as? [HKCategorySample] ?? [])
                    .reduce(0.0) { $0 + $1.endDate.timeIntervalSince($1.startDate) / 60 }
                cont.resume(returning: mins > 0 ? mins : nil)
            }
            store.execute(q)
        }
    }

    /// Last night's sleep: asleep-stage intervals since 6pm yesterday, summed.
    private func lastNightSleepMinutes() async -> Double? {
        guard let type = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else { return nil }
        let cal = Calendar.current
        guard let yesterday = cal.date(byAdding: .day, value: -1, to: Date()),
              let from = cal.date(bySettingHour: 18, minute: 0, second: 0, of: yesterday) else { return nil }
        let predicate = HKQuery.predicateForSamples(withStart: from, end: Date())
        return await withCheckedContinuation { cont in
            let q = HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, _ in
                let asleep: Set<Int> = [
                    HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue,
                    HKCategoryValueSleepAnalysis.asleepCore.rawValue,
                    HKCategoryValueSleepAnalysis.asleepDeep.rawValue,
                    HKCategoryValueSleepAnalysis.asleepREM.rawValue,
                ]
                let minutes = (samples as? [HKCategorySample] ?? [])
                    .filter { asleep.contains($0.value) }
                    .reduce(0.0) { $0 + $1.endDate.timeIntervalSince($1.startDate) / 60 }
                cont.resume(returning: minutes > 0 ? minutes : nil)
            }
            store.execute(q)
        }
    }

    // MARK: - Sending

    func sendToday() async {
        let iso = ISO8601DateFormatter()
        var metrics: [[String: Any]] = []
        let now = iso.string(from: Date())

        if let steps = await total(.stepCount, unit: .count()) {
            metrics.append(["metric": "steps", "value": steps.rounded(), "unit": "count", "measured_at": now])
        }
        if let kcal = await total(.activeEnergyBurned, unit: .kilocalorie()) {
            metrics.append(["metric": "active_calories", "value": kcal.rounded(), "unit": "kcal", "measured_at": now])
        }
        if let (kg, at) = await latest(.bodyMass, unit: .gramUnit(with: .kilo), within: 365) {
            metrics.append(["metric": "weight_kg", "value": (kg * 100).rounded() / 100, "unit": "kg", "measured_at": iso.string(from: at)])
        }
        if let sleep = await lastNightSleepMinutes() {
            // Stamped at the START OF TODAY, never `now`. A night's sleep is one
            // fact, and this courier re-sends it on every hourly delivery — with
            // `now` each re-send is a new timestamp, a new row past the dedupe
            // index, and every reader that sums a day's rows then multiplies the
            // night by the number of syncs. Sleep stays OUT of the server's
            // daily-total collapse on purpose (Health Auto Export sends real
            // per-segment rows there, and collapsing would delete most of a
            // night), so the dedupe has to come from a stable stamp here.
            let midnight = iso.string(from: Calendar.current.startOfDay(for: Date()))
            metrics.append(["metric": "sleep_minutes", "value": sleep.rounded(), "unit": "min", "measured_at": midnight])
        }
        // Ground covered on foot. Cycling and swimming go separately now — a
        // walking figure quietly containing 40km of riding is a number that
        // cannot be compared with anything, including itself last week.
        if let km = await total(.distanceWalkingRunning, unit: .meterUnit(with: .kilo)), km > 0 {
            metrics.append(["metric": "distance_km", "value": (km * 100).rounded() / 100, "unit": "km", "measured_at": now])
        }

        // Everything that adds up over a day.
        for m in Self.DAILY_TOTALS {
            guard let v = await total(m.id, unit: m.unit), v > 0 else { continue }
            metrics.append(["metric": m.name, "value": (v * m.round).rounded() / m.round,
                            "unit": m.label, "measured_at": now])
        }

        // The blue ring. A category sample, not a quantity — one entry per hour
        // that had a minute of standing in it, which is the number on the watch
        // face and the one the founder actually asked for.
        if let hours = await standHoursToday() {
            metrics.append(["metric": "stand_hours", "value": hours, "unit": "h", "measured_at": now])
        }
        if let mind = await mindfulMinutesToday() {
            metrics.append(["metric": "mindful_minutes", "value": mind.rounded(), "unit": "min", "measured_at": now])
        }

        // Point-in-time readings. A latest value, each with its own sensible
        // window — a VO2max estimate is months old and still the current one;
        // a resting heart rate from last week is not.
        for m in Self.LATEST_READINGS {
            guard let (v, at) = await latest(m.id, unit: m.unit, within: m.days) else { continue }
            metrics.append(["metric": m.name, "value": (v * m.round).rounded() / m.round,
                            "unit": m.label, "measured_at": iso.string(from: at)])
        }

        let workouts = await recentWorkouts()

        guard !metrics.isEmpty || !workouts.isEmpty else { return }
        do {
            let receipt = try await IngestClient.post(metrics: metrics, workouts: workouts)
            lastSync = receipt.line
            // A rejected write is an error even though the request succeeded.
            lastError = receipt.error == nil ? nil
                      : "Workouts were rejected by the server. Run schema/015 in Supabase."
        } catch {
            lastError = "Send failed: \(error.localizedDescription)"
        }
    }

    // MARK: - The sessions themselves

    /// Every workout the watch recorded in the last week, in the shape /ingest
    /// already understands. Each carries its HealthKit uuid as source_ref, and
    /// the server's unique index on (user, source, source_ref) means resending
    /// the same week forever can never double a run.
    private func recentWorkouts() async -> [[String: Any]] {
        let from = Calendar.current.date(byAdding: .day, value: -7, to: Date())
        let predicate = HKQuery.predicateForSamples(withStart: from, end: Date())
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
        let iso = ISO8601DateFormatter()

        let samples: [HKWorkout] = await withCheckedContinuation { cont in
            let q = HKSampleQuery(sampleType: HKObjectType.workoutType(), predicate: predicate,
                                  limit: 50, sortDescriptors: [sort]) { _, result, _ in
                cont.resume(returning: (result as? [HKWorkout]) ?? [])
            }
            store.execute(q)
        }

        return samples.map { w in
            var out: [String: Any] = [
                "kind": Self.name(for: w.workoutActivityType),
                "minutes": (w.duration / 60).rounded(),
                "occurred_at": iso.string(from: w.startDate),
                // HealthKit's own identity for this session.
                "source_ref": w.uuid.uuidString,
            ]
            // statistics(for:) rather than the deprecated totals — same numbers,
            // and it keeps working as Apple retires the old properties.
            if let d = w.statistics(for: HKQuantityType(.distanceWalkingRunning))?
                .sumQuantity()?.doubleValue(for: .meterUnit(with: .kilo)), d > 0 {
                out["distance_km"] = (d * 100).rounded() / 100
            } else if let d = w.statistics(for: HKQuantityType(.distanceCycling))?
                .sumQuantity()?.doubleValue(for: .meterUnit(with: .kilo)), d > 0 {
                out["distance_km"] = (d * 100).rounded() / 100
            }
            if let kcal = w.statistics(for: HKQuantityType(.activeEnergyBurned))?
                .sumQuantity()?.doubleValue(for: .kilocalorie()), kcal > 0 {
                out["calories"] = kcal.rounded()
            }
            // The training spike: what the heart actually did during this
            // session. Average says how hard it was; peak says whether there
            // was a top end in it. Neither is a medical reading and neither is
            // ever presented as one.
            let bpm = HKUnit.count().unitDivided(by: .minute())
            if let hr = w.statistics(for: HKQuantityType(.heartRate)) {
                if let avg = hr.averageQuantity()?.doubleValue(for: bpm), avg > 0 {
                    out["avg_hr"] = avg.rounded()
                }
                if let peak = hr.maximumQuantity()?.doubleValue(for: bpm), peak > 0 {
                    out["max_hr"] = peak.rounded()
                }
            }
            return out
        }
    }

    /// Apple's activity types are an enum; the log wants the word a person
    /// would say. Unmapped types fall back to something honest rather than a
    /// number nobody can read.
    private static func name(for type: HKWorkoutActivityType) -> String {
        switch type {
        case .running:                 return "Running"
        case .walking:                 return "Walking"
        case .hiking:                  return "Hiking"
        case .cycling:                 return "Cycling"
        case .swimming:                return "Swimming"
        case .traditionalStrengthTraining: return "Strength training"
        case .functionalStrengthTraining:  return "Functional strength"
        case .highIntensityIntervalTraining: return "HIIT"
        case .elliptical:              return "Elliptical"
        case .rowing:                  return "Rowing"
        case .stairClimbing, .stairs:  return "Stair climbing"
        case .yoga:                    return "Yoga"
        case .pilates:                 return "Pilates"
        case .coreTraining:            return "Core training"
        case .flexibility:             return "Stretching"
        case .dance, .cardioDance:     return "Dance"
        case .boxing, .kickboxing:     return "Boxing"
        case .martialArts:             return "Martial arts"
        case .soccer:                  return "Football"
        case .basketball:              return "Basketball"
        case .tennis:                  return "Tennis"
        case .golf:                    return "Golf"
        case .hockey:                  return "Hockey"
        case .climbing:                return "Climbing"
        case .mixedCardio, .crossTraining: return "Cross training"
        case .cooldown:                return "Cooldown"
        default:                       return "Workout"
        }
    }

    /// The phone wakes this app when Health changes — the thing no website,
    /// Shortcut or nightly alarm can be. Hourly is plenty: the server keeps
    /// one total per day however often it hears.
    private func registerBackgroundDelivery() {
        var watched: [HKSampleType] = [HKObjectType.workoutType()]
        for id: HKQuantityTypeIdentifier in [.stepCount, .activeEnergyBurned, .distanceWalkingRunning] {
            if let t = HKObjectType.quantityType(forIdentifier: id) { watched.append(t) }
        }
        for type in watched {
            let query = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, done, _ in
                Task { await self?.sendToday() }
                done()
            }
            store.execute(query)
            // A finished workout should land while the sweat is still on, not
            // an hour later — everything else is happy with hourly.
            let cadence: HKUpdateFrequency = (type == HKObjectType.workoutType()) ? .immediate : .hourly
            store.enableBackgroundDelivery(for: type, frequency: cadence) { _, _ in }
        }
    }
}
