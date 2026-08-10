// public/sw.js
// The service worker — what turns the website into something installable on a
// phone, on both platforms, with no App Store and no review.
//
// This is deliberately NOT a native app. iOS has supported web push from a
// home-screen app since 16.4 and Android has for years, so a PWA gets an icon,
// a splash, a standalone window with no browser chrome, and notifications on
// the lock screen — which is the entire reason to want an app here. A native
// build would take two codebases, two store accounts, two review queues and a
// release cycle to fix a typo, in exchange for almost nothing this cannot do.
//
// The caching is deliberately timid. A fitness log is worthless if it shows you
// yesterday's numbers with confidence, so anything carrying data is network
// first and only falls back to cache when the network genuinely fails.

const SHELL = 'wrought-shell-v3';

// Only the frame: markup, icons, manifest. No API responses ever.
const SHELL_FILES = [
  '/',
  '/index.html',
  '/app.html',
  '/connect.html',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/site.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Never touch anything that carries data or identity. A cached brief is a
  // wrong brief, and a cached auth response is a security problem.
  const live = url.pathname.startsWith('/api/')
    || url.pathname.startsWith('/.netlify/')
    || url.pathname.startsWith('/oauth/')
    || url.pathname.startsWith('/mcp')
    || url.pathname.startsWith('/ingest')
    || url.origin !== location.origin;

  if (live || e.request.method !== 'GET') return;

  // A page is never served from cache while the network is reachable. The
  // fetch below is already network-first, but Safari will happily hold a
  // stale HTML response — so navigations bypass the HTTP cache outright.
  // Otherwise a fix ships and the phone keeps showing the old bug, which is
  // indistinguishable from the fix not working.
  const req = e.request.mode === 'navigate'
    ? new Request(e.request, { cache: 'reload' })
    : e.request;

  e.respondWith(
    fetch(req)
      .then((res) => {
        // Keep the shell fresh whenever the network answers.
        const copy = res.clone();
        caches.open(SHELL).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(async () => {
        // ignoreSearch matters more than it looks. /app.html?merge=1 is the same
        // page as /app.html, and without this every link carrying a query string
        // is a cache miss.
        const hit = await caches.match(e.request, { ignoreSearch: true });
        if (hit) return hit;

        // Never answer a navigation with a DIFFERENT page. Tapping the home
        // screen icon and landing on the marketing homepage reads as having been
        // signed out — which, on a product whose whole promise is that it
        // remembers, is the one thing it must never fake. An honest "no network"
        // is better than a page that looks like your account is gone.
        if (e.request.mode === 'navigate') {
          return new Response(OFFLINE, {
            status: 503,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
        return Response.error();
      })
  );
});

const OFFLINE = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WROUGHT — offline</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#14110F;color:#F4EFE9;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
text-align:center;padding:28px}p{color:#9A8D84;margin:8px 0 0;font-size:14px}
h1{font-family:Rockwell,"Roboto Slab",Georgia,serif;font-size:26px;margin:0;letter-spacing:.02em}
button{margin-top:20px;padding:13px 20px;border:0;border-radius:11px;background:#F26419;
color:#1A0A02;font:inherit;font-weight:700;font-size:15px;cursor:pointer}</style>
<div><h1>No connection</h1>
<p>Your record is safe on the server. This page just cannot reach it right now.</p>
<button onclick="location.reload()">Try again</button></div>`;

// ── Push ───────────────────────────────────────────────────────────────────
// The nightly verdict on the lock screen, which is the whole point of the
// install. Nothing here composes the message: the server sends the words it
// already computed, so a notification can never disagree with the brief.
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { /* fall through to defaults */ }

  const title = data.title || 'WROUGHT';
  const body = data.body || 'Your read is ready.';

  e.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'wrought-brief',
    // Replace rather than stack. Three unread verdicts is how somebody turns
    // notifications off for good.
    renotify: false,
    data: { url: data.url || '/app.html' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = e.notification.data?.url || '/app.html';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      // Focus the app if it is already open rather than opening a second copy.
      for (const w of wins) {
        if (w.url.includes(target) && 'focus' in w) return w.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
