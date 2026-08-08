# FORGE — Agent Context

*Read this first. It is the persistent memory of the project.*

## What this is

**FORGE is the honest personal trainer that lives inside your AI.** Founder:
Laszlo (Marcus) Czako (`lczako-eng`, laszlobrianczako@gmail.com).

The origin is a real daily annoyance, and it should stay the north star: the
founder opens a **new ChatGPT page every single morning** and re-explains what
he ate versus what he did, because the model has no memory. FORGE is the memory
that survives the tab closing, plus a nightly read on what it all means.

**This is a separate project from Revolv / SupplAi.** Do not put FORGE code in
`SupplAi-Industrial` — that was an early error and was reverted. Different
product, different repo, different domain. The two share a founder and an
architectural instinct (memory is the moat, the AI is only the interface), and
nothing else.

## Doctrines (settled — do not re-litigate)

- **One sentence is a complete log.** Never a form, never "what were the macros".
  A health log that costs more than a sentence is one nobody keeps. `log` takes
  the user's words verbatim and an LLM structures them server-side.
- **The brief is the product.** Logging is table stakes; a hundred apps log.
  Nobody has a thing that reads the week back to you honestly.
- **The server computes, the model relays.** Every total, average, trend, streak
  and countdown is calculated in `lib/forge.js` and handed over with a `say`
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

- **Supabase = home.** All data, RLS on every table. `forge_events` (the human
  log, one row per thing said) and `forge_metrics` (device time series) are
  deliberately separate — a person emits a sentence a day, a watch emits a row a
  minute, and one table makes both queries bad.
- **`local_date` is stored, not derived.** A day is a day in the user's own
  timezone. Deriving from UTC at read time files a late-night snack under
  tomorrow and corrupts every brief. This has a test.
- **`lib/forge.js` holds all arithmetic**, apart from the protocol layer, so the
  MCP brief and the web dashboard cannot disagree. `api-progress.js` exists
  purely so the dashboard calls the same code rather than recomputing in JS.
- **MCP server**: `netlify/functions/mcp.js` at `/mcp` — stateless Streamable
  HTTP, JSON-RPC. 17 tools. Doctrines ship in `SERVER_INSTRUCTIONS`.
- **Auth**: OAuth 2.1 (PKCE, dynamic client registration) so "Sign in with
  Forge" appears in ChatGPT/Claude. Supabase session JWTs also accepted as a
  fallback. Everything secret is stored SHA-256 hashed.
- **Ingest**: `/ingest`, bearer key from `forge_ingest_keys`, idempotent via
  unique indexes. Accepts native shape and Health Auto Export's shape.

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

- `npm test` runs `test/harness.mjs` — 39 offline tests, no network, no database.
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
1. Create the GitHub repo `lczako-eng/forge` — the agent integration cannot
   (403 from `create_repository`), so the first push needs an empty remote.
2. Run `schema/001_forge_core.sql` then `002_forge_oauth.sql` in Supabase.
3. Set env vars in Netlify: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `OPENAI_API_KEY`, `FORGE_SITE_URL`. Inject `window.FORGE_SUPABASE_URL` and
   `window.FORGE_SUPABASE_ANON` for the web pages.
4. Decide the domain. `forge.fit` is the placeholder in `FORGE_SITE_URL`.

**Next builds, in order:**
1. Scheduled evening brief — push the verdict at 10pm instead of waiting to be
   asked. This is what turns FORGE from a tool into a habit.
2. Register OAuth apps for Oura / Whoop / Fitbit / Withings, then the pull
   sync function.
3. Progress photos with dated comparison.
4. Connector directory submissions (ChatGPT / Claude) once the flow is proven.

**Strategy notes:** the moat is accumulated personal memory, exactly as with
Revolv — features clone in weeks, four years of someone's training history does
not. Logging is commodity; the verdict and the memory are the product. The
honesty is the differentiator and the care flags are what make honesty safe to
ship.
