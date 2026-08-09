# Signing in — many doors, one account

WROUGHT has three ways in, and every one of them arrives at the same rows.

| Door | What it costs to run | What the user does |
|---|---|---|
| **Apple** | Apple Developer Program, **US$99/year** | Looks at their phone. Face ID, done. |
| **Google** | Free | One tap, picks an account. |
| **Email and password** | Free | Types both. |

Apple is listed first everywhere on purpose. On an iPhone it is a glance at the
screen — no address to type, no password to recall — and that is the difference
between opening this in a gym and not bothering.

---

## Why this is not just a convenience feature

A person is one training history. They are **not** one email address.

The founder's exact worry: *"even though your GTP might have a different email.
You're gonna have to link it to."* He is right, and the failure it describes is
the worst one this product has. Sign into wrought.fit with Google, let ChatGPT
connect under some other address, and there are now two accounts holding half a
life each. Nothing errors. Nothing looks broken. It looks like you did nothing
for three weeks — on a product whose entire promise is that it remembers.

So there are three defences, in order of preference:

1. **Prevention.** `authorize.html` — the screen ChatGPT sends people to — says
   plainly to come in the same way they do at wrought.fit, and offers the same
   three doors so that is easy to obey.
2. **Linking.** Dashboard → **Account** → *Link Apple* / *Link Google*. Adds a
   door to the account you are already in. Never creates a second account, never
   moves anything.
3. **Merging.** For when the split already happened. Same screen, lower down.

## Merging, and why it asks for so much

Merging needs a **live token for each of the two accounts** — not an email
address, not a user id. An email is guessable and a user id is printed inside
every JWT; either one alone would turn `/api/merge` into a way to read a
stranger's health record. There is no version of this that takes one token.

Two ways to prove the second account:

- **It has a password** — type its email and password. A throwaway Supabase
  client with its own storage does the sign-in, so the account you are keeping
  is never signed out.
- **It uses Apple or Google** — *Prove it with Apple/Google*. The browser has to
  leave and come back, so the surviving account's token is stashed first.

Then `schema/006_wrought_identity.sql` does the move in **one transaction**.
Every table, including the live OAuth grants — which is the line that matters:
**ChatGPT keeps working and starts writing to the account that survived, with
nothing to reconnect.**

Rows that both accounts already held (the same night's sleep, pushed twice)
stay one row. Nothing is doubled and nothing is dropped that was not already
there.

Afterwards the emptied account is **deleted**. An empty duplicate is not
harmless — sign in through that door next week and you are staring at a blank
record for the second time. Deleting it also frees its Apple or Google identity,
so it can be linked to the surviving account and become one more way in.

---

## Setup — what has to be switched on

### 1. Supabase, one migration

Run `schema/006_wrought_identity.sql` in the SQL editor. Without it, merging
returns `migration_006_not_run` and says so by name.

### 2. Supabase → Authentication → Settings

- **Enable manual linking** — ON. Without it the Account screen cannot read or
  add sign-in methods.
- **Redirect URLs** — add `https://wrought.fit/**`. Providers refuse to come
  back to a URL that is not on this list.
- **Site URL** — `https://wrought.fit`.
- **Confirm email** — OFF, so a password signup is instant rather than sending
  the link the whole change was meant to remove.

### 3. Google — free, about ten minutes

1. Google Cloud Console → **APIs & Services → Credentials → Create OAuth client
   ID → Web application**.
2. Authorised redirect URI: `https://<your-project>.supabase.co/auth/v1/callback`
   (Supabase shows the exact string on its Google provider page).
3. Paste the client ID and secret into Supabase → Authentication → Providers →
   Google, and enable it.

### 4. Apple — US$99/year, about half an hour

Needs a paid **Apple Developer Program** membership. There is no free tier for
Sign in with Apple on the web.

1. Apple Developer → **Certificates, Identifiers & Profiles**.
2. An **App ID** with *Sign in with Apple* enabled.
3. A **Services ID** — this is what Supabase calls the client ID. Its return URL
   is `https://<your-project>.supabase.co/auth/v1/callback`.
4. A **Sign in with Apple key** (.p8). Keep the key ID and your team ID.
5. Supabase → Authentication → Providers → Apple: Services ID, team ID, key ID,
   and the .p8 contents.

Until each provider is switched on, its button says so in as many words —
*"Apple sign-in is not switched on in Supabase yet"* — rather than failing with
something unreadable.

---

## What was considered and not built

**Passkeys.** Face ID unlocking wrought.fit directly, no provider in the middle,
free on Android too. It is the better long-term answer and Supabase has no
native support for it, so it would mean hand-rolling WebAuthn registration,
challenge storage and verification. Sign in with Apple gets the same Face ID
experience today for the price of a developer account. Revisit if that
membership is ever not worth renewing.

**Auto-merging two accounts that share an email.** Supabase already links
identities when a provider returns a *verified* email matching an existing
account, which covers the common case. Going further — merging on an unverified
email — would mean anybody who can create a Google account with your address
inherits your health record. Not worth it.
