// WroughtIntents.swift
// Hands-free, from a locked phone.
//
// The founder's ask: "hey Siri, gym bro — and then gym bro knows it's on the
// mic right away, so what I'm saying is transcribing."
//
// The honest constraint first, because it shapes everything below: iOS gives
// exactly one app a wake word and it belongs to Siri. Hotword detection lives
// on a coprocessor Apple does not expose, and an app cannot sit in the
// background holding the microphone open waiting for its own phrase — it gets
// suspended, the orange indicator burns all day, the battery dies, and review
// rejects it. So the wake word is "hey Siri". What comes AFTER it is ours.
//
// INAlternativeAppNames in Info.plist is what makes "gym bro" resolve to this
// app, so the sentence a person actually says out loud is the sentence that
// works. An AppShortcut phrase must contain the app name; giving the app the
// nickname is how the name gets out of the way.
//
// Two decisions that make this usable rather than a demo:
//
//   * openAppWhenRun = false. The point is that nothing opens. Launching the
//     app would demand Face ID, throw the screen on, and lose the reason to
//     have said it hands-free in the first place.
//   * authenticationPolicy = .alwaysAllowed, so it runs with the phone locked
//     in a pocket. What that exposes is bounded on purpose: appending to your
//     own log, and hearing your own day read back. Nothing here can read the
//     record out in detail, delete anything, or reach another account — the
//     device key is one account's, minted from the session signed in on screen.
//
// Everything spoken comes back from the server already worded. Nothing in this
// file composes a sentence about somebody's training, and nothing adds up. Same
// doctrine as the connector: the server computes, the mouth relays.

import AppIntents
import Foundation

// MARK: - The read

struct SpeakBriefIntent: AppIntent {
    static var title: LocalizedStringResource = "Today's read"
    static var description = IntentDescription(
        "Reads back the day so far — roughly what went in, what went out, and where the week stands.",
        categoryName: "Wrought"
    )

    // Nothing opens. That is the whole feature.
    static var openAppWhenRun: Bool = false
    static var isDiscoverable: Bool = true
    static var authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let line = await VoiceClient.speak(action: "brief", text: nil)
        return .result(dialog: IntentDialog(stringLiteral: line))
    }
}

// MARK: - The log

struct LogAloudIntent: AppIntent {
    static var title: LocalizedStringResource = "Log what you just did"
    static var description = IntentDescription(
        "Say one sentence about what you ate, lifted, weighed or felt. It is kept exactly as you said it.",
        categoryName: "Wrought"
    )

    static var openAppWhenRun: Bool = false
    static var isDiscoverable: Bool = true
    static var authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

    // An unfilled String parameter is what makes Siri open the mic and
    // transcribe. The prompt is deliberately two words: anything longer and
    // somebody starts talking over it, and the dictation loses the first half
    // of what they said.
    @Parameter(title: "What happened", requestValueDialog: IntentDialog("Go on."))
    var note: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let said = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !said.isEmpty else {
            return .result(dialog: IntentDialog("I did not catch that."))
        }
        let line = await VoiceClient.speak(action: "log", text: said)
        return .result(dialog: IntentDialog(stringLiteral: line))
    }
}

// MARK: - The phrases

// Every phrase has to contain \(.applicationName), which is why the nicknames
// in Info.plist matter — with "Gym Bro" declared there, "hey Siri, gym bro,
// what's the damage" is a legal phrase rather than a workaround.
//
// The list is the phrasebook from SERVER_INSTRUCTIONS, cut down to what people
// actually say to a phone. Siri matches these literally, so a missing phrasing
// is a silent failure: it just says it does not understand, and somebody
// concludes the feature does not work.
struct WroughtShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: SpeakBriefIntent(),
            phrases: [
                "\(.applicationName) what's the damage",
                "What's the damage in \(.applicationName)",
                "\(.applicationName) hit me",
                "\(.applicationName) how am I doing",
                "Ask \(.applicationName) how I'm doing",
                "\(.applicationName) read me back",
            ],
            shortTitle: "Today's read",
            systemImageName: "flame"
        )

        AppShortcut(
            intent: LogAloudIntent(),
            phrases: [
                "\(.applicationName) log this",
                "Tell \(.applicationName)",
                "\(.applicationName) log it",
                "Log with \(.applicationName)",
                "\(.applicationName) write this down",
            ],
            shortTitle: "Log it",
            systemImageName: "mic.fill"
        )
    }
}

// MARK: - The wire

enum VoiceClient {
    private static let url = URL(string: "https://wrought.fit/api/voice")!

    /// One POST, and the answer is already a sentence.
    ///
    /// Every failure returns something speakable rather than throwing. A thrown
    /// error makes Siri say "there was a problem with the app", which tells
    /// somebody standing in a gym nothing at all about what to do next.
    static func speak(action: String, text: String?) async -> String {
        guard let key = IngestClient.storedKey() else {
            return "Open Wrought once to connect it, then try again."
        }

        var body: [String: Any] = ["action": action]
        if let text { body["text"] = text }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // A phone on gym wifi is a phone on bad wifi. Long enough to survive a
        // cold function start, short enough that nobody stands there waiting.
        req.timeoutInterval = 20
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            let out = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            // The server words its own failures too, including a suspended
            // account — so a spoken field is trusted whatever the status code.
            if let spoken = out?["spoken"] as? String, !spoken.isEmpty { return spoken }
            return "Something went wrong at my end."
        } catch {
            return action == "log"
                ? "I could not reach Wrought, so that did not save. Say it again when you have signal."
                : "I could not reach Wrought just now."
        }
    }
}
