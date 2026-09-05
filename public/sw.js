// public/sw.js
// The service worker — what turns the website into something installable on a
// phone, on both platforms, with no App Store and no review.
//
// The installable website is the complete product. The optional iPhone shell
// frames this same page and adds only what the browser cannot reach: HealthKit
// background delivery and locked-phone Siri shortcuts. One web deploy updates
// both surfaces; the native build never becomes a second dashboard.
//
// The caching is deliberately timid. A fitness log is worthless if it shows you
// yesterday's numbers with confidence, so anything carrying data is network
// first and only falls back to cache when the network genuinely fails.

const SHELL = 'wrought-shell-v7';

// Only the frame: markup, icons, manifest. No API responses ever.
const SHELL_FILES = [
  '/app.html',
  '/connect.html',
  '/shell.css',
  '/app-info.json',
  // The morning notification opens this launcher — it carries no data, so it is
  // pure shell, and a tap that fails to load on bad wifi is the whole feature
  // gone. Precached so it opens even offline.
  '/go.html',
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
      .then(keys => Promise.all(keys
        .filter(k => k.startsWith('wrought-shell-') && k !== SHELL)
        .map(k => caches.delete(k))))
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

  // The marketing page and the recovery route are mutable documents, not app
  // shell. Keeping either in Cache Storage is how a deployed redesign can be
  // perfectly live on the server and still look unchanged on a saved icon.
  // Network-only here; the installed product itself remains available offline.
  const alwaysFresh = url.pathname === '/'
    || url.pathname === '/index.html'
    || url.pathname === '/refresh.html'
    || url.pathname === '/sw.js';
  if (alwaysFresh) {
    const fresh = new Request(e.request, { cache: 'no-store' });
    e.respondWith(fetch(fresh).catch(() => e.request.mode === 'navigate'
      ? new Response(OFFLINE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      : Response.error()));
    return;
  }

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
background:#F0E8DA;color:#171411;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
text-align:center;padding:28px}p{color:#9A8D84;margin:8px 0 0;font-size:14px}
h1{font-family:Rockwell,"Roboto Slab",Georgia,serif;font-size:26px;margin:0;letter-spacing:.02em}
button{margin-top:20px;padding:13px 20px;border:1px solid #171411;border-radius:0;background:#F26419;
color:#171411;box-shadow:4px 4px 0 #171411;font:inherit;font-weight:700;font-size:15px;cursor:pointer}</style>
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
      const wanted = new URL(target, self.location.origin);
      // A Daily Close hash is a real destination. If the app is already open
      // on /app.html, navigate that window to the card instead of opening a
      // duplicate merely because the fragments differ.
      for (const w of wins) {
        const current = new URL(w.url);
        if (current.origin === wanted.origin && current.pathname === wanted.pathname) {
          if (current.href === wanted.href && 'focus' in w) return w.focus();
          if ('navigate' in w) return w.navigate(wanted.href).then(client => client?.focus());
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
