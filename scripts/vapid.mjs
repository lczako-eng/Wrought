// scripts/vapid.mjs
// Generates the one pair of keys web push needs. Run once, ever.
//
//   node scripts/vapid.mjs
//
// Paste the two values into Netlify → Site configuration → Environment
// variables. The public key is public by definition — the browser is handed it
// before it can even ask for permission. The private key signs the request that
// says "this is the same server that phone subscribed to", so it is the one
// thing here worth protecting: anyone holding it can put words on the lock
// screen of every phone registered to this site.
//
// Changing the pair later invalidates every existing subscription silently —
// nobody gets an error, notifications simply stop. Generate once and keep them.

import crypto from 'node:crypto';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = publicKey.export({ format: 'jwk' });
const priv = privateKey.export({ format: 'jwk' });

const raw = Buffer.concat([
  Buffer.from([0x04]),
  Buffer.from(pub.x, 'base64url'),
  Buffer.from(pub.y, 'base64url'),
]).toString('base64url');

console.log('\nWROUGHT_VAPID_PUBLIC  =', raw);
console.log('WROUGHT_VAPID_PRIVATE =', priv.d);
console.log('WROUGHT_VAPID_SUBJECT = mailto:laszlobrianczako@gmail.com');
console.log('\nSet all three in Netlify. Generate once — regenerating silently kills every existing subscription.\n');
