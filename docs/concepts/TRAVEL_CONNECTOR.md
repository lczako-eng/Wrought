# The travel connector — concept note and honest verdict

*Written 2026-08-12, at the founder's request, as an example-versus-example
assessment against WROUGHT and spLing.*

**This is a concept note, not a plan of record, and NO CODE FOR IT MAY LAND IN
THIS REPO.** WROUGHT's own doctrine settles that: *"Different product, different
repo, different domain."* The travel connector shares a founder and an
architectural instinct with WROUGHT and nothing else. This file lives here only
because it is the branch that was open; the moment the idea is committed to, it
gets its own repository and this file moves with it.

Working name in this document: **CATCHMENT**. It is a placeholder chosen because
the product IS an airport catchment area — the ring of departure points a person
can actually reach — and because it sits in the same slab-word family as
WROUGHT. Nothing about it is settled.

---

## What the founder actually proposed

In his words: a travel connector built the same way as WROUGHT — the connected
AI is the interface, the website and a thin app carry admin and payment. The
specific problem is his own: he is in **London, Ontario**, and the airports he
can genuinely reach are

| Airport | | Approx. drive | Note |
|---|---|---|---|
| London | YXU | 0 min | Small, thin routes, usually priced highest |
| Hamilton | YHM | ~1h15 | Low-cost carriers |
| Toronto Pearson | YYZ | ~1h50 | Everything flies here |
| Billy Bishop | YTZ | ~2h | Porter, downtown |
| Detroit | DTW | ~2h + border | USD fare, US hub, huge network |
| Buffalo | BUF | ~2h45 + border | USD fare, notoriously cheap |

*(Drive times are from memory and must be verified before anything is built on
them — they are load-bearing arithmetic, not decoration.)*

And the query he wants to be able to ask: *"Somewhere warm, cheapest, a week
sometime in December, no layovers, and find me the hotel and the things to do
while you're at it."*

His claim: this beats Kayak and Booking because the flexibility is greater.

---

## The verdict, first

**The wedge is real, and it is much narrower than the pitch.** It is not
"flexible search" — flexible search exists and Google gives it away. It is
**the landed cost of a trip measured from a specific driveway**, which nobody
computes and nobody is structurally able to.

**Build it as a decision engine, not a booking engine.** Sell the answer;
refer the transaction out. That one choice removes about 80% of the risk
below.

**And do not write a line of code until the one-evening test in the last
section says the answer is worth money.**

---

## The one thing here that is genuinely unserved

Every OTA answers *"what is the cheapest flight from A to B?"* Google Flights
answers a much better version of it — up to seven origins against seven
destinations, and a whole-month price calendar. Kayak has nearby-airports and
flexible-dates too. **The flexibility itself is not the gap, and claiming it is
will get the product dismissed by anyone who has used Google Flights properly.**

The gap is this: **every one of those tools prices the fare and stops.** They
will happily tell you Buffalo is $340 cheaper and never mention that Buffalo
costs you a 2h45 drive each way, a week of airport parking, a tank of gas, a
border crossing in both directions, and a fare denominated in a currency you do
not earn.

Nothing on the market computes:

```
landed cost  =  fare
             +  FX spread, if the fare is in USD
             +  drive       (distance × your own per-km cost, both ways)
             +  parking     (nights × that airport's actual rate)
             +  border      (crossing time, and the risk of it going badly)
             +  the hours   (priced at whatever the traveller says they are worth)
```

That is exactly the same shape as WROUGHT's **three burns** doctrine: the
category that dominates the total for the person in question and that nothing
was counting. There it was a shift at a petting zoo. Here it is the drive.

**And no incumbent will ever build it**, which is what makes it defensible.
Expedia is not going to tell you to drive to a competitor's catchment. Google
has no idea what your car costs or whether you hold a NEXUS card. The
calculation requires knowing things about *you* that only a memory product
holds — and that is the WROUGHT instinct landing in a second domain.

The output is one sentence nobody else can produce:

> *"Fly out of Buffalo on the 14th. The fare is $312 USD against $598 CAD out
> of Pearson — but after the drive, six nights of parking and the exchange,
> you are ahead by $181, and it costs you five and a half hours of driving.
> Out of Hamilton on the 16th you are ahead by $94 and it costs you two and a
> half hours. Your call."*

That is a decision somebody can judge — the same standard WROUGHT applies to a
calorie target that must never appear without its maintenance beside it.

---

## The four hard problems

### 1. The combinatorics will bankrupt you, and this is the real constraint

Flexible search is a cross product, and it explodes:

```
6 origins × 12 candidate destinations × 31 December departure dates × 5 stay lengths
= 11,160 priced round trips — for ONE user asking ONE question
```

Duffel — now the realistic door for an indie developer — charges **$3 per
confirmed order plus 1% of order value**, and levies an **excess search fee of
$0.005 above a 1,500:1 search-to-book ratio**. A single query of the shape the
founder described consumes 11,160 searches, which on its own demands roughly
**7.4 completed bookings to stay inside the ratio.**

One user, one question, seven bookings owed. The naive product is not expensive;
it is arithmetically impossible.

**The fix, and it is a real one:** you cannot run the cross product live, and you
should not try. Run a **cached price surface** — coarse, refreshed on a schedule,
good enough to rank — then take live prices only on a shortlist of five to ten
candidates. That is what makes the answer cheap. It also means the headline
number is an **estimate**, which must be labelled as one every single time, in
exactly the way WROUGHT labels an inferred calorie. *"Roughly $310, priced two
days ago"* is honest and useful. A stale number presented as live is the
credibility death — a fare that has moved $200 by the time somebody clicks is
the travel equivalent of a guessed working weight.

### 2. The indie on-ramp closed six weeks ago

**Amadeus decommissioned its Self-Service API portal on 17 July 2026.** That was
the free-tier door every small travel product came through. What remains for a
new team is an enterprise agreement.

Where that leaves the supply side:

- **Duffel** — public pay-as-you-go, $3/order + 1%, no upfront fee. The cleanest
  path, and the recommended one. Weaker on low-cost carriers, which matters a
  lot at Hamilton and Buffalo specifically.
- **Kiwi / Tequila** — has exactly the right capabilities (virtual interlining,
  Nomad, multi-city) and is **invitation-only for new partners** as of 2026. Not
  available to you on day one.
- **Travelpayouts** — an affiliate aggregator, not a booking API. Useful for
  referral links and for hotels, useless for building a real price surface.

So the honest position is: **one viable supplier, thin on precisely the carriers
your local low-cost airports depend on.** That is a single point of failure on
the input side of the whole product, and it should be stated plainly rather than
discovered in month three.

### 3. Booking makes you a travel agent, and that is a support business

This is the biggest difference between CATCHMENT and WROUGHT and the one most
likely to be underestimated.

WROUGHT has **no operational liability**. Nothing it does can strand a person.
Its worst failure mode is a wrong number, which is why the care flags exist and
why they outrank everything.

The moment you sell a ticket, you own:

- schedule changes, cancellations and involuntary re-routes
- refunds, chargebacks and airline disputes
- **somebody stuck at Detroit at 11pm with your phone number**
- IATA accreditation, or Duffel standing as merchant of record, plus whatever
  Ontario's travel-seller regime requires (TICO registration — needs checking,
  and it is not optional if you take money for travel)

That is a 24/7 staffed operation. It is not a software business, it is not one
person's evenings, and it cannot be automated away in year one.

**Refer the booking out and none of it applies.** You hand over a link; the
airline or the OTA owns the ticket, the refund and the 11pm phone call. The
product keeps the part that is actually yours — the answer.

### 4. The affiliate maths does not carry the product

Current rates:

- **Flights: ~1.1–1.5% of booking cost.** A $600 fare returns about **$8**.
- **Hotels: 4–5% of Travelpayouts' revenue share** — not of booking value. On a
  $1,400 week that lands somewhere around $30–45.

So a booked trip is roughly **$40–50**, and only if they book through your link
at all. Assume two trips a year and a 30% link-through rate and you are looking
at **~$30 per user per year** — against a search bill that is real whether or
not anybody books.

That is not a business. It is a rounding error attached to an infrastructure
cost.

**Charge for the answer instead.** The value delivered is *"you are $181 ahead
by driving to Buffalo"* — and that value is fully delivered whether or not the
booking touches you. Price it as a per-search fee or a small annual
subscription, take referral revenue as a bonus that is never planned around, and
the seller-of-travel liability disappears at the same time. One decision fixes
problems 3 and 4 together.

---

## What carries over from WROUGHT — and what conspicuously does not

### Carries over (this is the reason it is cheap for you specifically)

Structurally, a large fraction of WROUGHT is domain-independent scaffolding you
have already built, debugged and tested:

- the MCP server pattern — stateless Streamable HTTP JSON-RPC on Netlify
  functions, doctrines shipped in `SERVER_INSTRUCTIONS`
- OAuth 2.1 with PKCE and dynamic client registration, so "Sign in with
  CATCHMENT" appears in ChatGPT and Claude
- Supabase with RLS on every table; the events/metrics split shape
- membership, trials, redemption codes, the admin aggregates view
- `/status`, `/api/export`, the offline worker, the sign-in surfaces, account
  linking and the anti-fork machinery
- **the doctrines themselves**, which transfer almost verbatim:
  - **the server computes, the model relays** — a fare, a drive cost or a total
    may only ever come from a tool
  - **estimates are labelled** — every cached price says when it was priced
  - **the invented-target failure** — a model asked *"what will this cost?"*
    with nothing in hand **will invent a number**. It happened on your own phone
    with a calorie target. It will happen here with a fare, and a fabricated
    fare is worse, because it is checkable in ten seconds and the product dies
    the moment somebody checks.

Realistically **35–45% of the codebase is reusable in shape**, and closer to
100% of the hard-won judgment. That is a genuine and unusual advantage.

### Does not carry over — and this is the strategic weakness

**WROUGHT's moat is accumulated personal memory.** Four years of training
history cannot be cloned, and it gets more valuable every single day it exists.

**Travel is two to four transactions a year.** There is no daily accretion, so
there is no compounding record, so there is no moat of that kind. This must be
faced rather than talked around: the thing that makes WROUGHT defensible is
mostly absent here.

What memory does exist is real but thin — and it is *constraint* memory rather
than *history* memory:

- NEXUS card, passport expiry, airline status, points balances
- won't fly redeyes, won't connect through Chicago in winter, aisle only
- the kids' school calendar, the partner's shift pattern
- **what their car actually costs per kilometre, and what an hour of their time
  is worth to them** — the two inputs the whole landed-cost calculation turns on

That is genuinely enough to make the second search better than the first, and
enough that a competitor starting fresh cannot answer as well. It is not enough
to be a four-year moat. **Plan accordingly, and do not tell yourself otherwise.**

### And the distribution channel is no longer open

WROUGHT went into an empty category. This one does not: **Expedia, Booking.com
and Kayak already have live apps inside ChatGPT**, reachable from the Connectors
page, showing real inventory with photos and prices in the conversation.

That is not fatal — none of them computes landed cost, and none of them ever
will — but "we are the travel thing inside your AI" is no longer the pitch. The
pitch has to be the specific arithmetic, and it has to be sharp enough to
survive being said in one sentence next to Expedia's logo.

---

## The shape it should take, if built

- **A decision engine.** It answers *where to fly from, on what date, at what
  true cost.* It does not sell tickets.
- **Landed cost is the product.** Every answer is a total, itemised, with the
  fare as only one line in it. The itemisation is what makes the number
  believable — the same reason WROUGHT's resting burn had to start showing its
  working.
- **A cached price surface, drilled down live on a shortlist.** Estimates
  labelled and timestamped, always.
- **The constraints are absolute, never optimised away.** *"No layovers"* means
  no layovers. A cheaper one-stop offered anyway is how somebody stops trusting
  the filter — the same class of error as a plan prescribing what the care flags
  warn about.
- **The hours are priced and shown separately from the dollars**, because they
  are not interchangeable and the traveller is the only one who can trade them.
  Show both; let them choose. Never collapse them into one score.
- **Refuse to guess.** No invented fares, no invented drive times, no invented
  parking rates. If the surface has no price for that pair, say so. WROUGHT's
  hardest-won lesson applies unchanged: **a model handed a vacuum invents**, so
  the fix is never a stronger prohibition, it is putting a real computed number
  where the vacuum was.
- **Hotels and things-to-do come later.** They are the founder's ask and they
  are real, but they are a second product with a second supply problem. Ship the
  flight decision alone, or ship nothing on time.
- **The app is optional, forever** — same doctrine, same reasons. Website plus
  connector is the whole product.

---

## Before any code: the one-evening test

The entire concept rests on a single empirical claim: **that the landed-cost
answer is materially different from the fare answer.** That is testable by hand
tonight, and it costs nothing.

1. Take a real trip — the founder's actual December week.
2. Price it manually across all six airports on Google Flights, using the month
   calendar.
3. Add the drive, the parking, the gas, the FX and the border for each.
4. Compare the winner against what Google Flights alone would have told him.

Then read the gap:

- **Under ~$100** — the product has no reason to exist. Google's answer is good
  enough, and the extra work is not worth paying for. **Stop here.** That is a
  successful evening, not a failed one.
- **$100–300** — real, but it is a feature, not a company. Possibly worth
  building for himself and a few hundred people in the same geography.
- **Over $300, repeatably, across several trips** — the wedge is genuine and
  worth a repo.

Run it three or four times, on different months and destinations, before
believing any single result. One good answer is salt and sleep; the trend is
the finding. That is the same rule WROUGHT applies to a weigh-in.

---

## Honest summary

**The instinct is right and the framing is wrong.** "More flexible than Kayak"
is a claim that loses to a Google Flights demo. "It prices the drive, the
parking, the border and the exchange rate, and no one else does" is a claim
that wins, because it is true and because no incumbent is structurally able to
make it.

**The economics only work if you sell the answer rather than the booking.**
Affiliate revenue at 1.1–1.5% on flights cannot pay for combinatorial search,
and selling travel drags in an operational liability WROUGHT has never had and
that one person cannot staff.

**The moat is thinner than WROUGHT's, and that is the honest cost of the
category.** Two to four transactions a year does not compound the way a daily
log does. What memory exists is about constraints, not history.

**Do the evening test first.** Everything above is downstream of one number
nobody has measured yet.

---

*Sources consulted 2026-08-12: Duffel published pricing; Amadeus Self-Service
decommissioning notice (17 July 2026); Kiwi/Tequila partner access status;
Travelpayouts published commission rates; Google Flights multi-origin and
flexible-date documentation; coverage of the Expedia and Booking.com apps
inside ChatGPT.*
