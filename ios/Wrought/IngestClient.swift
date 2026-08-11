// IngestClient.swift
// The same door everything else uses. The app holds one secret — a device key
// from wrought_ingest_keys, minted with the session of the account signed in
// on the page and kept in the Keychain — and POSTs the same native shape the
// Shortcut and Health Auto Export send. No second protocol, no private API:
// /ingest is a documented public endpoint and this is just one more client.

import Foundation

enum IngestError: LocalizedError {
    case badResponse(Int, String)
    case noKey

    var errorDescription: String? {
        switch self {
        case .badResponse(let code, let body): return "Server said \(code): \(body)"
        case .noKey: return "No device key yet — connect first."
        }
    }
}

enum IngestClient {
    private static let base = URL(string: "https://wrought.fit")!
    private static let keychainAccount = "fit.wrought.ingest-key"

    static func storedKey() -> String? {
        Keychain.read(account: keychainAccount)
    }

    /// One POST to the same endpoint the connect page uses, authorized by the
    /// page's own session — so the key can only ever belong to the account on
    /// screen. Shown-once semantics live server-side; the Keychain is the only
    /// place the plaintext survives.
    static func mintKey(sessionToken: String) async throws {
        var req = URLRequest(url: base.appendingPathComponent(".netlify/functions/api-key"))
        req.httpMethod = "POST"
        req.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["label": "Wrought for iPhone"])

        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200,
              let out = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let key = out["key"] as? String else {
            throw IngestError.badResponse(code, String(data: data, encoding: .utf8) ?? "")
        }
        Keychain.write(account: keychainAccount, value: key)
    }

    /// Metrics AND workouts in one call — the endpoint takes both, and a run
    /// is not a number: it is a session that belongs in the training matrix.
    /// What the server actually did with a send.
    ///
    /// The whole reason a broken workout write survived for weeks is that
    /// nobody could see this. The endpoint answered 200, the app said nothing,
    /// and the only symptom was an absence — which looks identical to a watch
    /// that recorded nothing. A receipt costs one struct and turns "where are
    /// my workouts" into a line on the screen.
    struct Receipt {
        var metrics = 0
        var sessionsSent = 0
        var sessionsSaved = 0
        var error: String?

        var line: String {
            if let error { return "Last sync: \(sessionsSent) workouts rejected — \(error)" }
            var bits = ["\(metrics) readings"]
            if sessionsSent > 0 { bits.append("\(sessionsSaved) of \(sessionsSent) workouts saved") }
            return "Last sync: " + bits.joined(separator: ", ") + "."
        }
    }

    @discardableResult
    static func post(metrics: [[String: Any]], workouts: [[String: Any]] = []) async throws -> Receipt {
        guard let key = storedKey() else { throw IngestError.noKey }

        var body: [String: Any] = ["source": "wrought_ios"]
        if !metrics.isEmpty { body["metrics"] = metrics }
        if !workouts.isEmpty { body["workouts"] = workouts }

        var req = URLRequest(url: base.appendingPathComponent("ingest"))
        req.httpMethod = "POST"
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else {
            throw IngestError.badResponse(code, String(data: data, encoding: .utf8) ?? "")
        }

        let out = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        return Receipt(
            metrics: out["metrics_written"] as? Int ?? 0,
            sessionsSent: out["sessions_received"] as? Int ?? 0,
            sessionsSaved: out["events_written"] as? Int ?? 0,
            // A 200 with an error inside it is exactly the shape that hid the
            // bug. Read it out rather than trusting the status code.
            error: out["events_error"] as? String
        )
    }
}
