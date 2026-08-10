# WROUGHT — Agent Context

*Read this first. It is the persistent memory of the project.*

## What this is

**WROUGHT is the honest personal trainer that lives inside your AI.** Founder:
Laszlo (Marcus) Czako (`lczako-eng`, laszlobrianczako@gmail.com).

The origin is a real daily annoyance, and it should stay the north star: the
founder opens a **new ChatGPT page every single morning** and re-explains what
he ate versus what he did, because the model has no memory. WROUGHT is the memory
that survives the tab closing, plus a nightly read on what it all means.

**This is a separate project from Revolv / SupplAi.** Do not put WROUGHT code in
`SupplAi-Industrial` — that was an early error and was reverted. Different
product, different repo, different domain. The two share a founder and an
architectural instinct (memory is the moat, the AI is only the interface), and
nothing else.

## Doctrines (settled — do not re-litigate)

- **One sentence is a complete log.** Never a form, never "what were the macros".
  A health log that costs more than a sentence is one nobody keeps. `log` takes
  the user's words verbatim and the structured reading of them.
- **The connected model does the structuring, not us.** ChatGPT has already read
  the sentence — and the photograph of the plate, which this server never sees,
  so it is the only thing that *can* turn a picture of dinner into macros. `log`
  takes an `events` array it fills in; `parseLog` is the fallback for when it
  does not, and needs `OPENAI_API_KEY`. The founder's objection was the right
  one: *"I'm not sure why it needs an API key when you're using your own GPT
  already."* Nothing about the estimate changes — WROUGHT catches it on the way
  past and keeps it. Do not move parsing back to the server to make it
  "consistent"; that costs a key, a bill, and the photograph.
- **The brief is the product.** Logging is table stakes; a hundred apps log.
  Nobody has a thing that reads the week back to you honestly.
- **The server computes, the model relays.** Every total, average, trend, streak
  and countdown is calculated in `lib/wrought.js` and handed over with a `say`
  string. Never leave arithmetic to a language model.
- **Honest, never cruel.** Hard on the behaviour, never on the person. No
  commentary on their body. Bluntness is the user's setting (`gentle` /
  `honest` / `brutal`) and is honoured exactly.
- **Care flags outrank everything**, including the honesty doctrine. Computed
  server-side in `careFlags()`: sustained sub-1200 kcal intake, loss faster than
  1.2 kg/week, no rest in 14 days. When one fires, coaching stops. This is the
  only way this product genuinely hurts somebody — treat it as load-bearing.
- **Estimates are labelled.** Calories from a described meal are inferred. Say
  "roughly". The credibility dies the first time a guess is read as a fact.
- **Not a medical device.** No diagnosis, no reading HRV as a clinical sign, no
  medication advice. Say so and point at a doctor.

## Architecture (settled)

- **Supabase = home.** All data, RLS on every table. `wrought_events` (the human
  log, one row per thing said) and `wrought_metrics` (device time series) are
  deliberately separate — a person emits a sentence a day, a watch emits a row a
  minute, and one table makes both queries bad.
- **`local_date` is stored, not derived.** A day is a day in the user's own
  timezone. Deriving from UTC at read time files a late-night snack under
  tomorrow and corrupts every brief. This has a test.
- **`lib/wrought.js` holds all arithmetic**, apart from the protocol layer, so the
  MCP brief and the web dashboard cannot disagree. `api-progress.js` exists
  purely so the dashboard calls the same code rather than recomputing in JS.
- **MCP server**: `netlify/functions/mcp.js` at `/mcp` — stateless Streamable
  HTTP, JSON-RPC. 26 tools. Doctrines ship in `SERVER_INSTRUCTIONS`.
- **Auth**: OAuth 2.1 (PKCE, dynamic client registration) so "Sign in with
  Wrought" appears in ChatGPT/Claude. Supabase session JWTs also accepted as a
  fallback. Everything secret is stored SHA-256 hashed.
- **People sign in with an email and a password, not a link.** The founder was
  flat about it: *"I don't wanna send a link anymore. It needs to be a login
  takes people info logged in."* A magic link is less to build and it is the
  wrong trade — it puts an inbox between somebody and their own data every
  single time, and on a phone in a gym that is the difference between opening it
  and not bothering. `app.html` and `authorize.html` both sign in and create
  accounts; `connect.html` only signs in, because a second copy of a signup flow
  is a second thing to drift. **The credential error stays flat** — Supabase says
  "Invalid login credentials" for a wrong password and for an address that never
  registered alike, and separating them would let a stranger test whether
  somebody has an account on a health product. Reset still goes by email,
  because it has to. All of it has tests; the OTP call is a one-line revert that
  nothing else would notice.
- **Ingest**: `/ingest`, bearer key from `wrought_ingest_keys`, idempotent via
  unique indexes. Accepts native shape and Health Auto Export's shape.

### Many doors, one account — and the fork that must never happen

Apple, Google and a password, on all three sign-in surfaces. Apple leads because
on an iPhone it is Face ID and nothing else — the founder asked for exactly that
("the Apple facial recognition"), and it is the fastest door this product has.
Full setup in `docs/SIGN_IN.md`. Apple costs **US$99/year**; Google is free.

**The reason this is not a convenience feature.** A person is one training
history, not one email address. The founder saw it coming: *"even though your
GTP might have a different email. You're gonna have to link it to."* Sign into
wrought.fit with Google, let ChatGPT connect under some other address, and there
are two accounts holding half a life each. Nothing errors. It looks like you did
nothing for three weeks — on the one product whose entire promise is memory.
**A silent fork is the worst failure in this system**, worse than any crash,
because a crash is visible.

Three defences, in order:

- **Prevention** — `authorize.html` says to come in the same way as at
  wrought.fit, and offers the same three doors so that is easy to obey.
- **Linking** — dashboard → Account. Adds a door to the account you are in.
  Never a second account, never moves anything. Needs *manual linking* ON in
  Supabase.
- **Merging** — `api-merge.js` + `006_wrought_identity.sql`, for when it already
  happened.

**The proof that unblocked it.** Merging needs control of both accounts, and for
the person who most needs it — locked out of the second one, reset email not
arriving — neither a password nor an email was available. But their assistant is
still signed in and still working, which is a **better** proof of current
control than a password set once months ago. So `link_account` mints a
six-character code from inside the conversation, and the dashboard takes it in
place of the second token. Ten minutes, single use, claimed under a lock, and
worthless without also being signed in on the surviving account — two proofs
still, one of them just no longer a password. `012_wrought_link_codes.sql`.

**Merging demands a live token for BOTH accounts** — never an email, never a
user id. An email is guessable and a user id sits inside every JWT; either alone
would make `/api/merge` a way to read a stranger's health record. The other
account is proved either by its password (through a throwaway client with its
own storage, so the surviving session is untouched) or by its provider (which
means leaving the page, so the kept token is stashed first).

The move is **one transaction**. Rows both accounts already held stay single;
nothing is dropped that was not already there. **The load-bearing line is
`wrought_oauth_tokens`** — moving the live grants means ChatGPT keeps working
and starts writing to the surviving account with nothing to reconnect. The
emptied account is then deleted: an empty duplicate re-forks the log the next
time somebody comes through that door, and deleting it frees its Apple or Google
identity to be linked properly.

`get_profile` returns `account.email` and, when the account is empty, a
`fork_check` note. **An empty account and someone saying "I logged that
yesterday" is almost never a new user** — and answering it by asking them to log
the week again is how a memory product loses trust while looking like working
software. There is a test.

### Two-factor — enforced on the server, or it is decoration

TOTP via any authenticator app; nothing is ever sent by text. Switched on from
the dashboard's Account tab, which is the **only** place it can be enrolled or
removed — a connect flow offering to set up 2FA mid-authorization is how
somebody ends up half-enrolled.

**The browser prompt is the polite half.** A second factor the browser checks
and the server does not is decoration: the password alone still yields a valid
session JWT and every endpoint would take it. Supabase stamps `aal` on the
session — `aal1` is one factor, `aal2` is the second actually presented — and
the claim alone proves nothing, since somebody with no factors is legitimately
`aal1` forever. It is only a failure when the account **has** a verified factor
and the token says `aal1`. That is `mfaSatisfied()` in `lib/wrought.js`, and
`getAuthUser` refuses on the session-JWT path.

**The connector path is deliberately NOT re-checked**, and that asymmetry is
load-bearing. ChatGPT holds a token minted at authorization time and there is no
way to ask it for a code mid-conversation — re-checking would break every
connector. So the gate moves to where the token is *minted*:
`oauth-authorize-complete.js` refuses `aal1` before it writes the code. Without
that line, "connect your assistant" would be a permanent way around the second
factor rather than a use of it. Both halves have tests.

Factor lookups are cached five minutes. On a lookup failure the **last answer
actually received is preferred, even expired** — an outage must not quietly
switch somebody's second factor off. With no answer ever recorded it allows the
request, because locking every user out of their own health record when an admin
endpoint blinks is the worse failure and almost nobody has a factor to bypass.

### The page you land on when the network is gone

**A failed navigation is never answered with a different page.** The worker used
to fall back to `/index.html`, so tapping the home screen icon on bad wifi
dropped you on the marketing homepage — which reads as having been signed out,
the one thing a product whose whole promise is memory must never fake. Now an
unreachable page gets an honest offline card, and `caches.match` runs with
`ignoreSearch` because `/app.html?merge=1` is `/app.html` and without it every
link carrying a query string missed the cache.

The wordmark is a link on every page, but on the dashboard it goes to the
dashboard, not to `/`. Being thrown out to a sales pitch from inside your own
record was the complaint, not the fix.

### Capture in passing — the most important doctrine in the server

The founder's words: *"if I accidentally say I just did 10 push-ups I'll
remember that for that day — I don't want to have to flip the page."*

The connector is live in **every** conversation on the account, not just the
ones about training. So a mention of food, training, weight, sleep or a symptom
is a log regardless of what the conversation is nominally about — someone asking
about a tax form who says they just did ten push-ups gets those push-ups filed,
in the same turn, with `quiet: true`, and then the tax conversation continues.

Nobody opens a fitness app to record ten push-ups. They mention it and it is gone
forever. Catching those is the whole difference between a log that reflects a
life and one that reflects the days somebody remembered to open an app.

**Vague is still worth recording.** "Doing my workout" files a training day with
every number null. A training day recorded beats an interrogation that makes
somebody stop telling you things, and the parser is explicitly instructed never
to pad a vague mention into a specific one — a guessed 500-calorie "lunch"
silently poisons a weekly total in a way a null never does.

**`amend_last` exists so detail arriving later updates the entry instead of
creating a second one.** Without it, "doing my workout" plus a later "that was
legs, 40 minutes" becomes two phantom sessions and the day double-counts. It
re-parses the original words together with the new ones and merges the detail,
so nothing already known gets wiped.

### Training — a partner, not a diary

`003_wrought_training.sql` + `lib/training.js`. The difference is tense: a diary
is written afterwards and is always slightly a lie (you round the reps up); a
partner is present tense and writes down what actually happened.

- **`wrought_sets` stores every set individually**, and that grain is the whole
  point. "You had 92.5 for 6 last Tuesday, put 95 on" cannot be said from a
  session summary. Summaries are where progress goes to die.
- **Session state lives on the server**, never in the conversation. Chats get
  cleared and phones die between sets; the model asks where the user is rather
  than remembering.
- **Loads are computed, never guessed.** Double progression in
  `progressionCall()`. For a lift with no history it refuses to invent a weight
  and prescribes RPE instead — tested for all three tiers. Guessing a
  stranger's working weight is the fastest way this product injures somebody.
- **`position` is stored on every set** — where in the session the lift
  happened. Almost nobody stores this, which is why almost nobody can answer
  "is my bench stalling, or is it just always third?". `orderInsight()` needs
  two sessions at each position and ignores gaps under 3%, because below that
  it is sleep and salt, not order.
- **Tiers change how it talks**, not just the volume. Beginner gets compounds
  only and every movement explained; advanced gets named and left alone.
- **Routines cover sport.** A training log that cannot hold Tuesday five-a-side
  is not a training log.

### The phrasebook — nobody says "call the brief tool"

A block in `SERVER_INSTRUCTIONS` maps how people actually ask onto the tools:
*"what's the damage"*, *"hit me"*, *"gym bro"*, *"jim bro"*, *"roast me"*,
*"morning"* all mean `brief`; *"I'm hungry"*, *"talk me out of it"*,
*"it's late and I'm at the fridge"* mean `whats_next`; *"got 8"*, *"failed at
5"* mean `log_set`. Losing it breaks nothing loudly — the connector just quietly
stops understanding ordinary English, which is the hardest regression to spot,
so there are tests.

**"Gym bro" is a register, not a licence.** It changes delivery and nothing
else: the numbers still come from the tools, nothing about their body is ever
mentioned, and a care flag silences the whole voice instantly. Tested, because a
persona that can outrank the flags is exactly how this feature would turn into
the thing the flags exist to prevent.

**Being addressed by name means the question is for WROUGHT.** *"Hey Jim bro,
what account am I on?"* came back with the founder's **ChatGPT Plus** account —
answered from the model's own context, never touching a tool. Confidently,
uselessly wrong, and indistinguishable from right.

So the instruction is explicit: a message opening with *jim bro*, *gym bro*,
*broski*, *broheim*, *coach*, *trainer* or any nickname aimed at this connector
is a question FOR WROUGHT and must be answered from a tool, never from what the
model already knows. If no tool obviously fits, `get_profile` is the fallback.
*"what account am I on"*, *"who am I"*, *"is this connected"* are mapped to it
outright. Tested.

### Last night — the screen somebody actually opens

`lastSession()` in `lib/training.js` + the top of the Record view. The founder
asked for this before anything else and had to ask twice: *"how many reps you
did last night your workout that you've done your matrix... what are you
targeting?"*

Everything else on the dashboard is arithmetic ABOUT training — averages,
matrices, trends. **This is the training**, set by set, in the order it
happened, and it is what somebody opens the app to see the morning after. A
weekly average cannot tell you that you got 8 on the last set when you got 6
last time, and that single fact is the whole reason anybody keeps a log.

**Every lift is set against the last time it was done**, because a number with
nothing beside it is trivia. "92.5 for 6" means nothing; "92.5 for 6, up from 90
for 6" is the point. Same weight for more reps counts as UP — calling that "no
change" is how somebody stops believing the readout. Bodyweight work is carried
with a null weight rather than a zero, which the Lifts panel got wrong once
already.

### Blocks — a plan with an end, and a deload nobody has to choose

`buildBlock()` / `blockPosition()` in `lib/library.js`, `008_wrought_blocks.sql`,
and the `start_block` / `block_status` / `end_block` tools. Routines existed and
per-exercise progression already worked, so a block is an ordered schedule over
them plus a rule for how the volume moves. It adds the two things nobody does
for themselves:

- **A deload scheduled BEFORE it is needed.** Anybody who waits until they feel
  like they need one takes it a fortnight late, as an injury or a month off. It
  is the most skipped thing in training and the only fix is that something else
  already put it in the calendar. Every block length ends on one. A deload keeps
  the same lifts and reps at about half the sets — cutting reps too would make
  it a different session and lose the practice.
- **An end.** "Week 4 of 8" is a reason to show up on the days nobody wants to.
  A plan that finishes is finishable; an endless one is quit. When it completes,
  **say so** — that is the only reward the structure had to give.

**Position counts sessions finished, never dates.** Advancing by the calendar
would punish a chest infection by deleting the training, and the block would
read as finished having never happened. `wrought_sessions.block_id` is stamped
at `start_session`. The plan is frozen at the moment it starts, exactly as
sessions freeze their routine. **Still not one weight anywhere** — tested.

### Notifications — the worker finally has something sending to it

`lib/push.js`, `007_wrought_push.sql`, `api-push.js`, and the send folded into
`brief-nightly.js`. **No dependency**: web push is a fully specified,
deterministic algorithm (RFC 8291 payload encryption, RFC 8292 VAPID), both
publishing test vectors, so it can be checked against the specification itself
offline rather than trusted because a package is popular. **The harness runs RFC
8291's vector on every push** — it matches byte for byte.

The push service routes the message and can never read it: the payload is
encrypted to a key pair only the browser holds. That matters more here than most
places, because the message is a line about somebody's eating and it passes
through infrastructure belonging to a company that is not us.

`scripts/vapid.mjs` generates the one key pair, once. **Regenerating silently
kills every existing subscription** — nobody gets an error, notifications just
stop. `brief_hour` is per user and per timezone; a notification at the wrong
hour is how somebody mutes an app for good, and they never come back on. A day
with nothing logged still gets nothing.

### Progress photos — the one place this product could be cruel

`009_wrought_photos.sql` + `api-photos.js` + the Photos tab. The scale is a bad
instrument over months — it moves with salt, sleep and the hour of the day, and
cannot tell three kilos of muscle from three kilos of anything else. Two
photographs eight weeks apart answer what the number keeps getting wrong, and
for somebody who has done everything right and watched a flat line it is the
only place the work becomes visible.

**NOTHING EVER READS THE IMAGE.** No body-fat estimate, no pose scoring, no
analysis, ever. A number invented from a photograph of somebody's torso would
break the estimates-are-labelled doctrine exactly where it does the most harm,
and there is no honest version of it. There is a test that greps for the attempt.

Private bucket, objects namespaced by user id with the storage policy checking
that first path segment, and every URL signed and expiring within the hour — a
leaked row id is not enough to fetch anything. The comparison line is
deliberately flat: no "look how far you've come", no score. **No sharing
feature, now or later.** Export hands them their own files; what they do next is
their business.

### Pull APIs — the fidelity upgrade, still never the entry price

`lib/pull.js` + `api-device.js`. Withings, Strava, Oura, Whoop, Fitbit. **Apple
Health and Health Connect remain the answer to "how do I connect my watch"** —
two doors, dozens of apps, no partnerships and no keys. This is for the handful
worth pulling at higher resolution.

**Withings first**, and the order is not arbitrary: bodyweight is the number
people most reliably stop logging by hand, so a scale that reports itself
removes the most-abandoned manual entry in the product. Strava second, being the
best-documented API in the category.

Each provider needs an OAuth app registered by the operator, and until then the
button **says which environment variable is missing** — "connect Oura" leading
to somebody else's error page is worse than a greyed-out button with a reason on
it. The callback state is HMAC-signed and expires in ten minutes: unsigned,
anybody could craft a callback attaching their provider account to a stranger's
record, which reads as an integration bug and is actually a way to write into
somebody else's health log. Readings land in `wrought_metrics` with `source_ref`
set, so the existing unique index means syncing twice cannot double a day.

### The library — curated, and never a weight

`lib/library.js` + the `programmes` tool. The founder's complaint was a filing
problem, not a knowledge one: *"I have an S tier workout list of exercises rated
really highly, but I'm turning pages all the time, can't find half this shit."*
A list you scroll is not a library; this is one you ask a question of.

- **Programmes are ordered over PATTERNS, not named lifts.** Movement names get
  chosen at the last moment against what the person actually owns, which is why
  "dumbbells only" needs no separate library.
- **Not one weight anywhere**, in a movement or a built session — tested. Loads
  come from `progressionCall()` against real history, or as an RPE. A library is
  exactly where a guessed working weight would look most reasonable.
- **Days available is a hard ceiling**, never ambition. Prescribing six sessions
  to somebody with three is how a programme gets abandoned in week two.
- **Tier gates the movements themselves**, not just the volume — a beginner can
  never be offered an advanced lift, and gets every movement explained while an
  advanced lifter is left alone. Both tested.

### Connected assistants — two logins, and only one was visible

`api-connections.js` + the Account tab. `authorize.html` had always said *"revoke
it any time from the dashboard"* and there was no such thing on the dashboard —
a promise made at the exact moment somebody is deciding whether to trust this
with their health record, and not kept.

It also settles a confusion the founder hit and was right to find odd: **the
connector holds its own token, and that IS a login — just not this browser's.**
ChatGPT can be fully working while wrought.fit shows a sign-in screen, because
they are separate sessions. Signing out of the browser does not disconnect the
assistant; connecting the assistant does not sign you into the browser. The
panel says so in as many words.

Revoking deletes the refresh token as well as the access token — access alone
and the assistant mints a new one on its next call, so the revoke looks like it
silently failed. Clients are named from their **redirect URI**, never from the
`client_name` they registered, which is self-reported and can say anything.

`get_profile` returning `account.email` is the one-message way to check which
account an assistant is actually attached to: ask it, and it says.

### The profile — a place to look, not a form

`010_wrought_profile_web.sql` + `api-profile.js` + the Account tab. Every field
here was already reachable through `set_profile`, and that stays the right way
to CAPTURE them — five facts, asked once, in passing, never as an opener. It was
the wrong and only way to CHECK them: *"what does it think my height is"* had no
answer anybody could go and read, and **a memory product that cannot show you
what it remembers is asking for trust it has not earned.**

Nothing is required and nothing is asked at signup. Blank means WROUGHT does not
know it and will say so rather than guessing. The timezone is verified against
`Intl` rather than trusted — a bad one files every late-night snack under the
wrong day and corrupts every brief after it. Rejections name the field, because
"could not save" sends somebody hunting through eleven inputs.

The picture lives in its own private bucket, separate from progress photos:
deleting every progress photo must not take somebody's avatar with it, and a
bulk operation on one bucket must never reach the other. **Nothing reads it**,
same rule, and there is a test. `administrator` on the response is read from
`WROUGHT_ADMIN_EMAILS`, never from a column.

### /status — the page that answers "is this thing set up"

`api-status.js`, served at `/status`. Every endpoint names the migration IT
needs when IT fails, which is right, but it means finding out what is missing
costs a tour of the product one broken screen at a time. This answers it in one
look, and renders as a readable page when a browser asks for HTML.

It checks migrations by **probing for a table or column each one creates**, never
a version number — so it still tells the truth when somebody ran the SQL by hand
in pieces. The trailing slash on `SUPABASE_URL` is caught by name, because Kong
answers "Invalid path specified in request URL" and nothing explains why.

**It shows presence, never values.** No key, no admin address, no row counts —
a setup checklist is not a reason to publish how busy a health product is. There
is a test that plants a fake key and admin address in the environment and
asserts neither appears in either response format. It gives **one** next step,
not a list: a checklist with eleven open items is one nobody starts.

### Memberships, trials and codes — and what a revoke may never take

`011_wrought_membership.sql` + `lib/membership.js` + the Admin tab's *people*
and *codes* views. The founder's ask, and he drew the privacy line himself:
*"I agree with you that I won't see health information but everything else I
should."* That is exactly the right line, and it is enforced in code rather than
in a promise.

**The default is permissive, always.** No membership row means free and active.
A missing row, a failed lookup, an un-migrated table — all of them let the
request through. The failure mode being designed against is locking somebody out
of their own health record, so only an explicit revoke ever blocks.

**An expired trial does not block, it drops to free.** Ending a trial by taking
away access to a year of somebody's own training is not a business model, it is
a hostage situation.

**Export always works. Even revoked, even lapsed.** `ALWAYS_ALLOWED` covers
export, the profile, connections and status, and the suspension message says out
loud that the record is intact and portable — being cut off is precisely when
somebody needs to hear that. Suspension reaches the assistant as a tool result
rather than a protocol error, so ChatGPT relays the words instead of showing a
broken connector.

**Codes are coupons, not credentials** — stored as they read, because they are
meant to be handed out; the limit is `max_uses` and `expires_on`, not secrecy.
That is the opposite of `wrought_ingest_keys`, which are secrets and are hashed.
The alphabet excludes `0/O` and `1/I` because somebody will read one down a
phone. Redemption is a single locked transaction, so a code with one use left
cannot be spent twice by two people pressing at once, and stacking two codes
**extends** rather than shortens.

**The people list shows who, never what.** Email, join date, last sign-in, how
MANY entries, plan and status. It reads `wrought_events` for `user_id` and
`local_date` only — never `detail` — and a test greps for the attempt. An
operator cannot revoke themselves; that is a locked door with the key inside.

### The operator's view — and what it refuses to show

`api-admin.js` + the Admin tab, which only appears when the server says so.
Administrators are named in `WROUGHT_ADMIN_EMAILS` (comma separated, matched
case-insensitively against the verified session email) — never a column somebody
could set on themselves, never a flag in a token.

**It shows aggregates only, and that is a decision rather than an unfinished
screen.** Accounts, active-in-7-days, entries logged, sets, sessions, device
rows. It cannot display one named person's food, training, weight or symptoms,
and must not be extended to. Being the administrator of a health product is not
a licence to read the health data in it; the moment that screen exists, every
promise on `/privacy.html` reduces to trusting whoever holds the password.

The retention line is the number that matters — signups are vanity, still
logging a week later is the product working.

### The rack screen — trainer mode

`api-session.js` + the Trainer tab. The coaching always existed in the tools;
what did not exist was somewhere to **look** at it. Mid-set nobody composes a
sentence to an assistant — they want one glance saying what lift, what weight,
which set, how long left on the rest.

It reads the same `wrought_sessions` row the tools write, and takes its load
from `progressionCall()` rather than working one out, so **the screen and the
voice cannot tell you two different weights**. When there is no history it shows
the RPE refusal rather than hiding it — that refusal is the safest thing in the
product. Polls every 5s while the tab is open and stops the moment you leave it.

### Earned room — the one rule that must never invert

`earnedRoom()` tracks the week, and when someone has genuinely been under it
hands back a number and tells them to spend it. It works because the room only
exists if the log is honest, so the reward reinforces the behaviour the product
depends on — and it cannot be gamed, since gaming it means logging food you did
not eat in order to be told you may not eat more.

**It only ever ADDS permission.** Being over is one factual line with no
instruction attached. The moment "earned" has an opposite it is a punishment
schedule, which is what turns a food log into a disorder. A care flag switches
the frame off entirely, and in that state it grants permission unconditionally,
quotes no number and explains nothing — explaining *why* would tell someone
already under-eating that they had not qualified for a treat. There is a test
for that exact failure, because the first version had it.

### The five facts, and a day that is not spent lying down

`restingBurn()` answers "what would you burn lying still". Without a watch that
was the ONLY figure, so calories out counted a working day as zero — and the
error runs in the dangerous direction, because an overstated deficit tells
somebody to eat less than they need. `005_wrought_activity.sql` adds
`activity_level`; standard multipliers in `ACTIVITY` cover the day when nothing
is measuring it. **A measurement always beats a multiplier** — a device
overrides it — and with neither, `energy_balance` says on the response that the
number is resting-only rather than staying quiet.

Height, birth year, sex, a recent weight and activity level are asked **once,
together, in one message**, the first time a number needs them, and never as an
opener. Five facts, once, ever — anything more is the interrogation that makes
people stop using health apps.

### Fasting — the record, not the plan

`004_wrought_fasting.sql` adds `fast` as an event type; `log_fast` records one.
The eating window is a **timetable**; a fast is the **train**. Conflating them
means congratulating somebody for a fast they did not do, and after that none of
the numbers mean anything.

Deliberately a trust system, in the founder's words: *"it could be all just
verbal — I could say last night I stopped eating at eight and I started eating
again at eight."* Nothing to press at either end, because a tracker needing a
button at 8pm measures the evenings somebody remembered to open it, which is how
every food log dies. `fastLength()` treats crossing midnight as the ordinary
case; equal times are 24h, not zero.

**It is never graded** — no target, no streak, no score, and a test asserts the
summary carries no praise or judgement. A fast with a score attached becomes a
reason to skip breakfast to keep a number alive, which is the same failure mode
`earnedRoom()` is built to avoid.

### Nutrition — counted honestly, at every altitude

`lib/nutrition.js`. A daily macro total is the least interesting number in
nutrition; everybody has a bad Tuesday. The shape is what needs years of record:
sugar climbing every December, meat in four meals out of five, this year running
below last one.

- **Macros are grams, summed and always labelled estimated.** Sugar is a subset
  of carbs, never additional to them.
- **Categories are counted in MEALS, never grams.** "Meat was in 71% of your
  meals" is honest; "you ate 4kg of meat" is a fabrication, because no
  description of dinner supports a weight. There is a test asserting no weight
  language ever appears in a composition response.
- **Calories are shaded `mid`**, not high-or-low — they are not good or bad in
  themselves and must never be quietly moralised. Sugar is the one row shaded
  lower-is-better.
- **Year-over-year is the number nobody else can give you**, and it only exists
  because something has been adding up. It stays silent until both years have
  30+ logged days.

### Two classes called `.bar`, and the header they flattened

Worth keeping because it cost an evening and looked like six different bugs. A
progress bar added with the blocks work claimed `.bar` — a name the **header
row** already owned — and set `height: 6px; overflow: hidden` on it. The whole
navigation collapsed into a 6px strip, which is why tabs came back clipped at
both ends no matter what was tried, and why every layout fix appeared not to
work.

The header owns `.bar`. Anything else gets its own name: `.progbar` for the
block progress bar, `.col` for the chart columns inside `.lift`. **A test now
asserts `.bar` is defined exactly once and that nothing carries a bare
`class="bar"`.** Before blaming a layout, check whether two things share a class.

The tabs live at the top of the page, in the header, scrolling sideways — the
founder asked for that directly, and a scrolling row fits however many tabs
there are. The earlier fixed bottom bar is gone; on top of being the wrong
place, `backdrop-filter` on the header made the header the containing block for
anything `position: fixed` inside it, so it anchored to the header rather than
the screen.

The mark is `#record`, not `/app.html` — pointing it at the page it is already
on reloaded and looked like nothing happened.

### Coming back from a reset email

`resetPasswordForEmail` returns somebody to the dashboard with the recovery
grant in the URL fragment, and the page used to show them the ordinary sign-in
form — asking for the password they had just told us they do not have. That is
the exact moment somebody gives up. `PASSWORD_RECOVERY` and `type=recovery` both
now open a *set a new password* screen, and saving it signs them straight in.

### The empty dashboard — the screen that decides everything

A brand new account has nothing to draw, and drawing it anyway produced nine
panels all saying *"not enough data yet"*. The founder's reaction was the right
one: *"what is this garbage... no symbols no nothing."* On the one screen
somebody judges the whole product by, an honest empty state read as broken
software.

`isFirstRun()` + `firstRun()` in `app.html`. When nothing has been logged,
trained or pushed, the Record view is replaced by its own screen: the mark, what
the product is waiting for, and three things to do — the five facts, a sentence
to the AI, the phone — each ticking itself off as it becomes true. Plus a link
to `?demo=1`, so somebody can see it full of data in one tap rather than taking
it on faith.

**Any data at all and the real dashboard returns.** This is a first-run state,
not a permanent shell.

Sign out and switch account live at the bottom of Account, and both land back on
the sign-in screen rather than the marketing page. There was no sign-out at all
before, which is why staying signed in felt like having no say in it. The panel
says out loud that signing out does **not** disconnect the assistant — they are
separate sessions, and pretending otherwise sends somebody hunting for a
connector that is working perfectly.

### Every item its own number, and the total underneath

`entryRows()` in `app.html` + per-entry macros on `dayFacts`. The founder,
looking at a day card: *"one steak's up to the right and the pizza's to the
left — should be altogether and then a total. Each one should have its own list
and then add it together."*

A list of names above a single figure is **unauditable**. You cannot see which
item is the 750 and which is the 300, so a mis-heard entry disappears into an
average and stays there — which is the exact failure the readable log exists to
prevent, reappearing on the screen people actually look at. Items first with
their own calories, the sum **under** them where a sum belongs; tapping a row
opens its macros, because the calories are the headline and the rest is detail.
An entry with no calories says out loud that it counts for nothing in the day's
total, rather than showing a quiet em dash.

### The five facts, asked where the number is missing

`factsForm()` on the hero panel + `weight` accepted by `api-profile.js`. The
founder read *"calories out needs a recent weigh-in and birth year"* on the
dashboard and had no way to answer it from that screen — and filling in every
box under Account would not have fixed it either, because **a weigh-in is an
event, not a profile column, and the website had no way to record one at all.**
The assistant could; the site could not. That was a hole, not a preference.

So the form lives on the panel that is refusing to draw, and it disappears the
moment the burn is known — a gap being filled, not a settings page that follows
people around. Height, a weight and a birth year are demanded because the
arithmetic cannot run without them; sex and activity level stay optional and
flagged. Pounds and inches are converted, never stored as typed, and a weight
outside 20–400 kg is refused rather than becoming a resting burn nobody can
explain. If the profile saves and the weigh-in does not, it says so — a flat
failure sends somebody re-entering their height. The demo never shows it: a
form there would collect a real weight into a screen that discards it.

### The zone the days are filed under

A pizza eaten at 11:44 landed on **yesterday**, stamped 23:28, because the
account was still on the default zone twelve hours from where the founder was
standing. Nothing errored. The day card, the streak, the calendar and every
weekly total were all quietly wrong, and the only visible symptom was a date
that looked slightly odd — which is exactly the shape of bug that survives for
months.

`zoneWarning()` compares the **date** the server filed under with the date in
the browser, and offers the fix in one tap. The trigger is a different DATE, not
a different zone name: `America/Toronto` and `America/New_York` disagree about
nothing that matters here, and nagging about them trains somebody to dismiss the
one that counts.

**The demo is reachable from inside the app**, not only from a URL somebody has
to be told about — the person who most needs it is the one staring at a
dashboard with a single meal on it, deciding whether this is worth a fortnight.
In the demo the footer becomes the way back, and sign-out is hidden, because
signing out of borrowed numbers is meaningless.

### The calendar — the subtraction, on every square

`lib/calendar.js` + the Calendar tab. The founder asked for it in one breath:
*"a calendar with everything I ate, and I wanna know calories in versus
calories out — you add up the math. Then weekly, then yearly."* All three parts
matter and the middle one is the product: a diary shows what went in, and
everybody has one of those. Squares in rows of seven is the only layout where
"good all week except Thursday" is something you SEE rather than derive.

**A day nobody logged is not a zero-calorie day**, and this is the whole reason
it is not thirty lines in the page. Summing raw calendar days counts every
forgotten day as a perfect fast, manufactures an enormous deficit out of
forgetfulness, and then advises on it — an error running in the dangerous
direction. Totals and averages count **logged days only** and say how many:
*"counted across 9 days, not the whole 30."* Same on the other side — with no
height, birth year or weight, calories out is null on every square rather than
a resting burn standing in for a working day, and **colour is the net**, so a
square where only one half is known stays neutral and dashed. A coloured square
is a claim about the subtraction.

A window is only reported when the loaded range covers it — a "this year"
figure built from seven days is a fabrication wearing a long label. The page
does no arithmetic at all; there is a test that greps for a `reduce` in the
view, because a calendar and a brief disagreeing about the same Tuesday means
neither is worth reading.

### The log must be readable

`api-log.js` + the Log view in `app.html`. Everything else on the dashboard is
arithmetic *about* the record — matrices, trends, averages. This is the record:
day by day, newest first, every meal and every set exactly as it went in.

It matters more than it looks. A product whose whole promise is "it remembers"
has to let you go and look, or the memory is a claim rather than a fact. It is
also the only place somebody catches a mis-heard entry from three weeks ago —
"burrito" filed as "burrata" is invisible in an average and obvious in a log.

Paginated by **date**, not by row, because a day is the unit a person thinks in.
Sessions render as `<details>` grouped into exercises with their sets
underneath — forty flat rows is unreadable; four exercises with their sets is
the workout you actually did.

### A hub, which means a wide door and a way out

The founder's own framing: *"it's a hub for all stuff. Connect all stuff."*
Two things follow, and neither is optional.

**The door has to be wider than fitness.** `/ingest` now speaks blood glucose
(mmol/L, with mg/dL converted — an 18× mix-up turns a normal 5.5 into 99),
blood pressure, body temperature, lean mass, and lab markers: cholesterol,
HbA1c, ferritin, vitamin D, testosterone, TSH. A hub holding every step you
took and nothing about your blood is a pedometer with ambitions. Bloodwork is
`live` without being an aggregator — there is no third party to integrate with,
you just send the numbers off the sheet.

**And there has to be a way out.** `api-export.js` returns every event, set,
metric, session, routine, goal and verdict as JSON or CSV. A hub you cannot
leave is a trap, and the pitch — "give us years of your life" — is only
reasonable if all of it comes back on demand. Credentials are the one thing
deliberately excluded. Do not remove this endpoint to add a paid tier.

**`/ingest` is a documented public endpoint, not a private protocol.** Anything
that can POST JSON can feed this. That is what makes it a hub rather than an app
with integrations.

### Brand — the word is the mark

**Still no invented symbol** — no wave, no abstract glyph, nothing standing
beside the name pretending to mean it. That rule holds.

**But the word now has a tile**, because a favicon slot and a connector listing
render something whether you supply one or not, and an empty slot is somebody
else's placeholder — which is exactly what ChatGPT showed. The tile is the same
word cut to its first letter: a slab W punched OUT of a hot plate, so the tile
is the metal and the letter is the hole. Knockout rather than a letter on a dark
square, because figure-ground contrast is the only thing that survives 32px once
no serif is a pixel wide. Founder-approved after seeing five drawn options —
*"that new symbol looks amazing, make that universal"*.

**The wordmark is the same bracketed slab as the tile, on every page** —
`--stamp`, weight 700, Rockwell then Roboto Slab then the serifs every platform
ships. A compressed grotesque beside a slab W reads as two different companies,
which is exactly what happened: the landing page moved to the slab and the
dashboard, connect, privacy and terms did not, so **signing in swapped the
brand** and the founder's complaint was *"the page looks nothing like the
advertising outside of it"*. The compressed grotesque keeps its real job under
its own name, `--grotesk` — big display numbers and lift names. Two roles, two
variables, and a test asserting all six pages set the word in the slab, because
this drift is invisible on any page viewed by itself.

`icon.svg` plus PNG at 512/192/180/32, wired into every page head,
`.well-known/mcp.json` and `site.webmanifest`. Paths, never `<text>` — a favicon
depending on a font is a rectangle on somebody else's machine.

### Devices — two doors, not fifteen integrations

The founder asked for "Apple Watch and Samsung watch and Oura and Nike Run —
anything to take the stats." The answer is **not** fifteen integrations.

**Apple Health and Health Connect are already aggregators.** Nike Run Club,
Strava, Peloton, Oura, Whoop, Samsung Health and Fitbit all write into whichever
one is on the user's phone. Supporting those two doors picks up dozens of apps
on day one with no partnerships or API keys. The setup conversation is one
question — *what phone do you carry?* — and one connection.

**Both doors are push-only, permanently.** HealthKit and Health Connect have no
cloud API: no entitlement, no partner programme, no price. The data lives on the
device and leaves only if the device sends it. Never imply an Apple Watch is
"syncing" from our side. Nike Run Club has had no public API for *anybody* since
2018 and Samsung's is partner-gated — for those, the phone is the only route
that exists, so say it plainly rather than apologising.

`lib/providers.js` is the single source of truth and drives both the
`connect_device` tool and `connect.html`, so the assistant and the website can
never tell a user two different stories. Full map in `docs/INTEGRATIONS.md`.

Direct pull APIs (Strava, Oura, Whoop, Withings, Fitbit, Garmin, Polar) are a
fidelity **upgrade**, never the entry price. Priority order: Withings first (a
self-reporting scale removes the most-abandoned manual entry), then Strava.

## Conventions

- `npm test` runs `test/harness.mjs` — 265 offline tests, no network, no database.
  Run it before every push. It covers the JSON-RPC envelope (which fails as an
  uninformative "could not connect" inside ChatGPT) and all the arithmetic
  (which fails as a confidently wrong number in somebody's verdict).
- Test MCP changes with the harness before pushing; screenshot pages at 390px.
- Founder communicates by voice-to-text; interpret generously ("super bass" =
  Supabase, "Jim bro" = a gym-bro daily brief, "GTP" = ChatGPT).
- PRs created and merged by the agent per the founder's standing "you just make
  the changes" preference. Attribution footer on all GitHub posts.

## Status & next steps

**Blocked on founder:**
1. **The push.** `lczako-eng/wrought` exists, but this session cannot reach it —
   `add_repo` needs an approval that never rendered, and the GitHub MCP enforces
   the same allowlist, so the API fallback is blocked too. Escape hatch already
   sent: a git bundle with full history. `git clone wrought-full.bundle`, set the
   remote, push. Retry `add_repo` first in any new session.
2. Run `schema/001_wrought_core.sql`, then `002_wrought_oauth.sql`, then
   `003_wrought_training.sql`, `004_wrought_fasting.sql`,
   `005_wrought_activity.sql`, `006_wrought_identity.sql`, `007_wrought_push.sql`,
   `008_wrought_blocks.sql`, `009_wrought_photos.sql` and
   `010_wrought_profile_web.sql` and `011_wrought_membership.sql` in Supabase. Full checklist in `docs/SETUP.md`.
3. Set env vars in Netlify: `SUPABASE_URL` (**no trailing slash** — Kong answers
   "Invalid path specified in request URL" and nothing says why),
   `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`,
   `WROUGHT_SITE_URL=https://wrought.fit`,
   `WROUGHT_ADMIN_EMAILS=laszlobrianczako@gmail.com`. Nothing to inject —
   `/config.js` serves the two public values to the pages from these.
4. **Sign-in providers** — `docs/SIGN_IN.md` has the full walkthrough. In
   Supabase: turn ON *manual linking*, add `https://wrought.fit/**` to the
   redirect URLs, set the Site URL, and configure the Google provider (free) and
   the Apple provider (needs the **US$99/year** Apple Developer Program). Until
   each is on, its button says so in as many words rather than failing oddly.
5. **Supabase → Authentication → Providers → Email → turn OFF "Confirm email."**
   Without this, `signUp` still sends a confirmation link, which is exactly what
   the password change was meant to get rid of. The pages handle it either way
   and say so rather than hanging, but the founder's ask is only actually met
   with it off.
6. Domain bought: **wrought.fit** (renews ~C$70 Aug 2027).

### Notifications — MCP cannot push, so the phone carries it

**An MCP server can never make ChatGPT or Claude speak first.** The protocol is
strictly request/response: the client calls us, we can never call the client.
No amount of cleverness changes that, and anyone claiming otherwise is
describing a different mechanism. What actually reaches a phone:

1. **The Shortcut reply.** The phone is already POSTing to `/ingest` nightly, so
   the response carries `notification` — that day's verdict — and one extra
   *Show Notification* action puts it on the lock screen. No app, no push
   certificates, no permission grants. Shipped.
2. **Email at 22:00** via `brief-nightly.js`. Shipped (needs `RESEND_API_KEY`).
3. **Web push to an installed PWA** — the proper answer. `sw.js` and
   `site.webmanifest` are built and the site offers to install itself: Android
   gets a real button off `beforeinstallprompt`, iOS gets the honest Share →
   Add to Home Screen instruction, since nothing can trigger that from script.
   The worker caches only the shell and never `/api`, `/oauth` or `/mcp` — a
   cached brief is a wrong brief. **Still needed: VAPID keys and a send
   endpoint.** The push and notificationclick handlers are already written and
   deliberately compose nothing; the server sends words it has already computed,
   so a notification can never disagree with the brief.

`brief-nightly.js` runs **hourly**, not nightly, because 22:00 is a different
instant per user — it serves only those for whom it is currently the send hour.
A day with nothing logged gets no email; a nightly nag is how a product gets
muted forever.

**Where the model still runs server-side:** only `writeVerdict` for the 22:00
email, and `buildPlan`. `/ingest` never needed one — watch data arrives as
numbers. The founder's answer to the last one is right and is the plan: the
verdict lives on the website and the phone app, written by the connected model
when he next talks to it and saved into `wrought_briefs` (which exists for
exactly that). Do that and the whole thing runs with no API key at all.

**The "light app" is the PWA, and that is the right answer.** Installed, it has
an icon, a splash, a standalone window with no browser chrome, and the lock
screen — which is the entire reason to want an app here. Native would mean two
codebases, two store accounts, two review queues and a release cycle to fix a
typo, in exchange for almost nothing this cannot already do. Revisit only if
something genuinely needs the OS: HealthKit read access (which does not exist
for servers anyway), or a widget.

**Next builds, in order:**
1. **Deploy, then use it for a fortnight.** Everything on the list below is
   downstream of the site being live and the founder having actually trained
   with it. A week of real use finds the bugs no test does.
2. **Register the OAuth apps** — Withings first, then Strava. The code is done
   and waiting on credentials; each provider's button already names the
   environment variable it needs.
3. **Connector directory submissions** — checklist in `docs/SUBMISSION.md`.
   Community registries first, then Claude, then ChatGPT.
4. Strava webhooks, so a run lands seconds after it finishes rather than at the
   next sync.

### Getting listed — the connector connector

The founder: *"I can't be a back door connector. I'll have to be a connector
connector."* Right instinct. Everything a directory asks for that is code or
copy is **done**: OAuth 2.1 with dynamic client registration, tool annotations,
`/privacy.html` naming every subprocessor, `/terms.html`, `/llms.txt`,
`/.well-known/mcp.json`, `/api/export`, medical disclaimers throughout.

**The hard prerequisite is deployment.** Every directory calls the live
endpoint, walks the OAuth flow and lists the tools as step one of review. Do not
submit before it is up and has had a fortnight of real use — reviewers notice an
unused server, and a week of your own usage finds the bugs that would sink a
review.

Order: community MCP registries first (free, instant, just a PR), then Claude,
then ChatGPT. Being pasted into a settings box is not a failure state — it is
how every connector starts.

Health data draws the hardest review, which this product should welcome: the
care flags, labelled estimates, refusal to invent a working weight and refusal
to diagnose are exactly what a reviewer wants to find. Point at them.

**Rejected, on purpose:** "health age" / "body age". It is a marketing number
with no clinical standing and most apps invent the formula. The one defensible
version is VO2max percentile against age group, which the watch already
measures — build that and call it what it is. Inventing a scientific-sounding
number would break the estimates-are-labelled doctrine in the one place the
founder would be fooling himself.

**Strategy notes:** the moat is accumulated personal memory, exactly as with
Revolv — features clone in weeks, four years of someone's training history does
not. Logging is commodity; the verdict and the memory are the product. The
honesty is the differentiator and the care flags are what make honesty safe to
ship.
