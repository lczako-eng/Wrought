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
- **Care flags outrank automated coaching, not the daily briefing itself.**
  Computed server-side in `careFlags()`: sustained sub-1200 kcal intake, loss
  faster than 1.2 kg/week, no rest in 14 days. When one fires, coaching stops.
  But the scheduled morning, midday and evening pushes are appointments: they
  still deliver the factual brief the person asked for and carry `REVIEW` as a
  secondary title note. Replacing all three with the same warning makes the
  brief — the product — disappear. This distinction is load-bearing.
- **Estimates are labelled.** Calories from a described meal are inferred. Say
  "roughly". The credibility dies the first time a guess is read as a fact.
- **Not a medical device.** No diagnosis, no reading HRV as a clinical sign, no
  medication advice. Say so and point at a doctor.
- **The app is optional, forever.** The founder, settling it: *"you can use
  just the HTML and the connector to make this work. You don't need the app —
  but if you want the Apple Health stuff, then we'll put the app in there
  too."* Website + connector = the complete product on every platform. The iOS
  app exists only for what the OS locks away (HealthKit's deduplicated
  statistics, native push) and is the smoothest door to them — never the only
  one. `/ingest` stays a documented public endpoint any client can feed.
  Nothing may ever require the app: not a feature, not a screen, not a
  notification. An app-required product halves the market, hands Apple review
  a veto over the roadmap, and turns "works inside the AI you already have"
  into a lie.

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
  HTTP, JSON-RPC. 42 tools. Doctrines ship in `SERVER_INSTRUCTIONS`.
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

**And a CDN is not allowed to take the page down.** The Supabase client is
imported late on purpose, but it was a bare top-level `await`: when jsdelivr
did not answer, the module rejected and **every line after it never ran**,
`boot()` included. No wordmark, no message, nothing to do and nothing to say
why — worst on `?demo=1`, which is shown to somebody with no account and no
warm render to fall back on. Caught now, with the failure card deliberately
**not** the sign-in gate, for the same reason the worker stopped falling back
to the homepage: answering a network failure with a password form tells
somebody they have been signed out.

**The half-truth in that fix is the more useful entry.** The card claimed the
demo and the manual both still worked. The demo genuinely does. The manual is
static markup that makes no request, so it renders perfectly with no client —
but **its only entrance was the peek link on the sign-in gate, and the card
replaces that gate.** The screen claiming the manual still worked was the exact
screen making it unreachable. One `openManual()` now, wired to both doors,
because two copies is how the second stops matching the first. Tested in a
browser rather than asserted: the card appears, the link renders the guide.

**`.stat` was the third time.** `.stat span` was written for the caption, and
every count-up figure is wrapped in `<span class="n">` — so 126, 7,340 and
6h 42m each rendered at 14px in dim grey with their units set LARGER than the
figures they label, on the section whose whole promise is a number readable
across a room. `.leg` had the identical shape, was found earlier, and was fixed
with a comment explaining it. After `.bar` and `.setpill`, the rule is now
flat: **a descendant selector that styles "the text in this card" will find the
number too.** There is a test that flags any bare descendant `span` rule
setting font-size, colour or display.

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

### The three burns — and the one nothing was counting

`lib/activity.js` + `013_wrought_work.sql` + the `log_activity` tool. The
founder, after a shift: *"today I worked at the Petting Zoo. It's very hard
work so I wanna make sure that captures it and then add it to the total as
well — like one is your daily metabolic rate, your workout, and other."*

His division is the right one, and it is right because of what each part means
to the person reading it. **Resting** cannot be changed. **Training** is a
choice they made. **Other** is a job they went to — and for anybody doing
physical work it is larger than the other two combined and was completely
invisible. A single "calories out" figure hides all of that behind one number
nobody can act on.

- **Priced off the Compendium of Physical Activities**, the MET table every
  exercise physiologist and every fitness app is already using underneath. That
  matters for the estimates doctrine: a published reference figure is not a
  language model's impression of what a petting zoo costs. Still labelled an
  estimate every single time. **The model must never estimate these calories
  itself** — a guess here is hundreds of calories wrong in a direction that
  changes what somebody eats.
- **Everything is NET, `(MET − 1)`.** MET values are gross — they include the
  resting cost of those hours, which the daily resting burn is already
  charging for. Adding them raw on top of a full-day BMR bills those hours
  twice and invents a thousand calories nobody spent.
- **The larger of the two, never the sum, and never the device outright.** A
  watch has already counted part of the shift — that is where the steps came
  from — so adding them is the double-count trap. But *"a measurement beats an
  estimate"* is the wrong rule here, and a real day proved it: 5,292 steps and
  four and a half hours at a petting zoo came back as **740 active calories**.
  A wrist accelerometer does not see load; carrying, lifting and holding barely
  register next to walking. So both are treated as estimates of the same
  quantity and the better-founded one wins, with `active_source:
  'logged_over_device'` saying which and why. Deliberately conservative — some
  non-work movement gets absorbed rather than added — because overstating a
  burn is a credibility problem while understating one tells somebody to eat
  less than they need. Same shape for the session: Apple's active energy is
  everything above resting, workouts included, so training comes **out** of
  that total rather than on top of it, floored at zero.
- **Logging work can never make somebody's burn go down.** Never below what
  the activity multiplier alone would have said — being punished for telling
  the truth is how a log stops being told the truth.
- **A shift is not a session, and that is load-bearing.** Its own event type,
  never counted toward the weekly target, never in the training matrix, never
  fed to progression. Somebody hitting "four sessions this week" by going to
  work would make the one number the expectation rests on meaningless. And
  **no praise for having gone to work** — it is a fact about the day, recorded
  because it burns calories.
- **Hours ON TASK, not the length of the shift.** Nobody works at full effort
  through their break, and an eight-hour shift billed as eight hours of labour
  is how the number stops being believable. The person answering knows the
  difference; the tool asks for it that way.
- **An unknown job asks rather than guesses.** Off the table, the server asks
  whether it was light, moderate, hard or very hard. Their read on their own
  day beats anything inferred from a job title, and refusing outright would be
  wrong here — the alternative to a classified estimate is the shift going
  unrecorded.
- **Capped at 1.5× resting, and the cap is said out loud.** Over-reported hours
  must not hand somebody 3,000 calories of permission; capping quietly would be
  worse, because then the log is lying too.

`trainingBurn()` also fills a related hole: a logged gym session used to
contribute **nothing** to calories out unless a watch measured it, so the
person most likely to be logging by hand was the person whose training counted
for zero.

### The nightly read finally fires, and it needs no key

`plainBrief()` in `lib/voice.js`. `brief-nightly` asked `writeVerdict` for a
paragraph, `writeVerdict` returns null without `OPENAI_API_KEY`, and the send
loop skipped on a null verdict — so **the one surface that can genuinely speak
first had never once spoken**, silently, for exactly the reason the founder did
not want to pay for a key.

The fallback composes the line from facts already computed: in, out, the net,
sessions, steps, where the week stands. No opinion, no coaching, no praise —
a number and its direction is worth a notification and an invented sentence is
not. A care flag remains the entire spoken or generated verdict, but the
scheduled lock-screen close still carries the computed receipt and marks
`REVIEW` secondarily in its title. Nothing logged still sends nothing; a
nightly nag is how a product gets muted permanently.

The written verdict stays better when a key exists, and is still preferred.

**The hour is theirs.** `brief_hour` existed in the schema and was settable from
nowhere — now `set_profile` takes it, validated 0–23 so a bad value comes back
as a sentence rather than a constraint violation. *"Send it at nine"* is 21.
The function runs hourly because 9pm is a different instant for everybody.

### Runs read as a progression

`cardioProgress()` in `lib/form.js`. The founder: *"I've been running about a
month straight and today was my best run yet, because I pay attention to it. I
need that progression. I need to see it. I need to see where my walls are."*

`progressionCall` answers this for a barbell and cannot answer it for a run —
no top set, no double progression, nothing to add. What a run has is **pace**,
and pace stalls in a way somebody can feel and not name.

- **A personal best is over a COMPARABLE distance** (within 20%). Beating a 5k
  pace on a 1km sprint is not a better run, and calling it one is how the
  number stops being believed.
- **The trend is first third against last third**, so one good day cannot carry
  it and one bad day cannot sink it.
- **A flat pace is named as the wall and never scolded.** It does not know
  whether it was heat, hills, sleep or a heavy week, and does not guess.
- Carried on `brief` so a best gets said **the day it happens** — that is the
  entire reason somebody goes out again tomorrow.

### Form — the shadow it leaves, never a claim about the lifter

`lib/form.js` + the `form_check` tool. The founder: *"sometimes I do skip and
the form goes out the window, and I think more form is more important."* He is
right, and this is the one place where being useful and being honest pull
hardest against each other — because the useful sentence is the one nothing
here is entitled to say.

**IT CANNOT SEE THEM LIFT.** No camera, no bar-speed sensor, nothing on the
bar. "Your form is breaking down" is an assertion about something never
observed — the same offence as reading a body-fat percentage off a photograph,
and it would poison every honest number the product has. So nothing here
describes technique.

What the record *does* carry is the shadow technique leaves behind:

- **The last set falling off a cliff, repeatedly.** 8, 8, 8, 4 is not a bad
  day — it is a weight that only holds for three sets. Requires it across
  sessions, because one collapsed set is a phone call or somebody taking the
  rack. The verdict is priced in kilos, not exhortation.
- **The same weight costing more.** RPE climbing while the load stands still.
  It says the cost went up and **refuses to say why** — recovery, food,
  technique, a bad fortnight at work are not separable from here.
- **Grinding.** RPE 9 and still short of target. The combination is the point:
  missing at RPE 7 means the weight is wrong; missing at 9.5 means nothing is
  being practised but failure.
- **Their own words, quoted and never interpreted.** The most valuable thing in
  the file and the least clever.

**Every finding ships with its evidence**, and the evidence is always rows the
log actually contains — a verdict without them is an opinion wearing a number.
It **only ever softens**: no finding may ever end in "add weight". And it is
deliberately quiet, because a coach who finds a fault every session is one
people stop listening to.

**This is the real argument for logging by voice.** A notebook has a column for
weight and a column for reps and nowhere at all for *"third set I rushed it"* —
so the one fact that explains the number six weeks later is the one paper
structurally cannot hold. The instructions tell the model to pass anything
about how a set FELT into `log_set` verbatim, including vague ones, and never
to tidy it into an assessment. Words about pain are marked as a report about a
body rather than a coaching cue: a doctor's question, not a form one.

### The plan — stated before the first session, changed in one sentence

`PACES` / `PUSH` / `goalCall()` in `lib/training.js`, `014_wrought_plan.sql`,
and the `my_plan` / `set_plan` tools. The founder: *"your plans to tailor-made
plan for you — aggressive, non-aggressive fat burning — and how hard this
thing's gonna prompt you. This should be explained right when you try your
first workout: what plan are you on? Let's build this thing before diving right
into it. And it should give you the ability to change it any time."*

Every piece of this already existed and **none of it was answerable.** The
intent sat on a goal row, the pace was hardcoded at 0.5%/week, the pushiness
did not exist at all, days and tier were profile columns. *"What am I actually
doing"* had no reply — and a plan nobody can state is a plan nobody is
following.

- **Pace is bounded, and aggressive is the fast end of SAFE.** Every pace still
  floors intake at 1,200 and still projects under the rate `careFlags` warns
  about. **The product must not prescribe what it warns about** — a plan that
  paces somebody into their own care flag would spend a fortnight coaching them
  to eat less and then tell them they were losing too fast. When a request hits
  a ceiling it comes back in `held` and is said out loud, never applied
  quietly. Tested across four body sizes at all three paces.
- **Push is not bluntness.** Bluntness is how a verdict is WORDED; push is how
  OFTEN training gets raised unprompted. Conflating them means turning down the
  nagging also turns down the honesty, which is the one thing the product
  exists for. A care flag silences pushing entirely — relentless is a setting,
  not a licence.
- **The plan is explained before the first session, once**, carried on
  `suggest_workout` as a `plan` block. Somebody training without knowing what
  they are training toward is doing exercise, not a programme, and the
  difference is whether there is a reason to show up on a Tuesday they do not
  feel like it. It rides ON the suggestion rather than blocking it: a setup
  interview between somebody and their first workout is how the first workout
  stops happening. Asked all at once, answered in the same turn as the session.
- **Changing it is never a negotiation** — the same doctrine as `drop_goal`.
  No remark about commitment, no asking why, no warning about backing off. A
  plan somebody keeps missing is a plan set wrong. `set_plan` recomputes the
  calorie and protein targets in the same call, so a new pace can never stand
  beside an old target — the stacked-rings bug, in a new place.

### "Wrought" is a word dictation cannot spell

Nobody types to this product; they talk to their phone. "Wrought" comes back as
**route**, rot, rout, wrot, rought. So `SERVER_INSTRUCTIONS` maps those onto
the connector whenever the sentence is about training, food, weight or a plan —
same treatment as *"jim bro"*. **The subject decides, not the spelling**:
"what's my route to the gym" is directions and nothing to do with us. It never
corrects the pronunciation and never replies "did you mean Wrought?" — it just
answers. Losing this breaks nothing loudly; the connector simply stops
recognising its own name, which is the hardest regression to spot.

### Three Siri synonyms, and the fix that was written before the error was read

**ITMS-90626: too many name synonyms in "en". No more than 3.** That was the
whole cause of two failed uploads, and it is worth recording twice over —
once for the limit, once for how it was handled.

`INAlternativeAppNames` is what makes "hey Siri, gym bro" reach the app, since
every `AppShortcut` phrase must contain the application name. Apple caps the
list at **three per language** and enforces it at UPLOAD rather than at build,
so a fourth compiles, archives, and then fails validation with an error a long
way from the file that caused it. Five were tried, then four. The three that
survive are *Gym Bro*, *Jim Bro* (dictation's version, same as the phrasebook)
and *Broski*. Adding a fourth means removing one.

**The process failure is the more useful lesson.** The archive succeeded both
times, which correctly says the Swift compiled and the bundle was refused — but
that was then used to reason to the wrong culprit and ship a fix, when the
upload log had the exact error in it the whole time. Two burned build numbers.
**Read the error before writing the fix**, especially when the error is sitting
in a log nobody has been asked for.

The plist is complete and `GENERATE_INFOPLIST_FILE` is `NO` regardless — not
because it caused this, but because relying on a merge this repo cannot test is
a standing risk. The `INFOPLIST_KEY_` settings were deleted rather than left
inert: two places for the health usage strings is how one of them goes stale,
and a stale usage string is an App Review rejection. A test pins the synonym
count and the required keys — the harness cannot run Xcode, but it can check
the things Xcode and App Store Connect would have complained about.

### Hands-free — Siri owns the wake word, and that is the whole design

`api-voice.js` + `lib/voice.js` + `ios/Wrought/WroughtIntents.swift`. The
founder: *"hey Siri, gym bro — and then gym bro knows it's on the mic right
away, so what I'm saying is transcribing."*

**A custom wake word cannot exist on iOS and never will.** Hotword detection
runs on a coprocessor Apple exposes to nothing, and an app cannot hold the
microphone open in the background waiting for its own phrase — it gets
suspended, the orange indicator burns all day, the battery dies and review
rejects it. So the wake word is Siri's. What follows it is ours, and
`INAlternativeAppNames` is the lever: every `AppShortcut` phrase must contain
the application name, so the app is taught to answer to **Gym Bro**, **Jim
Bro** (what dictation makes of it half the time, same as the phrasebook),
Broski and Coach. Then the sentence somebody actually says is the sentence that
works.

Two intents, and the list is short on purpose because **they run with the phone
locked** — `openAppWhenRun = false` so nothing opens and no Face ID is demanded,
`authenticationPolicy = .alwaysAllowed` so it works from a pocket. What that
exposes is bounded by design: appending to your own log, and hearing your own
day read back. **Nothing that deletes, exports or reads the record out in detail
may ever be given an always-allowed intent**, and there is a test that greps for
the attempt.

**The bearer is the device key, not a session.** A locked phone cannot run a
PKCE dance or show a sign-in sheet. It reuses the `wrought_ingest_keys` key the
HealthKit courier already holds — one credential on the phone rather than two,
revoked in the same place as everything else, and already in the Keychain with
`AfterFirstUnlock` accessibility, which is exactly what makes a locked
dictation work at all.

**Speech is not a screen, so the answers are short.** A verdict can be a
paragraph because eyes skim and can go back; a spoken answer past a couple of
clauses becomes something to talk over. `lib/voice.js` owns that shape and does
no arithmetic, and neither does the Swift — same doctrine as the connector, a
third mouth relaying numbers computed once. A care flag is the **entire** spoken
answer with nothing appended, because in speech "outranks everything" has to
mean the sentence stops there. Flags get their own human sentences: `guidance`
is written for a model and read aloud would be baffling.

**Nothing parses at the phone end, and that is the point.** There is no model on
that wire, so a dictated sentence lands verbatim marked `source: 'voice'` and
Siri says *"saved, word for word"* — a description, not an apology. The
connected AI does the structuring later, exactly as it does for the photograph
of a plate: `brief` hands back `voice_pending` with each id and what was said,
and `structure_entries` writes the reading back **by id** (`amend_last`'s "the
last thing today" is the wrong target when these are days old and several at
once; ids are checked against the caller's own rows first, because an unchecked
id would let a stranger rewrite somebody else's log). This is what keeps the
founder's objection answered — **the whole feature needs no API key.**

Still optional, like everything native. The website and the connector remain the
complete product; this is one more door.

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
- **A number they remember is a claim, not a load.** `baselineFromClaim()` +
  the `calibrate_lift` tool. For a lift with **no history**, the assistant may
  ask once what they usually do; the server discounts the claim (10% working,
  15% stated max — the least trustworthy number in any gym — plus 5% for
  beginners), converts across rep ranges by Epley, floors to a real plate, and
  frames the first set as a **calibration**. The performed set becomes the
  baseline; the claim goes to memory (category `lifts`), never into set
  history, and **the record beats the memory forever after** — `history_wins`
  when history exists. Never program a claim as-is, never suggest testing a
  max. This is the founder's "ask them their limits and be careful about it";
  the care is the feature.
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

### Changing your mind is one call, not a negotiation

`retireGoalsFor()` + `drop_goal`. *"I wanna have my goal switched to 12,000
steps — you'll do it."* `set_goal` used to INSERT, so a change left the old
10,000 standing beside the new 12,000: two rings for one intention, and a brief
scoring the same walk twice. A goal now **replaces** any active goal aiming at
the same metric and cadence, and the body-goal path retires all three of its
own. Retired, never deleted — what somebody used to aim at is part of the
record — and the answer says *"Changed"*, because a person who moved a target
wants to hear that it moved.

`drop_goal` removes one entirely, and its doctrine is one line: **maintenance,
never a confession.** A target nobody is chasing clutters every brief and turns
the dashboard into a list of misses, so removing it gets no remark about
commitment and no question about why.

**"I'm going to the gym" is an opening, not an order.** It is answered with ONE
line that already contains a proposal — what is most overdue from their log and
an assumed length — never three questions and never a silent session. The
readiness line comes FIRST when it is not *ready*: the body's veto belongs
before the plan. And **a new weight is just `log_weight`** — it silently
re-bases the resting burn, the calorie target and the protein target, and it is
never congratulated. Praising a loss while staying silent on a gain is how a
log starts getting edited to please the app.

### Readiness — the body gets a veto, never a spur

`readiness()` in `lib/training.js`, carried on `start_session` and every brief.
The founder: *"it has all my heart health data, it should show training spikes
... recovery should know the time you're starting your workout."* Resting heart
rate and sleep read against **their own fortnight** — you today versus you
lately, never a chart of strangers. 7% over baseline is the endurance-coaching
threshold; under that it is salt, sleep and what time somebody stood up.

**Two rules make it safe to ship.** It is **not a diagnosis** — an elevated
resting heart rate has a hundred causes this cannot tell apart, so no
condition is ever named and a week of bad signal is answered with "that is a
doctor's question". And **it only ever softens**: strained means train lighter,
same movements, nothing near failure; *ready* means train as planned and
**nothing more**. Turning a good reading into "add weight" is how the feature
would talk somebody into an injury on a day they already felt off — same shape
as `earnedRoom()`, which only ever adds permission. Both have tests.

**The training spike** rides on every workout: `avg_hr` and `max_hr` from the
watch's own per-session statistics, kept on the record so a run three months
from now is comparable at the same effort. HRV comes across as a recovery
signal, read as a trend, never as a clinical number.

### Targets, drawn rather than described

`scoreGoals()` gains `percent` / `over`; `targetsPanel()` draws them as rings
directly under the day's hero. The founder: *"set some goals like 10,000 steps
... it has to be visually stunning."* A goal in prose is a note to self; a goal
as a ring is a fact taken in without reading — and "am I on track" is the
second question anybody has, right after "what did I do".

**The percentage is computed server-side** like every other number, so a ring
and the brief can never disagree about the same day. An `at_most` goal fills as
it is SPENT — 80% of a calorie ceiling means 80% eaten, the direction that
reads correctly at a glance. The percentage is **uncapped** while the arc is
capped: an overshoot is flagged and stated, never hidden behind a full circle.
Colour is the verdict only — moss met, temper on the way, heat for a ceiling
actually passed. Nothing red, nothing scolding: a half-full ring is
information. `distance_km` and `active_minutes` became scoreable when the iOS
app started sending them — a metric nothing can aim at is a dead end.

**The baseline is asked for once**, the first time somebody trains or asks with
no goals on file: one question, then targets in the same turn. Suggestions are
pitched at where they actually are (steps a little above their current average,
not a round number off a poster). **Changing a target is never a negotiation** —
a goal somebody keeps missing is a goal set wrong, and lowering it to what they
will really do is the correct move, because a target nobody hits stops being
read at all.

### A body goal becomes numbers — computed, paced, floored

`goalCall()` in `lib/training.js` + `intent` on `set_goal`. *"Should be getting
goals established as well — losing weight, gain more muscle — and tailor plans
to that."* The words are the goal; the **server** turns them into targets,
because a model asked for a cutting target confidently says 1,500 — to a 150kg
man and a 60kg woman alike, and one of them gets hurt.

The rails are the point: loss paced at **0.5% of bodyweight a week** with the
daily deficit clamped 300–750, the intake target **never below 1,200** (the
care-flag floor — the product must not prescribe what it warns about), a gain
is a small ~250 surplus, protein 1.6 g/kg capped at 220g, and *"lose weight AND
get more muscular"* is `recomp` — modest deficit, protein high, training does
the rest. One call sets the calorie and protein daily goals alongside the goal
itself, so the brief scores the plan the moment it exists. Without the five
facts it refuses and asks. Everything is labelled an estimate, and the caveat
is doctrine: **the weekly weigh-in trend corrects the target, never the other
way round.**

### At the rack — the clipboard, the swap, and the next workout

Three rules for the live session, all born from the founder describing how he
actually trains:

- **The server holds the clipboard.** Every `log_set` answer carries a
  `checklist` — each exercise with sets×reps, marked done / current / to come,
  with sets remaining on the live one. "What's left" is answered from the
  latest checklist, never from the model's memory. One short question per rest
  gap, never a form.
- **`swap_exercise` — the machine being taken is normal, not a discussion.**
  Same PATTERN through kit the person owns (the library knows both), sets and
  reps kept, sets already done counting toward the slot. **The load comes from
  the replacement's own history, never carried across** — 80kg off a bench
  press landing on a machine press is how an interruption injures somebody.
  With no history, the RPE refusal applies as everywhere else. A named
  preference wins even off-library; their gym has machines ours does not.
- **`end_session` names the next workout.** From the block when one is running
  (deload weeks flagged as deliberate; a finished block is SAID — the only
  reward the structure had), else the longest-rested routine. It also carries
  `training_week`. The server can never speak first, so the close of one
  session is the only place the next one can be planted.

### A saved workout, the tick list, and the five minutes before

`lib/warmup.js` + `notes` on `wrought_routines` + the checklist panel. The
founder: *"I want saved workouts like my S-tier workout that I can create with
the GPT... it should have a name, the procedure, a write-up at least, with a
checkmark that will calculate how much percent of your workout you've
completed. And before workout it really should ask — recommend some stretches
and so forth. You can always say skip it, but it should be part of the
package."*

- **The write-up is what makes it a workout rather than a list.** `save_routine`
  takes `notes` — what the session is for, why that order, what to push and
  what to leave a rep in the tank on — shown at the top every time it starts.
  It **survives an `add[]`**: wiping the reasoning because somebody added calf
  raises is the same loss as an amend overwriting a known detail.
- **The percentage is over SETS, never exercises.** Three of four exercises
  touched is not 75% when the last one is six sets. Capped at 100 while the
  count underneath stays honest, and computed in `sessionProgress()` — the same
  function `api-session.js` and `log_set` both call, so the screen on the rack
  and the voice in the conversation can never quote two different numbers in
  the same minute.
- **The warm-up is built from the patterns in THIS plan.** A generic warm-up is
  obviously generic and gets skipped for that reason alone. It is offered in
  one line, skippable in one word, and **the session is handed over without
  waiting for an answer** — a warm-up that blocks the workout is one people
  resent and then a session they stop starting.
- **Dynamic before, static after**, and that is content rather than taste: a
  held stretch immediately before a heavy set measurably costs force for the
  next half hour. The static work is real and is offered at the END.
- **It is never physiotherapy.** With a limitation on file the warm-up still
  runs but never claims to treat anything — the not-a-doctor line, in the place
  it is most tempting to cross.

**A session logged through the assistant now burns something.** `needsDuration`
flags a workout that went in with no minutes, because it contributes exactly
zero to calories out while looking perfectly logged — the same failure as a
named food with no macros, in the place people are least likely to check. The
figure is computed from minutes **and their own bodyweight**: sixty minutes of
lifting is not the same number for a 60kg and a 150kg person, and a standard
guide figure is wrong for both.

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

### The expectation — set once, kept visible, never a debt

`weekSoFar()` in `lib/training.js`, carried on every brief as `training_week`.
The founder's ask: *"set the expectations of like three or five workouts a week,
create that baseline and then go from there."* An MCP server can never make the
assistant speak first, so the expectation cannot be a reminder that arrives —
it has to be a number already on the table every time the person talks. The
notification channel is the only surface that genuinely speaks first.

Setup mirrors the five facts: the first time somebody wants a workout and the
profile has no `train_days` or equipment, the assistant asks ONCE, all together
— days they will honestly do, equipment, anything they cannot do (limitations
go to `remember` category `health`, and are never silently programmed around).
Weeks start Monday. A missed week is information, never a debt: **sessions never
roll over**, an impossible week is told it will finish short rather than counted
down to zero, and a met target or a care flag silences the push entirely. Guilt
is how training logs die. Tested, including the absence of scolding words.

The dashboard has a **1d** range — `api-progress` clamps at 1, not 3, because
"show me today" silently becoming "show me three days" is a lie in a small hat.

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

### Lines that say whether it is working

The founder: *"I want some line graphs — up and down, if you progress on
calories per day, a 2-D line and progression, the same with workouts."*

Line charts existed. What they lacked was any way to tell **progress** from
**movement**, which is the only question anybody has of one.

- **The seven-day mean rides alongside the daily line.** One day's calories is
  salt, sleep and what somebody remembered to say; the eye follows spikes and
  spikes are noise. This is the trends-beat-days doctrine made visible.
- **The target is drawn on it**, dashed and under the data. Without it a chart
  says a number moved and never whether it moved the right way. It is forced
  inside the frame — a target above the data's own maximum would render off the
  top of the plot and silently stop existing, exactly when somebody is furthest
  from it.
- **The area fills each contiguous run, never across a gap.** Filling straight
  through an unlogged stretch paints a solid shape over days with no data in
  them, which is a picture of a record that does not exist.
- **Sessions a week is a rolling seven-day COUNT**, not a per-day one — a raw
  count is 0,1,0,0,1, a barcode rather than a trend. The rolling figure IS
  "workouts a week", which is the number the whole expectation rests on.
- **Axis labels are deduped.** A 3-to-4 range rounded across three ticks
  printed "4, 4, 3" and made the training number look broken.
- All of it computed in `api-progress` — `rolling()` and `trailingMean()` — and
  the mean **skips unlogged days rather than averaging them in as zero**, the
  calendar's rule, which runs in the dangerous direction if it is got wrong.

**Saved workouts became readable on the website too.** `routinesPanel` opens to
the write-up and the movements; the assistant could recite all of it while the
dashboard showed a row saying "Leg day - 4 lifts". A memory product that cannot
show you what it remembers is asking for trust it has not earned - and that
applies to a routine exactly as it applies to a meal three weeks ago.

### The day, given a shape

The founder, looking at the Log: *"this has to be clean and beautiful, not
ugly. You should say all the information as well, but you should be giving a
very good visual indicator."*

**Nothing was removed.** Every number in the old text run is still on screen —
it was given somewhere to sit. The day now opens with its calorie total at
headline size, a **macro bar** underneath it, and the device readings as chips
instead of a run-on blue sentence.

- **The macro split is by CALORIES, not grams**, and computed in `api-log`.
  Fat is 9 kcal a gram against 4 for protein and carbs, so a gram bar draws a
  high-fat day as a low-fat one and the picture ends up arguing with the total
  printed directly above it. Server-side because **a drawn proportion is a
  claim about the day** and has to come off the same numbers the brief quotes.
- **Sugar gets a figure and no swatch.** It is a subset of carbs, never a
  fourth slice, and a swatch would imply a share of the bar it does not have.
- **Dates read as dates.** "Mon 2026-08-10" is a filename; the ISO form stays
  on the title attribute because that is what somebody quotes back when
  something is wrong.

**The view switcher is one control, not five loose boxes.** A row of separately
outlined rectangles reads as five unrelated buttons; an inset track with a
filled pill reads as one thing with a current position, which is what it is.
The range row (`1d / 7d / 30d`) deliberately keeps its outlined form — it is a
filter, not a place you are, and collapsing them would make "30d" look like
somewhere you had navigated to. Same palette throughout; fewer edges.

`MONTHS_SHORT` is named apart from the calendar's `MONTHS` — the `.bar` lesson,
applied before it cost anything.

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

### A target beside its maintenance, and twenty questions nobody sits through

Two asks from one message, and they pull in opposite directions.

**The number needs its context.** The founder: *"it might say you're allowed
2,400 a day, but it should also let you know that your maintenance is this
while what you're trying to achieve is that."* Exactly right. `my_plan` gave a
bare `calorie_target`, and a target on its own is a rule handed down — it reads
as arbitrary and invites exactly the argument the invented-2,600 incident
turned into. It now carries `maintenance`, `deficit` and
`projected_kg_per_week` beside it, and the instruction is to say all three
every time: *"2,833 against a maintenance of 3,833, so about a thousand down a
day and roughly 0.9kg a week."* That is a decision somebody can judge.

**And twenty questions, asked one at a time.** He wanted a twenty-question
intake. He is right that the context makes the coaching better and wrong about
the delivery: a twenty-question form at signup is the most reliable way to make
somebody close the tab, and it contradicts the settled five-facts doctrine.

So `lib/intake.js` holds the list — twenty-five things, from the five that
block arithmetic through injuries, medication, sleep, how they actually eat,
where their eating falls apart, and how they want to be spoken to. `get_profile`
carries what is known, what is not, and **`ask_next`: one item, never a list.**

- **The hard five are still asked together, once**, the first time a number
  needs them. Nothing changed there.
- **Everything else is picked up in passing**, only when the conversation has
  already walked into it — somebody mentioning a sore knee is the moment to ask
  about injuries and no other moment is. Never a form, never two in a turn, and
  the model is told not to mention that a list exists.
- **Limitations jump the queue** among the soft ones. Programming around an
  injury nobody mentioned is how this hurts somebody.
- **Medication and conditions are recorded, never advised on** — the
  not-a-doctor line, in the place it is most tempting to cross.
- **Somebody who ASKS to be set up properly gets the whole thing**, because
  they asked. Available on demand, never imposed.

No migration: soft answers land in `wrought_memory` under their category, which
is why free text survives intact.

### The conversation the tools were absent from

*"They're recorded in this chat, Broski, but not logged in an external
app/Roz, because I don't currently have its logging connection available.
Today: ~2,050 calories eaten + 5 hours petting-zoo work."*

**That answer is right, and it is the improvement.** Every earlier version of
this incident had the assistant claiming a save that never happened; here it
said plainly that the record does not hold it. Nothing about the honesty needs
fixing.

**Stopping there is the failure.** A day sitting in a conversation is one
closed tab from being gone forever, on the product whose entire promise is
that it remembers. So the instruction is now that the moment a tool call works
again, the whole conversation gets **flushed** — one `log` call carrying every
food and drink, plus `log_activity` for the shift — and then `day_total` is
read back and quoted. Not summarised, not waited on, not offered.

- **The times travel with it.** `time_hint` per item, or the entire day lands
  at the catch-up minute and reads as one meal to the day card, the eating
  window and every average built on it. A catch-up spanning a previous day is
  ASKED about rather than filed, because a client may not date its own events
  and yesterday's dinner under today corrupts both days at once.
- **Belt on the sheet, braces on the tool.** ChatGPT does not reliably read
  `SERVER_INSTRUCTIONS`; it always reads the description of the tool it is
  calling, so the rule rides on `log` as well.
- **"Are they logged?" is a question about the RECORD**, and it was in the
  phrasebook nowhere. Mapped now — along with *"did that go in"*, *"is it in
  there"*, *"did you save that"* — and answered by reading the day back, with
  anything missing written immediately rather than explained.

**And `Roz` is another spelling dictation makes of the name.** The list had
route, rot, rout, wrot, raw and rought; the founder's own phone produced *Roz*
twice in one conversation, and both he and the assistant then used it. A
connector that does not recognise its own name is the hardest regression to
spot, because nothing breaks loudly.

**What could not be fixed from here** is the cause: the connector was not
available in that chat. That is a ChatGPT-side setting per conversation, and
when the tools are absent, none of this server's instructions or descriptions
are in the model's context to steer it. The catch-up is the recovery, not the
prevention.

### Sustained means NOW, but the flag keeps its memory — the wolf-cry fix, corrected by its own review

The founder, after three weeks of the identical doctor sentence on his lock
screen every morning: *"Is this ever gonna be resolved?"* The honest answer
under the whole-window rule was **September 12** — five half-logged days from
mid-August kept it firing daily while his current week ran 2,065 / 2,240 /
1,535. He had long since stopped reading it, which is the failure the
partial-reading entry already names: **a dismissed care flag is as dangerous
as a missing one.**

**The first fix was wrong, and the adversarial review proved it by running
the code.** Judging only the last 7 logged days went blind to a 5:2-shaped
crash pattern (two 450-kcal days, five 1,250-kcal days, every week — a
sustained **1,021 average** with never three thin days in one week), and
forgot a genuine 200-kcal crisis five logged days later behind days that only
scraped past the binary 1,200 line. The claimed backstop was false:
`rapid_loss` needs weigh-ins, and the person this flag exists for is the
person avoiding the scale. Those counterexamples are pinned in the harness so
they cannot come back.

The rule is now a **composite — any one reading fires, at full strength**:

- **Acute** — 3+ of the last 7 logged days under 1,200. Present tense.
- **Average** — the last 14 logged days *averaging* under 1,200: the
  doctrine's literal definition, and the reading line-scraping cannot fake
  (a 200-kcal crisis followed by 1,210-kcal days averages 831 and HOLDS
  until recovery is real eating).
- **Lingering** — 3+ thin days across the month AND the latest still inside
  the last week of logging. Accumulated evidence fires while it touches the
  present — the weekly two-crash-day cycle stays caught forever — and
  releases only after a genuinely clean week, not a calendar month.

What the founder gets: the flag clears **days** after honest eating resumes
(a clean logged week plus a healthy fortnight average), never three stale
weeks later — escapable by behaviour, which is what keeps it believed. What
never moved: the 1,200 line, full-strength firing on thin logs, the partial
reading, flag-outranks-everything, and the guidance. Clearing now costs a
clean week AND a healthy average — the price the old rule charged, minus the
wolf-cry.

### The invented target — the named failure, in production

The most important entry in this file, because the thing every doctrine here
was written to prevent happened anyway, on the founder's own phone.

Asked *"how many am I allowed to have today at my weight?"* with no goal on
file, the connector answered: *"At 330 lb, 6'3", male, age 44, a reasonable
starting target for steady weight loss is around 2,500–2,700. I'd set your
working target at 2,600."*

**Nothing set 2,600.** It was invented, delivered as a recommendation, and it
was **below even the aggressive pace** the product itself will apply — the
computed figures for that person are 3,433 gentle, 3,083 steady, 2,833
aggressive, against a maintenance of 3,833. So the invented number was a
deficit roughly 480 kcal a day deeper than the paced one, which is the
direction that hurts somebody, from a product whose entire purpose is not doing
that.

**Instructions alone did not stop it and were never going to.** `setupNeeded`
already carried a blunt "do NOT pick one yourself" note — but only on two
tools, and the question did not land on either. **A model invents when it is
asked a question and handed nothing.** The fix is not more forbidding; it is
removing the vacuum.

So `targetOptions()` computes every defensible answer — maintenance, and the
three paced cuts, each floored at 1,200 and held under the care-flag rate — and
`get_profile`, `get_day` and `energy_balance` all carry it as `no_target_set`
whenever no daily calorie goal exists. There is now a real number exactly where
the model used to reach for a plausible one. Nothing is *set* by this: they are
options, `set_goal` still commits one, and offering a number is a different act
from imposing one.

The rule is stated in `SERVER_INSTRUCTIONS` as the top of the honesty section
and names the incident, because an abstract prohibition is what failed:
**a calorie figure may only ever come from a tool.** Same for a working weight,
a protein target, a deficit or a burn. Tested — including that the computed
floor sits above the number that was invented, so the guard is not decorative.

### Basal is not maintenance, and the number now shows its working

*"It should be about 3,000 or more just basal because I'm 330 pounds, and I
don't know why it keeps reverting it there."* Nothing was reverting - the
figure is deterministic from height, weight, age and sex - but **there was no
way to see that from the screen**, so it looked arbitrary.

`restingBurn` now returns a `basis`: the inputs, the age it derived, and the
equation by name. Folded away under the hero, because the working matters
enormously once and is clutter every day after. **A number nobody can audit is
a number they stop believing**, and they are right to - a stale height or a
wrong birth year produces a confidently wrong figure indistinguishable from a
correct one.

**The gap that caused the argument is BASAL versus MAINTENANCE.** Most
calculators quote maintenance - basal times an activity multiplier - which
lands several hundred higher on the same person. WROUGHT quotes basal and adds
the movement separately, so its `calories_out` is usually the *higher* number
once compared like for like. Naming the equation matters too: Harris-Benedict
lands a couple of hundred above Mifflin-St Jeor on the same body, and without
the name that difference reads as a bug.

Mifflin-St Jeor genuinely does read low for somebody carrying a lot of muscle.
The honest correction is the **weekly weigh-in trend**, never a different
formula chosen because its answer is nicer.

**An activity multiplier is a forecast.** It is the same number at 8am and at
11pm because nothing measured anything, so `other_projected` marks it and the
bar says *"moving, projected"* rather than *"moving today"*. Reporting a
projection as movement that has happened is a claim about a morning nobody had.

### The day is spoken directly under the numbers

`foodTodayPanel()` in `app.html`, first thing under the hero, with the training
panel moved up beside it. The founder, looking at *"3,065 to burn today"* over
an empty day: *"if you're showing the facts of the numbers, you should be
speaking to it underneath — what did you do today? What did you log today? How
much food did you eat? What kind?"*

The gap was structural: the Record tab drew the arithmetic ABOUT the day and
the actual entries lived only on the Log tab, so the screen that opens first
could quote a burn with no answer to *"against what"*. Now: every food item
with its own calories and time, the sum underneath (the day-card doctrine, on
the first screen), an entry with no calories saying it *counts for nothing
yet* rather than dashing quietly, and the training rows reading heart rate
from the session effort stamp as well as a device's own fields.

**The empty state names the failure it usually hides.** *"Nothing logged yet"*
on this panel most often means food was said to an AI that heard it and never
wrote it down — so the panel says exactly that, with the one-word fix ("say
'log that'"). A screen that reads the truth plainly is the fork-detector the
conversation cannot be.

### Two bugs a screenshot at 7am found

Both looked like amnesia and neither was.

**The 1d view lost the weight.** The burn's weight fallback searched only the
LOADED range — and a one-day range usually has no weigh-in on it, so
`restingBurn` came back missing, and the whole five-facts form reappeared
asking for a height the profile was holding perfectly well. It now falls back
to the most recent weigh-in anywhere, which is what `balanceFor` in the MCP
layer always did. **A window is not a memory.**

**And the form asked for everything regardless.** Even with height on file it
rendered an empty Height box, which reads as forgetting. It now renders only
what is genuinely missing, pre-fills what is known, and counts anything on file
as answered rather than demanding it be typed again.

**Nothing eaten yet is not a deficit.** Resting burn is a WHOLE DAY's figure,
so at 7am against no food the subtraction said *"3,833 under"* — an artifact of
the day being four hours old rather than a reading, and one that runs in the
dangerous direction, since an overstated deficit is the number that tells
somebody to eat less than they need. Until something is logged there is no
ring: the burn is shown as the burn, labelled *"to burn today"*, and the caveat
says it is the whole day's estimate rather than what has been spent so far.

### The max — recorded, estimated, and never something to go and test

`estimatedMax()` + the max on every lift. The founder: *"should be recording
my max for each one and it should be in a live graph."*

**A best SET is the honest record** — 235 for 4 is a fact that happened. But it
cannot be compared against 175 for 8, and that is the whole problem with
reading a training log: every set sits at a different rep range, nothing lines
up, and progress is invisible even when it is real. Epley puts both on one
scale, which is the only way *"am I stronger than in March"* has an answer.
Both numbers are shown: the real set, and the estimate that makes it
comparable.

- **Labelled an estimate everywhere it appears.** An unlabelled projected max
  is a number people go and try to lift.
- **Nothing is ever programmed from it**, and WROUGHT never suggests going and
  testing a real one. A max attempt is the single most dangerous thing an app
  can talk somebody into — the estimate exists precisely so nobody needs to.
- **Reps capped at 12.** Epley diverges badly above that; a set of twenty would
  produce a confident and absurd figure.

**And a personal record is memory, not a window** — the third place this rule
has been needed, after the weigh-in and last night's session. Lifts are built
from the floored history rather than the selected range, and the panel is no
longer hidden behind the trends gate: *"what is my best bench"* must have the
same answer whichever range button is pressed, and a record that changes when
you press one is not a record.

### What the session cost, and the cardio counted apart

`lib/effort.js`, stamped on the workout event at close. The founder: *"when you
start your workout you should officially start the heart rate during that
period, during each exercise... and yesterday my treadmill stuff should be
calculated as a separate statistic."*

**All of it was answerable from data already arriving, and no new sensor was
needed for any of it.** "Officially start the heart rate" turns out to be a
QUERY rather than a feature: `wrought_sessions` already stores `started_at` and
`ended_at`, `heart_rate` samples already arrive with `measured_at`, and nothing
was reading one against the other.

- **Per exercise, from the set clock.** `wrought_sets.logged_at` means the
  samples between one lift's first set and the next lift's belong to the lift
  being done then — including its rest gaps, which is correct: the cost of a
  heavy triple is partly what it does to you for the two minutes after.
- **A treadmill is not a bench press.** Blending twenty-five minutes of incline
  walking into "volume moved" makes the volume wrong and hides the cardio
  entirely — same doctrine as a shift not being a session, one level down. Two
  statistics, and the split is by MOVEMENT rather than by session, because a
  session is very often both.
- **"No heart rate" and "no watch on" are different facts** and the reason is
  named: *the window is right, the samples are missing.*
- **The caveat rides every time.** A wrist reading moves with grip and cold
  hands as well as effort — a trend across sessions, never a score for one set.

**And a heart rate is a training statistic and nothing else.** Blood oxygen,
respiratory rate and the rest of `CLINICAL_CAUTION` are stored and shown as
readings, never pulled into this: a clinical number beside a workout invites
*"is that bad"*, and the honest answer is a doctor, never a fitness app. There
is a test that greps for the leak.

**On more sensors: the door is already open.** `/ingest` is a documented public
endpoint that takes any named metric, and Apple Health and Health Connect are
already aggregators — a strap, a ring or an oximeter that writes to either is
carried with no new integration. That is the whole reason the hub was built
wide.

### "Never estimate — you have the Apple Watch"

Two halves, and the first is a presentation failure rather than an arithmetic
one. On a measured day the hero read *"524 TRAINING (ESTIMATED)"* — but
524 + 68 = 592 was **exactly the watch's active total**; only the SPLIT
between training and the rest of the day was derived. Labelling the split
"estimated" made a measured day look invented. The hero now says the truth in
one line: *"Your watch measured 592 moving in total today — the split between
training and the rest of the day is the estimated part."*

The second half is a real measurement upgrade: `windowedActive()` in
`lib/effort.js`. The watch's `active_calories` rows inside the session window
become the session's own calories, stamped at close (`calories_source:
'watch'`), so `trainingBurn` counts them as measured and the label goes away
honestly. **The guard is the point**: active energy often arrives as ONE
daily-total row, and a single row falling inside the window is the whole day
wearing a session's clothes — billing a day's 592 to a fifty-minute session
overstates the burn in the direction that tells somebody they have room to
eat. Two or more rows for the day (sub-daily granularity) or the labelled
estimate stands. Verified to bite.

### The athlete track — sensors as trends, tests as bests, one thing to work on

`025_wrought_athlete.sql` + `lib/athlete.js` + `log_test` / `athlete_report`
+ `track` / `sport` on `set_plan` + the *Athlete* panel. The founder: *"as a
trainer for competitive sports, that should have a version where we take more
sensors — VO2 max, sprint time and stuff like that. This should have a plan to
build you like a super athlete, and your reminders should reflect all this:
you should be working out five times a week, these are the ones I recommend
you work on. It should analyse."*

Everything the watch sends was already stored — VO2 max, resting HR, HRV,
one-minute HR recovery, walking HR, the six-minute walk — and nothing read it
as a trend or turned it into a recommendation. Now:

- **Markers are THIS MONTH AGAINST LAST**, needing three samples on each
  side; one reading is a reading, not a trend. Each marker knows which
  direction is the good one (VO2 up, resting HR down). A missing marker says
  so and **how it arrives** — never a number in its place.
- **Tests are bests.** `log_test` takes what a person can only run and tell
  you — a 40 m sprint, a vertical jump, a 5k, a mile, the beep test, a plank —
  parsed from *"24:10"* / *"23 inches"*, stored in `wrought_metrics` at noon
  of the day with `source: manual`, so a re-told result **replaces** through
  the dedupe index rather than doubling. Never estimated, never converted from
  a workout.
- **At most three recommendations, each with its evidence**, in a fixed
  order: **recovery first, and it only ever means lighter this week** (a
  falling HRV or rising resting HR must not be told to add a stamina session),
  then engine (stamina sessions short, or VO2 flat/down), speed (no test, a
  stale test, or well off the best), strength, consistency. `top.say` is the
  one line — *"Work on: …"*.
- **Nothing here is medical.** VO2 max, HRV and heart rate are training
  signals read as trends against the person's own record — never a diagnosis,
  never *"your heart"*, never a reassurance either. The caution rides every
  response and is printed on the panel; a test greps the read for clinical
  words.
- **The commitment is OFFERED, never set.** Switching onto the track with no
  commitment offers five a week — two strength, two stamina, one speed, about
  five hours — and `set_plan` writes it only on a yes or their own numbers.
  Then the Wednesday check and the morning brief carry *"work on"* every week.
- **The reminders reflect it.** `week_check`'s body gains the top
  recommendation; the morning brief gains the same line after the week's
  position; `brief` carries the whole `athlete` block. All from ONE read, so
  the notification, the brief and the panel cannot name different things. A
  care flag silences the line everywhere.
- **Off the track it costs nothing** — no metrics query, `athlete: null`,
  no panel. A sport named in the in-passing questionnaire (*"none"* is a real
  answer) puts somebody on the track; so does *"I play hockey"* through
  `set_plan`. Applied to the live database through the connector.

### Every style has a voice — a register that changes delivery and nothing else

`lib/voices.js`, merged onto `STYLES`, carried as `voice` on `design_workout`
and on every `log_set` of a session run from a tradition workout. The
founder: *"each coach's style should reflect their attitude, their
aggressiveness and so forth."*

A style already changed the session — sets, reps, rest, the finisher. This is
the other half: **how the trainer standing there talks**, once the person has
picked that style for the day. A corner man counts the clock down. A
high-intensity coach wants one set and silence. An easy-strength coach sends
them home. Each voice is a register: attitude, intensity (`calm` / `steady` /
`demanding` / `relentless`), example lines between sets, what it does on a
miss, what it never does.

**The gym-bro rules, with a tradition's name on** — and every one is a test:

- **Delivery only.** A demanding voice never adds a plate or a set; a calm one
  never removes one; every load still comes from `log_set`. A test greps every
  line for *add a plate / go heavier*.
- **A register in that tradition, not an impersonation.** No voice line
  carries the surname, none says *"I am …"*, and every voice carries the
  honesty sentence in its own data. The routine's NAME carries the surname on
  purpose — that is how the person finds it (`styleFrom` on the session name
  is how `log_set` finds the voice) — and the voice never speaks it.
- **Honest, never cruel, still.** No body, no shaming; *relentless* is about
  the next set, never the person. A care flag silences every voice exactly as
  it silences gym bro.
- **The person's own bluntness still governs verdicts** about food and the
  week; the voice governs the session.

The Trainer-styles and Tradition-workouts panels show the intensity stamp,
the register and the attitude line, so picking a style is picking a coach with
eyes open.

### The shelf — the twenty-one listed, taken from in a tap, and in the morning

The founder: *"this should go in your morning brief, and this should be added
as a list somewhere in the app or webpage so that people know what's going on
with this — and it should be totally customisable, add and subtract workouts."*

- **A *Tradition workouts* panel on the Trainer tab** lists all twenty-one
  with the write-up and the movements, grouped by discipline. *Add to my
  workouts* goes through `routineAction({ action: 'create' })` — the same door
  as every other workout — and *Take out* RETIRES it (put back in one tap;
  delete stays on the Saved-workouts panel where it asks first). Once added it
  is theirs to edit like any other saved workout. `api-progress` sends
  `traditions` from `STYLE_ROUTINES`, so the website and the tools carry one
  list. Never in the demo.
- **The morning brief names the shelf**: *"Up next: S-Tier, about 50 min. Or
  one of your 22 saved workouts — tap to choose."* The opener asks the
  assistant to list them by name from `list_routines`, due one first, rest
  day a real answer.
- **`pickDue()` — the seeding exposed a real bug.** Both the morning and
  `end_session` picked *"up next"* as the longest-rested routine with nulls
  first, so the day the twenty-one landed (never run, `last_used_on` null)
  the morning would have offered *"Up next: Fight camp"* to a man whose
  workout is S-Tier. The picker now prefers what has actually been RUN,
  longest rested among those; never-run routines are offered only when
  nothing has ever been run. One pure function, both readers, tested to fail
  on the nulls-first order.

### Where they train — a place is a row, not a sentence

`024_wrought_places.sql` + `lib/places.js` + `add_gym` / `my_gyms` /
`drop_gym` + `place` on every training door and on a logged workout. The
founder: *"when you're doing a workout — you could do it manually as well,
like 'I'm going for a walk at the park'. But if there's a new gym and it
recognises that you're working out somewhere else, it should add a new gym.
Some of that coach should be ready in there, because I've added a few gyms
already."*

**He had added them — to ChatGPT, which said it saved them and wrote
nothing.** The memory table on his account held zero gyms. A place kept as
free text in `wrought_memory` (category `gym`, the earlier design) is a place
the model has to parse back every time and a save nobody can check — the
claimed-save failure with a gym's name on it.

- **One row per place**: name, kind (`gym` / `home` / `outdoor` / `travel`),
  equipment, times used, last used. Unique per name, case-insensitive.
  `wrought_sessions.place` carries where a live session is; the finaliser
  stamps it onto the workout event as `detail.place`; `workoutList` and the
  day panels show *"at GoodLife"* on the row.
- **A place named is a place recorded.** `place` on `suggest_workout`,
  `start_session`, `design_workout` and on a workout in `log`. The first time
  a name is said it becomes a row — nobody opens a settings screen to add a
  gym. `add_gym` reads the list back off the record, so *"added"* is a claim
  the record supports, and the never-claim rule rides the tool.
- **A new gym is asked for its kit ONCE, in one clause, and never blocks.**
  Until the kit is known the session is built for the main gym's equipment
  and the response says so — building blind is the failure the founder named
  (*never build a plan around a machine the photos did not show*). **An
  outdoor place is never asked**: the park has no rack; a walk at the park is
  a workout with a place, full stop. Kind is inferred from the name
  (`kindFor`) and can be stated.
- **Every door degrades before 024**: probed once per container, the tools
  answer with the migration by name, sessions open without the column, and
  the finaliser does not select it. Applied to the live database through the
  connector.
- The Trainer tab has a *Where you train* panel — each place, its kind, its
  kit or *"no kit listed yet"*, and a one-tap *Train here*. Memory-era gym
  sentences surface once in `my_gyms` as `unstructured_gyms` with an offer to
  add each properly.

### Twenty-one lineages — named for the method, credited as a tradition, never an ambassador

`STYLES` in `lib/design.js`, the Trainer-styles panel, `design_workout`. The
founder: *"what are the top biggest trainers in the world ever — I want twenty
of them, Freddie Roach, Louie Simmons, Schwarzenegger — as kind of our
ambassadors, but we're gonna have to call it a style."* And then the question
that settled the shape: *"if I copy their styles and put their name in it, will
I get sued?"*

**The method is not protectable. The name is.** Nobody owns one hard set to
failure or a max-effort day; anyone may train that way and say so. A person's
name on a paid product implies their endorsement — right of publicity — and
most of these people are alive and several actively protect their names. A
handful of the method names are trademarks outright: Starting Strength, 5/3/1,
Westside Barbell, FST-7, Heavy Duty. *"Ambassadors"* is exactly the word that
would draw the letter. The founder chose the honest form in as many words:
*"build it that way, like a tradition."*

- **A style is named for its METHOD** — *Conjugate method*, *Fight camp*,
  *One hard set*, *Aerobic base* — **recognised from the famous name people
  actually say** (`match` carries the surname and the brand, because
  recognising what somebody said is not the same as using it as ours), and
  **credits the person as the lineage**: `tradition` reads *"in the tradition
  of Louie Simmons' conjugate method…"*. Never the author, never an endorser,
  never a face. `provenance` on every one says published methodology, *not
  his programme and not an endorsement*. That is the ordinary, allowed way to
  reference published work, and it is also the honesty doctrine this product
  already runs on. **A test asserts no style's name contains a surname or a
  trademark, that every lineage is credited as a tradition and disclaims both
  programme and endorsement in its own data, and that the word "ambassador"
  appears nowhere in the product.**
- **The twenty-one**: Roach, D'Amato, Dundee, Steward (boxing); Simmons,
  Sheiko, Starr, Rippetoe, Wendler (powerlifting); Poliquin, Bompa (strength
  and conditioning); Bowerman, Lydiard (running); Tsatsouline, Dan John
  (kettlebell and simplicity); Weider, Gironda, Jones, Mentzer, Rambod,
  Schwarzenegger (bodybuilding). Plus the three unnamed generic shapes that
  were already there. *"A lawsuit"* in the founder's dictation was Louie
  Simmons.
- **A style genuinely changes the session, and says what it changes.** Sets,
  reps and rest as before, plus three shapes added for this list, each with a
  test: a **finisher** that lands on the last lifting movement only (seven
  sets on every movement is a different and much worse session), a
  **movement cap** that can lower but never raise the clock's ceiling, and a
  **long-conditioning share** so a running style gives most of the hour to one
  steady effort. `emphasis` is one honest line about what the style does; where
  a method is really about the WEEK — hard/easy days, periodised blocks, a base
  built over months — the line says so and names the tool that owns the week
  rather than pretending one session carries it. **The beginner cap holds for
  every style**, and so does the no-loads rule the harness already runs across
  all of them.
- The panel groups by discipline, shows the tradition under the method and the
  emphasis under that, and the *Build it* tap carries the tradition into the
  ask. The response carries `tradition` and `emphasis` beside `provenance`.

### The trainer between the sets — words in, load out

`lib/coach.js` + `felt` on `log_set`. The founder: *"we have to get like a
professional trainer... asking me questions in between reps. Where are you with
this today — you can go a little harder or a little softer. And when I say I'm
done my first set: how'd it go, were you struggling."* And the day that made it
concrete: *"285 on each side, I did eight, my full reps with ease. I added 25,
second set, and I started to struggle a little bit. It felt fine."*

That sentence is a complete autoregulation event, and every part of it arrived
as WORDS. `nextSetLoad` needs a number — and the conversion was being left to
the language model, in the tool description, in as many words: *"that was
easy" ≈ 6*.

**That is the invented-calorie failure in the place it hurts fastest.** A model
deciding what "felt fine" means is a model deciding how much weight goes on a
bar. The conversion is server-side now, against the **RIR-anchored RPE scale**
(10 is nothing left, 9 is one more rep, 8 is two) — because reps-in-reserve is
a question a lifter can actually answer mid-session, where a bare 1-to-10 is a
vibe.

- **Null is a real answer, and the common one.** "Done", "logged it", "next"
  report no effort, so no number is produced and the load holds — which is what
  keeps *an unreported effort never adds weight* true rather than decorative.
- **When signals conflict, the harder reading wins.** The founder's own
  sentence proves the need: *"I started to struggle a little bit. It felt
  fine."* An overstated ease is the one that puts weight on the bar; an
  overstated effort only holds it there. Tested, and verified to fail on the
  naive last-match implementation.
- **`effort_read` says what it heard and from which phrase**, so a wrong
  reading gets corrected out loud rather than silently moving the weight.
- **Two questions, never both at once.** `ask_after` is asked in reps left;
  `ask_before` opens a new exercise with *harder, softer, or as it is* — and
  **never offers "harder" on a day readiness flagged**, because the body's veto
  only ever softens. A short set gets a different question: did it come apart,
  or just run out.

**And the professional methods are offered, never imposed** — *"you could
suggest that and I'll see if I want it or not."* `METHODS` names six (reps in
reserve, top set and back-offs, double progression, a scheduled deload, wave
loading, watching bar speed), two at a time, tier-gated like every other
prescription, each with what it COSTS — a method without its cost is a pitch
rather than a choice. A stalled lift reorders them so the plateau-breakers come
first. **The provenance is stated honestly**: this is established published
methodology, not a live survey of any particular coach. Presenting textbook as
insider knowledge is a small lie that makes the honest numbers harder to
believe.

### "Had room left" — the words that drove the load and were never kept

`wordsForRecord()` in `lib/coach.js` + `on_record` / `words_check` on
`log_set` + the `rack_note` tool. The founder's screenshot: ChatGPT read
*"185 × 8, had room left — hold 185 for set 2"*, and he wrote underneath:
*"Remember, there could be a note on this that could be added for memory."*
The live row held **8 × 185, rpe null, note null.** Three faults, one
screenshot:

- **`felt` was dropped before the insert.** It drove the effort read and was
  then discarded; only `note` reached the row. So the one fact that explains
  the number six weeks later — how it felt — was structurally unstorable
  through the field built to carry it. Both go on the row now, verbatim, felt
  first, deduped when one is inside the other.
- **"Had room left" matched nothing** in the effort table, so the load held
  by SILENCE rather than by reading. From the outside the two are identical
  and they are not the same thing: one is autoregulation, the other is the
  absence of it. Room, gas, "plenty in the tank", "not too bad" and "felt
  fine" read now; the harder reading still wins and a cold room is not an
  effort.
- **The answer to "how did that feel" arrives a turn AFTER the row is
  written**, and there was no door back to it. `rack_note` attaches the words
  to the set just done, fills an EMPTY reading from them (never overwriting a
  number they gave), recomputes the next load from the set as it now reads,
  and takes an aim answered after the session started. `end_session` also
  accepts `aim` now — `start_session`'s note had been telling the model to
  pass it there, and nothing read it. A promise on the sheet the code did not
  keep.

**The row is read back, and the result says when it holds nothing.** The
notes ChatGPT was writing were its own paraphrases — *"Second set; got 6
reps."* — the reps field restated, a row that says nothing. `on_record` is
the stored row; `words_check` says in as many words when no words are on it,
so a set they spoke about and a set they did not stop looking identical.
Words about a body are flagged where they are said (`body_report`): a
doctor's question, never a cue and never reassurance.

**And 017 had never been applied live**, so every aim ever answered was
dropped at the door with a warning only the model saw. Applied through the
connector; the probe is cached per container, so a warm function keeps
saying it cannot store an aim until it recycles.

### The incline press that was the overhead press — a noise word that changed the load

`exerciseKey()` in `lib/training.js` + `rekeyRows()` / `rekeySets()` + the
`session_status` tool. Found while reading the founder's session rows for the
screenshot above, and it is the invented-load failure delivered by a synonym
table.

**The key normaliser stripped every word that changes what a number on the
bar means.** "incline", "machine", "seated", "dumbbell", "assisted",
"weighted" were all noise, so *"Incline barbell press"* became *"press"* and
keyed to **overhead press**, and *"Seated row machine"* keyed to the barbell
row. His 84kg incline press was standing as the overhead press's last
performance — a lift he does at 57kg — and `progressionCall` would have put
86kg on the bar for it. The same night, the 100kg machine row was the barbell
row's history.

- **Over-splitting is the safe error; over-merging is the dangerous one.** A
  key that is too specific costs a *"no history yet"* refusal, which is the
  safest sentence in the product. A key that is too broad prescribes another
  lift's load. So only the words that never change the load are noise now:
  *barbell* (the default implement), *bb*, *flat*. The implement, the angle,
  the machine, seated, assisted and weighted stay in the key; *db* and *kb*
  are spelled out rather than dropped. Bare *"press"*, *OHP*, *shoulder press*
  and *military press* still mean the overhead press.
- **The record is re-keyed on the way in.** `exercise_key` is stamped at
  write time, so the merges were sitting in the rows — and the lift record,
  the max, the volume count and the progression all read the stored key.
  `rekeySets` runs beside the other sweeps on the dashboard and the brief,
  grouped by name, and refreshes the plan of any session still running so
  the checklist does not restart an exercise at set 1. Applied to the
  founder's rows through the connector as well.
- **Two tests had pinned the merge as correct** — *Incline DB bench press*
  keyed to *bench press*, a Smith squat to a back squat. Changed
  deliberately, with the reason on them.

**And the "glitching" that was not.** The same screenshot: ChatGPT said
*"Wrought's set logger is glitching on this one, so I don't want to falsely
tell you it saved."* The Supabase logs for that minute show every call
answering 200 and the row landing with his words on it. The refusal to claim
a save was right; the stopping place was wrong, because the model had no way
to LOOK. `session_status` reads the live session back off the rows — the last
set as stored, the checklist, the percentage from the same `sessionProgress`
the rack screen uses — and the rule is on the tool and the sheet: an errored
`log_set` is followed by `session_status`, never by a verdict; a set it shows
is never logged again, a set it does not show is logged now.

### A migration applied mid-set took the connector down — and the flush that followed nearly doubled the night

The most expensive minute in this file was mine, and the logs are exact.
At 00:30:17 UTC I applied `017_wrought_session_aim.sql` through the
Supabase connector. PostgREST reloaded its schema cache and reconnected —
*"Connection Pool initialized… Config reloaded… Schema cache queried in
1375ms"* — and for those seconds every request to the database failed.
The founder was between pec-deck sets. His next `log_set` reached the
function and nothing reached the database: no token lookup, no insert, no
edge log at all. ChatGPT said *"Wrought just went unavailable again"*, he
re-authorised the connector at 00:37, and it flushed the rest of the
session through `log` as a workout event at 00:41.

**Rule: never apply a migration, however additive, while anybody is
training.** Check `wrought_sessions` for an active row first; a DDL statement
bounces PostgREST and there is no window in which a live set can wait. The
"apply it through the connector" convenience in this file now carries that
condition.

**And a three-second blip became a six-minute outage because the server
called it a sign-in failure.** The 8:33 screenshot shows ChatGPT *"holding
it here"* with no tool call at all — it had written the connector off.
`getAuthUser` swallowed the failed token lookup, fell through to the JWT path
(which cannot vouch for an opaque OAuth token), returned null, and the
handler answered **401 with the sign-in challenge**. A client reads a 401 as
a dead token: it stops calling tools for the rest of the conversation and
waits for a reconnect. *Could not check* is not *not signed in*.
`authVerdict()` in `lib/wrought.js` is the pure decision — a lookup that
failed, or an auth API that fell over, is `unavailable`; a table that was
read and held nothing is `none` — and `getAuthUser` throws
`AuthUnavailable`, which the MCP handler answers with **503 and
Retry-After** and no challenge. The dashboard's version of the same rule
already existed in other words: a network failure is never answered with a
password form. The `api-*` functions let the throw surface as a 500, which
the page shows as a server error rather than the sign-in gate.

**And the flush itself was the right recovery with the wrong landing.** It
left a live session holding five sets beside an event holding the rest —
pec-deck, seated row, a second treadmill — so the finaliser would have filed
a second workout for the same hour, and the weekly count, the one number the
whole plan rests on, would have read two. `foldPlan()` / `foldIntoSession()`
in `lib/session.js`: a workout told to `log` while a session opened TODAY is
running goes **into** that session. What was already logged set by set is
skipped, never doubled; a planned lift not yet done gets its sets at its own
slot; a new lift is appended to the plan in the order it happened; no event
is written, and the finaliser files one workout with everything. Only a
session from today qualifies — folding tonight's lifts into yesterday's stale
session would move them to the wrong day. The founder's night was repaired
by hand the same way: the event's rows moved onto the session, the event
removed, one workout on the record.

### Gauging — the set that just happened decides the next one

The founder, after logging a set and getting nothing back: *"it's not really
gauging me."* Two failures behind that, and both are the invented-number
failure wearing new clothes.

**The load came off a photograph.** He showed the connector a bench with a 45
on it; it answered *"135lb total"* and prescribed three working sets of 8–10 at
that weight. Nothing computed it. **What is loaded on a bar in a picture is
what somebody else left there** — it is an observation about a barbell, not a
prescription for a person, and programming it is exactly the 2,600 incident in
a place where being wrong hurts faster. The instruction now says a working
weight may only ever come from a tool, names the photograph case explicitly,
and — the part that actually works — points at `calibrate_lift` and at
`progressionCall`'s refusal rather than forbidding harder.

**And `log_set` was not adjusting anything.** The next set's load inside the
same exercise was a hardcoded `verdict: 'same'`, so *"tell me how many you got
and how hard it felt and I'll adjust"* was a promise kept entirely by the
language model. The one place this product is a training partner rather than a
diary, and it was guessing. `nextSetLoad()` computes it now — different
question from `progressionCall`, which decides what to open with next time
from the whole history; this is autoregulation within the hour.

- **An unreported effort never adds weight.** Without an RPE the only signal is
  reps, and reps alone cannot tell a comfortable eight from a grinding one.
  Silence holds. Same shape as readiness: it only ever softens.
- **One step at a time**, in real plate increments, never a jump.
- **Falling short comes down.** Missing the target at a high RPE is not
  character-building, it is a weight that is wrong today — and the line says
  finishing the sets matters more than the number.
- **Hitting the target at RPE 9 holds.** They earned it; adding on top of a set
  that already cost that much is how a good session becomes an injury.
- **Bodyweight work has nothing to move** and never has a load invented for it.

### Stretching — dynamic before, held after, and the half nobody ever got

*"Nothing about stretching."* Right, and it was worse than missing: the rule
was written, the content existed, and **both halves were delivered wrong.**

- **The warm-up was on `start_session` and nowhere else** — and *"I'm going to
  the gym"* lands on `suggest_workout`, which is the more common door by a
  distance. The one feature built specifically to be OFFERED rather than waited
  for was, for most sessions, never offered at all. It is on both now, built
  from the requested focus or from what the log says is overdue.
- **The held stretches were attached to the WARM-UP object**, so the static
  work was offered at the one moment it is wrong and never at the moment it is
  right. `cooldownFor()` is on `end_session` now — named for what actually
  worked, because *"stretch out"* reads as filler and gets skipped for exactly
  that reason, the same argument that makes the warm-up pattern-specific.

**Dynamic before, static after is content, not taste.** A held stretch
immediately before a heavy set measurably costs force for the next half hour;
afterwards it costs nothing and is where the range-of-motion work belongs. Both
objects say so in one clause, because it is the opposite of what most people
were taught at school.

**A cool-down must never become the reason somebody stops closing a session.**
Offered in one line, skippable in one word, never insisted on and never
repeated — the record of the workout matters more than the stretching does. And
it is never physiotherapy: with a limitation on file the holds are still
offered and never presented as treating anything.

**A back squat was getting a pulling warm-up.** `back` in the pull block's
pattern matched *"Back squat"*, so a squat day came with dead hangs and
scapular pulls. The word is worth keeping — plenty of sessions carry `back` as
the muscle — but not as the front half of *back squat*.

### The five minutes before the first set

`lib/preflight.js`, carried on `suggest_workout` AND `start_session`. The
founder: *"should I ask you before work how you feel, what you wanna
accomplish — it should look at your intake for the day and see where you're
at."*

Three things, and only one existed.

- **How they feel.** `readiness()` is the objective half and is genuinely
  useful, and it is blind to the half that matters most on the day: a watch
  cannot tell a bad night from a bad week at work, and it has never once known
  somebody's back is tight. **Nobody had ever been asked.**
- **What they want out of it.** A session picked by *what is most overdue* is
  right on average and wrong on the day somebody came in to do one thing.
  Asking costs a clause and changes the whole hour — a stated goal beats the
  matrix.
- **Where the day actually stands.** Six hundred calories by six in the evening
  is a fact about the session about to happen, and the training half and the
  eating half of this product had never spoken to each other at the one moment
  they obviously should.

**It never blocks the session** — the warm-up's lesson, applied again. Both
questions in ONE line, in the same message as the plan, answered in the same
turn or not at all.

**Fuel advice only ever points at eating MORE.** Telling somebody about to
train that they should eat less is the dangerous direction, and a workout is
not the moment for a deficit conversation under any framing. A well-fed day is
stated flatly — *"about 1,800 in so far"* — and never as *"1,800 of 2,500"*,
because that invites doing maths about what is left at the one moment that
thought is least useful.

**What they have taken is stated and never advised on.** That a tablet was
logged is a fact about the day; whether they should have, whether it interacts,
whether to take more is a doctor's question every time. And **nothing here ever
becomes a reason to add weight** — a good reading, a good mood and a full
stomach all mean train as planned and nothing more.

The tests for the last two assert on **what the person is shown**, not on the
model-facing note — that legitimately contains the prohibition itself, and
grepping it catches the rule rather than a breach of it. Second time that trap
has been hit in this file.

### Preemptive — the setting that was stored and drove nothing

`lib/prompt.js` + `nudge` on `log`, `brief` and the dashboard. The founder:
*"should be prompt in advice — the whole point of it is preemptive."*

He is right, and the gap was embarrassing: **`plan_push` was stored, was shown
back on the plan, and changed nothing.** No instruction said what light, normal
or relentless actually do, and the level was carried on no response the model
reads. A setting called *how hard this thing chases you* that does nothing when
you set it is the worst kind of feature — it looks answered.

**What preemptive can mean here.** The server can never speak first. So it
means: the moment they say ANYTHING — a meal, a weight, a question about
something else entirely — the answer already carries the one thing worth
raising. That is a large difference from waiting to be asked *"how am I
doing"*, which is a question people ask when they already suspect the answer.

- **A care flag silences it completely**, including the cheerful ones. A
  personal best delivered to somebody who has eaten under 1,200 for three days
  is encouragement pointed the wrong way.
- **One thing, never a list.** A nudge with three items in it is a lecture and
  the second is never read.
- **A win is a nudge, at every level.** The most valuable unprompted sentence
  is not *"you're behind"* — it is *"best run yet"*, said the day it happens.
  Somebody who asked to be left alone did not ask to be denied their own best
  run, so wins are not gated by push.
- **An impossible week is stated, never counted down to zero**, and only at
  relentless — there is nothing actionable left and repeating it is pure guilt.
- **A quiet capture stays quiet.** Somebody mid-way through a tax question who
  mentioned ten push-ups did not open a conversation about their training week.

**`light` fired for nobody, and that was a real bug.** "Well behind" was first
defined as *nothing done and three days left* — but for anybody training four
days a week, by the time three days remain with nothing done the week is
already arithmetically impossible and the branch above has taken it. A setting
that silently means *never* is worse than not offering it. It is a proportion
now: under half the pace the week implies.

### The questionnaire is a gate — the founder overrode the softer doctrine

`intakeGate()` in `lib/intake.js` + `trainingGate()` in `mcp.js` + the
*Getting to know you* panel. The founder, twice, the second time as an
instruction: *"we should put that as a stop place — we can't further any
workouts until the questionnaire is finished. It could be loose too, like
weight loss AND muscle building. Like 20 or 30 questions."* The in-passing
doctrine survives for ordinary conversation, but the gate is his call and it
is drawn precisely:

- **WROUGHT never refuses to RECORD.** `log`, `log_set` and the briefs stay
  open forever — capture is the soul of the product and gating it would kill
  the memory. There is a test asserting neither capture door touches the gate.
- **WROUGHT refuses to PRESCRIBE until it knows who for.** `suggest_workout`,
  `design_workout`, `programmes` (the building half — the single-pattern lookup
  is the mid-session swap case and stays open), `start_block` and
  `start_session` **with no routine named** return `setup_required` until all
  25 intake items are answered.
- **The line moved once, on the founder's call, because the first version was
  too wide.** Gating `start_session` outright meant somebody mid-questionnaire
  could not run a workout **they had already saved** — which is not
  prescribing, it is their own plan plus recording what they do against it.
  The symptom was total and he found it: *"the GPT hasn't really prompted me
  on anything — when I say I want to do a workout it should be saying where
  you at, and the checkmark thing is not happening."* No session means no
  clipboard, nothing to tick and no position to be asked about. **Named
  routine runs, `log_set` runs, building waits** — and the refusal carries
  `can_run_now` so the saved workouts are offered by name rather than the
  product just reading as broken.
- **A gate that only refuses is a dead end.** It used to hand back all
  nineteen remaining questions and a sentence saying how many were left, which
  leaves the asking to the model — and a model handed a list and no script
  writes one polite sentence and stops. Nineteen questions became nineteen
  turns of nothing happening. `ask_now` pulls the next four out and puts them
  in `say`, so even a relay that reads nothing else moves the setup forward by
  four. **And every question has a second-person form** beside its
  model-facing one: *"what they are actually after"* read aloud is baffling.
- **"None" is a real answer.** No injuries, no sports, no medication close
  their questions once recorded — that is what lets the questionnaire finish.
- **Loose answers are fine**: *"lose weight and build muscle"* is recomp. The
  gate note says both, or the model interrogates people into precision they
  never offered.
- **The gate is visible.** The dashboard shows *Getting to know you · N of
  25*, the remaining questions as copy-chips, and says workouts unlock when it
  is done — a gate nobody can see is indistinguishable from a product that
  never asks. Same `intakeState` on both surfaces, so the screen and the
  refusal cannot disagree.
- Asked in GROUPS of three or four at the gate (they asked for a workout; the
  fastest way through is to finish), one-at-a-time in-passing everywhere else.

### The gate is fourteen questions, asked one at a time, saved by the tool that asks the next

The founder, after the gate blocked a mat plyometrics add-on and ChatGPT dumped
all fifteen remaining questions in one message: *"a lot of these questions
should be focused more on training so we can build the notifications around it
— how many muscle building workouts you want to do a week, how many stamina,
how many minutes total you're willing to commit — and then your notification
should reflect that, like a halfway-during-the-week point. A lot of that stuff
there is kind of irrelevant, so I don't see why it's stopping you from getting
a workout. Make it as easy as possible — multiple choice, yes or no. Or do it
right through the GPT, one at a time: OK you have outstanding questions, let's
finish this, here's a question; after you answer it, it saves it."*

Three faults in one screenshot, one root: the gate demanded all twenty-five,
handed the model four at a time to save through four different tools, and the
model did what a model handed a list does — printed the list and claimed
*"I'll get those locked in."* Nothing was written.

- **The gate is only what building a workout needs — fourteen, not
  twenty-five.** The five facts, anything to work around, what they are
  after, pace, how hard to chase, strength sessions a week, stamina sessions
  a week, minutes a week, how long they have trained, the kit. Alcohol,
  takeaways, sleep, medication, sports, bluntness and the brief hour are still
  tracked and still picked up in passing, and **none of them may ever stand
  between somebody and a session.** `gate: true` on the item is the whole
  rule; there is a test naming every key on each side.
- **One question per message, with something to tap.** Every gating item
  carries `options` (a numbered menu in the conversation, buttons on the
  website), a unit and a hint for a number, quick picks for a list, and a
  stated *none* fact for free text. `askLine()` renders the one line the
  model says; *"2"* picks the second option, loose words work, *"none"*
  closes the question. **The count is the count**: *"3"* to *"how many
  strength sessions"* is three, not the third option — the exact value wins
  before a menu position, and that ordering has a test that fails the other
  way round.
- **`answer_setup` is the loop, made structural.** It saves through
  `lib/setup.js` and returns the NEXT question — the one surface a model
  cannot skip. It never holds the list, so it cannot dump the list. Several
  answers volunteered at once go in one call; it still hands back one
  question. `complete: true` says to call the training tool again in the same
  turn. The result's `saved` is read back off the record, and the rule is
  stated on the sheet AND the tool: *never say an answer is saved unless it
  came back in `saved`.* This overrides the earlier four-per-message rule, on
  the founder's instruction.
- **The website is the other door — a form, not a list to copy from.**
  `api-setup.js` + the *Getting to know you* panel: buttons for a choice, one
  box for a number with its unit, quick picks for the kit, *None* where it
  applies. Each tap saves through the same `applyAnswers` and the panel
  redraws off the record, so a question the screen shows as answered is one
  the assistant stops asking. The heading counts the fourteen. The gate's
  refusal carries `wrought.fit/app.html#setup`, which scrolls to the form.
  Never in the demo.
- **The commitment lives on the profile, and `train_days` is its sum.**
  `023_wrought_commitment.sql` adds `strength_per_week`, `cardio_per_week`,
  `minutes_per_week`. Columns rather than goal rows because they are siblings
  of `train_days`, scored by `weekSoFar` against the Monday week — a fake goal
  row each would draw three unscoreable rings. Strength plus stamina is
  written to `train_days` in the same save, so every existing reader of the
  weekly expectation keeps working. `weekTargets(profile)` is the one place
  the four numbers are read, and a test asserts every `weekSoFar` caller uses
  it. Saved through `set_plan` too.
- **Sessions are typed from the stamp, or from the shape, never by guess.**
  The day rollup counts `strength_sessions` and `cardio_sessions`: `kind`
  wins; without one, sets and reps are lifting and a distance is cardio; a
  session that is neither is counted in the total and *named* as untyped.
- **`week_check` is the mid-week read.** A new alert kind, on a weekday they
  choose (`days`, default Wednesday) at an hour they choose, whose body IS
  `commitment.say` from `weekSoFar` — computed once, so the notification and
  the training-week panel cannot quote different figures. A met side is said
  as met; **an impossible side is said as finishing short, never counted
  down**, and a test greps the line for scolding words. A care flag silences
  it — a read of the training week is coaching. Offered by `suggestAlerts`
  only once a commitment exists, never switched on by itself; the completed
  setup offers it in one line and sets it only on a yes.
- **Before 023 runs, nothing throws.** A commitment answer on an old database
  is dropped from the save, reported as `not_saved` with the migration named,
  and the rest of the patch lands; `set_alert` for `week_check` answers with
  the migration by name on a check-constraint rejection.

### The targets gate — the second stop, and where the link actually rides

The founder, after asking for the goals hyperlink "100 times": *"we're not
going further anymore until there's a hyperlink that directs you right to
either your app or the website."* This overrides the softer "carried on both
doors, never blocking" doctrine for the CALORIE target the same way the
questionnaire gate overrode in-passing intake — his call, recorded here.

`goalsRequired()` in `mcp.js`, chained one step behind `intakeGate` in
`trainingGate`. What an adversarial review of the first version found, all of
it kept as design:

- **In the primary flow this gate never fires, and that is correct.** The
  questionnaire cannot complete without an intent; the intent is set through
  `set_goal`, and `set_goal` writes the daily calorie target in the same
  insert. So the questionnaire refusal is the gate that actually fires — and
  **the hyperlink rides THERE** (`trainingGate` attaches `set_link` and the
  markdown-link instruction to every intake refusal). The targets gate is the
  net behind it, for paths that close the questionnaire without a calorie
  choice: a bare weight goal set without an intent, a legacy account.
- **"None" is a real answer.** A calorie target set once and dropped passes
  the gate forever — `drop_goal` is maintenance, never a confession, and a
  gate that re-demands a deliberately removed target is a form that follows
  somebody around. Only an account that has NEVER chosen meets the gate.
- **A care flag suspends the gate, and silences the non-blocking asks too.**
  The honest rationale: a demand to pick a deficit is coaching intake, and
  when a flag stands, coaching stops. (The first version claimed the product
  "refuses to set a target under a flag" — no such refusal exists in code;
  `set_goal` itself stays open because its outputs are floored and paced-safe
  by construction.) The same rule now silences `goals_needed` on
  `suggest_workout` and `start_session` for flagged accounts — the alert
  kinds already obeyed it; the in-conversation ask obeys it too.
- **The gate is visible.** `targets_gate` on the api-progress `setup` block,
  computed server-side in the exact state the tools refuse in, draws one line
  on the No-calorie-target panel — a gate nobody can see is indistinguishable
  from a product that never asks. Saved routines and capture stay ungated,
  and the refusal's `say` carries the goals-page URL itself, so a client that
  reads nothing else still shows a line the person can tap.

### The target is priced off BASAL — the founder overrode the maintenance basis

*"You can't count on my everyday activity. It has to be on my basal rate and
only my basal rate."* — and again as an instruction: *"It's gonna be based off
the basal rate that's assigned to you, and your basal rate should be a
calculation of how big you are, age, sex."* Said twice, the second time after
the objection below was raised. His call, recorded here.

**He is right about the provenance, and that is the whole argument for it.**
Maintenance was basal × an ACTIVITY multiplier, and that multiplier is a
lifestyle CATEGORY somebody picks off a list — "moderate, moving most of the
day". It moved his target by ~1,360 kcal on nothing but a guess, which is the
invented-number failure with a dropdown in front of it. Basal is computed from
four measured facts (height, weight, age, sex), `restingBurn.basis` shows its
working, and a number that shows its working can be argued with.

**What it costs, and the cost is real.** Basal is what a body costs doing
nothing, so every step, shift and session comes off ON TOP of the deficit:
a real day loses faster than the pace names. For the founder — basal 2,473 —
the options became gentle 2,073, steady 1,723, **aggressive 1,473**.

- **The 2,600 guard could no longer stand, and was re-pointed rather than
  deleted.** The harness used to assert every computed option sat ABOVE the
  2,600 a model once invented for this exact person — the proof the guard was
  not decorative. 1,473 is below it. Quietly dropping the assertion would have
  left the file looking guarded when it was not, so it now pins the two things
  that actually still protect a large body: the 1,200 floor, and the response
  SAYING movement is not included. A basal-priced target is only honest if the
  person knows the rest of their day comes off as well — silence there would be
  the invented-2,600 failure inverted, a computed number delivered as though it
  were the whole story.
- **The floors did not move**, and for a small body the 1,200 floor now binds
  BEFORE the 300 deficit floor can — the rail working, in the safe direction.
- **"Maintain" had to be renamed.** At basal, a body that moves still loses, so
  the option is *"eat to basal"* everywhere — menu, dashboard, plan. Calling it
  maintaining while it quietly ran a deficit is exactly the silent wrongness
  this product exists to prevent.
- **A stored target above basal is not a surplus.** Legacy accounts hold
  maintenance-era targets, and "3,083 against a basal of 2,473" must read as
  *the deficit comes from what you move* — never "surplus", which tells
  somebody who is losing that they are gaining.
- **The weigh-in trend stopped being a nicety.** It was always the corrector;
  under this basis it is the only thing that reconciles the projected rate with
  the real one, and every surface says so.

`energyBalance` is untouched: the day's BURN still counts resting + training +
work, and the receipt still itemises it. This is the TARGET basis only.

### One bun reported as a whole day

*"Add another ciabatta bun — how many am I at today? How many calories?"*
came back with **330 kcal, 11g protein, 59g carbs, 6g fat.** That is one
ciabatta bun, delivered as a day's total, on the product whose entire job is
adding the day up.

**The cause was structural, not a model slip**, and that is the important
part. `log` returned the day only as a PROSE sentence, and `amend_last` — the
tool the model calls immediately afterwards to fill in macros it estimated —
returned **no day total at all**. So at the exact moment the question was
asked, the only numbers in front of the model were the ones it had just
written for that single item. It did not misread the day; it was never shown
one.

`dayTotal()` now rides on `log`, `amend_last` and `structure_entries` alike,
labelled `EVERYTHING logged today, not the item just added`, and `amend_last`
re-reads the day AFTER its own write so the total is never stale by exactly
the edit that caused it. The instruction says the rest: a running total is the
whole day, never the thing just logged, never added up by the model, never
answered from the conversation — and **a total that looks low because
something did not get logged is a fact worth surfacing rather than a number
to quietly inflate.**

**And then the other half, which the founder asked for immediately after:**
*"when I ask to add something he has to give the individual calories as well,
not just a total."* It is the same argument he already made about the day card
— *"one steak's up to the right and the pizza's to the left"* — arriving now
about the conversation, and it is right for the same reason. **A total with
nothing beside it is unauditable.** You cannot see which item is the 750 and
which is the 300, so a mis-heard entry disappears into the sum and stays
there. The per-item figure is also the only one the person can check: nobody
can dispute a day's 2,180, and anybody can say *"that steak was not 900"*.

So `day_total` carries `items` — every food and drink row of the day with its
own calories and macros — `log`'s `recorded` carries each thing's figures,
`amend_last` returns the `entry` it just wrote, and `structure_entries` the
same. **All of them read back off the STORED row rather than echoed from the
arguments**, which is what makes reading them out a confirmation that the
record holds them rather than a repetition of what the model meant to write.
The item, then the day, in that order, because that is the order the person is
thinking in — and every figure still labelled an estimate, since breaking a
sum into its parts must not make the parts look measured.

Same shape as the invented 2,600 and the 135lb off a photograph: the model
reached for the nearest number because the right one was not in front of it.
The fix is never more forbidding — it is removing the vacuum.

### The audit the founder demanded — five complaints, five causes

*"The trainer completely doesn't work... it keeps closing... none of the
exercises landed... loading is slow... it's not really graphing your total
calories."* All five were real.

- **"It closes after two seconds"** — the Trainer tab re-rendered every 5
  seconds, poll or no session, wiping open panels and half-typed text. The
  poll now runs only while a session is live, an unchanged payload never
  repaints, and open panels + typed text survive when it does.
- **"None of the exercises landed"** — his workouts predate the bridge, and
  the bridge only fires on write. `backfillDerivedSets()` sweeps recent
  workout events with exercises and no derived rows, on the way into the
  dashboard, beside `closeStaleSessions`.
- **Slow loading** — three fronts: preconnect/modulepreload for the CDN, a
  shimmer skeleton instead of one grey line, and **the last visit paints
  instantly** from localStorage with a visible *updating* pill, replaced the
  moment fresh data lands. Never silently stale: a failed fetch replaces the
  warm render with the error. (The service worker still never caches `/api` —
  this is the page's own cache, visibly refreshed.)
- **"Not graphing total calories"** — a single logged day drew "Not enough
  data yet", which reads as the log not working; one point now draws as a dot
  with its value. And `inOutChart()` draws eaten-beside-burned per day from
  the same calendar squares the month view uses, so the chart, the calendar
  and the brief cannot disagree.
- **Photos from the AI cannot land here, and the screen now says so** — this
  server never receives images; the AI reads them where they were sent and
  passes on words. A promise, not a gap.

### The manual is in the app, and it is made of sentences

`lib/guide.js` + the Guide tab. The founder, before his first session with it:
*"can you get any prompts, questions and stuff? It's my first workout with
it"* — and then, plainly: put them in the app.

**The manual is example SENTENCES, not a feature list.** Nobody reads
"supports natural-language logging with macro inference" and knows what to
say; they read *"had a steak and a baked potato"* and know immediately. The
whole product is that you talk normally, so the manual has to be made of the
talking — anything else teaches a command language that does not exist and
makes the thing look harder than it is. Forty-four of them, in the eight
groups somebody actually meets: say it, set it up, get a workout, at the rack,
save one you like, show it your gym, ask how it is going, fix something.

- **Tapping a line copies it.** The gap between reading an example and using
  it should be nothing at all. A blocked clipboard selects the text instead —
  silence would read as a dead button.
- **It SHOWS somebody talking before it describes talking.** The founder:
  *"the top, about how to use this thing, has to be more apparent — easier to
  use, less words, or it needs to be just easier to read. Animated."* The old
  screen was this file's own doctrine failing: sixteen paragraphs of prose
  explaining that you do not need to learn anything. So it opens with a real
  sentence typing itself out and the thing that happens to it, and the prose
  underneath is cut to one short line per section — 798 words on screen down
  to 459. The long form still exists in the `guide` TOOL, where a model reads
  it and prose is the right shape.
- **Not one invented number on the answering side.** A demo figure on a health
  product reads as somebody's own data at a glance, and this is the one screen
  a person is on precisely because they cannot yet tell which is which. The
  reply says what HAPPENS, which is the part being taught anyway.
- **Reduced motion is obeyed, not approximated** — the whole line appears at
  once and the rotation stops. Somebody who told their phone that movement
  makes them ill did not ask for a slower animation, and a manual is exactly
  the screen where they still need the content.
- **It is reachable without a password**, which it had never actually been:
  the gate covered the whole app, so the one screen written to need no session
  could not be opened by anybody who could not get past the sign-in form. A
  promise made in a comment and not kept in the markup.
- **Second tab, and called "Say this".** Sixth in a sideways-scrolling row is
  not apparent whatever the label says, and *"Guide"* reads as documentation
  nobody opens — the screen is sentences you say.
- **No session and no request.** It is the one screen that must work for
  somebody who cannot get signed in, which is precisely when they most need to
  know what to say.
- **The refusals are printed on it**, because *"give us years of your life"* is
  only a fair ask next to what it will not do with them.
- `guideRead()` serves the same content to the `guide` tool, so the manual
  cannot disagree with itself in two places.

**And the gym inventory is saved as each batch of photos arrives, never at the
end.** ChatGPT was answering *"keep sending the pictures, I'll build up an
inventory of the whole gym"* — which holds the entire gym in a conversation
that then ends, on the one product whose promise is that it remembers. The
instruction now says to call `set_profile` after every batch with the full
list so far.

### Every workout, however it arrived

*"I still don't see individual workouts."* The Recent sessions panel was built
from `wrought_sessions` alone — the sessions the ASSISTANT runs, set by set. A
run off the watch is a `wrought_events` row of type `workout` and never creates
a session, so **every workout from Apple Health was missing from the one panel
named for them**, while sitting in the record the whole time.

`workoutList()` merges both and **dedupes by `session_id`**, not by name and
date: a finalised session writes an event carrying its own id, so the session
row and the event are one workout seen twice. Counting both would double every
gym session — and make somebody think a workout logged once had been logged
twice, which is worse than the omission. A session with no event of its own is
still included, so nothing predating the finaliser is lost. Each row carries
`source`, because *"why is this not in my log"* is answered completely
differently for a watch and for a dictated sentence.

### "It takes a while to load" — the queries were queueing

The founder, on the dashboard. Not the queries being slow: them **queueing**.

`api-progress` had grown a chain of statement-level `await`s — the thirty-day
run-up, the block, the all-time count, the last weigh-in, the cardio rows, the
fasts — each one a full round trip from a Netlify function to Supabase, each
one waiting for the last, and **none of them needing anything the others
returned**. They are now in the same `Promise.all` as everything else: sixteen
queries at once, three serial hops left (auth, the stale-session sweep — which
WRITES rows the batch then reads — and the block's own session count, which
genuinely depends on having found a block).

**And a 7.7MB client was being loaded to draw a dashboard.** `lib/wrought.js`
had a top-level `import OpenAI from 'openai'`, and every function in the
product imports that file, so the OpenAI SDK was bundled into the dashboard,
the ingest door and the voice endpoint — none of which can reach it. Netlify
cold-starts a function by loading its bundle, so the first load after a quiet
hour paid for parsing a client it could not possibly use. It is now pulled in
on first real use; `openai` stays null without a key so every `if (!openai)`
guard behaves exactly as before.

The lesson is the one that keeps recurring in a file this size: **each new
answer arrived as its own `await` on its own line, and each was individually
harmless.** There is a test that counts the serial hops now, because this is
invisible in review and obvious to whoever is holding the phone.

**And it recurred in the browser within a day of being written down.** Opening
the Trainer tab fetched the routines, then the connection state, then the live
session — three consecutive `await`s, none needing anything the others return,
three serial hops to a cold function before the screen could draw. Batched now,
with the same test applied one layer out: it counts only awaits that START a
request, because `await res.json()` is reading a response already in hand and
counting it would make the assertion noise nobody trusts. **The pattern is not
a bug that gets fixed once — it is the default shape of adding one more
answer**, so the guard has to live wherever answers get added.

### Built, correct, and nowhere to look at it

The founder: *"a lot of things are not showing up on the website."* He was
right, and the audit found one pattern rather than eleven bugs: **every one of
these was built as a TOOL ANSWER and never given a PANEL.** The arithmetic was
done, tested and shipping; the website simply had no surface for it. A memory
product that cannot show you what it knows is asking for trust it has not
earned — and several of these he had asked for in exactly those words: *"I need
to see it."*

Now on the dashboard: **the plan** (`lib/plan.js` — pace, push, days, and the
target **never** without its maintenance and weekly rate beside it), **the
week** against what was agreed, **recovery**, **runs read as a progression**,
**the form watch** with its evidence and his own words, **fasting and the
eating window**, and **the computed target options** where a number used to be
invented.

- **`planRead()` is shared with `my_plan`.** Two readers is how the plan
  somebody is TOLD and the plan somebody can LOOK at drift apart, and then
  neither is worth reading.
- **The Targets panel used to say "tell your assistant" when nothing was set.**
  That is the vacuum, on the website — the same one that produced the invented
  2,600. It now shows maintenance and all three paced cuts, computed and
  floored, and showing them sets nothing.

**Three real bugs the demo had been hiding**, which is the more useful half:

- **`formWatch` returns `evidence` as a SENTENCE** from two of its three
  builders, and the demo was handing the page an array. `.map()` on a string
  throws — the panel would have died on the first real finding while the demo
  looked perfect. The demo now carries the real shape, because a demo that
  disagrees with the server hides bugs instead of showing the product.
- **`windowStatus` has no `set` field**, and the panel was gated on it, so the
  eating window could never draw.
- **Four tabs returned silently without a session.** `loadTrainer`,
  `loadPhotos`, `loadAccount` and `loadAdmin` all began `if (!s.session)
  return;` — the tab lit up as selected and the previous screen stayed on. In
  the demo that is three of seven tabs doing nothing when tapped, on the screen
  somebody uses to decide whether this is worth a fortnight. `needsSession()`
  says why instead.

**And the one that mattered most.** Care flags, the week's count, recovery and
earned room were all read off the SELECTED range — harmless at thirty days and
broken at one. **Care flags read weeks of the record — an acute week, a
fortnight average, a month of thin-day memory — so on the 1d view the
dashboard now opens on they could not fire at all** — the one thing
that outranks everything else in this product, structurally silent. The week's
count read off a single day is not a missing number, it is a WRONG one, on the
figure the whole plan rests on. They get their own thirty days whatever the
buttons say. Third time this rule has had to be applied: **a window is not a
memory.**

### The bridge — a workout logged afterwards reaches the set record

`setRowsFromWorkout()` / `syncSetsFromWorkouts()` in `lib/training.js` +
`016_wrought_set_source.sql`. The founder asked *"what did I do today"* and
ChatGPT recited the whole session from its own chat memory — bench, rows,
treadmill — while **none of it stood in the record that matters.** A workout
logged after the fact arrives as ONE event whose `detail.exercises` carries
the lifts, and those exercises never reached `wrought_sets`: the grain the
lift record, the estimated max, `orderInsight` and `progressionCall` are all
computed from. The person logging by telling their AI afterwards — the most
ordinary way to log — had training that counted for nothing in the one place
it matters.

- **The event's claim is expanded faithfully, never embellished.** "3 sets of
  8 at 100" becomes exactly three rows of 8×100; a missing weight stays null.
- **A session-backed event derives nothing** — the finaliser wrote it FROM
  real sets, and deriving more would double every gym session.
- **`event_id` (016) makes it idempotent**, and **the bridge refuses to run
  until that migration exists.** Without the column there is no way to identify
  an event's own derived rows, so a re-sync could only ever ADD a second copy —
  an amend of *"that was 105, not 100"* would leave both, and the number the
  amend explicitly corrected away would keep feeding the lift record, the max
  and every progression call forever. The 015 lesson says a door must be
  correct before the SQL runs; here correct means **not corrupting**, and a
  feature that waits is a far smaller cost than a strength record quietly
  holding retracted numbers nobody can find.
- **Insert first, then delete the old.** Delete-then-insert is two round trips
  with no transaction between them: a timeout after the delete erases a
  workout's whole set record. Reversed, the worst case is a visible duplicate
  the next sync cleans up. And **no caller discards the result** — a swallowed
  error here is training that looks logged and counts for nothing.
- **`logged_at` is the workout's own time, never the sync's.** `lastPerformance`
  orders by it, so a Monday session structured on Thursday would otherwise
  outrank a real Wednesday one and `progressionCall` would prescribe from the
  older, lighter day. Structuring days-old dictation is this feature's ordinary
  case, not an edge one.
- **A day already covered by a live session is left alone.** Training set by
  set and then re-telling the same workout would write a second copy beside the
  real one, and every read keyed by session-id-or-date would see two sessions.
- **A re-classified entry is cleared, not orphaned.** Non-workout events are
  still passed to the sync: they derive nothing and delete what they used to,
  so a mis-structured note leaves no phantom training behind.
- **Every door feeds it**: `log` (typed or in passing), `structure_entries`
  (dictated), `amend_last` (corrected later).
- **The conversation is not the record.** The phrasebook maps *"what did I do
  today"* to the tool and says why: reciting the chat back hides exactly the
  entries that failed to land.

### One movement normaliser, and the regex that was eating crunches

`normaliseMovement()` + `TIMED_MOVEMENT` in `lib/training.js`, used by
`save_routine`, `api-routines` and `api-progress` alike. The inline copies of
the timed-movement pattern had `/row|run/` without word boundaries: **"row" is
the front of every barbell row and "run" is the middle of "crunch"**, so
strength movements were classified as cardio and had their sets silently
nulled on save. Word boundaries plus lookarounds — a **Farmer's walk** and
**walking lunges** are loaded strength movements that merely contain "walk".

The old save defaulted every movement to 3×8, so a timed movement stored as
EXACTLY that pair with no minutes is the artifact of a default that never
described it — it reads back as unknown. **Only the exact pair**: somebody who
genuinely stored 4×10 on a timed movement keeps it, because rewriting real
data to fit a theory is worse than the artifact.

**READ and WRITE are separate functions, and conflating them was a real bug.**
`readMovement` retires that artifact on the way OUT. Running the same
judgement on the way IN rewrote the stored data of anybody who had genuinely
programmed a treadmill as intervals — as a side effect of adding an unrelated
movement. Both routine doors now write stored movements back exactly as they
were read, and **a partial update changes only the fields actually supplied**:
a fully-defaulted object spread over a stored movement blanks its minutes,
detail, cue and load for the sake of changing its reps. *A save never silently
deletes* applies to FIELDS exactly as it applies to movements.

### A saved workout, edited from either door

*"Didn't save all the info — some of it saved."* Two faults, and the first one
was losing his work.

**A save could silently delete.** `exercises` REPLACED the whole list, so *"add
the treadmill to S Tier"* — passed as `exercises` rather than `add` — quietly
wiped the bench press and the shoulder press. A routine is built up over weeks,
one good session at a time, and a tool that erases it as a side effect of
adding to it is not safe to call. **Merging is the default now**: a matching
name updates in place, new names append, nothing already there is dropped.
Taking one out needs `remove`; starting over needs `replace: true`.

**And a treadmill walk is not three sets of eight.** It was saved as `3×8`,
which is nonsense on the screen and useless when the session starts — what
defines it is minutes, speed and incline. Timed movements carry `minutes` and a
verbatim `detail` (*"level 10+, 2.5–3 mph"*), and sets and reps stay **null**
rather than being filled with a default that describes nothing.

**Both doors.** `api-routines.js` + the Trainer tab: add a movement, take one
out, create a workout, retire it, delete it. The founder asked for the iPhone
slider in the orange and he is right about the shape — **a switch reads as
reversible where a button reads as final**, which is exactly the difference
between retiring a routine and deleting one.

- **Talking is the fast way to build one; a screen is better at a LIST.**
  Taking one movement out of the middle by voice means naming it exactly and
  hoping. Here it is a tap. Neither door is the real one — they write the same
  rows through the same shape.
- **Retiring is not deleting.** `active: false` keeps the routine and its
  history, exactly like a retired goal. Only delete removes it, and only delete
  asks first.
- **Editing is on Trainer only.** On the Record tab this panel sits among
  twenty others and is there to be read; destructive controls in a scroll-past
  is how somebody deletes a workout with their thumb.
- **Still no loads, on either door.** A weight typed into a plan is a guess
  with a text box around it.
- *"3×8 or 25 min"* is **one** box. Two number fields for a treadmill walk is a
  form, and anything unparseable is kept verbatim rather than thrown away. The
  number and the setup are read TOGETHER — *"25 min level 10+, 2.5–3 mph"*
  keeps both, because for cardio the trailing text IS the instruction.
- **Removing a movement is a slide, not a button.** The founder saw the ×
  and said make it a slide, and he is right for a safety reason as well as a
  taste one: the row's content translates left and the action is revealed
  BEHIND it, so nothing destructive is tappable until the row has been
  deliberately moved. `pointer` events so a mouse drag works like a thumb;
  `touch-action: pan-y` so the list never eats the page's scrolling; a
  clearly-horizontal drag claims the gesture; `:focus-within` slides the row
  open for keyboard users so the gesture is never the only way in.

### The instruction sheet not every client reads

The decisive fact behind a whole run of ChatGPT failures — the phrasebook
ignored, saves claimed without calls, *"what account am I on"* answered with a
ChatGPT plan, the gate never asking its questions: **every one of those rules
lived in `SERVER_INSTRUCTIONS`, and not every client shows that sheet to its
model.** Claude honours MCP `instructions`; ChatGPT's support is
spotty-to-absent. What every client demonstrably does read is the **tool
descriptions** and the **tool results**.

So the rule is now structural: **anything load-bearing rides on the tool it
governs, and nothing critical may exist only in the instruction sheet.**
`save_routine` leads with its own trigger phrases and the never-claim-a-save
rule; `design_workout` says to chain into `save_routine` in the same
conversation; `get_profile` names the account question it exists to answer.
The sheet stays, for clients that read it — it is the belt, the descriptions
are the braces, and the tool RESULTS (say/note/on_file/day_total) remain the
strongest surface of all, because a model cannot skip reading the answer to a
call it just made. Tested: the harness pins the critical rules to the
descriptions, not just the sheet.

### The save that never happened — a claim about the record

`on_file` on `save_routine`. ChatGPT answered *"Added, Broski. 💪 S-Tier Home
Workout is now saved as your base home strength/core routine"* and the
dashboard held one workout, not two. **`save_routine` was never called.** The
reply carried no movement list and none of the tool's own sentence — it was a
write asserted from the conversation.

This is the same family as the invented 2,600 and the 330-calorie total, and
it is the most dangerous member of it. **A claimed write that never happened is
worse than a crash, because a crash is visible and this looks exactly like
success.** Nobody finds it until they open the dashboard weeks later and their
workout is not there — on the one product whose entire promise is memory.

- **Echoing the object just sent proves nothing** — it is the same sentence a
  model could write unaided. What cannot be fabricated is the state of the
  account AFTER the write, so `save_routine` re-reads every routine on file and
  returns the count and the names, and the instruction is to say them. Same
  doctrine as reading a meal's macros back off the stored row, applied to the
  fact that a row exists at all.
- **The rule is stated like the other two**: a calorie figure may only come
  from a tool; a working weight may only come from a tool; and now **saying
  something was saved is a claim about the record and may only come from a
  tool.** The incident is named in the instruction, because an abstract
  prohibition is exactly what failed the first two times.
- *"Add that to my list"* was not in the phrasebook. It is now, along with
  *"put that in"* and *"add it to my home workout"* — an instruction the
  connector does not recognise is one it answers conversationally.

### The website can finally log a meal — the hole under every ChatGPT fix

*"Wtf where is the food it worked before."* — *"Ffs it worked a few days
ago."* Food described to ChatGPT, acknowledged conversationally, and never
written. The tell was in its own reply: *"based on everything you've logged
**with me** today"* — the assistant treating its conversation as the record.

Every previous fix for this aimed at making the model call the tool, and every
one of them **depended on the model**. Meanwhile the settled doctrine says the
app is optional forever and website + connector are the complete product — and
**wrought.fit could read a meal and not record one.** Routines had a door.
Movements had a door. A weigh-in had a door. Food, the thing this product is
most about, had none, so when the assistant would not write there was nowhere
else to go. `api-log.js` was literally `GET, OPTIONS`.

`lib/quickadd.js` + POST and DELETE on `/api/log` + one box under the day.

- **One line, never a form.** A meal split across name / calories / protein /
  carbs / fat boxes is exactly the thing nobody keeps — the oldest doctrine
  here. *"chicken and rice 650"*, typed the way it would be said. A test pins
  the box to a single input, because this is the panel a second field would
  creep onto.
- **IT NEVER GUESSES A NUMBER.** The connected model can turn *"a steak and a
  baked potato"* into macros because it read the sentence and the photograph;
  this parser is not a model and must never behave like one. It extracts the
  figures a person TYPED and refuses to invent any they did not. No figure
  lands as null, saying out loud that it counts for nothing yet — a plausible
  400 on an unnumbered lunch poisons the week in a way a null never does. Same
  rule as a typed load on a routine: their own number is theirs to keep, and a
  generated one does not exist.
- **A leading quantity is not a calorie figure.** Only a TRAILING number, two
  digits minimum, so *"2 eggs"* can never be filed as a two-calorie meal — the
  shape of wrong number that survives for months inside an average.
- **Macros parse in ONE left-to-right pass**, and that is the whole trick. Two
  separate sweeps for *number-then-word* and *word-then-number* read across
  each other's boundaries, so *"45g protein 60g carbs"* comes out with protein
  60. Alternation in one scan cannot: the engine tries every branch at a
  position before advancing, so whichever form the line uses wins where it
  starts. The single-letter form must be attached — *"40p"* — because *"12 c"*
  in *"12 cookies"* is a cup far more often than twelve grams of carbohydrate.
- **A stated time travels as `time_hint`, never as a date.** A client may not
  date its own events; the hint is resolved in the user's own zone server-side.
  *"steak at the pub"* is a place, not a clock.
- **The reply is read back off the STORED row**, then the whole day recomputed
  from the stored rows — the item, then the day, in the order the person is
  thinking in. Echoing what was sent proves a write was composed, never that it
  landed, and this product has been bitten by that three times now.
- **A write error is never swallowed.** `not_saved` with the message on it: a
  silent failure here looks exactly like success, which is the failure the
  whole endpoint exists to end.
- **Removing is scoped to food and drink.** A workout event owns derived rows
  in `wrought_sets`, and deleting one from here would leave a lift record
  standing on training the log no longer holds. Retraction of anything else
  stays with the connector, where the clean-up exists.
- **Never in the demo** — a form there collects a real meal into a screen that
  discards it, the same reason the five-facts form is hidden.

And on the connector side, `day_total`'s check now names the phrase that gave
it away: **never say "everything you have logged with me"** — the conversation
is not the record, the two are routinely different, and that difference is the
thing the person actually needs told.

### The morning brief closes yesterday, restates the deal, then asks

`lib/morning.js` + the morning pass in `brief-nightly.js`. The founder's shape
is exact: *"this is what you burned yesterday; this is where you are in the
game; you trained this many times this week; what do you wanna train today?"*

The old morning got two of those ideas near the screen and missed the point.
It fed **today's barely started record** to `energyBalance()` and announced a
whole-day projection, while yesterday's intake was only a fallback after every
other line. It also presented the longest-rested routine as a static plan. That
is a status notification, not a morning conversation.

The sequence is now load-bearing:

- **Yesterday's completed burn first**, computed from yesterday's food,
  workouts, work, device active energy and device resting energy. It is still
  said as *about* — calories out remains an estimate even when a watch supplied
  part of it — and an unrecorded day never receives a made-up historical total.
- **The current goals and expectations next**, read from the active goal rows,
  never inferred on the lock screen. This is the deal the person is following
  today, not a score for a day that has barely started. No target means no
  invented number; it says what still needs setting instead.
- **The training week always states its position**, including when the target
  is met. Hiding the count after success makes the figure behave like a nag
  that only appears while somebody is behind.
- **The last line is the tap back into the conversation.** A due saved routine
  is offered as *up next*, never assigned. Otherwise rest is named as a
  first-class answer. The whole push is the hyperlink. It opens the saved
  destination — ChatGPT, Claude or the app — and the assistant asks whether to
  keep or change the goals before asking what they want to train. It explicitly
  waits before changing a target or choosing/building the session. The human
  tap remains the legal bridge across MCP's request/response boundary.

A care flag never stops this sequence before its first line. The lock-screen
title gains `REVIEW`, and the long form may add a factual record note after the
brief, but yesterday's burn, today's goals, the live week and the training
question remain the morning appointment. This was settled after the founder's
phone showed a doctor warning in place of every briefing he had configured.

### A care flag must be a door, not a daily dead end

The founder's lock screen showed the failure more clearly than any test could:
the same doctor warning every morning, with no goals, no training position and
no way to answer the uncertainty behind it. Worse, the count moved from five
low days in the morning to six at night because **380 calories logged so far
today was treated as a completed day**. That wording change bypassed the
same-day repeat guard and sent the warning twice.

Two rules now hold together:

- **An open day is never intake evidence.** Every live care-flag caller passes
  the person's current `local_date` as `openDate`; `careFlags()` excludes that
  date from the low-intake reading while leaving today's weigh-in and training
  available to their own safety checks. Breakfast is not a 380-calorie day.
- **Incomplete food logs are record quality, not nutrition.** A low-intake flag
  carries the exact `evidence_dates` and `needs_review`. An explicit review door
  still asks which dates were fully logged and which had meals missing, but it
  does not replace any scheduled brief. The morning push opens the ordinary
  morning conversation; any care note is mentioned after the briefing.

`review_intake_days` records the person's explicit answer as an idempotent note
(`intake-review:YYYY-MM-DD`). `complete=false` leaves every observed calorie
and meal untouched but prevents that partial diary being used as proof of a
full day's intake. `complete=true` keeps the day in the safety reading. **The
tool may never infer the answer from a small number, a meal count or silence**,
and it never asks somebody to invent meals they do not remember. After the
write it recomputes the flag. A reviewed complete low-intake pattern still
stops automated coaching and points to a doctor or dietitian exactly as before;
it does not suppress factual scheduled briefings.

### The evening brief is today's receipt against the goals

The default close is **20:00 in the person's timezone**; an hour they explicitly
set still wins. The first part is deterministic and comes from the same server
facts as the dashboard: workouts and minutes, physical work and time on task,
steps, food and protein, computed burn, each evidenced daily goal as
actual/target, and the live training-week count. It says exactly what went on
the record that day and what those facts did against the expectations stated in
the morning. A care flag changes the title to `DAY CLOSED · REVIEW`; it never
replaces this receipt with the warning again.

That receipt leads whether an OpenAI key exists or not. When a key exists, the
written verdict may add at most two short sentences of interpretation; it may
not recompute, replace or repeat the receipt, and it does not plan tomorrow —
the next morning owns that conversation. A weekly goal is not presented as a
daily score, and an unlogged metric is never rendered as zero.

### Notifications you set by talking — the AI writes the rule, the cron sends it

`018_wrought_alerts.sql` + `lib/alerts.js` + `set_alert` / `my_alerts` /
`drop_alert` + the alert pass in `brief-nightly.js`. The founder: *"you can
tell your AI to push anything you want, like you're fasting — you just have to
say it. Can you not do that? How would that work?"*

**It works because the assistant never pushes anything.** MCP is strictly
request/response and always will be — no amount of cleverness makes ChatGPT
speak first. What the assistant does is **write a rule**; the scheduled
function that already runs hourly for the nightly brief reads the rules and
sends. So *"tell me at nine to stop eating"* is not a promise a model has to
keep across a closed conversation. It is a row.

That is also why `set_alert`'s description is blunt that **saying "I'll remind
you" without calling it is a promise nothing keeps** — the claimed-save
failure, in the one place where the failure is invisible until the hour comes
and nothing happens.

- **A care flag silences every coaching kind, completely.** Telling somebody
  who has eaten under 1,200 for three days that they are *"at 80% of target"*
  is encouragement pointed straight at the harm the flags exist to prevent.
  **Their own custom reminders survive a flag**, because those are theirs and
  are not coaching.
- **Nothing ever tells somebody to eat less.** The intake line states where the
  day stands and stops — no *"you have 500 left"*, because a lock screen is the
  worst possible place to start doing sums about what is allowed. The single
  exception is `kitchen_closed`, and only because **they chose the hour**:
  honouring somebody's own timetable is not the app deciding they have had
  enough. Tested, including that the word "left" cannot appear.
- **One at a time, once a day, never in the night.** Two notifications in an
  hour is a lecture and the second is never read. Their own words outrank
  anything the server worked out. `last_sent_on` is the once-a-day guard and is
  **stamped only when delivery actually succeeded** — marking it sent on a
  failure means the one day a phone was off is the day the rule silently skips.
  A rule with its own hour is explicit consent for that hour; anything derived
  from the day's numbers is held inside waking hours.
- **Training is never guilt.** Silent on a day already trained, silent when the
  week is met, and **an impossible week is not counted down to zero** — the
  `weekSoFar` doctrine, in a place where repeating it is pure guilt. A test
  greps the line for scolding words.
- **Nothing is on by default, ever.** `suggestAlerts` OFFERS and the note says
  so: a product that starts notifying somebody because it decided it knew best
  is one they mute on day two, and a muted product never comes back on.
- **Off is one tap and never a question**, on the website as well as in the
  conversation — `drop_goal`'s doctrine. Somebody who cannot find the off
  switch mutes the whole app instead of the one rule.
- **One sender for every kind of notification** (`deliver()`), or one of them
  quietly stops cleaning up dead subscriptions. And a failure in the alert pass
  can never cost somebody their nightly read.
- **A rule with nowhere to land is the quietest possible failure**, so
  `set_alert` returns `not_deliverable` when no phone is subscribed — it looks
  exactly like a rule that works right up until the hour comes.

**`goal_check` — the scheduled read, which is a different rule.** *"By four
o'clock every day there should be a notification stating what percent of your
steps you are."* `goal_pace` waits for a threshold and fires when it is
crossed, so **on a slow day it never fires at all** — which is exactly the day
somebody wanted telling, and while there is still an evening left to act on it.
`goal_check` fires at an hour they chose and reports the figure whatever it is.
**A phone that has not synced is not a day with no steps**: steps arrive from a
device, so an unsynced morning reads as zero, and a scheduled 4pm "0% of your
steps" is a false claim about somebody's own day arriving on a lock screen —
worse than silence. It stays quiet until something has actually been measured,
the same refusal `awaiting_device` already makes on the dashboard.

**The targets are asked for before the next session, and MAINTAIN is a real
answer.** *"It should be prompted to set your goals right away, before the next
workout, for everybody — how many calories you want to be at, or if you just
want to maintain."* The order in that sentence is the right one and it is why
`goalsToSet()` is not a separate feature from the notifications: **a percentage
is a fraction OF something**, so with no daily target there is nothing for
"80% of your steps" to be 80% of, and `set_alert` refuses to create the rule.
Carried on BOTH doors into a session — `suggest_workout` is *"what should I
train"* and `start_session` is *"I'm at the gym"*, and a block riding on only
one would miss most sessions. It never blocks the session and disappears once
the goals exist, so it is a gap being filled rather than a form that follows
somebody around. Every calorie figure comes from `targetOptions`; **maintain is
offered as a first-class choice rather than the option for somebody who would
not commit**, because treating it as a fallback is how a person ends up
agreeing to a deficit they never asked for. The step figure is **their own
average nudged about 10%**, never 10,000 — that number is a 1960s pedometer
advertisement, and offering it to somebody averaging 3,000 sets a target they
miss every day until they stop reading the screen. With no step history it
offers nothing rather than inventing one, the same refusal as a working weight.

**Steps are RECEIVED, never calculated here.** They arrive at `/ingest` from
Apple Health, Health Connect, Samsung or the iOS courier under a dozen aliases,
are summed per local day, and are scoreable as a daily or weekly goal like any
other metric. Nothing in this product counts a step; it stores the number the
phone already counted, which is why a device that has not synced has to be
answered with silence rather than a zero.

**`goal_pace` — 80% of a target THEY set.** The founder: *"I want personal
notifications if you're at, let's say, 80% calorie burn of the day."* Doing
that as a bespoke burn alert would have covered one metric; doing it against
the GOALS somebody actually set covers steps, active calories, distance and
active minutes with one rule, scored by the same `scoreGoals` the dashboard
rings are drawn from — so a notification and the ring it refers to can never
quote different numbers. **A metric with no goal on file fires nothing and
`set_alert` refuses to create it**, because inventing a target to make the rule
work is the invented-calorie failure in a new place: a number this product
chose, arriving on a lock screen as though they had agreed to it. **An
`at_most` goal is never cheered on** — a ceiling filling up is `intake_pace`,
which is deliberately worded not to tell anybody to stop, and a second cheerier
"80% there" at a limit reads as encouragement to spend the rest of it.

**The column three readers forgot, caught before it shipped.** `metric` was
added to `wrought_alerts` with `goal_pace` and `goal_check`, and all three
readers of the table still listed the old columns — `api-push` (the dashboard),
`alertsFor` (what the assistant says back), and **`brief-nightly`, which is the
thing that actually sends**. Without it `dueAlerts` cannot match the goal, so
both kinds would have been stored, shown on the website, described correctly by
the assistant, and **never fired once**. Nothing errors; the hour simply comes
and nothing happens, which from the outside is indistinguishable from
notifications being switched off. Same shape as the day panels reading a field
the server never sent: a column list and the code consuming it, drifting in
silence. The test walks every `select` on the table, ignores the ones that are
plainly id-only lookups, and asserts the rest carry everything `describeAlert`
and `dueAlerts` read.

**A tolerant writer beside a stricter constraint, guarded a third time.** The
harness now reads the `wrought_alerts` check constraint out of 018 and asserts
`ALERT_KINDS` and `set_alert`'s own enum are exactly equal to it — the shift
bug's lesson, applied before it could happen again rather than after.

**Still blocked on the two VAPID environment variables.** `scripts/vapid.mjs`
generates the pair once; regenerating later kills every existing subscription
silently. Until they are set, `vapidConfigured()` is false and every send is a
no-op — the rules are stored and start working the moment the keys exist.

### The checklist you can tick, and the aim every session states

`017_wrought_session_aim.sql` + POST on `api-session.js` + `recordSet()`. The
founder: *"needs a checklist for every workout... you can put a checkmark for
everything that you've done... and for every workout you have to tell them what
you're trying to achieve in every workout, it's just general."*

Two holes, and the first is the food door's shape one screen along. **The rack
screen could show exactly where you were in a session and could not move you
through it.** Every tick had to go through the assistant, so a phone in a gym
with no signal to ChatGPT was a phone that could watch a workout and not record
one. `api-session.js` was `GET, OPTIONS`.

- **ONE write path, shared.** `recordSet()` in `lib/session.js` does the insert
  and advances the cursor, and both `log_set` and the tick call it. Two copies
  would drift, and the drift shows up as the screen and the voice disagreeing
  about which exercise you are on — the precise thing this endpoint was built
  to prevent. There is a test that the rack screen has no insert of its own.
- **A typed weight is theirs; an untyped one does not exist.** The boxes are
  prefilled with what was PRESCRIBED so it can be confirmed or changed, and a
  blank stays null rather than being asserted on somebody's behalf. With no
  history the weight box is empty and says why — the RPE refusal, on a screen.
- **Tapping a row makes it the one you are on.** The rack is not always free in
  the order it was planned, and a checklist that can only be worked top to
  bottom is a checklist people abandon at the first taken bench. A jump writes
  nothing; it is checked BEFORE the "nothing current" guard, because a cursor
  that has run past the end is exactly when somebody needs to jump back.
- **The response IS the refreshed screen**, read back off the record — never a
  DOM patch from a guess. And the poll's signature is updated to what was just
  drawn, or five seconds later it repaints out from under a thumb.

**And every session now states what it is for.** The PLAN has an aim; a saved
routine has a write-up; the session actually happening had nothing.
`preflight` has always ASKED *"is there anything you want out of today in
particular"* — and the answer went nowhere, read once by a model in one turn
and then lost. Now it is stored, carried on the rack screen while they train,
and stamped on the workout event at close, so the record says what was being
chased rather than only what was lifted.

- **Null is a real answer.** A session that arrives beats one still being
  specified — the warm-up's rule. `aim_pending` asks in one clause and never
  holds the session up, and the model is told never to invent one.
- **The door is correct before the SQL runs**, the 015 lesson again and the
  sharpest version of it yet: naming a column PostgREST does not know about
  makes it reject the WHOLE query, so an un-run 017 would have made the rack
  screen say *"no workout is running"* while one plainly was. A missing
  sentence turned into a dead screen. Probed once per container, like 016.

**The gate he asked for already exists** — `intakeGate` refuses to PRESCRIBE
until all 25 intake items are answered, while capture stays open forever. That
line was drawn on his own earlier instruction and has not moved.

### The dose — hard sets per muscle, per week

`lib/volume.js` + the `training_volume` tool + the panel. The founder: *"how to
make this pro level training?"*

Everything a good programme needs was already here — double progression,
autoregulation between sets, scheduled deloads, readiness, the form watch,
blocks that ramp volume and end. What was missing is the **first question any
qualified coach asks of a programme, before exercise selection and before the
split: how many hard sets is each muscle getting a week.**

`focusCall` looks like it answers this and does not. **It counts SESSIONS** —
so a day with two sets of flyes and a day with twelve sets of pressing are the
same day to it, and the log could report "chest was worked twice this week"
while the chest did almost nothing. Weekly set volume is the closest thing
strength training has to a dose, and nothing in the product could state it.

- **Counted, never estimated.** It is arithmetic on rows that already exist —
  `wrought_sets` has carried `muscles` since 003. Sets logged without a muscle
  cannot be counted and it says so rather than reporting a confident nothing.
- **The band is CONTEXT, not a target.** 10–20 sets per muscle per week is a
  population range from the training literature; the caveat says that every
  single time, because a number this easy to read as a target stops being an
  estimate the moment it is quoted without one.
- **The honest answer to a light week is SETS or FREQUENCY, never a heavier
  bar.** Same shape as readiness only ever softening: the figure here is a
  count of sets, and turning it into "go heavier" would be the invented-load
  failure wearing a new number. Tested, on the tool description as well as the
  sheet.
- **A week's work in one day is its own finding**, and it is the one somebody
  can fix without training less — 24 sets of back in a single session is a
  different problem from 24 sets of back.
- **The baseline is only as long as the record is.** Dividing nine days of
  training by four weeks halves every figure and makes a well-trained
  fortnight read as neglect.
- **Not behind the trends gate.** It is a fixed seven-day figure off the
  floored set history, so it must read the same whichever range button is
  pressed — the lifts-panel lesson, and the fourth time *a window is not a
  memory* has been needed.

### The shift that was filed as a note

`insertEvents` validates `event_type` against `VALID_TYPES` and **silently
rewrites anything missing from it to `note`** rather than rejecting it. 013
added `activity` to the check constraint in the database; that set was never
updated. So every shift the founder logged went in as a note — `dayFacts`
filters on `activity` and found none, four and a half hours at the petting zoo
burned nothing, and the entry still appeared in the log, which is exactly what
made it invisible. Nothing errored at any layer.

**A tolerant writer beside a stricter reader is the most expensive combination
there is**, because the write succeeds, the row exists, and only the code that
was looking for the real type notices. There is now a test that reads the
constraint out of `schema/013` and asserts the set is exactly equal to it.

### Putting it back in one tap

Explaining the loss is not fixing it. The founder was looking at a row saying
2,400 beside a total that had moved by 498, and the only way out was to
negotiate a retraction with ChatGPT — on the product whose settled doctrine is
that the website and the connector are each a complete door.

**Log as work**, on the training row itself. `api-log.js` takes
`action: 'refile_as_work'`.

- **The server never decides this by reading the words.** Re-typing an event
  from its summary is not reversible, and a five-hour hike is a real workout.
  The offer appears where the confusion actually lives — a session over two
  hours, or a day whose training was clamped — and the person taps it, because
  the person knows. Same doctrine as the duplicate detector: it only ever asks.
- **The calories are RECOMPUTED, never carried across.** The figure on a
  mis-filed workout is whatever the assistant estimated; work is priced from
  the MET table against hours on task and bodyweight, which is the entire
  reason `log_activity` exists. Carrying the old number would smuggle a guessed
  figure into the one place that is supposed to be computed — six hours of
  animal care at 150kg comes to **3,119**, not the 2,400 that was asserted.
- **An unknown job asks rather than guessing**, exactly as `log_activity` does,
  and nothing is written until it is answered.
- **The derived sets go with it.** A workout event can own rows in
  `wrought_sets`; leaving them would keep a lift record standing on training
  the log no longer holds — the same reason the food DELETE refuses to touch a
  workout.
- **The panel had no `id` to act on.** `dayFacts` sent training and activity
  entries without one, so the screen could display a row and never act on it.
  Third time a panel and a payload have disagreed about a field.

### The shift filed as a session, and the 1,902 that vanished quietly

The next screenshot, and a different bug from the one above. The panel read
**TRAINING · TODAY — "worked at the Petting Zoo... 6 hours total; estimated
2,400 calories burned" · 1 session, 360 min — full body.** It was on the
record. It was typed `workout`.

**That is what "a shift is not a session" costs when it is broken.** Apple's
active energy already contains workouts, so `energyBalance` clamps a session to
what the watch measured: `train = min(2,400, 498) = 498`. Correct for training,
catastrophic for work the wrist never saw. The same six hours are worth
**2,971 out as a session and 4,873 as work** — a difference of **1,902 kcal**,
and there is a test pinning both figures. It also lands in the weekly training
count, which makes the one number the whole plan rests on meaningless.

**The clamp is right and stays. What was missing was the sentence.** A cap, an
uncounted session and a meal with no macros are all named in `set_aside`; this
one was not, so a row said 2,400 while the total moved by 498 and nothing
anywhere explained the gap. **An unexplained difference between a row and a
total is how somebody stops believing both.** `training_clamped` carries it now
and the receipt says it, naming the way out — if that was work, `log_activity`
prices it from hours on task and is not capped by the watch.

**And the rule moved onto the tool.** The doctrine lived in
`SERVER_INSTRUCTIONS`, which not every client reads; `log`'s own `event_type`
field now says work is never a workout, and says what it costs — a rule with no
cost attached is one that gets reasoned around.

### The regression: a fix that assumed a migration had been run

The worst entry in this file, because the rule it breaks was already written
down two sections above it, and I read this file at the start of every session.

Adding `activity` to `VALID_TYPES` (19 Aug) stopped a shift being silently
filed as a note. Correct — and it **quietly assumed 013 had been run.** Where
it has not, the database's check constraint rejects the row, `insertEvents`
throws, and **`log` does not catch it**: the whole call fails, so a sentence
mentioning a shift and a meal **loses the meal too**.

That is strictly worse than the bug being fixed. The old behaviour lost the
CATEGORY; the new one loses the WRITE.

**The 015 lesson says exactly this and was not applied** — *a door must be
correct before the SQL runs*, which is why `setsCanBeTracked()` makes the
bridge refuse rather than corrupt. A schema change and the code that depends on
it do not ship together, so **every write that needs a migration must degrade,
never throw.**

`degradePlan()` now does it: on a check-constraint rejection, only the types a
LATER migration introduced are downgraded to `note`, the intended type is kept
on the row as `_intended_type`, everything else in the batch is untouched, and
the retry saves the lot. It is **said, not swallowed** — `not_counted_yet`
rides on `log` and `log_activity` — and `refileMistypedActivity` puts them back
the moment 013 runs.

**And the first test for it was vacuous.** It stubbed `supabase` by
`Object.defineProperty` on the module namespace; ES namespaces are sealed, the
stub silently did nothing, and the test passed with the fix removed. The
decision is a pure function now, tested with no database, and verified to fail
two ways: not degrading at all, and degrading rows it should not touch. **A
test that passes against broken code is worse than no test.**

### The shifts already on the record, still worth nothing

Fixing `VALID_TYPES` fixed the NEXT shift and did nothing for the ones already
filed. The founder saw it immediately: ChatGPT said *"6 hours at the Petting
Zoo, ~2,400 calories burned"* while the dashboard's burn read
**2,473 at rest + 498 training** and no work line at all. Both numbers were
honestly reported; only one of them was on the record.

The read path was never the problem — `dayFacts` filters `event_type ===
'activity'`, `api-progress` hands those entries to `energyBalance`, and
`activityTotal` counts them. **If the burn shows no work, the row is not typed
`activity`**, and before the writer fix every one of them was a `note`.

`refileMistypedActivity()` repairs them, beside the other sweeps on the way
into the dashboard. **The fingerprint is what makes it safe**: `log_activity`
is the only thing in this product that writes `key`, `met`, `hours` and `kcal`
together, and it matches on all four rather than on the summary — matching
prose would re-type a genuine note about a workday, and there is no undo for
that. Only `note` → `activity`, never anything else, scoped to one user on both
statements, and the error is returned rather than swallowed because a silent
repair is the same class of failure as the bug it undoes.

**A fix that leaves the existing data wrong has fixed half the bug** — the half
nobody can see. Weeks of somebody's work sitting in the log, visible, and
counting for nothing.

### The log and the record, read the same way

*"In the record put the log in there — what was eaten, and then underneath what
was worked out, active."*

Both screens already held it. The **order** was opposite: the Log led with the
workout and put the food underneath, the Record leads with food. Same
information, two shapes, and that is how one tab starts feeling like a
different product from the other.

- **Eaten, then trained and active**, with the two halves labelled — the day
  reads as in-then-out on both screens now.
- **A shift gets its own bucket** instead of dropping into the bin at the
  bottom with notes, and it carries its **hours on task and its calories**:
  *"logged as activity"* with no number is the feature failing quietly, since
  the number is the entire reason to log it. Still never a session, still never
  in the weekly count, still never praised.
- **A day with only a shift on it is not an empty day** — the log's `empty`
  test skipped it, so eight hours of somebody's life could vanish from the one
  screen that exists to show them their record.
- The demo carries a shift on the days it claims one, because a demo missing a
  field is how the last two of these hid.

### The food list that read `log` when the server sends `entries`

The worst bug in this file, because it was one word, it was mine, and it spent
three rounds blaming somebody else.

*"Still nothing underneath it why?"* — *"Ffs it worked a few days ago."* —
*"the new food is not showing up there anymore, what did you change?"* Every
one of those was `foodTodayPanel` reading `t.log`. `dayFacts` calls the day's
entries `log`; **`api-progress` renames it to `entries` on the way out**; the
panel read the server-side name. So `items` was `undefined` on every load, the
list was empty on every load, and the panel drew its empty state from the day
it shipped. Nothing threw. Nothing logged. And the hero **one panel above it**
went on correctly reporting 3,040 kcal eaten, so the screen visibly
contradicted itself and the only symptom was food that was never there.

- **An empty state is a claim about the record**, and this one was false in the
  most expensive possible way: it says the assistant *"heard you and never
  wrote it down"*. A field-name typo therefore spent three sessions accusing
  ChatGPT of losing meals it had actually logged — and sent the fix hunting
  connector instructions, tool descriptions and a whole website logging door
  before anybody read the line. **Check what the panel is reading before
  investigating why the data is missing.**
- **The same bug, one field along**: `today.activity` was never in the payload
  either, so a logged shift the burn was correctly counting had nowhere to
  appear on the page. Two panels, two silent name mismatches.
- **The demo was hiding it**, exactly as `formWatch`'s evidence array once did.
  Demo entries carried no `type`, and the panel filters on type — so the demo
  drew an empty list too and it looked deliberate. Demo rows now carry `type`
  and `id` because the server puts them there.
- **The guard is structural, not another comment.** A test extracts every
  `today.*` field the day panels read — resolving each panel's own alias, since
  one binds the whole object and the other binds a branch — and asserts the
  server actually sends it. Verified to fail on both original bugs.

### The same meal, counted twice

The other half of the same day. ChatGPT re-logged three foods that were already
on the record, noticed, and then *"fixed"* it in prose: **"after removing the
duplicate counting, your actual total today is about 1,760."** The record still
held 3,040.

That is the missing-bagel failure inverted, and it is worse. There the number
was wrong and the record was right; here **the number quoted was right and the
record was wrong**, so nothing looked broken and the next morning the day is
still double-counted — in the weekly total, the calendar square and every
average built on it.

- **A duplicated meal is a duplicated ENTRY, not an inflated sum.** The row
  comes off with `undo_last`, or nothing has been fixed. `day_total` carries
  the doubled rows with their ids on every read, not just on the write that
  caused them, because by the time anybody notices the write is long past.
- **It only ever ASKS.** Two coffees in a day is completely ordinary, and
  quietly deleting one because it matched a string would be far worse than
  counting it twice. Minutes apart is carried as `likely` — a logging accident;
  hours apart is lunch and dinner and is surfaced without the flag.
- **Never a corrected total while the extra row still stands.** That leaves the
  figure right in the conversation and wrong in the log, which is the worst of
  both and is precisely what happened.
- On the dashboard the doubled rows are marked where the Remove button already
  is, and the caveat says the size of it — *"780 kcal of this total"* — because
  the whole reason to itemise a day is that a wrong row is catchable.

### One pill, and the whole dashboard slid sideways

Found while verifying the box at 390px, and it is the `.bar` lesson one class
along. `.setpill` is declared in **three** places and `.ls-sets` is the
container for **six** different things — lift sets, run stats, readiness
signals, the form watch's evidence. So a `white-space: nowrap` written for
*"92.5 × 6 @8"* also reached an evidence SENTENCE, which measured **565px
inside a 390px screen**, and the entire page scrolled horizontally under the
thumb. Nothing looked broken in isolation; the dashboard just slid.

Nothing refuses to break now and nothing may exceed the gutters
(`max-width: 100%`). Wrapping a set pill on a very narrow phone is by far the
cheaper failure. Scoping the nowrap to `.ls-sets` is **not** a fix — that is
the container holding the sentences. There is a test, and it strips CSS
comments first, because the rule's own explanation names the property it
forbids and grepping the warning rather than the breach is a trap this harness
has now fallen into three times.

### The breakfast that was never logged, and the range that proved it

*"Total so far: ~880 calories."* — *"Huh, what about breakfast???"* — *"You're
right, I missed your breakfast... you're at about 1,280–1,330 calories today."*

**Two failures in one reply, and the range is the tell.** `day_total` returns
ONE figure computed from stored rows, so *"1,280–1,330"* can only mean the
arithmetic happened in prose. A range in a total is a model computing, never
a server relaying.

**The deeper one: the bagel was never LOGGED.** It was mentioned in
conversation, acknowledged conversationally, and never written. The total was
right; the recital was wrong. This is the claimed-save failure in food form —
and noticing the gap and then patching it with mental arithmetic is the worst
available response, because it hides a missing ENTRY behind a number that
looks like an answer, and tomorrow the day is still short a bagel.

So `day_total` carries a `check`: **these items ARE the day — if they mention
food that is not in the list, it was never logged, so call `log` for it now
and read the total again.** A missing meal is a missing entry, not a missing
sum. `log`'s own description leads with firing the moment food is MENTIONED
rather than when a save is requested, and says that *"you're right, I missed
that"* may only ever be followed by a write. `get_day` says the total is one
figure and never a range. Belt on the sheet, braces on the tools.

### The day as a receipt — both sides, every line

`lib/receipt.js` + `receipt` on `log_activity`, `energy_balance` and `get_day`.
The founder, after four hours at the petting zoo came back as *"logged 4 hours
of work today as activity 💪"* and nothing else: *"it should tell me
everything — I should see what those four hours of calories are worth against
what's on there, and it should be kind of a receipt of everything, each
calories for each. Be more specific."*

**The number was in the response and the model summarised past it.** But the
better fix is the one he asked for, and it is the same argument he has now made
three times — about the day card (*"one steak's up to the right and the pizza's
to the left"*), about the conversation (*"the individual calories as well, not
just a total"*), and now about **the other side of the subtraction.** Only the
eating half had ever been itemised. The burn was three summed figures and a
sentence, on the product whose whole pitch is doing the subtraction honestly.

- **The lines add up to the total, exactly**, and there is a test asserting it
  across every way the burn can be assembled. A receipt whose rows do not sum
  to its own total is a screen arguing with itself, and the reader is right to
  stop believing both numbers. So the three OUT lines are the **counted**
  figures straight off `energyBalance`, never recomputed, and what each is MADE
  OF hangs underneath as inputs rather than as more lines — because the inputs
  genuinely do not always sum to the counted figure.
- **What was set aside is said.** The burn takes the larger of a logged shift
  and a watch's day rather than their sum; that is correct and invisible, and
  somebody who logged four hours and sees a smaller figure than their own
  arithmetic concludes the log was ignored. A cap, an uncounted session and a
  meal with no macros are all named the same way. **Silence there is how a
  correct number loses an argument it should win.**
- **`trainingBurn` itemises from the same pass that totals**, like
  `activityTotal` already did. Recomputing per-session figures elsewhere is how
  a receipt and a total quote two different numbers for one workout.
- **A day still running is not a finished subtraction** — the dashboard hero's
  rule, needed again. The resting burn is a WHOLE DAY's figure, so at 7pm
  against 330 eaten the net reads *"4,603 down"*, which is a fact about the day
  being incomplete. It is still shown, because hiding a number somebody asked
  for is its own dishonesty, and it is labelled every time.
- **Logging work always comes back with what it was worth.** *"Logged as
  activity"* with no number is the feature failing quietly: the number is the
  entire reason to log it.

### In or out of the workout — the reversible half of removing

`off` on a movement + `action: 'bench'` + the two-way slide. The founder:
*"should give me the ability to swipe the ones I want on the workout or not,
so add and remove as need be."*

Sliding a movement away **deleted** it, and that is what was wrong with the
gesture rather than the gesture itself. **A control people have to be careful
with is one they stop using** — so the swipe was doing the most destructive
thing available in one motion, on a list built up over weeks.

- **Left takes it out, right puts it back.** The row keeps its detail, its cue
  and its place in the order — the position IS the information — and simply
  stops being in the session.
- **Retire-then-delete, one level down.** Delete is only reachable on a row
  that is already out, and it still asks. Two deliberate steps for the one
  action nothing can undo, exactly like the routine switch and the Delete link
  beside it. Same doctrine as a retired goal: what somebody used to run is part
  of the record.
- **`planFromRoutine` is the only door** from a saved routine to a live one, so
  filtering there drops it from the clipboard, the checklist, the progress
  percentage and the next-lift call at once. **A switch that only changes the
  colour of a row is decoration**, and there is a test that the plan actually
  loses it.
- **The badge counts what is IN.** A movement taken out still shows — that is
  the point of taking it out rather than deleting it — but counting its sets
  would make the chip promise work nobody is going to do.
- The gesture only travels in a direction that has something behind it: a row
  already in the workout cannot be pulled right, because revealing an inert
  button teaches people the gesture does nothing.

### A named workout is a brief, and a brief gets taken

`lib/design.js` + the `design_workout` tool. The founder: *"we could add new
workouts — like, I call it whatever, and they can fulfil it with me. So like a
questionnaire trying to get me, you know, what kind of workout do you want, so
they can build a workout pro level."*

Everything needed to BUILD one already existed — patterns, the curated library,
tier gating, equipment matching. What did not exist was **the conversation that
decides what to build**. `suggest_workout` answers *"what should I train
today"* from what is most overdue, which is right on average and is not what
somebody means when they say *"make me a leg day and call it Leg Day"*.

- **Not one weight, ever**, in any focus at any tier at any length — tested
  across every combination, including that no text anywhere names one. A
  session designed to somebody's own specification is exactly where a
  plausible working weight would slip through, because it would read as
  considered rather than invented.
- **It never asks what the record already answers.** Tier, equipment, days and
  injuries are on file; re-asking is how a brief turns into the form this
  product exists not to be, and it tells somebody the memory does not work.
  Every question carries its own `why`, so none can quietly become a field
  nobody justified.
- **Two answers are enough to build** — what it is for, and how long they have.
  Everything else has a defensible default already on file, and **a session
  that arrives is worth more than one still being specified.** The instruction
  says so explicitly, because otherwise the model finishes the list.
- **Length is a hard ceiling**, the same rule as days available: twenty minutes
  and ninety minutes are different workouts, and programming seventy for
  somebody who said forty is how the last third of every session gets abandoned
  and starts feeling like a failure.
- **Something to leave alone is worked around, never made lighter.** The
  movement is DROPPED — how much a sore joint can take today is a claim nothing
  here is entitled to make — and nothing in a built session claims to treat,
  rehabilitate or fix anything. There is a test grepping for the words.
- **How people actually name a session is what lands**: *"chest and tris"*,
  *"arms day"*, *"leg day"*, *"cardio"*. Making somebody pick off a list is the
  form again.

### A typed weight is theirs; a generated one still does not exist

The founder overrode the flat no-loads rule in as many words: *"I can slide to
delete or I can add it for amount of weight or time."* The line that survives
is the one that was always the point — **WROUGHT never INVENTS a load.** A
weight the person types on their own plan is their own reference: parsed only
with an explicit unit (`2x8 135lb`, `at 60kg` — a bare number is ambiguous and
stays in the verbatim detail, because guessing lb-or-kg on a health product is
how a number doubles), stored in kg like every weight in the record, and shown
back in **their** unit (`wrought_wu`, learned from the dashboard payload and
kept in localStorage so the Trainer tab shows a 135 lb man his 135). The rack
still computes the working load from real history, and the record beats the
reference the moment one exists. Nothing generated — library, programmes,
design — carries a weight, and those tests are untouched.

### A half-done plan is filed as a half-done plan

`completion` on the workout event, computed in `finaliseSession` by the same
`sessionProgress` the live checklist uses — so the percent somebody watched
mid-session and the one on the record can never disagree. The founder: *"it
needs to keep, in like a database, how much I've done of each exercise, or I
decided to skip or whatever — so if I only do half of them you'll know that,
or half of one of them."*

The clipboard knew all of it DURING the session and threw it away at the
close: a six-exercise plan finished at three read back identically to a
three-exercise plan finished in full. Now the event keeps planned-vs-done per
exercise, and **skipped (never touched) and short (started and left) are
different facts** — one is a choice about the session, the other about the
exercise. **The shortfall is in the summary itself** — `(62% of plan)` — because
the summary is what every list, day card and brief actually shows. An ad-hoc
session has open slots and no real plan, so it carries no completion rather
than a noisy one. `end_session` states it as a fact, never a scolding: a
half-done plan recorded honestly beats a finished one invented.

### The save that worked and the screen that never said so

*"It didn't add the other stuff."* It did. Three faults, and the loudest one
was not a save failing at all — which is why it had already been "fixed" twice.

- **The write was blocked by the guard meant to stop the flicker.** The
  Trainer tab's *unchanged answer never repaints* check was keyed on the
  api-session body ALONE, and that screen also draws the saved workouts. So
  adding a movement went: save it, server returns the new list, re-render,
  identical SESSION payload, **early return, nothing on screen.** Reproduced
  in a browser: the server held `Bench press` and the list showed two
  movements. From the outside that is indistinguishable from a save that
  failed. **A guard against repainting is only safe while it can see the whole
  of what is painted.**
- **The setup text was dropped at the door.** *"Incline treadmill walk at
  level 10+, 2.5–3 mph"* is naturally an `add[]` call, and `add[]` declared
  `name`, `sets`, `reps`, `muscles` — no `minutes`, no `detail`. The model had
  the words; the tool had no field for them. The implementation always merged
  the full shape, so **only the schema was narrow** — the worst version of
  this bug, because nothing errors and nothing logs and the save merely looks
  like it half-worked. One `MOVEMENT_ITEM` now, used by both doors.
- **The badge counted what the rows retired.** A treadmill walk stored with
  the old 3×8 default renders as `—` (`readMovement` retires the artifact) and
  the count still read the RAW rows: one visible 3×8 movement, *"6 SETS"* on
  the chip. **A number that contradicts the rows under it is worse than no
  number** — it makes somebody doubt the rows. Fixing it exposed a latent
  shape bug underneath: `api-progress` sends `exercises` as a COUNT and
  `api-routines` sends the ARRAY, and the old fallback printed the array
  straight into the markup the moment `sets` hit 0 — which a routine of
  nothing but timed work legitimately is.

**Then the same complaint one layer further in, found with a browser rather
than a guess.** The badge was fixed and the treadmill row was still empty, and
all three remaining causes were on the way IN:

- **The input ate it.** The how-much box carried `maxlength="20"`, sized for
  *"3×8 or 25 min"* — and it is the box the **verbatim** setup goes in, the one
  thing that must be kept word for word because for cardio that text IS the
  instruction. *"25 min level 10+, 2.5-3 mph"* is 27 characters, so the FIELD
  truncated it to *"level 10+, 2."* before anything was sent. **Nothing errors
  when an input truncates** — it just saves a shorter truth, and a clipped
  detail is indistinguishable from one that never saved. A test now asserts
  the input can never truncate before `normaliseMovement` does.
- **The row clipped what survived.** `.rmv` is `overflow: hidden` — the swipe
  needs it, Remove sits behind the row — so a flex child that refuses to
  shrink does not overflow visibly, it **disappears in silence**. `.rmvn` had
  the default `min-width: auto`. Second time a swipe affordance has hidden a
  layout bug rather than shown one.
- **And a dash said nothing.** A movement with no sets, no minutes and no
  detail drew an em dash, which cannot be told apart from a row that failed to
  render. It says *"not set"* now, and the panel says once how to fill it —
  type the same name with how much and it UPDATES that movement rather than
  adding a second, which is the part nobody would guess. Dim and italic, never
  red: a gap in a plan is information, not an alarm.

**And the page now says which build it is.** Three bugs running were reported
as *"still broken"* when the fix was live and the page in hand was older than
it, so the same evening got spent twice. `window.WROUGHT_BUILD` off Netlify's
`COMMIT_REF`, one line at the bottom of Account. It is not decoration: **a fix
that cannot be confirmed as delivered is a fix that gets re-reported,
re-diagnosed and re-shipped**, and "this is broken" and "this is stale" lead
to completely different afternoons.

### The workout nobody STARTED — the other half of the same lesson

`log_set` refused outright without an active session: *"No workout is
running."* The founder hit it at the end of a full session — bench, rows,
shoulder press, every set reported as he went — and **none of it had reached
`wrought_sets`**. No lift record, no estimated max, no `last_session`, no
progression next time. The sets existed only as sentences in a conversation.

**Nobody says "start a workout" either.** They walk in and start reporting
sets. The administrative sentence is the one least likely to get said — at
BOTH ends — so the server says it instead: a session opens automatically on
the first set, and `auto_started` rides back so the model mentions it in half
a clause and never as a correction.

- **An ad-hoc session is not a plan and never pretends to be one.** `sets: null`
  marks an open slot; nothing invents how many sets are coming, and an open
  slot never finishes on its own. A different lift is appended in the order it
  actually happened rather than refused for not being on a plan.
- **It still needs to know WHICH lift.** A bare "got 8" with no session and no
  exercise is genuinely unanswerable, and guessing one would be worse than
  asking.
- **`end_session` no longer dead-ends.** "No workout is running" is a true
  sentence and a useless one — to somebody who has just finished training it
  reads as *your workout was lost*. If one was already filed today it says so;
  otherwise it offers to take the sets.

### The workout filed on the wrong day — the sweep stamped "now"

*"I didn't have a workout today — that was yesterday's S-Tier, why is it even
on today?"* He was right. `finaliseSession` has always passed the session's
real end time as `occurred_at` — and **`insertEvents` silently discarded it**,
stamping "now". Invisible when the writer and the workout share a day; wrong
the moment `closeStaleSessions` closes yesterday's session on today's
dashboard load, which is its ordinary case. The doctrine *"the event is filed
when it happened"* was written in the comments and untrue in the code — same
class as deriving `local_date` from UTC: right about WHAT, wrong about WHEN,
corrupting two days at once (a phantom workout today, a false rest day
yesterday, and the weekly count wrong through both).

`eventTimestamp()` is the pure decision now — explicit `occurred_at` wins,
then `time_hint`, then now — and `refileMisdated()` repairs what the bug
already wrote: the session row still knows when it ended, so the sweep puts
the event back on that day. **Six hours of tolerance**, because `end_session`
legitimately stamps minutes after the last set; the target is events filed the
better part of a day late, and a tight tolerance would churn every
honestly-closed session. Verified to fail on the original discard.

### The workout nobody closed — the data was there the whole time

`lib/session.js`. The founder, twice: *"it's not logging my training again."*
He was right, and it was not the ingest door.

A live session lives in `wrought_sessions` with status `active`, and every set
goes straight into `wrought_sets`. But the **workout event** — the row the
brief, the day card, the matrix, the weekly count, the calendar square and the
training burn all actually read — was written only by `end_session`. So
somebody who logged a full session set by set and then walked out of the gym
had every set stored correctly and a day that read *"Rest day (nothing
logged)"*. Worse: the next `start_session` marked the old one **abandoned**, so
the training was deleted from every view for good.

**Nobody says "end session".** They finish the last set and leave — and the
one sentence least likely to get said, by somebody training with headphones
in, is the administrative one at the end. A log that counts only the sessions
somebody remembered to close is the same failure as a food log that counts
only the days somebody remembered to open the app.

So **a session with sets in it is training**, whether or not it was closed.
`finaliseSession()` files it exactly as `end_session` does — one shared path,
so a workout closed by hand and one closed by the server can never produce two
different-looking rows. `closeStaleSessions()` runs on the way into the
dashboard and the brief, so it turns up without another workout having to be
started first.

- **The minutes are start → LAST SET, never start → now.** A session left open
  overnight would otherwise bill fourteen hours, inventing hundreds of calories
  of burn — and an overstated burn is the number that tells somebody they have
  room to eat. `end_session` is the one caller that passes `now`, because
  saying "I'm done" genuinely is the end.
- **The event is filed when it happened**, not under today, or a late Tuesday
  session lands on Wednesday — the same class of error as deriving `local_date`
  from UTC.
- **An empty session is abandoned, never turned into a workout.** A phantom
  session counting toward the weekly target makes the one number the whole plan
  rests on meaningless.
- **Four hours since the last set** is the line. Sets sit minutes apart; four
  hours is not a rest, it is somebody who left. Generous on purpose — closing a
  workout somebody is still doing is the worse mistake, because the next set
  would land on a finished session.
- **`carried_over` says it once and does not scold.** It is a fact about the
  record, not a telling-off for forgetting.

### It opens on today, and the range finally does something

Three faults in one sentence from the founder, and all three were real: *"when
we open it up it should always be on the first day. It's not showing on the
first day my workout, my exercise... and it's not running totals — look at the
seven day, should be yesterday, today to this point. The same with the month."*

- **The dashboard opens on 1d.** It used to open on thirty days, so the first
  thing anybody saw at 7am was a month of averages — the answer to a question
  nobody has yet. What they came for is today.
- **The range now changes something above the fold.** Every window figure on
  the page was an average per LOGGED DAY, and the buttons only touched charts
  far below. `rangeRollup()` adds the chosen stretch up once — in, out, net,
  to this point — through the same `roll()` the calendar's week and month
  already use, so the running total, the calendar and the brief cannot quote
  three different figures for the same Tuesday. Logged days only, all three
  numbers off the same days so they visibly subtract, the denominator said out
  loud, and **today counts as it stands** because it IS partial.
- **Today's training is on the day view.** A run that came off the watch an
  hour ago belonged to no panel: the matrix is arithmetic ABOUT training and
  `last_session` reads the assistant's own session table, so the day it
  happened on showed a burn that included it and nothing saying what it was.
  Sessions and shifts each with their own minutes, distance, calories and heart
  rate — and a shift still carries a `work` chip, still never counts toward the
  weekly target, and is still never praised.

**Two things a one-day default would have broken, caught before shipping.**

**A window is not a memory — again.** Sets were fetched over the selected range
alone, so at 1d "last night" had no sets attached and no previous session to
compare against: the panel drew a session with nothing in it, which reads
exactly like a workout that failed to save. `histFrom` floors that query at 60
days for `lastSession` while trends stay bounded by the range. Same rule that
already governs the weigh-in lookup, in the second place it was needed.

**And a quiet morning is not a new account.** `isFirstRun` was decided from the
loaded window — harmless at thirty days, a lie at one, because somebody with a
month of history who has not logged anything yet today would be handed the
brand-new-account page. On the one product whose entire promise is memory that
is the worst thing this screen can do, so `has_history` is counted over all
time on the server and the window heuristic survives only as the demo's
fallback.

A 1d view also has nothing for nine chart and matrix panels to say, and nine
panels each reading *"not enough data yet"* is precisely what the first-run
screen exists to prevent. They collapse into one line pointing at 7d and 30d.

**The ledger bars had never painted.** `.fill` is a `<span>` and a bare span is
inline, so `height: 100%` and the gradient landed on the line box rather than
the track and every in-versus-out bar rendered as an empty grey slot. One
`display: block`. It reads as a number the page failed to draw, which on a
screen about somebody's eating is worse than drawing no bar at all.

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

### The about page, and the tutorial in the conversation

`public/about.html` + the `guide` tool. The founder: *"need an about page, and
prompts a tutorial on AI to tell you how to use Wrought and what it means."*
The page explains the name (wrought — the old past tense of *work*, what iron
is called once it has been worked enough to hold a shape), and the manual is
**example sentences, not feature lists**, because talking normally IS the
manual. The refusals are printed on it — no flattery, no guessed weights, no
guilt, care flags stop coaching, not a medical device — and so is the export
promise, because "give us your record" is only fair next to "here is the door".

`guide` serves the same tutorial as a tool, so "how do I use this" / "what does
wrought mean" is answered from data rather than the model's memory of a README
it never read. The note says answer what was asked, not recite the manual.

**A photograph of a gym is an equipment list.** Same architecture as the
dinner plate: the connected model reads the image, this server never sees it —
only the extraction arrives. The main gym goes to `set_profile` equipment;
additional named gyms go to `remember` (category `gym`); "I'm at the home gym"
passes that inventory to `start_session`/`suggest_workout`. Never build a plan
around a machine the photos did not show.

### The partial index that ate every workout

Worth keeping in full, because it cost weeks and looked like four other things.

`001` created the ingest dedupe index as **partial** — `where source_ref is not
null` — reasoning that hand-logged rows carry no ref and should not be
constrained. The reasoning was sound and the consequence was not: **Postgres
cannot infer a partial unique index from a bare column list**, and PostgREST has
no way to send the predicate. So every `ON CONFLICT (user_id, source,
source_ref)` came back `42P10` and every device-sent workout was thrown away.

Three things made it invisible:

- **Metrics kept arriving**, because `wrought_metrics_dedupe_idx` is not
  partial. Steps, distance and calories landing while workouts vanished is a
  symptom shaped exactly like a HealthKit permission problem — which is where
  the hunting went, twice.
- **The endpoint answered 200** with a cheerful `events_written: 0`, because
  the write result was checked with `if (!error)` and the error was never
  surfaced. **A swallowed error is worse than a crash**; a crash is visible.
- Nothing else writes events through `/ingest`, so no other feature broke.

**The phone now shows a receipt.** `IngestClient.Receipt` reads
`events_written` and `events_error` off the response and the connect card
prints one line — *"Last sync: 14 readings, 2 of 2 workouts saved."* An absence
of workouts and a silent app look identical from the outside, and telling those
two apart used to mean reading a database. A 200 carrying an error inside it
still reads as a failure.

`015` drops the predicate. Nothing is lost: a unique index already treats NULLs
as distinct, so hand-logged rows stay unconstrained — the partial clause was
never buying the protection it appeared to buy, only making the index unusable
for conflict inference. `/ingest` also gained a fallback that dedupes by reading
existing refs first, so the door is correct before anybody runs the SQL, and
`events_error` now rides on the response.

### Everything the watch keeps — the wide door, widened

The founder: *"all the matrix that is captured by this watch should be on that
app — like times standing on your feet. There's so many things that could be on
there."*

He is right, and the reason is the moat rather than the feature list: **a metric
nothing is storing is a metric nobody can ask a question about in two years**,
and it cannot be backfilled. Apple keeps the samples on the phone, but nobody
goes back and collects a year of stand hours they never thought to capture.

Now carried: stand hours (the blue ring, asked for by name) and stand minutes,
exercise minutes, flights, cycling and swimming distance kept **apart** from
walking, walking heart rate, one-minute heart-rate recovery, VO₂ max,
respiratory rate, blood oxygen, walking speed, step length, gait asymmetry,
double support, Apple's steadiness, six-minute walk, stair speed, mindful
minutes, water, sound exposure, BMI, lean mass, waist.

- **The courier is table-driven.** `DAILY_TOTALS` and `LATEST_READINGS` in
  `HealthCourier.swift` feed both the permission set and the send, so they
  cannot drift — and a HealthKit type read without permission returns nothing
  at all, silently, which looks exactly like somebody who does not own that
  sensor. A test asserts every name sent has a home at the door.
- **Stand hours and mindful minutes are CATEGORY samples**, not quantities.
  Asking for them as quantities returns nothing and reads as a person who never
  stands up, which is why they get their own query.
- **A HealthKit percentage is a FRACTION.** Blood oxygen arrives as `0.97`, not
  97 — same shape as the glucose 18× bug, and "your blood oxygen is 1%" is what
  somebody rings a doctor about. Anything at or under 1 in that group is
  converted once, at the door.
- **Apple's basal, when the watch reports one, is USED — for frame coherence,
  not because it is truer.** Apple defines active energy as *their* total minus
  *their* basal, so pairing Apple's active with our Mifflin basal produces a
  total that matches neither frame — the founder's watch said one resting
  number and the screen said another, and both called themselves his basal.
  `energyBalance` takes `deviceResting` and uses the watch's pair whole;
  Mifflin remains the fallback for accounts with no device and stays visible
  in `resting_basis` for comparison. Neither is a measurement, and the weekly
  weigh-in trend is still the only honest correction. Filed as
  `resting_calories`, never `total_calories` — a basal filed as a total reads
  as a day of doing nothing.

- **A device owner never gets a projection.** `deviceExpected` (a push
  connection that synced within three days) turns a silent morning into
  `awaiting_device`: the burn shows only what is known, says *"your watch
  hasn't sent today — nothing is projected"*, and names the fix (open the
  app). A whole-day multiplier standing in for a watch with real numbers on
  it is exactly what the owner of that watch did not ask for.
- **`dayFacts.device.readings` is generic**, and so is the dashboard panel. A
  metric added at the ingest door draws on screen the same day with no second
  edit. A bespoke line per reading is how a hub stops accepting new things.
- **Nothing is interpreted.** `CLINICAL_CAUTION` marks blood oxygen,
  respiratory rate, blood pressure, glucose, temperature, gait asymmetry and
  steadiness — the readings people frighten themselves with. Apple's steadiness
  ships with a **fall-risk label**, and repeating that back IS a diagnosis. The
  screen marks them with a hairline, never a warning colour, and the
  instructions forbid reassurance as firmly as alarm: telling somebody their
  blood oxygen is fine is the same act as telling them it is not.

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

- `npm test` runs `test/harness.mjs` — 627 offline tests, no network, no database.
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
1. **The push works — this item is CLOSED, and the history is kept because the
   wrong lesson was nearly drawn from it.** It once read that the repo could not
   be reached and that a git bundle had to be carried out by hand. That was true
   of one early session and has not been true since: the repository attaches to
   the session and `git push` goes through GitHub's own proxy, which is
   **independent of the environment's network access level**. Every PR in this
   file since was pushed and merged that way.

   The distinction is the useful part, because it recurs. A session can be
   completely walled off from the internet — `wrought.fit`, `cdn.jsdelivr.net`
   and `example.com` all answering 403 at the CONNECT — while GitHub and npm
   answer 200, because those two ride separate paths. MCP connector traffic is a
   third path again, travelling through Anthropic's servers rather than the
   session's network, which is why the Netlify and Supabase tools can work in a
   session that cannot load a web page.

   So **"I cannot reach the site" never implies "I cannot ship the fix"**, and
   the two must be reported separately. Confusing them is how an afternoon gets
   spent building an escape hatch nobody needed. To let a session actually SEE
   the live site, the environment's network access must be set to Custom with
   `wrought.fit`, `*.wrought.fit`, `cdn.jsdelivr.net`, `*.supabase.co` and
   `app.netlify.com` listed — account UI at claude.ai/code, and it applies to
   new sessions only.
2. Run `schema/001_wrought_core.sql`, then `002_wrought_oauth.sql`, then
   `003_wrought_training.sql`, `004_wrought_fasting.sql`,
   `005_wrought_activity.sql`, `006_wrought_identity.sql`, `007_wrought_push.sql`,
   `008_wrought_blocks.sql`, `009_wrought_photos.sql` and
   `010_wrought_profile_web.sql`, `011_wrought_membership.sql`, `012_wrought_link_codes.sql`, `013_wrought_work.sql`, `014_wrought_plan.sql` `015_wrought_ingest_dedupe_fix.sql`, `016_wrought_set_source.sql` `017_wrought_session_aim.sql`, `018_wrought_alerts.sql`, `023_wrought_commitment.sql` and `024_wrought_places.sql` in Supabase. Full checklist in `docs/SETUP.md`. (017 and 018 through 025 were applied through the Supabase connector from a session — `list_migrations` shows them by name — so a session with that connector can apply an additive migration itself rather than leaving it on this list — **but never while a `wrought_sessions` row is active: DDL bounces PostgREST and the founder's mid-set `log_set` failed for exactly that reason.** 017 sat unapplied for weeks while the code degraded politely around it; check `/status` before assuming a column exists.)
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
7. **The Shortcut route is RETIRED (2026-08-10)** — the founder built one end
   to end and his 2,778-step day arrived as 33,640: Shortcuts exposes raw
   per-device samples, phone+watch double, and no reachable filter or grouping
   fixes it. connect.html now leads with Health Auto Export (Apple's own
   deduplicated totals, workouts included; /ingest reads its shape natively)
   and keeps the hand-built Shortcut as a demoted option whose limits are
   stated outright — fine for weight and resting HR, overcounts steps/energy.
   The prebuilt-iCloud-link plan is dropped; the iOS app supersedes it. Do not
   resurrect the Shortcut as a recommended route.

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

**The revisit clause below FIRED on 2026-08-10.** The founder spent an evening
discovering, tap by tap, that Shortcuts cannot produce a deduplicated step
count — "Find Health Samples" exposes raw per-device samples and no statistics
query, so phone+watch always double and grouping does not fix it. Health Auto
Export can, because it is a NATIVE app: HealthKit's HKStatisticsQuery (the
deduplicated daily totals — the number on the watch face) plus background
delivery are native-only APIs. So the first native build, after the fortnight
of real use, is **the app as the founder specified it**: *"the AI is basically
the thing that's working it, but the app is the statistics house... the same
stuff on the website is on the app... but everything's ran through the GTP."*
Concretely: a native shell owning the three native-only powers — sign-in,
HealthKit background delivery posting to /ingest, and real APNs push (the
nightly verdict; same hand-rolled `.p8` JWT pattern as Apple sign-in, same
developer account) — presenting the SAME screens the website serves, not a
rebuilt copy. One set of screens means zero drift and dashboard fixes ship to
both surfaces in one deploy; "sync" is free because no surface holds state —
every screen draws from the server, which is the existing doctrine extended to
a third window. NO chat in the app: capture and coaching stay in the connected
AI. Apple rejects bare website wrappers (guideline 4.2); HealthKit + push are
the genuine native functionality that makes this pattern approvable. Until it
ships, Health Auto Export is the recommended watch route and /ingest reads its
shape natively, workouts included.

**The shell is WRITTEN: `ios/Wrought.xcodeproj`**, on the founder's direct
instruction ("write it with Swift... put it into the GitHub"). Six Swift files:
a WKWebView framing `wrought.fit/app.html` (the statistics house — same
screens, same server, zero drift), a HealthKit courier using HKStatisticsQuery
(the deduplicated watch-face numbers) with hourly background delivery posting
the native shape to `/ingest` as source `wrought_ios`, and a key handshake
that reads the page's own session to mint the device key — the app can never
feed a different account than the one signed in on screen. Key in the
Keychain, never UserDefaults. NOT COMPILED — no Xcode in the build container;
`ios/README.md` has the founder's 10-minute build steps and honest caveats
(email+password in-app; Google/Apple OAuth refuse embedded webviews; APNs
push is the next native build). Harness tests pin the doctrine: no chat
surface, statistics-not-samples, same `/ingest` door, entitlements present.

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

### Three different things called "connected"

The founder, looking at Google Drive and Notion in his ChatGPT composer:
*"Why are they popping up like that? Why can't I get Wrought to pop up like
that?"* They get confused constantly and only one of them is ours to fix:

1. **In the built-in list beside Drive and Notion** — a DIRECTORY LISTING,
   granted by OpenAI on review. A custom connector never appears there however
   correct it is. `docs/SUBMISSION.md` is the whole answer, and the hard
   prerequisite is being deployed and used first.
2. **Addable by pasting `https://wrought.fit/mcp`** — a custom connector. This
   already works and is genuinely fine for early users.
3. **Switched ON inside one conversation** — a per-chat toggle the person
   controls every time. This is the cause of *"I don't currently have its
   logging connection available"*, and there is **no server-side fix**: when
   the tools are absent, nothing in `SERVER_INSTRUCTIONS` or any tool
   description is in the model's context to steer it. The catch-up flush is
   the recovery, not the prevention.

And a lock-screen notification is a **fourth** thing again, with nothing to do
with the connector at all. That is web push from `brief-nightly.js`, blocked on
the two VAPID variables and an installed PWA, and no listing anywhere changes
it. Getting listed will not make notifications work and notifications working
will not get it listed — the two are unrelated, and conflating them is how a
week gets spent on the wrong one.

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
