// netlify/functions/lib/redirect.js
// Which addresses an assistant may ask to be sent back to after sign-in.
//
// The sign-in page finishes by sending the browser to the redirect address the
// client registered, with the code on it. Registration is open to anybody — it
// has to be, that is how ChatGPT and Claude add a connector — so the address is
// a stranger's string until something checks it. A `javascript:` address is
// not a place: navigating to it RUNS it, on wrought.fit, where the person's
// sign-in is kept. One registered client and one tap on Connect would have
// handed somebody else the whole record. Found by the scenario simulator.
//
// The rule, from OAuth 2.1 and RFC 8252: https anywhere; plain http only to
// this machine (local development clients); a native app's own private
// scheme ("cursor://…", "com.example.app:/cb"); never a scheme that runs,
// embeds or opens something; never a fragment, never credentials in the URL.
// Checked at registration, again when a code is minted (for anything
// registered before this rule existed), and again on the page itself.

const NEVER = new Set([
  'javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:', 'filesystem:',
  'ws:', 'wss:', 'ftp:', 'mailto:', 'tel:', 'sms:', 'intent:', 'view-source:', 'chrome:', 'jar:',
]);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Null when the address is a fine place to send somebody back to; otherwise why not. Pure. */
export function redirectRefusal(uri) {
  const raw = String(uri ?? '').trim();
  if (!raw) return 'empty';
  if (raw.length > 2000) return 'too long';
  // Control characters and whitespace inside an address are how a scheme check
  // gets slipped past ("java\tscript:").
  if (/[\u0000-\u0020\u007f]/.test(raw)) return 'contains spaces or control characters';
  let u;
  try { u = new URL(raw); } catch { return 'not an address'; }
  const scheme = u.protocol.toLowerCase();
  if (NEVER.has(scheme)) return `the ${scheme} scheme is never a place to send somebody`;
  if (u.hash) return 'carries a fragment';
  if (u.username || u.password) return 'carries credentials';
  if (scheme === 'https:') return u.hostname ? null : 'has no host';
  if (scheme === 'http:') return LOOPBACK.has(u.hostname.toLowerCase()) ? null : 'plain http is only for this machine';
  // A native app's private scheme: letters first, then letters, digits, + . -
  return /^[a-z][a-z0-9+.-]*:$/.test(scheme) ? null : 'not a recognised scheme';
}
