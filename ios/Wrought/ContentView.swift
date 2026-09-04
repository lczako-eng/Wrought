// ContentView.swift
// The whole UI: the website, full-bleed, plus one native card that exists only
// until the watch is connected. The website already knows how to be the
// product; the app's only visible job is the one door the web cannot open.

import SwiftUI

struct ContentView: View {
    @EnvironmentObject var courier: HealthCourier
    @StateObject private var webView = WebViewStore()

    var body: some View {
        ZStack(alignment: .bottom) {
            LinearGradient(
                colors: [
                    Color(red: 0.16, green: 0.12, blue: 0.10),
                    Color(red: 0.078, green: 0.067, blue: 0.059)
                ],
                startPoint: .topTrailing,
                endPoint: .bottomLeading
            )
            .ignoresSafeArea()

            WebView(store: webView)
                .ignoresSafeArea(edges: .bottom)
                .background(Color.clear)

            // The connect card. Shown until Health is feeding, then never
            // again — a settings screen that follows people around is how a
            // one-job app starts pretending to be a second product.
            if courier.state != .connected {
                connectCard
                    .padding(.horizontal, 16)
                    .padding(.bottom, 12)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.25), value: courier.state)
        .onAppear { courier.attach(webView: webView) }
    }

    private var connectCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 11)
                        .fill(
                            LinearGradient(
                                colors: [
                                    Color(red: 0.96, green: 0.65, blue: 0.14),
                                    Color(red: 0.95, green: 0.39, blue: 0.10)
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                    Image(systemName: "heart.text.square.fill")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundColor(Color(red: 0.10, green: 0.04, blue: 0.01))
                }
                .frame(width: 42, height: 42)

                VStack(alignment: .leading, spacing: 3) {
                    Text("APPLE HEALTH COURIER")
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .kerning(1.2)
                        .foregroundColor(Color(red: 0.65, green: 0.59, blue: 0.55))
                    Text("Make the phone do the logging")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundColor(.white.opacity(0.96))
                }

                Spacer(minLength: 8)

                Text("1 TAP")
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .kerning(0.8)
                    .foregroundColor(Color(red: 0.96, green: 0.65, blue: 0.14))
                    .padding(.horizontal, 9)
                    .padding(.vertical, 7)
                    .background(Color(red: 0.95, green: 0.39, blue: 0.10).opacity(0.10))
                    .clipShape(Capsule())
            }

            Text(courier.state == .working ? "Connecting…" : courier.statusLine)
                .font(.system(size: 14))
                .foregroundColor(Color(red: 0.66, green: 0.60, blue: 0.56))
                .fixedSize(horizontal: false, vertical: true)

            Button {
                Task { await courier.connect() }
            } label: {
                Text(courier.state == .working ? "Working…" : "Connect Apple Health")
                    .font(.system(size: 16, weight: .bold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(
                        LinearGradient(
                            colors: [
                                Color(red: 0.96, green: 0.65, blue: 0.14),
                                Color(red: 0.95, green: 0.39, blue: 0.10)
                            ],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .foregroundColor(Color(red: 0.10, green: 0.04, blue: 0.01))
                    .clipShape(Capsule())
            }
            .disabled(courier.state == .working)
            .opacity(courier.state == .working ? 0.72 : 1)

            // Honesty over polish: when something is wrong, the card says what,
            // in words, rather than dimming a button and leaving a mystery.
            if let err = courier.lastError {
                Text(err)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundColor(Color(red: 0.91, green: 0.45, blue: 0.30))
                    .fixedSize(horizontal: false, vertical: true)
            }

            // The receipt. An absence of workouts and a silent app look exactly
            // the same from here, and telling those two apart used to mean
            // asking somebody to read a database. Now it is a line on a card.
            if let sync = courier.lastSync {
                Text(sync)
                    .font(.system(size: 11.5, weight: .medium, design: .monospaced))
                    .foregroundColor(Color(red: 0.36, green: 0.56, blue: 0.69)) // --temper
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(20)
        .background(
            LinearGradient(
                colors: [
                    Color(red: 0.20, green: 0.16, blue: 0.14).opacity(0.98),
                    Color(red: 0.10, green: 0.08, blue: 0.07).opacity(0.99)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
        .overlay(
            RoundedRectangle(cornerRadius: 24)
                .stroke(Color.white.opacity(0.09), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 24))
        .shadow(color: .black.opacity(0.56), radius: 28, y: 14)
    }
}
