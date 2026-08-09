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
- **Ingest**: `/ingest`, bearer key from `wrought_ingest_keys`, idempotent via
  unique indexes. Accepts native shape and Health Auto Export's shape.

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

**No symbol.** The wave/bar mark was removed deliberately: a mark beside the
name is a small apology for the name not being strong enough alone. WROUGHT set
heavy (800) and wide (0.3em tracking) in capitals is harder to look at than any
glyph drawn next to it, and it survives being a favicon, a lock-screen line and
a connector entry without anything being redrawn. Do not reintroduce a symbol.

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

- `npm test` runs `test/harness.mjs` — 108 offline tests, no network, no database.
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
   `003_wrought_training.sql`, `004_wrought_fasting.sql`, and
   `005_wrought_activity.sql` in Supabase.
3. Set env vars in Netlify: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `OPENAI_API_KEY`, `WROUGHT_SITE_URL=https://wrought.fit`. Inject
   `window.WROUGHT_SUPABASE_URL` and `window.WROUGHT_SUPABASE_ANON` for the pages.
4. Domain bought: **wrought.fit** (renews ~C$70 Aug 2027).

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
3. **Web push to an installed PWA** — the proper answer, and the next build.
   iOS supports it from 16.4 for home-screen apps. Needs VAPID keys, a service
   worker and a manifest.

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

**Next builds, in order:**
1. Web push via PWA — the last notification channel that does not depend on the
   user having built a Shortcut.
2. Register OAuth apps for Oura / Whoop / Fitbit / Withings, then the pull
   sync function.
3. **Multi-week programmes.** The last structural piece — routines exist, the
   per-exercise progression already works, so a programme is an ordered
   schedule over them. Everything after this is polish.
4. Progress photos with dated comparison.
5. Connector directory submissions — full checklist in `docs/SUBMISSION.md`.

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
