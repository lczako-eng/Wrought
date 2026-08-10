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

    private let store = HKHealthStore()
    private weak var web: WebViewStore?

    var statusLine: String {
        switch state {
        case .connected: return "Connected — your watch reports in on its own."
        case .failed:    return "Not connected yet."
        default:         return "Steps, burn, heart rate, weight and sleep — read the way the Health app reads them, sent to your record automatically."
        }
    }

    private var readTypes: Set<HKObjectType> {
        var t = Set<HKObjectType>()
        for id: HKQuantityTypeIdentifier in [.stepCount, .activeEnergyBurned, .restingHeartRate, .bodyMass] {
            if let q = HKObjectType.quantityType(forIdentifier: id) { t.insert(q) }
        }
        if let sleep = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) { t.insert(sleep) }
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
        if let (bpm, at) = await latest(.restingHeartRate, unit: HKUnit.count().unitDivided(by: .minute()), within: 2) {
            metrics.append(["metric": "resting_hr", "value": bpm.rounded(), "unit": "bpm", "measured_at": iso.string(from: at)])
        }
        if let (kg, at) = await latest(.bodyMass, unit: .gramUnit(with: .kilo), within: 365) {
            metrics.append(["metric": "weight_kg", "value": (kg * 100).rounded() / 100, "unit": "kg", "measured_at": iso.string(from: at)])
        }
        if let sleep = await lastNightSleepMinutes() {
            metrics.append(["metric": "sleep_minutes", "value": sleep.rounded(), "unit": "min", "measured_at": now])
        }

        guard !metrics.isEmpty else { return }
        do { try await IngestClient.post(metrics: metrics) }
        catch { lastError = "Send failed: \(error.localizedDescription)" }
    }

    /// The phone wakes this app when Health changes — the thing no website,
    /// Shortcut or nightly alarm can be. Hourly is plenty: the server keeps
    /// one total per day however often it hears.
    private func registerBackgroundDelivery() {
        for id: HKQuantityTypeIdentifier in [.stepCount, .activeEnergyBurned] {
            guard let type = HKObjectType.quantityType(forIdentifier: id) else { continue }
            let query = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, done, _ in
                Task { await self?.sendToday() }
                done()
            }
            store.execute(query)
            store.enableBackgroundDelivery(for: type, frequency: .hourly) { _, _ in }
        }
    }
}
