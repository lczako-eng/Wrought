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
    /// The server refused the key itself — revoked, or unknown to it. The key
    /// has already been forgotten when this is thrown.
    case keyRefused

    var errorDescription: String? {
        switch self {
        case .badResponse(let code, let body): return "Server said \(code): \(body)"
        case .noKey: return "No device key yet — connect first."
        case .keyRefused: return "Wrought no longer accepts this phone's key."
        }
    }
}

enum IngestClient {
    private static let base = URL(string: "https://wrought.fit")!
    private static let keychainAccount = "fit.wrought.ingest-key"
    /// The account the key was minted for: the user id (`sub`) of the page
    /// session that minted it. Kept beside the key so a different account
    /// signing in on the page can be noticed.
    private static let ownerAccount = "fit.wrought.ingest-key.owner"

    static func storedKey() -> String? {
        Keychain.read(account: keychainAccount)
    }

    static func storedOwner() -> String? {
        Keychain.read(account: ownerAccount)
    }

    /// Drops the key and its owner. The courier, Siri and the connect card all
    /// read the Keychain, so from here the app is simply not connected.
    static func forgetKey() {
        Keychain.remove(account: keychainAccount)
        Keychain.remove(account: ownerAccount)
    }

    /// Drops the key only if it is still the one a refused request carried.
    /// A key minted while that request was in flight — another account
    /// signed in on the page — is not the key that was refused. True when it
    /// was dropped.
    @discardableResult
    static func forgetKey(ifStill sent: String) -> Bool {
        guard storedKey() == sent else { return false }
        forgetKey()
        return true
    }

    /// True when the server refused the KEY — the only case where it is
    /// forgotten. Both doors answer an unknown or revoked key with
    /// `invalid_key`. A 403 for a suspended account (`membership_revoked`),
    /// or a 401 from a captive portal or proxy, says nothing about the key,
    /// and dropping a good key there would disconnect somebody for nothing.
    static func refusesKey(status: Int, body: Data) -> Bool {
        guard status == 401 || status == 403 else { return false }
        let out = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        let error = out?["error"] as? String
        return error == "invalid_key" || error == "missing_key"
    }

    /// The user id inside a Supabase session token. Only compared, never
    /// trusted for anything: the server checks the token itself when it mints.
    static func subject(ofSessionToken token: String) -> String? {
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { return nil }
        var payload = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while payload.count % 4 != 0 { payload += "=" }
        guard let data = Data(base64Encoded: payload),
              let claims = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let sub = claims["sub"] as? String, !sub.isEmpty else { return nil }
        return sub
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
        if let owner = subject(ofSessionToken: sessionToken) {
            Keychain.write(account: ownerAccount, value: owner)
        } else {
            Keychain.remove(account: ownerAccount)
        }
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
            // A revoked key used to be kept forever: every send failed, the
            // connect card never came back, and nothing could mint a new one.
            if refusesKey(status: code, body: data), forgetKey(ifStill: key) {
                throw IngestError.keyRefused
            }
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
