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

**The wedge is real, and it is narrower and sharper than the pitch.** It is not
"flexible search" — the capability exists and Google gives it away. It is two
things that compose:

1. **It proposes the option you did not ask for.** Google answers the question
   you typed; it never volunteers Buffalo on the 14th.
2. **It prices the trip from a specific driveway** — fare, drive, parking,
   border, exchange — which nobody computes and nobody else is structurally able
   to.

And it is **not for travellers, it is for frequent travellers in a multi-airport
catchment.** That is the customer, and naming them narrowly is what makes the
rest of this defensible.

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
flexible-dates too.

**But the capability existing is not the same as the option arriving**, and the
founder was right to push back here: *"nobody's giving me options when I do
that."* He is describing what happens at the screen. Google Flights answers
precisely the question you typed and never proposes the one you did not. The
month grid works per origin-destination pair; Explore degrades your constraints
to draw a map; a multi-origin search collapses into one cheapest list that never
states the **trade**. To get the good answer out of it you have to already
suspect the good answer exists and interrogate the tool into confirming it.

That is a failure WROUGHT has already met twice: the arithmetic was built,
tested and shipping, and **the website simply had no surface for it.**
Capability nobody surfaces is capability nobody has. So the honest framing is
not *"more flexible than Kayak"* — it is **"it proposes the option you did not
ask for."** Google structurally does not make that claim and Expedia has no
incentive to.

The second gap: **every one of those tools prices the fare and stops.** They
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

## The second half of the wedge — constraints nobody has a box for

The founder: *"I could talk to the guy and say listen, I want only this airline
— very specific, very customizable. The other ones, you gotta fill in boxes."*

This was underweighted in the first draft. It is real, and it composes with
landed cost rather than sitting beside it.

**A filter set is a fixed vocabulary**, and every OTA's filter set is the
intersection of what is cheap for them to index. The constraints people actually
carry have no box:

- *"Air Canada only, I'm chasing status."*
- *"Nothing through Chicago in January."*
- *"I have to be back before my daughter's recital on the 19th."*
- *"I'd pay $80 more not to take a redeye."*

**The last one is the important one**, and it is why this is more than a nicer
input field. A filter can only express a HARD constraint — on or off. What it
structurally cannot take is the **exchange rate between constraints**: how much
a redeye is worth avoiding, what an hour of driving costs you, whether $60 is
worth a 6am start.

And that is **exactly the input the landed-cost calculation already needs.**
Both halves of the wedge want the same fact out of the traveller. That is not a
coincidence — it is the product. The conversation is the only interface that can
collect it, because no form has ever successfully asked somebody what an hour of
their time is worth.

**The caveat, so it is not discovered later:** Expedia's ChatGPT app also takes
natural language. The difference is that it translates the sentence **down into
its own filter boxes** — the boxes are still there, hidden behind the
conversation. So the advantage only exists if the backend can express
constraints theirs cannot. That is a genuine technical distinction and it is
defensible, but it has to be **built deliberately**. It does not come free with
having a chat interface, and assuming it does is how this turns into a worse
Expedia with a nicer greeting.

---

## What cannot be undercut, and what actually is

The founder: *"we get to undercut every single one of them cause zero
expenses."* Both halves of that are wrong, and the correction makes the pitch
stronger rather than weaker.

- **The expenses are not zero — search IS the expense.** 11,160 priced
  itineraries per flexible question, arriving whether or not anybody books. It
  is the single largest cost in the product and the whole reason the cached
  surface exists.
- **A fare cannot be undercut at all.** The seat price is set by the airline.
  Expedia does not mark it up and hand back the difference — it earns commission
  from the *airline* side, so there is no margin sitting there to give away.
  Where negotiated fares do exist they go to whoever has volume, which on day one
  is everybody except us. **A new entrant is priced ABOVE the market, not
  below.** Any pitch built on being cheaper per seat collapses the first time
  somebody compares one.
- **What actually gets undercut is the wrong airport.** The $181 in the Buffalo
  example does not come out of anybody's margin — it comes from flying out of
  Buffalo instead of Pearson. It is a **routing saving**, and it is larger than
  any discount an OTA could offer even if it wanted to.

So the saving is never framed as a discount. It is a **better answer**, which is
both true and the stronger claim.

---

## Show the comparables — the best feature idea in this thread

The founder: *"the cheapest best options and then put comparables with the other
ones throughout there."*

**This is right and it should be built first among the nice-to-haves.** Every
answer carries, beside it, what the ordinary search would have told you:

| | Fare | Landed | |
|---|---|---|---|
| **Buffalo, 14 Dec** | $312 USD | **$734** | our answer |
| Pearson, 12 Dec | $598 CAD | $915 | what Google shows first |
| Hamilton, 16 Dec | $505 CAD | $828 | second best |

It is the same doctrine as `form_check`: **every finding ships with its
evidence.** A verdict without it is an opinion wearing a number. And the same
lesson as the resting burn that had to start showing its working — *a number
nobody can audit is a number they stop believing, and they are right to.*

It does three things at once that nothing else does:

- **It is proof of work.** The answer is checkable in thirty seconds against the
  tool the person already trusts, which is the only way a new product earns
  belief on a number that big.
- **It shows the size of the saving without ever claiming a discount.** The
  comparison IS the pitch, and it makes it without a marketing sentence.
- **It survives being wrong.** When the ordinary search wins, saying so
  out loud is what makes the other 80% credible. A tool that always finds a
  saving is a tool nobody believes twice — the same reason `form_check` is
  deliberately quiet and only ever softens.

---

## The cost argument — half right, and the half that is wrong is load-bearing

The founder: *"deals are made, I'd get the discounts and all that kind of stuff
that everybody else does — but I could do this because there's no cost to me at
a penny. I can make a penny off everybody, so there's nobody that can compete
with that."*

**The instinct is sound and the arithmetic inverts.** Take it in three parts.

### Zero HEADCOUNT is real. Zero MARGINAL cost is not.

Expedia carries thousands of staff, offices and an enormous marketing spend.
Those are **fixed** costs, and a fixed cost amortises: spread across a hundred
million users it is fractions of a cent per query. One operator with no payroll
genuinely does beat that at small scale, and that advantage is real.

But **our costs are marginal** — metered search, growing linearly, arriving
whether or not anybody books. So the curves cross. Low fixed cost wins early;
at scale, the party with amortised infrastructure and direct distribution
contracts has the *lower* per-query cost, not the higher one.

**A penny per user only works if a search costs meaningfully less than a
penny.** At $0.005 per excess search, eleven thousand of them is $55 — five and
a half thousand pennies, for one question. This is exactly why the cached price
surface is not a performance optimisation: **it is the precondition for the
founder's own business model.** His instinct requires that architecture, and
without it the pricing he is describing loses money on every single query.

### The deals do not come, and they do not come with hustle

Negotiated and consolidator fares are **volume-gated**. Airlines discount to
distributors who move seats, and on day one we move zero. This is not a door
that opens with persistence or a good pitch — it opens with volume, and volume
is the thing we do not have.

So realistically we resell retail inventory through Duffel at retail prices.
**We are priced above the market, not below it, and that does not change for
years.** Any plan whose first move is "get the discounts everybody else gets"
should be struck out now rather than budgeted for.

### The competitor is not Expedia

*"Nobody can compete with that"* is the part to worry about, because the cost
structure is **not proprietary**. Any competent person with a Duffel key and
this same idea has the identical cost base six months from now.

What is actually defensible is the catchment arithmetic, the constraint memory
and the named segment — **never the cost base.** Building the pitch on being
cheap to run is building it on the one thing that can be copied in a weekend.

### And a penny off everybody is the wrong target anyway

It is the mass-market frame, and this is not a mass-market product. The honest
shape is **a real amount off a small, findable group**: five thousand frequent
travellers in multi-airport catchments at $40 a year is $200,000, and it
requires beating Expedia at precisely nothing. That is a business. *"A penny off
everybody"* requires a hundred million users to be one.

---

## The name — FlexFare has a specific problem

The founder's proposal, in his dictation: *"flex fair."* **FlexFare** is clear
and it says what the product does, which is more than most names manage. Two
objections, and the first is disqualifying.

- **"Flex fare" is already airline vocabulary, and it means the opposite
  thing.** Across the industry a *Flex* fare is the expensive, changeable,
  refundable class — Lufthansa Economy Flex, Virgin Atlantic Flex Fares, and the
  Lite / Classic / Flex fare families airlines sell at checkout. So the name
  tells a traveller *"we sell you the pricey refundable ticket"* when the whole
  product is about finding the cheap one. It is generic industry vocabulary,
  which also makes it hard to protect and easy for an airline to object to.
- **It centres the word FARE**, which is the one axis this product cannot win
  on. The fare is set by the airline and we are above the market on it. The
  product competes on the **total**, and the name should not point at the number
  we lose on.

The name wants to point at the *catchment*, the *drive*, or the *total* — the
thing being measured that nobody else measures. **CATCHMENT** remains the
working placeholder for that reason. Nothing is settled, and this is worth a
proper session rather than a paragraph.

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

**Travel is a handful of transactions a year.** There is no daily accretion, so
there is no compounding record, so there is no moat of that kind. This must be
faced rather than talked around: the thing that makes WROUGHT defensible is
mostly absent here.

**But the founder corrected the number, and the correction defines the
customer.** The first draft said two to four trips a year. His own figure is
*"6–7 times a year at least"* — and he is not the average traveller, he is the
target one. That distinction is the most useful thing to come out of this
assessment:

> **This is not a product for travellers. It is a product for FREQUENT
> travellers who live in a multi-airport catchment.**

That segment is far smaller and far better. It is the only group for whom the
landed-cost arithmetic is worth anything: one trip a year does not justify
learning a tool, and somebody with one reachable airport has no decision to
make. Six or seven trips against six reachable airports is a decision worth
money **every time**, and it is a population that can be described, found and
spoken to — Southern Ontario, the Detroit–Windsor corridor, Vancouver–Bellingham,
San Diego–Tijuana, anywhere a border or a cluster puts real fare spread inside a
three-hour drive.

It also fixes the subscription maths that the affiliate model could not carry.
Six or seven searches a year, each worth $100–300 in avoided cost, is
comfortably a paid product. Two searches a year is not.

The memory still accretes slowly — but each trip teaches it a real preference,
and by trip four it knows things a cold competitor cannot ask for without
sounding like a form.

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

**Run it BACKWARDS, on trips already taken.** This is the better version and it
only became available once the founder said he flies six or seven times a year:
he is not short of test cases, he has a year of them, and a trip already taken
has a **known actual price** to check the answer against. A hypothetical
December week can only ever be compared against another estimate.

1. List the last six trips actually taken, with what was paid and which airport
   was used.
2. Price each one again across all six airports on Google Flights, using the
   month calendar around the dates that were genuinely flexible.
3. Add the drive, the parking, the gas, the FX and the border for each.
4. For each trip, ask the only question that matters: **was there a better
   departure point, and by how much?**

Then read the gap — the average across all six, not the best one:

- **Under ~$100** — the product has no reason to exist. Google's answer is good
  enough, and the extra work is not worth paying for. **Stop here.** That is a
  successful evening, not a failed one.
- **$100–300** — real, but it is a feature, not a company. Possibly worth
  building for himself and a few hundred people in the same geography.
- **Over $300, repeatably, across several trips** — the wedge is genuine and
  worth a repo.

Six trips is the sample, and the **average** is the finding. One good answer is
salt and sleep — the same rule WROUGHT applies to a weigh-in, and the same
reason its charts carry a seven-day mean beside the daily line.

And note what a bad result actually means: if six real trips show no better
departure point, that is not a failed experiment. It is a year of the founder's
own travel proving he was already choosing correctly, learned in one evening
instead of one quarter.

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
category.** A handful of transactions a year does not compound the way a daily
log does. What memory exists is about constraints, not history. What replaces
the moat is **segment**: frequent travellers inside a multi-airport catchment,
who are the only people for whom this arithmetic is ever worth money.

**Do the evening test first.** Everything above is downstream of one number
nobody has measured yet.

---

*Sources consulted 2026-08-12: Duffel published pricing; Amadeus Self-Service
decommissioning notice (17 July 2026); Kiwi/Tequila partner access status;
Travelpayouts published commission rates; Google Flights multi-origin and
flexible-date documentation; coverage of the Expedia and Booking.com apps
inside ChatGPT.*
