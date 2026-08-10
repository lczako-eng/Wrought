// scripts/apple-secret.mjs
// Turns the .p8 Apple gave you into the string Supabase actually wants.
//
//   node scripts/apple-secret.mjs \
//     --team A1B2C3D4E5 \
//     --services fit.wrought.signin \
//     --p8 ~/Downloads/AuthKey_ABC1234567.p8
//
// WHY THIS EXISTS. Supabase's Apple provider has two boxes — Client IDs and
// "Secret Key (for OAuth)" — and no field for a team ID or a key ID. Everybody
// pastes the .p8 into the second box and everybody gets an unreadable failure,
// because that box does not want the key. It wants a short-lived token SIGNED
// with the key, carrying the team ID and the key ID inside it. The tell is on
// the page itself: "Apple OAuth secret keys expire every 6 months." A private
// key does not expire. A token does.
//
// Apple documents the shape (Generate and validate tokens): an ES256 JWT with
// the key id in the header, the team id as issuer, the Services ID as subject,
// and appleid.apple.com as audience. Six months is the ceiling Apple enforces.
//
// No dependency, same reason as lib/push.js: this is a fully specified,
// deterministic construction, so it can be built against the specification
// rather than trusted because a package is popular. The one non-obvious line
// is dsaEncoding — node signs ECDSA as DER by default and JWT requires the raw
// r||s pair, which is the failure that reads as "invalid_client" from Apple
// with nothing else to go on.
//
// SIX MONTHS FROM TODAY THIS STOPS WORKING and Sign in with Apple breaks on the
// web with no warning from anybody. Run it again and paste the new value in.
// The .p8 does not change — keep it, Apple only lets you download it once.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}

const die = (msg) => { console.error(`\n${msg}\n`); process.exit(1); };

// ~ is the shell's, not node's — an unexpanded tilde in a quoted path is the
// most likely reason this cannot find a file that is plainly sitting there.
const p8Path = (args.p8 || '').replace(/^~(?=$|\/)/, os.homedir());

if (!args.team || !args.services || !p8Path) {
  die(`Usage:

  node scripts/apple-secret.mjs --team <TEAM ID> --services <SERVICES ID> --p8 <path to AuthKey_*.p8> [--key <KEY ID>]

  --team      10 characters, developer.apple.com → Membership details
  --services  the Services ID, e.g. fit.wrought.signin — NOT the App ID
  --p8        the key file Apple let you download exactly once
  --key       only needed if the file has been renamed; otherwise it is read
              out of AuthKey_XXXXXXXXXX.p8`);
}

if (!fs.existsSync(p8Path)) die(`No file at ${p8Path}`);

// The key id is in the filename Apple ships, so asking for it again is asking
// somebody to read ten random characters off a screen for no reason.
const keyId = args.key || (path.basename(p8Path).match(/AuthKey_([A-Z0-9]{10})\.p8/i) || [])[1];
if (!keyId) die('Could not read the key ID from the filename. Pass it with --key.');

const pem = fs.readFileSync(p8Path, 'utf8');
if (!/-----BEGIN PRIVATE KEY-----/.test(pem)) {
  die(`${p8Path} does not look like a private key. Open it in a PLAIN text editor —
Preview and Word rewrite the quotes and drop the newlines, and the result fails
with an error that says nothing about the file.`);
}

let key;
try { key = crypto.createPrivateKey(pem); }
catch (e) { die(`That key would not load: ${e.message}`); }

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

const now = Math.floor(Date.now() / 1000);
// Apple's ceiling is 15777000 seconds. Stay a day inside it rather than
// discovering the boundary is exclusive at the moment sign-in breaks.
const exp = now + 15777000 - 86400;

const header = { alg: 'ES256', kid: keyId };
const claims = {
  iss: args.team,
  iat: now,
  exp,
  aud: 'https://appleid.apple.com',
  sub: args.services,
};

const signing = `${b64(header)}.${b64(claims)}`;
const sig = crypto.createSign('SHA256')
  .update(signing)
  .sign({ key, dsaEncoding: 'ieee-p1363' })
  .toString('base64url');

const jwt = `${signing}.${sig}`;
const until = new Date(exp * 1000).toISOString().slice(0, 10);

console.log(`\nPaste this into Supabase → Authentication → Providers → Apple → "Secret Key (for OAuth)":\n`);
console.log(jwt);
console.log(`\nAnd in "Client IDs" put: ${args.services}`);
console.log(`\nValid until ${until}. Sign in with Apple stops working on the web that day,`);
console.log(`silently. Run this again with the same .p8 and paste the new value in.\n`);
