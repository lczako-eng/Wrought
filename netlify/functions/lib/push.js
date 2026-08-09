// netlify/functions/lib/push.js
// Web push, by hand.
//
// The service worker's push handler has been sitting there finished for a
// while, waiting for something to actually send it a message. This is that.
//
// WHY NO LIBRARY. Everything else in this project runs on node:crypto and the
// Supabase client and nothing else, and web push is a fully specified,
// deterministic algorithm — RFC 8291 for the payload encryption, RFC 8292 for
// the VAPID signature. Both publish test vectors, which means this can be
// checked offline against the spec itself rather than trusted because a package
// has a lot of downloads. The harness runs RFC 8291's vector on every push.
//
// WHAT IT MEANS FOR PRIVACY. The push service — Google, Apple, Mozilla — routes
// the message but never sees it. The payload is encrypted to a key pair the
// browser generated and only the browser holds. This matters more here than for
// most products: the message is a line about somebody's eating and training, and
// it passes through infrastructure belonging to a company that is not us.

import crypto from 'node:crypto';

const b64u = buf => Buffer.from(buf).toString('base64url');
const fromB64u = s => Buffer.from(String(s), 'base64url');

// ── VAPID ───────────────────────────────────────────────────────────────────
// Proves to the push service that this is the same server that the browser
// subscribed to, and gives them somebody to contact when something is wrong.

function jwkFromRaw({ publicKey, privateKey }) {
  const pub = fromB64u(publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('VAPID public key must be 65 uncompressed bytes');
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) };
  if (privateKey) jwk.d = b64u(fromB64u(privateKey));
  return jwk;
}

export function vapidHeader({ endpoint, publicKey, privateKey, subject, ttlSeconds = 12 * 3600, now = Date.now() }) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({
    aud,
    exp: Math.floor(now / 1000) + ttlSeconds,
    sub: subject,
  }));
  const signingInput = `${header}.${body}`;

  const key = crypto.createPrivateKey({ key: jwkFromRaw({ publicKey, privateKey }), format: 'jwk' });
  // ieee-p1363 gives the raw r||s pair. Node signs DER by default, and a DER
  // signature here is rejected by every push service with a 401 that says
  // nothing about why.
  const sig = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });

  return {
    Authorization: `vapid t=${signingInput}.${b64u(sig)}, k=${publicKey}`,
  };
}

// ── Payload encryption, RFC 8291 ────────────────────────────────────────────

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// HKDF, the two-step form the spec is written in.
function hkdf(salt, ikm, info, length) {
  const prk = hmac(salt, ikm);
  return hmac(prk, Buffer.concat([Buffer.from(info), Buffer.from([0x01])])).subarray(0, length);
}

// `senderKeys` and `salt` exist only so the RFC's test vector can be run
// against this. Real sends always generate both fresh — reusing either would
// leak the plaintext of every message sent under the same pair.
export function encryptPayload({ payload, p256dh, auth, senderKeys = null, salt = null, recordSize = 4096 }) {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  const realSalt = salt ? fromB64u(salt) : crypto.randomBytes(16);

  const ecdh = crypto.createECDH('prime256v1');
  if (senderKeys) ecdh.setPrivateKey(fromB64u(senderKeys.privateKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();

  const sharedSecret = ecdh.computeSecret(uaPublic);

  // The receiver's key comes first in key_info, and getting that order wrong
  // produces a message that encrypts cleanly and decrypts to noise on a phone
  // you cannot debug.
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'), uaPublic, asPublic,
  ]);
  const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);

  const cek = hkdf(realSalt, ikm, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = hkdf(realSalt, ikm, 'Content-Encoding: nonce\0', 12);

  const plaintext = Buffer.from(payload, 'utf8');
  // 0x02 marks the last record. 0x01 would mean "more follows" and the browser
  // would sit waiting for a record that never comes.
  const padded = Buffer.concat([plaintext, Buffer.from([0x02])]);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(recordSize, 0);
  const head = Buffer.concat([realSalt, rs, Buffer.from([asPublic.length]), asPublic]);

  return Buffer.concat([head, body]);
}

// ── Sending ─────────────────────────────────────────────────────────────────

export function vapidConfigured() {
  return !!(process.env.WROUGHT_VAPID_PUBLIC && process.env.WROUGHT_VAPID_PRIVATE);
}

export const vapidPublicKey = () => process.env.WROUGHT_VAPID_PUBLIC || null;

// Returns { ok, status, gone }. `gone` means the browser threw the subscription
// away — uninstalled, permission revoked, cleared data — and the row should be
// deleted rather than retried forever.
export async function sendPush(sub, message, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!vapidConfigured()) return { ok: false, status: 0, gone: false, reason: 'vapid_not_configured' };

  const publicKey = process.env.WROUGHT_VAPID_PUBLIC;
  const privateKey = process.env.WROUGHT_VAPID_PRIVATE;
  const subject = process.env.WROUGHT_VAPID_SUBJECT || 'mailto:hello@wrought.fit';

  let body;
  try {
    body = encryptPayload({ payload: JSON.stringify(message), p256dh: sub.p256dh, auth: sub.auth });
  } catch (e) {
    return { ok: false, status: 0, gone: true, reason: `bad_subscription: ${e.message}` };
  }

  let res;
  try {
    res = await fetchImpl(sub.endpoint, {
      method: 'POST',
      headers: {
        ...vapidHeader({ endpoint: sub.endpoint, publicKey, privateKey, subject, now }),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        // Two hours. A verdict about last night is worthless on Thursday, and
        // a push service holding it that long is a notification that arrives
        // for a day the user has already lived.
        TTL: '7200',
        Urgency: 'normal',
      },
      body,
    });
  } catch (e) {
    return { ok: false, status: 0, gone: false, reason: e.message };
  }

  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    gone: res.status === 404 || res.status === 410,
  };
}
