// public/in-app.js
// IS THIS PAGE INSIDE AN APP'S WEB VIEW? One answer, for every page that has
// to behave differently there — the button that asks the phone to send, the
// Google door, the notifications panel, export. Each page used to be able to
// work it out for itself, and two copies of a test like this is how two pages
// end up disagreeing about where they are.
//
// The Wrought iPhone app registers its bridges from build 13 (wroughtSync,
// wroughtWatch). Build 12 registers none, so the tell there is an iOS page
// whose user agent carries no "Safari/" token and that is not a Home Screen
// install. Another app's in-app browser matches that too, and shares every
// limit this answer is used for: Google refuses to sign in there, there is no
// web push, and a download has nowhere to go. So whatever a page says on the
// strength of it must be true inside any app, not only inside ours.
//
// A classic script, not a module: if it fails to load, the pages read the
// answer as "not in an app" and behave as the website, rather than failing.
window.wroughtInApp = function wroughtInApp() {
  const bridges = window.webkit?.messageHandlers || {};
  const ua = navigator?.userAgent || '';
  return !!bridges.wroughtSync || !!bridges.wroughtWatch
    || (/iPhone|iPad|iPod/.test(ua) && !/Safari\//.test(ua) && !navigator?.standalone);
};
