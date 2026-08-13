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
not. A care flag is the **entire** message, because a lock screen has no room
to bury one. Nothing logged still sends nothing; a nightly nag is how a product
gets muted permanently.

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
broken at one. **Care flags need three logged days and a fortnight, so on the
1d view the dashboard now opens on they could not fire at all** — the one thing
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
- **`event_id` (016) makes it idempotent**: `structure_entries` and
  `amend_last` REPLACE an event's derived sets rather than doubling them, and
  deleting the event cascades its derived sets away. The code works before the
  migration runs (the 015 lesson) — it only loses idempotency until then.
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

- `npm test` runs `test/harness.mjs` — 515 offline tests, no network, no database.
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
   `010_wrought_profile_web.sql`, `011_wrought_membership.sql`, `012_wrought_link_codes.sql`, `013_wrought_work.sql`, `014_wrought_plan.sql` and `015_wrought_ingest_dedupe_fix.sql` in Supabase. Full checklist in `docs/SETUP.md`.
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
