// ContentView.swift
// The whole UI: the website, full-bleed, plus one native card that exists only
// until the watch is connected. The website already knows how to be the
// product; the app's only visible job is the one door the web cannot open.

import SwiftUI

struct ContentView: View {
    @EnvironmentObject var courier: HealthCourier
    @State private var webView = WebViewStore()

    var body: some View {
        ZStack(alignment: .bottom) {
            WebView(store: webView)
                .ignoresSafeArea(edges: .bottom)
                .background(Color(red: 0.078, green: 0.067, blue: 0.059)) // --iron

            // The connect card. Shown until Health is feeding, then never
            // again — a settings screen that follows people around is how a
            // one-job app starts pretending to be a second product.
            if courier.state != .connected {
                connectCard
                    .padding(16)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.25), value: courier.state)
        .onAppear { courier.attach(webView: webView) }
    }

    private var connectCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("YOUR WATCH, EVERY NIGHT")
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .kerning(1.4)
                .foregroundColor(Color(red: 0.60, green: 0.55, blue: 0.52))

            Text(courier.state == .working ? "Connecting…" : courier.statusLine)
                .font(.system(size: 15))
                .foregroundColor(.white.opacity(0.92))
                .fixedSize(horizontal: false, vertical: true)

            Button {
                Task { await courier.connect() }
            } label: {
                Text(courier.state == .working ? "Working…" : "Connect Apple Health")
                    .font(.system(size: 16, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                    .background(Color(red: 0.949, green: 0.392, blue: 0.098)) // --heat-3
                    .foregroundColor(Color(red: 0.10, green: 0.04, blue: 0.01))
                    .cornerRadius(9)
            }
            .disabled(courier.state == .working)

            // Honesty over polish: when something is wrong, the card says what,
            // in words, rather than dimming a button and leaving a mystery.
            if let err = courier.lastError {
                Text(err)
                    .font(.system(size: 12.5))
                    .foregroundColor(Color(red: 0.91, green: 0.45, blue: 0.30))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(18)
        .background(Color(red: 0.106, green: 0.086, blue: 0.078)) // --scale
        .overlay(
            RoundedRectangle(cornerRadius: 13)
                .stroke(Color(red: 0.20, green: 0.17, blue: 0.15), lineWidth: 1)
        )
        .cornerRadius(13)
        .shadow(color: .black.opacity(0.5), radius: 18, y: 8)
    }
}
