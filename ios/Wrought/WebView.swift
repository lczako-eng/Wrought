// WebView.swift
// The website, framed. wrought.fit/app.html IS the statistics house — every
// screen here is the same code the browser gets, drawn from the same server,
// so the app and the site can never tell two stories about the same Tuesday.
//
// The store exists so native code can ask the page for one thing: the signed-in
// session token, used once to mint the device key for the Health courier. The
// page is never scripted beyond that read — the app frames the website, it
// does not puppet it.

import SwiftUI
import WebKit

@MainActor
final class WebViewStore: NSObject, ObservableObject {
    let webView: WKWebView

    override init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()   // cookies + localStorage persist, so sign-in survives relaunch
        config.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.078, green: 0.067, blue: 0.059, alpha: 1)
        webView.scrollView.backgroundColor = webView.backgroundColor
        super.init()
        webView.navigationDelegate = self
        // The native shell persists cookies and localStorage, but the HTML is
        // deliberately fetched fresh. Otherwise relaunching the app can revive
        // an old interface from WebKit's protocol cache after the site shipped.
        let request = URLRequest(
            url: URL(string: "https://wrought.fit/app.html")!,
            cachePolicy: .reloadIgnoringLocalCacheData
        )
        webView.load(request)
    }

    /// The Supabase session access token, read from the page's own storage.
    /// The project ref in the storage key differs per deploy, so keys are
    /// scanned rather than assumed.
    func sessionToken() async -> String? {
        let js = """
        (() => {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (/^sb-.*-auth-token$/.test(k)) {
              try { return JSON.parse(localStorage.getItem(k)).access_token || null; }
              catch { return null; }
            }
          }
          return null;
        })()
        """
        return await withCheckedContinuation { cont in
            webView.evaluateJavaScript(js) { result, _ in
                cont.resume(returning: result as? String)
            }
        }
    }
}

extension WebViewStore: WKNavigationDelegate {
    // Stay inside the product. Anything leaving wrought.fit — the privacy page
    // links out, exports, OAuth providers — opens in the real browser, which is
    // also the honest place for Google and Apple sign-in: both refuse embedded
    // web views, and pretending otherwise fails with an error page nobody can
    // act on. Email + password works fully in-app.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.allow) }
        if let host = url.host, host == "wrought.fit" || host.hasSuffix(".supabase.co") {
            decisionHandler(.allow)
        } else if navigationAction.navigationType == .linkActivated {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
        } else {
            decisionHandler(.allow)
        }
    }
}

struct WebView: UIViewRepresentable {
    let store: WebViewStore

    func makeUIView(context: Context) -> WKWebView {
        let refresh = UIRefreshControl()
        refresh.addTarget(context.coordinator, action: #selector(Coordinator.reload), for: .valueChanged)
        store.webView.scrollView.refreshControl = refresh
        return store.webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(store: store) }

    final class Coordinator {
        let store: WebViewStore
        init(store: WebViewStore) { self.store = store }
        @objc func reload() {
            if let url = store.webView.url {
                store.webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
            } else {
                store.webView.reload()
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                self.store.webView.scrollView.refreshControl?.endRefreshing()
            }
        }
    }
}
