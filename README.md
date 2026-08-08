# WROUGHT

**The honest personal trainer that lives inside your AI.**

You already talk to an AI every day. What you do not have is one that remembers
yesterday. So every morning it is a blank page again — what you ate, what you
lifted, what the scale said, typed out to something that will have forgotten all
of it by lunchtime.

WROUGHT is the memory that does not close with the tab, plus the one thing in your
life willing to tell you the truth about the week you just had.

```
You,   8:14am   two eggs and black coffee, 182 on the scale
You,   7:40pm   pushed 40 minutes upper body, bench 3x8 at 80

WROUGHT, 10pm     Roughly 2,140 calories and 148g of protein — you hit protein for
                the fourth day running, which is the longest you've held it. Bench
                moved: 80kg for three sets of eight is up from 77.5 a fortnight ago.
                You haven't trained legs in 19 days and it's starting to show in the
                volume. Weight's trending down about 0.4kg a week, which is the right
                speed. Tomorrow is legs. No more negotiating with yourself about it.
```

---

## What it is

An **MCP server**. Add one URL to ChatGPT, Claude, or anything else that speaks
MCP, sign in once, and it is simply there in every conversation from then on.
There is no app to open and abandon in February.

- **One sentence is a complete log.** No forms, no weighing rice in grams. You
  say it the way you would say it to a person and it files it — food broken into
  macros, lifts into sets and loads, the scale into a trend.
- **A verdict every night.** What happened, what you got right, what you got
  wrong with the number attached, and the one thing to do tomorrow. You pick how
  hard it hits: `gentle`, `honest`, or `brutal`.
- **Your watch does the boring half.** Sleep, steps, resting heart rate and
  weight arrive on their own overnight.
- **Progression you can see.** Weight as a trend line rather than a daily scare,
  volume per session, and a muscle-by-week matrix that shows the hole where legs
  used to be.
- **It remembers the awkward parts.** The knee that goes below parallel. The
  month you travel. The fact you will never go running. Said once, honoured
  forever.

## Honest, not cruel

The whole point is something that will not flatter you, so it names the
3,400-calorie day and the three skipped weeks with the numbers attached. But it
is hard on the **behaviour**, never on the person. It does not comment on your
body. And if the log starts to look like someone eating too little or losing
weight too fast, `careFlags` fires server-side, the coaching stops, and the tone
changes — regardless of what the user asks for or how the request is framed.

WROUGHT is a journal that can do arithmetic. It is **not a medical device**, it
diagnoses nothing, and calories inferred from a described meal are always
labelled as estimates.

---

## The tools

| Tool | What it does |
|---|---|
| `log` | The workhorse. Plain English in, structured entries out. |
| `brief` | The daily read and the written verdict. |
| `progress` | Trends, chart-ready series, the training matrix. |
| `whats_next` | What to do right now — eat, train, or stop. |
| `suggest_workout` | Programmes the next session from what is actually stale. |
| `get_day` · `search_log` | Read one day; search all of history. |
| `log_weight` · `log_measurement` · `undo_last` | Direct entry and correction. |
| `get_profile` · `set_profile` · `set_goal` · `set_eating_window` | Setup, asked once. |
| `connect_device` | Watches, rings and scales. |
| `remember` · `recall` | Injuries, constraints, hatreds. |

## Architecture

```
ChatGPT / Claude / any MCP client
        │  JSON-RPC over HTTPS, OAuth 2.1 + PKCE
        ▼
   /mcp  ── netlify/functions/mcp.js        protocol + 17 tools
        └─ netlify/functions/lib/wrought.js   ALL arithmetic lives here
        ▼
   Supabase (Postgres, RLS)                 the memory
        ▲
   /ingest ── netlify/functions/ingest.js   Apple Shortcut, Health Auto Export
        │
   iPhone / Apple Watch / Oura / Whoop
```

Everything that counts, compares or judges lives in `lib/wrought.js`, apart from
the protocol layer, for two reasons: the MCP brief and the web dashboard must
never disagree about a number, and arithmetic should be testable without a
network.

**The server computes, the model relays.** Never hand a language model three
numbers and hope it subtracts correctly — hand it the answer and a sentence.

### Apple Watch, and why it works differently

Apple Health has **no cloud API**. There is no entitlement, no partner
programme and no price at which a server can read an Apple Watch. The data lives
on the phone and leaves only if the phone sends it.

So Apple **pushes**: a free iOS Shortcut POSTs to `/ingest` once a night with a
scoped bearer key. Oura, Whoop, Fitbit, Garmin and Withings have real cloud APIs
and **pull** over OAuth. Every "Apple Health integration" you have ever used is
the push route underneath; most of them just do not say so.

## Setup

```bash
npm install
npm test          # 52 offline tests — protocol envelope + all arithmetic
```

1. Run `schema/001_wrought_core.sql` then `schema/002_wrought_oauth.sql` in the
   Supabase SQL editor.
2. Set the environment variables below in Netlify.
3. Deploy. Add `https://<your-site>/mcp` to ChatGPT or Claude as a custom
   connector.

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side writes; never sent to a browser |
| `OPENAI_API_KEY` | Parsing plain-English logs and writing verdicts |
| `WROUGHT_SITE_URL` | Canonical origin, e.g. `https://wrought.fit` |
| `WROUGHT_MODEL` | Optional model override |

The two web pages need `window.WROUGHT_SUPABASE_URL` and
`window.WROUGHT_SUPABASE_ANON` injected at deploy time (Netlify snippet
injection) — the anon key only ever reaches rows RLS already permits.

## Status

Working: the MCP server and all 17 tools, OAuth 2.1 with dynamic client
registration, Apple Health ingest, the dashboard, the harness.

Next: OAuth apps registered for Oura / Whoop / Fitbit / Withings so the pull
providers connect; a scheduled function that pushes the evening brief instead of
waiting to be asked; verified progress photos.

---

© 2026 Laszlo Czako. WROUGHT is a training and nutrition journal, not a medical
device, and not a substitute for a doctor or a dietitian.
