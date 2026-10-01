import Foundation
import WatchConnectivity
import WebKit

// Only plans and live telemetry cross this bridge. No account tokens are sent to Watch.
//
// One hub for the process, activated at LAUNCH by the app delegate. A live
// message from the Watch can wake this app in the background with no window,
// and what the Watch queued — a workout's final state included — is handed
// over once a session is active; a session only the web view created existed
// for neither. The web view attaches to the hub later.
@MainActor
final class WatchBridge: NSObject, WCSessionDelegate, WKScriptMessageHandler {
    static let shared = WatchBridge()
    weak var webView: WKWebView?
    private let liveActivity = WorkoutLiveActivity()
    private var activated = false
    /// The newest workout state seen, by the Watch's own clock. A final state
    /// queued while the phone was out of reach can arrive late, and must not
    /// end a workout that has started since.
    private var newestState: Double = 0

    // Declared so the stored defaults above are built on the main actor, as
    // the class is; nothing is activated here — that waits for activate().
    override init() { super.init() }

    /// Called from the app delegate at launch; later calls do nothing.
    func activate() {
        guard !activated else { return }
        activated = true
        liveActivity.adoptExisting()
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    /// Back in the foreground: pick up a Live Activity an earlier process left
    /// on the lock screen, and end one the Watch stopped updating long ago.
    func cameToForeground() {
        liveActivity.adoptExisting()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.host == "wrought.fit",
              message.frameInfo.securityOrigin.protocol == "https",
              let body = message.body as? [String: Any] else { return }
        if body["action"] as? String == "status" { status(); return }
        guard let raw = body["plan"], let data = try? JSONSerialization.data(withJSONObject: raw),
              let plan = try? JSONDecoder().decode(WorkoutPlan.self, from: data), plan.valid else {
            emit(["type": "watchStatus", "message": "This workout plan is not valid."]); return
        }
        if let problem = blocker() {
            emit(["type": "watchStatus", "message": problem]); return
        }
        do {
            // Stamped, so the Watch can tell a send from the replay of the last
            // one: the same plan sent again on purpose — after an edit on the
            // Watch — is taken, and a relaunch's replay is not.
            try WCSession.default.updateApplicationContext(["plan": data, "sentAt": Date().timeIntervalSince1970])
            emit(["type": "watchStatus", "message": "Plan queued for your Watch. Open WROUGHT there and check the rounds before starting."])
        } catch { emit(["type": "watchStatus", "message": "Plan could not be sent: \(error.localizedDescription)"]) }
    }

    /// What stands between this iPhone and the Watch app, said as it is. One
    /// sentence used to cover all three, so somebody with no Apple Watch was
    /// told to install a Watch app.
    private func blocker() -> String? {
        guard WCSession.isSupported() else { return "This iPhone can't connect to an Apple Watch." }
        let session = WCSession.default
        if session.activationState != .activated {
            return "Still connecting to your Apple Watch. Try again in a moment."
        }
        if !session.isPaired { return "No Apple Watch is paired with this iPhone." }
        if !session.isWatchAppInstalled {
            return "Wrought isn't on your Apple Watch yet. In the Watch app on this iPhone, install it from Available Apps."
        }
        return nil
    }

    private func status() {
        let problem = blocker()
        emit(["type": "watchStatus", "installed": problem == nil,
              "reachable": problem == nil && WCSession.default.isReachable,
              "message": problem ?? "Watch companion installed. Open WROUGHT on your Watch to train."])
    }

    private func emit(_ payload: [String: Any]) {
        guard webView?.url?.host == "wrought.fit", webView?.url?.scheme == "https",
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('wrought-watch', {detail: \(json)}));", completionHandler: nil)
    }

    /// A live message and a queued transfer carry the same state and are
    /// handled the same way.
    private func receiveState(_ message: [String: Any]) {
        guard message["type"] as? String == "workoutState" else { return }
        if let at = message["timestamp"] as? Double {
            guard at >= newestState else { return }
            newestState = at
        }
        liveActivity.receive(message)
        emit(message)
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        Task { @MainActor in self.status() }
    }
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
    nonisolated func sessionDidDeactivate(_ session: WCSession) { session.activate() }
    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        Task { @MainActor in self.receiveState(message) }
    }
    /// The Watch queues a workout's final state with transferUserInfo, which is
    /// kept and delivered once the phone can be reached again — a live message
    /// sent while it was out of reach is simply lost.
    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        Task { @MainActor in self.receiveState(userInfo) }
    }
}
