import Foundation
import WatchConnectivity
import WebKit

// Only plans and live telemetry cross this bridge. No account tokens are sent to Watch.
@MainActor
final class WatchBridge: NSObject, WCSessionDelegate, WKScriptMessageHandler {
    weak var webView: WKWebView?
    private let liveActivity = WorkoutLiveActivity()
    override init() {
        super.init()
        if WCSession.isSupported() { WCSession.default.delegate = self; WCSession.default.activate() }
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
        let session = WCSession.default
        guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else {
            emit(["type": "watchStatus", "message": "Install the WROUGHT Watch companion first, then try again."]); return
        }
        do {
            try session.updateApplicationContext(["plan": data])
            emit(["type": "watchStatus", "message": "Plan queued for your Watch. Open WROUGHT there and check the rounds before starting."])
        } catch { emit(["type": "watchStatus", "message": "Plan could not be sent: \(error.localizedDescription)"]) }
    }
    private func status() {
        let session = WCSession.default
        emit(["type": "watchStatus", "installed": session.isWatchAppInstalled,
              "reachable": session.isReachable, "message": session.isWatchAppInstalled
                ? "Watch companion installed. Open WROUGHT on your Watch to train."
                : "The Watch companion needs to be installed with this iPhone build."])
    }
    private func emit(_ payload: [String: Any]) {
        guard webView?.url?.host == "wrought.fit", webView?.url?.scheme == "https",
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('wrought-watch', {detail: \(json)}));", completionHandler: nil)
    }
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        Task { @MainActor in self.status() }
    }
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
    nonisolated func sessionDidDeactivate(_ session: WCSession) { session.activate() }
    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        guard message["type"] as? String == "workoutState" else { return }
        Task { @MainActor in self.liveActivity.receive(message); self.emit(message) }
    }
}
