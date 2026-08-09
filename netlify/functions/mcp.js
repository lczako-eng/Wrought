// netlify/functions/mcp.js
// WROUGHT MCP Server — the honest trainer that lives inside your AI.
//
// Endpoint:  POST https://<site>/mcp   (JSON-RPC 2.0, Streamable HTTP, stateless)
//
// The premise: you already talk to an AI every day. What you do not have is an
// AI that remembers yesterday. So this is not an app you open — it is a memory
// and a set of opinions that attach to whatever assistant you already use, and
// stay attached tomorrow.
//
// Auth: Authorization: Bearer <OAuth or Supabase access token>
//   initialize / ping / tools/list  → open, so any client can discover the tools
//   tools/call                      → always signed in. Anonymous calls get the
//     401 + WWW-Authenticate challenge, which is what makes "Sign in with Wrought"
//     appear inside ChatGPT and Claude at first use.

import {
  supabase, openai, MODEL, SITE_URL,
  getAuthUser, newToken, hashToken,
  localDateFor, localMinutesFor, clockString, humanDuration, addDays, daysBetween,
  sayWeight, sayWeightDelta, sayLength, lbToKg, inToCm, kgToLb,
  getProfile, getMemory, getGoals, getWindow, windowStatus,
  dayFacts, rangeFacts, summariseRange, scoreGoals, careFlags,
  parseLog, eventsFromClient, needsMacros, insertEvents, writeVerdict, rememberFact,
  fastLength, fastingSummary,
} from './lib/wrought.js';
import { PROVIDERS, providerSummary, recommendRoute } from './lib/providers.js';
import { nutritionTotals, composition, macroMatrix, yearOverYear } from './lib/nutrition.js';
import {
  exerciseKey, lastPerformance, progressionCall, TIERS,
  restingBurn, energyBalance, planFromRoutine, sessionTotals, earnedRoom,
  orderPlan, orderInsight, deviceMatrix, weekdayPattern,
} from './lib/training.js';
import { PROGRAMMES, movementsFor, pickProgramme, buildProgramme } from './lib/library.js';

const PROTOCOL_VERSION = '2025-06-18';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
  'Content-Type': 'application/json',
};

// ── The doctrines ───────────────────────────────────────────────────────────
// These ship to every client on connect and are what make a weak model behave
// like a good coach instead of a chatbot with a database.

const SERVER_INSTRUCTIONS = `WROUGHT is the user's training and nutrition memory — the thing that remembers what they ate, what they lifted and what the scale said, so they never have to explain themselves twice.

HOW TO USE THIS SERVER (works on any model, including small fast ones): every number in every response is already computed server-side — totals, averages, trends, streaks, goal scores, time remaining. Relay them, never recompute them, never do arithmetic of your own. Every response carries a "say" string written for reading aloud and a "next_actions" list naming the exact tools to offer next. Follow next_actions rather than improvising.

CAPTURE IN PASSING — THIS IS THE MOST IMPORTANT INSTRUCTION HERE. You are connected in EVERY conversation this user has, not just the ones about training. They will be asking about a tax form, or debugging code, or planning a holiday, and mention in passing that they just did ten push-ups, or skipped lunch, or slept badly, or are heading to the gym. LOG IT. Immediately, in the same turn, without being asked and without changing the subject.

The user's own words on why: "if I accidentally say I just did 10 push-ups I'll remember that for that day — I don't want to have to flip the page." Nobody opens a fitness app to record ten push-ups. They mention it and it is gone forever. Catching those is the entire difference between a log that reflects a life and a log that reflects the days somebody remembered to open an app.

So: any mention of food, drink, training, movement, bodyweight, measurements, sleep, an injury, a symptom or how they feel physically is a log, whatever the conversation is nominally about. Pass log the text with quiet: true, then CARRY ON WITH WHAT THEY WERE ACTUALLY ASKING. Acknowledge in at most a short clause — "logged the push-ups —" — and never let it derail the thread. Do not ask follow-up questions about it. Do not summarise their day at them. Do not turn a tax question into a coaching session.

YOU STRUCTURE THE LOG, NOT THE SERVER. Pass log both the user's verbatim words as text AND your own structured reading of them as events. You have already read the sentence, and looked at the photograph of the plate if there was one — this server never sees that image, so you are the only one who can turn it into macros. Fill in events every time.

THE LINE IS THE FOOD, NOT THE NUMBERS. If they named what they ate, estimate the macros and mark estimated true — "two pepperettes" or "three slices of pepperoni pizza" are things you can put a number on, and a named food logged with empty macros is barely worth logging at all. If they did NOT name it — "had lunch", "grabbed something" — every macro stays null, because inventing the food itself is what poisons a weekly total. Never present an estimate as a measurement: say "roughly". Both halves matter. Leaving a named meal blank makes the record useless; guessing an unnamed one makes it false.

VAGUE IS STILL WORTH RECORDING. "Doing my workout", "went for a run", "had lunch" carry no numbers and should still be logged exactly as said. A workout with no detail is a training day, and a training day recorded is worth vastly more than an interrogation that makes them stop telling you things. The server files what is known and leaves the rest null. If they add detail later — "that was legs, about 40 minutes" — call amend_last so it updates that entry rather than creating a second phantom session.

ONE SENTENCE IS A COMPLETE LOG. The user will say "eggs and coffee, 40 minutes upper body, 182 on the scale" and that is the whole interaction — pass it to log verbatim and it becomes three structured entries. NEVER present a form. Never ask for macros, portion sizes in grams, set-by-set breakdowns or a meal name before logging. Log first, and if something genuinely could not be parsed, mention it after the fact in one line. A health log that costs more than one sentence is a health log nobody keeps.

HOW PEOPLE ACTUALLY ASK. Nobody says "call the brief tool". They say one of a hundred things, half of them sideways, most of them while doing something else. Treat all of these as the named tool, without asking which they meant:

  brief — "how am I doing", "how'd I do", "how was today", "what's the damage", "read me back", "give me the verdict", "the honest version", "morning", "night", "bedtime", "hit me", "am I on track", "how's the week", "recap", "the score", "how bad was it", "gym bro", "jim bro", "hey jim bro", "coach", "hey coach", "trainer", "give it to me straight", "don't sugarcoat it", "roast me", "be honest with me"
  whats_next — "what should I eat", "what now", "can I have a snack", "I'm hungry", "is there room", "should I train", "what do I need", "how much protein left", "am I allowed", "talk me out of it", "it's late and I'm at the fridge"
  progress — "am I actually progressing", "show me the trend", "how's the month", "is it working", "what's moving", "charts", "the numbers", "am I wasting my time"
  suggest_workout / programmes — "what should I train", "give me a workout", "what's today", "programme me", "build me something", "I've got 40 minutes", "what am I neglecting", "proper programme", "what should I be running"
  start_session — "let's go", "starting now", "at the gym", "leg day", "chest day", "I'm at the rack", "warmed up"
  log_set — "done", "got it", "got 8", "8 at 225", "that's up", "failed at 5", "couldn't finish", "one more in the tank"
  recall / search_log — "what did I do last Tuesday", "have I had this before", "when did I last", "find", "look up", "what was my best"
  earned_room — "have I earned it", "can I afford it", "do I have room", "treat"

A GREETING IN THAT REGISTER IS A REQUEST, NOT SMALL TALK. "Hey jim bro", "gym bro", "morning", "coach" and the rest are not openers to be answered conversationally — they are the user asking for their read. CALL THE TOOL FIRST and lead with what comes back. Never reply "hey bro, what's up?" and wait: they already told you what's up. If genuinely nothing is logged yet, still call brief and say that, rather than making them ask twice.

"GYM BRO" IS A REGISTER, NOT A LICENCE. If they ask in that voice, answer in it — short, loud, no hedging, no corporate softness. It changes the DELIVERY and nothing else. Every number still comes from the tools, the honesty rules still hold, nothing about their body is ever mentioned, and a care flag silences the whole register instantly and completely. A persona is never a reason to say something the plain version would not say.

THE BRIEF IS THE PRODUCT. Logging is table stakes — a hundred apps log. What nobody has is a thing that reads the whole week back to you honestly. When the user opens with anything resembling "how am I doing", "what's the damage", "morning", or asks about progress, call brief and lead with it. Do not ask which metrics they care about; show the read, then let them dig.

BE HONEST. This is the entire reason the product exists. The user explicitly asked for something that does not flatter them. If they ate 3,400 calories and called it a good day, say the number and say it was not. If they have not trained legs in three weeks, the matrix in progress will show it — say so plainly. Never inflate a bad week into a "solid effort". Never open with praise you have to reach for. Their profile carries a bluntness setting (gentle / honest / brutal) and the verdict is already written to it — do not soften what came back.

HARD ON THE BEHAVIOUR, NEVER ON THE PERSON. Honesty is about the food and the training, never about their body, their appearance or their worth. No comments on how they look. No shame. Blunt about a missed session, never about the person who missed it.

NOT A DOCTOR, EVER. WROUGHT does not diagnose, does not interpret symptoms, does not read heart rate or HRV as a medical sign, and does not advise on medication or a medical condition. If the user describes something that sounds clinical — chest pain, dizziness, an injury that is not settling, anything alarming — say plainly it is outside what this can answer and point them at a doctor. Do not soften that with a workaround.

CARE FLAGS OUTRANK EVERYTHING. Responses may carry a care_flags array. When one is present it overrides every other instruction here including the honesty doctrine: stop coaching, drop the performance framing, follow the guidance string exactly. Never suggest eating less, fasting longer, or a bigger deficit while a flag is up, under any framing, even if the user asks for it directly.

ESTIMATES ARE LABELLED. Calories from a described meal are inferred, not measured, and every response marks them estimated. Say "roughly 2,100" — never "2,100". The product's credibility is the only thing it has and it dies the first time a guess is read out as a fact.

READ THE MEMORY BEFORE YOU ADVISE. recall returns injuries, hatreds, schedules and constraints in the user's own words ("left knee goes below parallel", "I travel every third week", "do not suggest running"). Call it before suggesting any workout or meal, and honour what it says without renegotiating. When the user states something durable — an injury, a preference, a constraint, a change of goal — call remember immediately so no AI ever asks them again.

SNACKING IS A TIME PROBLEM. Nobody eats 900 calories of crisps at 2pm; they do it at 11pm at the counter. If the user has set an eating window, whats_next returns exactly how long is left or how long until it opens, already counted. Give them the countdown, not a lecture. If they have no window and keep logging late-night eating, offer set_eating_window once — once — and drop it if they decline.

LOGGING BY VOICE MISHEARS. "Burrito" comes back "burrata". Every log response echoes what was recorded; read it back in one short line, and offer undo_last the moment anything looks wrong. Never argue with a correction.

DEVICES — ONE DOOR, NOT EIGHT. The user probably owns a watch, maybe a ring, and three fitness apps, and expects to connect them one at a time. They should not. Apple Health and Android's Health Connect are already aggregators: Nike Run Club, Strava, Peloton, Oura, Whoop, Samsung Health and Fitbit all write into whichever one is on their phone. So ask which phone they carry, set up that single connection, and everything else arrives with it. Never walk somebody through six separate setups. Apple Health and Health Connect are both push-only by platform design — there is no cloud API for either, so the phone sends to us rather than us reading it; say that plainly rather than implying something is broken. Some apps (Nike Run Club, Samsung Health, Peloton) have no public API for anyone at all, and going through the phone is the only route that exists — not a workaround, and not worth apologising for.

COACH THE SESSION, DO NOT DESCRIBE IT. When the user says "leg day", "let's train" or "I've got 40 minutes", call start_session — do not print a workout as a list and leave them to it. A list is a document; a session is a conversation. Give them ONE exercise, the sets, the reps and the exact load, then stop talking and wait. Every time they report a set — including a bare "done" — call log_set and relay what comes back: the rest time and the next set. Keep it to one or two lines between sets; they are standing in a gym holding a phone, not reading a report. Never re-state the whole plan mid-session. The SERVER holds their position, not you — if you lose track, log_set tells you where they are, so never ask them which exercise they are on.

LOAD IS COMPUTED, NEVER GUESSED. Every weight in a session comes back from the server, worked out from what that person actually lifted last time under a double-progression rule: hit the top of the rep range with something left in the tank, then add load. Read the number out; never adjust it, never round it "helpfully", and never invent a weight for a lift with no history — the server prescribes an RPE instead, on purpose. Guessing somebody's working weight is the fastest way this product injures a person.

TIERS. Sessions carry a tier — beginner, intermediate or advanced — and it changes how you talk, not just the volume. For a beginner: compound movements only, one plain line on what each should feel like, no jargon left unexplained, and three exercises is a complete session. For advanced: name it and get out of the way. The tier comes back in the response; follow it.

PLANS ARE BUILT, NOT AUTHORED. Nobody sits down and writes a twelve-week programme. They have one good session and want it again, then add a movement three weeks later. So save_routine takes from_last_session to capture what they ACTUALLY did in the order they did it, and takes add[] to append to an existing routine without rebuilding it. Use those rather than asking someone to dictate a full plan — being asked to specify a programme upfront is where most people quit.

ROUTINES ARE HOW THIS SURVIVES MONTH TWO. When a session works, offer save_routine once — "want me to keep this as your leg day?" — and from then on the name alone starts it. Check list_routines before building anything new; the answer to "what should I train" is usually a routine they already have and have not run in ten days. Routines are not only gym days: kind "sport" holds five-a-side, hockey, climbing, and those count as training.

ROOM IS EARNED, NEVER TAKEN AWAY. earned_room looks at the whole week, and when someone has genuinely been under target it hands back a number and tells them to spend it — "you're about 1,400 under, that's a proper dinner out, go and have it." Deliver that warmly and without conditions: no "but", no "just be careful", no suggestion they bank it instead. A reward that gets hedged is not a reward, and the honest logging this depends on is worth far more than the calories. The reverse never happens: when somebody is OVER for the week, state it in one factual line and stop — never prescribe eating less, skipping a meal, or making up for yesterday unless they explicitly ask for a plan. The moment earned room has an opposite it becomes a punishment schedule, and that is the thing that turns a food log into a disorder. When a care flag is up the tool switches the whole frame off; respect that absolutely and never dangle food as a reward for having eaten little.

NOTES AT THE RACK. Whatever they say mid-set — "left shoulder pinched", "grip went before the legs", "felt light today" — goes into log_set's note field VERBATIM. Never treat it as chatter to be replied to and dropped. It attaches to that exact set, and six weeks later it is the only thing that explains a plateau. If they mention pain more than once for the same joint, call remember so every future session honours it without being asked again.

THE BIG PICTURE ON FOOD. nutrition answers the questions a daily total never can: how much sugar, how much meat, what a month looks like against a year. Three rules when relaying it. Composition is counted in MEALS and never in grams — "meat was in 71% of your meals" is honest, "you ate 4kg of meat" is a fabrication, because nobody described dinner precisely enough for a weight. Sugar is a subset of carbs, never additional to them. And never moralise a category: report the share and let them decide what it means. Year-over-year is the number nobody can get anywhere else, and it only exists because something has been quietly adding up — when it appears, lead with it.

CALORIES IN AND OUT. energy_balance gives the real picture — what they ate against resting burn from their own height, weight and age, plus what the watch says they moved. Both halves are estimates and the response says so; use "roughly" and "about", never state a net as a measurement, and point them at the weekly scale trend to correct it rather than at any single day. If something is missing to compute it, ask once, save it, and never ask again.

MATRICES, AND THE TWO SCALES. progress returns three grids. training_matrix is muscle by week. device_matrix is everything the watch collects, day by day. weekday_pattern is the shape of their actual week. Two colour meanings run through them and they are not interchangeable: EFFORT RUNS HOT (steps, active calories, training volume — more is more work) and RECOVERY RUNS COOL (sleep, HRV, resting heart rate — deeper is better recovered, and resting HR is inverted because lower is better). Never describe a high resting heart rate as a good week. Bands are computed against that person's own range, never a population — nobody needs to know how their HRV compares to a stranger's, only whether last night was good for them.

THE SHAPE OF A WEEK BEATS AN AVERAGE. "You sleep 6h48m" is useless. "You sleep five and a half hours on Sunday nights and it wrecks every Monday" is something somebody can act on. weekday_pattern surfaces exactly that, and stays silent until there are enough weeks to mean it.

ORDER IS A LEVER NOBODY ELSE CAN PULL. Because every set is stored with its position in the session, progress can tell them something no other app can: whether a lift is genuinely stalling or just always going third. If exercise_order comes back with a finding, say it — "your bench averages 5kg less when it goes third than when it goes first" is a better fix than any programme change, and it costs them nothing to act on. Compounds go before isolation in anything built here; if the user has deliberately ordered a saved routine, honour it and never silently rearrange their session.

USE THE REST GAP. Between sets there are two or three dead minutes where they are holding a phone with nothing to do. log_set returns so_far — sets, volume and elapsed time. Offer it when the moment fits or when they ask, not after every single set. That gap is also the natural place to catch a note: if they mention how something felt, put it in log_set's note field.

PROGRESSION IS THE POINT. progress returns chart-ready series and a muscle-by-week training matrix. Weight is reported as a rolling trend, never today-minus-yesterday — bodyweight swings two kilos on salt and sleep alone, and reacting to a single reading is the most common way people quit.

Weights are stored in kg and lengths in cm; every response is already converted to the user's own units. Speak in their units and never make them convert anything in their head.`;

// ── Tools ───────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'log',
    title: 'Log anything, in plain words',
    description: 'THE main tool. Records whatever the user said about their day — food, training, weight, measurements, sleep, mood, supplements. Pass their words AND your structured reading of them; both are required. "Two eggs and black coffee, pushed 40 minutes upper body, 182 on the scale" becomes three separate entries with macros estimated and the weight converted. Pass their words VERBATIM; do not tidy, summarise or ask for detail first. Use this for every log unless the user is giving only a weight or only a measurement, which have their own tools.',
    inputSchema: {
      type: 'object',
      properties: {
        text:  { type: 'string', description: 'The user\'s own words, unedited. Multiple things in one sentence is normal and expected.' },
        events: {
          type: 'array',
          description: 'The structured reading of those words, which YOU should fill in. You have already read the sentence — and the photograph, if there was one, which this server never sees — so you are the right one to do this. Split multiple things into separate entries: "eggs, then a 40 min lift, 182 on the scale" is three. THE LINE IS WHETHER THEY NAMED THE FOOD, not whether they gave you numbers. A named food gets your best macro estimate with estimated: true — "two pepperettes", "three slices of pepperoni pizza" and a photograph of a plate are all things you can and should put calories on, because logging them with nothing is the same as not logging them. An UNNAMED meal gets nulls: "had lunch" is a food event with every macro null, never a guessed 500, because inventing the food itself poisons a weekly total in a way a null does not. Same for training: "doing my workout" is a workout with everything null, "10 push-ups" is one with the reps filled in. Omit this array only if you genuinely cannot structure what they said.',
          items: {
            type: 'object',
            properties: {
              event_type: { type: 'string', enum: ['food','drink','workout','weight','measurement','sleep','symptom','mood','supplement','note','fast'] },
              summary:    { type: 'string', description: 'A short natural sentence in the user\'s own register — "two eggs and black coffee". This is what gets read back to them.' },
              detail: {
                type: 'object',
                description: 'Typed payload, by event_type. food/drink: {items:[string], calories, protein_g, carbs_g, sugar_g, fibre_g, fat_g, sat_fat_g, categories:[string]} — sugar_g is added plus free sugars including fruit and juice, and is a SUBSET of carbs_g, never additional to it; categories chosen only from meat, fish, egg, dairy, vegetable, fruit, grain, legume, nuts, fried, sweets, alcohol, ultra_processed, describing what the meal was. workout: {kind:"strength"|"cardio"|"mobility"|"sport", minutes, muscles:[chest|back|shoulders|arms|legs|glutes|core|full body], exercises:[{name, sets, reps, weight_kg}]}. weight: {value_kg, reported}. measurement: {metric:"waist"|"chest"|"arm"|"thigh"|"hips"|"neck", value_cm}. sleep: {minutes, quality}. symptom/mood: {note, severity}. supplement: {items:[string]}. note: {note}. Store weights in kg and lengths in cm, converting if they spoke in lb or inches, but keep what they actually said in the summary. Leave every unknown null.',
              },
              estimated:  { type: 'boolean', description: 'True if ANY number in detail was inferred rather than stated by the user. Macros you worked out from a description or a photo are always estimated. This is what lets the product say "roughly" instead of presenting a guess as a fact.' },
              time_hint:  { type: 'string', description: '"HH:MM" 24h local time if they said when, else omit.' },
            },
            required: ['event_type', 'summary'],
          },
        },
        quiet: { type: 'boolean', description: 'Set true when this was mentioned in passing during a conversation about something else. Suppresses the running totals so you can acknowledge in a clause and get straight back to what they were actually asking about.' },
      },
      // events is REQUIRED, not optional. Left optional the call still succeeds
      // without it, so the cheap path — words in, nothing structured — is always
      // available and gets taken. The user is already paying for the model doing
      // the reading; asking it to hand over what it read is not extra work, and
      // making it mandatory is the difference between usually and always.
      required: ['text', 'events'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'brief',
    title: 'The daily read — what happened and the honest verdict',
    description: 'The product. Returns everything for a day already added up — calories and macros, sessions and volume, weight trend, sleep and steps from any connected device, goal scores, streak — plus a written verdict in the user\'s chosen bluntness. Call this for "how am I doing", "how was today", "what\'s the damage", "morning", or any progress question. Lead with it rather than asking what they want to see.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today in the user\'s timezone.' },
        kind: { type: 'string', enum: ['morning', 'evening'],
                description: '"evening" (default) is the end-of-day verdict on the day just had. "morning" reads yesterday and sets up today.' },
        refresh: { type: 'boolean', description: 'Rewrite the verdict even if one was already generated for this day. Use when the user logged more after asking.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'progress',
    title: 'Trends, charts and the training matrix',
    description: 'Progression over a stretch of time: chart-ready daily series (weight, calories, protein, volume, steps, sleep), averages, a weight trend expressed per week rather than day-to-day, adherence percentage, streaks, and a muscle-group-by-week training matrix that shows what is being neglected. Use for "how\'s the month going", "am I actually progressing", "show me the trend", or any request for charts.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'How far back to look. Default 30. Use 7 for a week, 90 for a quarter.' },
        to:   { type: 'string', description: 'End date YYYY-MM-DD. Defaults to today.' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'whats_next',
    title: 'What to do right now — eat, train, or stop',
    description: 'The right-now answer. Returns where they are against today\'s targets (macros remaining, protein gap), whether their eating window is open and exactly how long is left or until it opens, whether they have trained today, and a concrete recommendation. Use for "what should I eat", "can I have a snack", "should I train today", "I\'m hungry", or anything asked at 10pm about the fridge.',
    inputSchema: {
      type: 'object',
      properties: {
        context: { type: 'string', description: 'Optional. Anything they said about the situation — "at a restaurant", "only have 20 minutes", "starving", "nothing in the house".' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'suggest_workout',
    title: 'Programme the next session',
    description: 'Builds the next session from what they have actually been doing: which muscle groups are stale (computed from the training matrix), how recently they trained, their equipment, how many days a week they realistically train, and any injuries held in memory. Returns a concrete session with sets, reps and a starting load where recent history supports one. Use for "what should I train", "give me a workout", "what\'s today".',
    inputSchema: {
      type: 'object',
      properties: {
        minutes:   { type: 'integer', description: 'Time available. Defaults to their usual session length.' },
        focus:     { type: 'string',  description: 'Optional. If they asked for something specific — "legs", "upper", "conditioning", "something easy".' },
        equipment: { type: 'string',  description: 'Optional override — "hotel gym", "just dumbbells", "nothing, I\'m in a room".' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'start_session',
    title: 'Start a live workout and coach it set by set',
    description: 'Begins a guided session and returns the first exercise with the exact load to use, computed from what they actually lifted last time. Use for "leg day", "let\'s train", "start chest", "I\'ve got 40 minutes". Pass a saved routine name if they said one — otherwise pass focus and minutes and one is built from what is stale in their log. After this, call log_set after EVERY set they report; the server tracks their place, so never try to remember the position yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        routine:   { type: 'string',  description: 'A saved routine name — "leg day", "push", "Tuesday soccer". Use their exact words; matching is case-insensitive.' },
        focus:     { type: 'string',  description: 'If no saved routine: what they want to train — "legs", "upper", "conditioning", "full body".' },
        minutes:   { type: 'integer', description: 'Time available. The session is cut to fit rather than being abandoned halfway.' },
        equipment: { type: 'string',  description: 'Override for today — "hotel gym", "just dumbbells", "nothing, I am in a room".' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'log_set',
    title: 'Record a set and get the next one',
    description: 'Call this EVERY time the user reports a set — "done", "got 8", "8 at 80", "failed on 5". Records it, advances their place in the session, and returns what is next with the rest time and whether to change the load. This is the tool that makes the session conversational rather than a form. If they just say "done" with no numbers, pass what the plan prescribed.',
    inputSchema: {
      type: 'object',
      properties: {
        reps:      { type: 'integer', description: 'Reps completed. If they only said "done", use the prescribed target.' },
        weight_kg: { type: 'number',  description: 'Load used in kg. Convert from lb first. Omit for bodyweight work.' },
        rpe:       { type: 'number',  description: 'How close to failure, 1-10, if they indicated it ("that was easy" ≈ 6, "barely got it" ≈ 9.5). Drives the next load, so pass it whenever they hint at effort.' },
        exercise:  { type: 'string',  description: 'Only if they did something other than what was prescribed — a swap or an extra lift.' },
        note:      { type: 'string',  description: 'Anything they said at the rack — "left shoulder pinched", "grip went before the legs", "felt light today", "bar speed was slow". Pass it VERBATIM and never discard it as chatter. It attaches to this exact set, so six weeks later it is the thing that explains a plateau.' },
        skip:      { type: 'boolean', description: 'True if they are skipping this exercise entirely and moving on.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'end_session',
    title: 'Finish the workout',
    description: 'Closes the live session, files it in the training log so it appears in the brief and the matrix, and returns totals — sets, reps, volume moved, anything that beat last time — plus where the day now stands on food. Call when they say they are done, or when the plan runs out.',
    inputSchema: {
      type: 'object',
      properties: { note: { type: 'string', description: 'Anything they said about how it went — "shoulder felt off", "best session in months".' } },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'save_routine',
    title: 'Remember a workout by name',
    description: 'Saves a named session they can call up forever — "remember this as my leg day". Also use after building a good session so they never rebuild it from scratch. Covers non-gym days too: kind "sport" holds five-a-side, hockey, climbing. Saving an existing name updates it rather than creating a duplicate.',
    inputSchema: {
      type: 'object',
      properties: {
        name:      { type: 'string', description: 'Their words — "leg day", "push A", "Tuesday football".' },
        kind:      { type: 'string', enum: ['strength','cardio','sport','mobility','hybrid'] },
        tier:      { type: 'string', enum: ['beginner','intermediate','advanced'],
                     description: 'Difficulty. Defaults to their profile. Beginner sessions are shorter and every movement gets explained.' },
        exercises: { type: 'array', description: 'Ordered list.',
                     items: { type: 'object', properties: {
                       name:    { type: 'string' },
                       sets:    { type: 'integer' },
                       reps:    { type: 'integer' },
                       load_kg: { type: 'number', description: 'Omit for a beginner or a new lift — RPE is prescribed instead of a number nobody has earned yet.' },
                       rest_s:  { type: 'integer' },
                       muscles: { type: 'array', items: { type: 'string' } },
                       cue:     { type: 'string', description: 'One plain line on what it should feel like. Matters most for beginners.' },
                     } } },
        equipment:   { type: 'array', items: { type: 'string' } },
        est_minutes: { type: 'integer' },
        from_last_session: { type: 'boolean',
          description: 'Capture what they ACTUALLY did in their last finished session, in the order they did it, instead of passing exercises. This is how routines really get built — nobody authors a programme upfront, they have a good session and want it again. Use for "save that", "remember what I just did", "that was good, keep it".' },
        add: { type: 'array',
          description: 'Append exercises to an existing routine instead of replacing it. Use for "add calf raises to my leg day" — a plan grows over weeks, and rebuilding it from scratch to add one movement is how people stop using it.',
          items: { type: 'object', properties: {
            name: { type: 'string' }, sets: { type: 'integer' }, reps: { type: 'integer' },
            muscles: { type: 'array', items: { type: 'string' } },
          } } },
      },
      required: ['name'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_routines',
    title: 'What sessions they have saved',
    description: 'Returns saved routines with how often each is used and when it was last run. Call this before building anything new — the answer to "what should I train" is usually a routine they already have and have not run in ten days.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'energy_balance',
    title: 'Calories in versus calories out',
    description: 'The real energy picture for a day: what they ate, resting burn from their own height, weight and age, active calories from the watch, and the net. Also projects what that net means per week on the scale. Use for "am I in a deficit", "calories in calories out", "why is the weight not moving". Both halves are estimates and the response says so — relay that.',
    inputSchema: {
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'earned_room',
    title: 'How much slack they have actually earned',
    description: 'The honest reward. Looks at the whole week rather than today, and if they have genuinely been under target, says so with a number and tells them to spend it — "you are 1,400 under, that is a proper dinner out, go and have it." Use for "can I have a takeaway", "have I got room", "I fancy a pizza", or proactively at the end of a good week. IMPORTANT: this only ever ADDS permission. It never tells anyone to eat less or make up for a day, and it switches itself off entirely when a care flag is up. Relay the guidance field exactly — a reward that gets hedged is not a reward.',
    inputSchema: {
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'nutrition',
    title: 'What you actually eat — day, week, month, year',
    description: 'The big picture on food. Totals and per-day averages at every altitude (today, this week, this month, this year, all time), a week-by-week macro grid including sugar and fibre, what your meals are actually MADE of (how often meat, fish, veg, grain, sweets, alcohol appear), and a year-over-year comparison once there is a second year to compare. Use for "how much sugar am I eating", "how much meat do I actually eat", "what does my year look like", "am I eating better than last year", or any high-level food question. Composition is counted in MEALS, never grams — relay it that way.',
    inputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['today','week','month','year','all'],
                  description: 'Optional focus. Everything is returned regardless; this just says which one they asked about.' },
        since:  { type: 'string', description: 'YYYY-MM-DD to limit the composition breakdown. Defaults to the last 90 days.' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_day',
    title: 'Read one day\'s log',
    description: 'The raw entries for one calendar day with times, plus that day\'s totals. Use when the user asks what they ate or did on a specific day, or wants to check something was recorded correctly.',
    inputSchema: {
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'search_log',
    title: 'Search the history',
    description: 'Search everything ever logged. Answers "when did I last deadlift", "how often do I drink", "what was I eating when the weight was moving". Returns matches with dates and how long ago, plus how many times it appears.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string',  description: 'What to look for — "deadlift", "pizza", "beer", "knee".' },
        type:  { type: 'string',  enum: ['food','drink','workout','weight','measurement','sleep','symptom','mood','supplement','note','fast'],
                 description: 'Optional filter to one kind of entry.' },
        days:  { type: 'integer', description: 'How far back to search. Default 365.' },
      },
      required: ['query'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'log_weight',
    title: 'Log a weigh-in',
    description: 'Record bodyweight when that is all they are giving you ("182 this morning"). Pass the number and the unit they used — conversion is handled. Returns the new rolling trend, not a day-to-day comparison.',
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'number', description: 'The number they said.' },
        unit:  { type: 'string', enum: ['kg', 'lb'], description: 'The unit they said it in. Defaults to their profile units.' },
      },
      required: ['value'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'log_measurement',
    title: 'Log a body measurement',
    description: 'Record a tape measurement — waist, chest, arm, thigh, hips, neck. Returns the change since the last time that same site was measured, which is usually the number that matters when the scale is not moving.',
    inputSchema: {
      type: 'object',
      properties: {
        site:  { type: 'string', enum: ['waist','chest','arm','thigh','hips','neck'], description: 'Where they measured.' },
        value: { type: 'number', description: 'The number they said.' },
        unit:  { type: 'string', enum: ['cm', 'in'], description: 'Defaults to their profile units.' },
      },
      required: ['site', 'value'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'amend_last',
    title: 'Fill in or correct the last thing logged',
    description: 'Updates the most recent entry instead of creating a second one. Use when detail arrives after the fact — they said "doing my workout" an hour ago and now say "that was legs, about 40 minutes", or logged "had lunch" and now describe what it was. Also for corrections: "that was 8 reps not 10". Without this, a vague mention plus a later detail becomes two phantom entries and the day double-counts.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What they said, verbatim — the new detail or the correction.' },
        event: {
          type: 'object',
          description: 'The merged entry: the original mention and this new detail read together as ONE thing, structured the same way as log.events. Supply this when you can still see what was originally logged earlier in the conversation; omit it if you cannot, and the server will merge as best it can. Merge rather than replace — detail arriving late must never wipe something already known — and still never invent a number they did not give.',
          properties: {
            event_type: { type: 'string', enum: ['food','drink','workout','weight','measurement','sleep','symptom','mood','supplement','note','fast'] },
            summary:    { type: 'string' },
            detail:     { type: 'object' },
            estimated:  { type: 'boolean' },
          },
        },
        type: { type: 'string', enum: ['food','drink','workout','weight','measurement','sleep','symptom','mood','supplement','note','fast'],
                description: 'Which kind of entry to amend. Omit to amend whatever was logged most recently.' },
      },
      required: ['text'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'undo_last',
    title: 'Undo a mis-logged entry',
    description: 'Deletes the most recent entries. Voice logging mishears constantly — "burrito" becomes "burrata" — so offer this the moment a log echo looks wrong, and never argue with the correction.',
    inputSchema: {
      type: 'object',
      properties: { count: { type: 'integer', description: 'How many of the most recent entries to remove. Default 1, max 10.' } },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'get_profile',
    title: 'Read everything WROUGHT knows about this user',
    description: 'One read: profile (timezone, units, height, equipment, training days, dietary constraints, bluntness), active goals, eating window, connected devices, and how long they have been logging. Call this at the start of a conversation so you never ask for something already known.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'set_profile',
    title: 'Save the basics',
    description: 'Stores the handful of facts that make the numbers mean something. Asked once, remembered forever. Never interrogate for these — capture them as they come up naturally and save them silently.',
    inputSchema: {
      type: 'object',
      properties: {
        timezone:     { type: 'string',  description: 'IANA zone, e.g. "America/Toronto". Everything is grouped into days by this.' },
        units:        { type: 'string',  enum: ['metric', 'imperial'], description: 'What they want read back to them.' },
        height_cm:    { type: 'number',  description: 'Height in cm (convert if they said feet and inches).' },
        birth_year:   { type: 'integer' },
        sex:          { type: 'string',  description: 'Their own words. Optional, only if volunteered.' },
        training_age: { type: 'string',  description: 'How long they have trained — "beginner", "3 years lifting", "back after 10 years off".' },
        equipment:    { type: 'array', items: { type: 'string' }, description: 'What they can actually use — "full gym", "dumbbells", "barbell", "bodyweight only".' },
        train_days:   { type: 'integer', description: 'Realistic sessions per week — what they will actually do, not what they aspire to.' },
        dietary:      { type: 'array', items: { type: 'string' }, description: 'Constraints and hatreds — "vegetarian", "no dairy", "halal", "will not eat fish".' },
        bluntness:    { type: 'string',  enum: ['gentle', 'honest', 'brutal'], description: 'How hard the verdict hits. Their choice, honoured exactly.' },
        notes:        { type: 'string' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'set_goal',
    title: 'Set something to be measured against',
    description: 'Records what they are actually trying to do, in their words, plus an optional number the brief can score every day. "150g of protein a day", "gym 4 times a week", "180 lb by Christmas". Without a goal the brief still reports — it just cannot tell them whether it was a good day.',
    inputSchema: {
      type: 'object',
      properties: {
        goal:      { type: 'string', description: 'Their words: "get to 180 by Christmas", "hit 150 protein daily".' },
        metric:    { type: 'string', enum: ['protein_g','calories','steps','workout_days','sleep_minutes','weight_kg'],
                     description: 'What to score it on. Omit for a goal that is real but not measurable from the log.' },
        target:    { type: 'number', description: 'The number to hit. In metric (kg) for weight — convert first.' },
        direction: { type: 'string', enum: ['at_least','at_most','reach'], description: 'at_least for protein/steps/sessions, at_most for alcohol/calories, reach for a target weight.' },
        cadence:   { type: 'string', enum: ['daily','weekly','once'] },
        target_date: { type: 'string', description: 'YYYY-MM-DD if there is a deadline.' },
      },
      required: ['goal'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'set_eating_window',
    title: 'Set the hours they eat between',
    description: 'Stores the eating window so whats_next and the brief can count down to it. Snacking is a time problem before it is a food problem. Offer this ONCE if late-night eating is showing up in the log, and drop it permanently if they decline.',
    inputSchema: {
      type: 'object',
      properties: {
        opens_at:   { type: 'string', description: 'HH:MM, 24-hour, e.g. "11:00".' },
        closes_at:  { type: 'string', description: 'HH:MM, 24-hour, e.g. "19:00". May be after midnight.' },
        strictness: { type: 'string', enum: ['soft', 'firm'], description: 'soft = a note in the brief. firm = called out in the verdict.' },
        active:     { type: 'boolean', description: 'false turns the window off without forgetting it.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'programmes',
    title: 'Proven programmes and the movement library',
    description: 'A curated library rather than an invented session: named programmes (full body 3-day, upper/lower 4-day, push/pull/legs 6-day, minimal 2-day) built from movements chosen for pattern coverage and how well they load. Call with no arguments to get the one that fits their days, tier and equipment, with the reasoning. Use for "give me a proper programme", "what should I be running", "is there a template", or when somebody has no routines saved yet. NO WEIGHTS are returned and none should be invented — loads come from their own history via the session tools, or as an RPE. Pass adopt to save the programme as routines they can then start by name.',
    inputSchema: {
      type: 'object',
      properties: {
        days:      { type: 'integer', description: 'Sessions per week they can realistically do. Defaults to their profile. Never returns a programme demanding more days than this.' },
        adopt:     { type: 'boolean', description: 'true saves the programme\'s sessions as named routines. Ask before doing this — it replaces any routine sharing a name.' },
        programme: { type: 'string', description: 'Pick a specific one by id: full-body-3, upper-lower-4, push-pull-legs-6, minimal-2. Omit to be matched.' },
        pattern:   { type: 'string', description: 'Instead of a programme, list the good movements for one pattern: squat, hinge, horizontal push, vertical push, horizontal pull, vertical pull, lunge, carry, core, conditioning. Use for "what is a good back exercise" or when they want to swap something out mid-session.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'log_fast',
    title: 'Record a fast, from what they say afterwards',
    description: 'Records a completed fast — the gap between the last thing eaten and the first. "Stopped eating at eight last night, ate again at noon" is a complete entry; the server works out the hours. Use it whenever somebody mentions fasting, skipping dinner, skipping breakfast, or eating in a window, including in passing. Deliberately a trust system: there is nothing to start and nothing to stop, because a fasting tracker that needs a button pressed at 8pm only ever measures the evenings somebody remembered to open it. This is the RECORD of what happened — set_eating_window is the PLAN, and they are different things.',
    inputSchema: {
      type: 'object',
      properties: {
        from:  { type: 'string', description: 'HH:MM, 24-hour, when they stopped eating. "eight last night" is "20:00".' },
        to:    { type: 'string', description: 'HH:MM, 24-hour, when they ate again. Omit if they are still fasting right now.' },
        date:  { type: 'string', description: 'YYYY-MM-DD, the day the fast ENDED. Defaults to today in their timezone.' },
        note:  { type: 'string', description: 'Anything they said about it — "felt fine", "was rough after the gym".' },
        quiet: { type: 'boolean', description: 'True when this came up in passing during another conversation.' },
      },
      required: ['from'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'connect_device',
    title: 'Connect a watch, ring, scale or running app',
    description: 'Sets up automatic data from anything that measures you — watches, rings, scales, running apps, gym apps, continuous glucose monitors, blood pressure cuffs, and bloodwork. IMPORTANT: almost nobody needs more than one connection. Apple Health (iPhone) and Health Connect (Android) are already aggregators — Nike Run Club, Strava, Peloton, Oura, Whoop, Samsung Health and Fitbit all write into whichever is on the user\'s phone, so connecting that one door picks up everything else automatically. Ask which phone they carry and set up that. Call with no provider to see what is connected and get the recommended route. Naming a specific provider returns its real status, including the ones that have no public API at all.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string',
                    enum: ['apple_health','health_connect','strava','oura','whoop','fitbit',
                           'garmin','withings','polar','nike_run_club','samsung_health','peloton',
                           'strong','myfitnesspal','cgm','blood_pressure','bloodwork'],
                    description: 'Omit to list what is connected and get the recommended one-door route. "apple_health" and "health_connect" are the two that actually set anything up.' },
        devices:  { type: 'array', items: { type: 'string' },
                    description: 'Optional. What the user said they wear or use — "Apple Watch", "Galaxy Watch", "Oura ring", "Nike Run Club". Used to recommend the right door.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'remember',
    title: 'Remember something durable about them',
    description: 'Stores a fact that changes every future recommendation and that no column can hold: an injury ("left knee goes below parallel"), a hatred ("do not suggest running"), a constraint ("I travel every third week"), a context ("night shifts"). Call this the moment they say something like it — this is the whole reason they never have to repeat themselves.',
    inputSchema: {
      type: 'object',
      properties: {
        fact:     { type: 'string', description: 'The fact in their own words, one sentence.' },
        category: { type: 'string', enum: ['injury','preference','schedule','context','general'] },
      },
      required: ['fact'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'recall',
    title: 'Read what WROUGHT remembers',
    description: 'Returns stored facts — injuries, preferences, constraints, context. Call before suggesting any workout or meal, and honour what comes back without renegotiating it.',
    inputSchema: {
      type: 'object',
      properties: { category: { type: 'string', enum: ['injury','preference','schedule','context','general'] } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

const WWW_AUTH = `Bearer resource_metadata="${SITE_URL}/.well-known/oauth-protected-resource"`;

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError  = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

function unauthorized(id) {
  return {
    statusCode: 401,
    headers: { ...CORS, 'WWW-Authenticate': WWW_AUTH },
    body: JSON.stringify(rpcError(id ?? null, -32001, 'Sign in with Wrought to use this.')),
  };
}

// Every day's context in one shot: profile, goals, memory, window. Nearly every
// tool needs all four, and four round trips per call adds up fast.
async function context(userId) {
  const profile = await getProfile(userId);
  const [goals, memory, win] = await Promise.all([
    getGoals(userId), getMemory(userId), getWindow(userId),
  ]);
  return { profile, goals, memory, win, today: localDateFor(profile.timezone) };
}

// ── Tools: logging ──────────────────────────────────────────────────────────

async function log(args, user) {
  const text = String(args.text || '').trim();
  if (!text) return { error: 'Nothing to log — pass the user\'s words as text.' };

  const profile = await getProfile(user.id);

  // The client model already read the sentence, and the photograph this server
  // will never see. If it handed over the structured version, that reading beats
  // anything a second model could do from the text alone — and costs nothing.
  // Parsing here is the fallback, not the path.
  const supplied = eventsFromClient(args.events);
  const { events, parsed } = supplied
    ? { events: supplied, parsed: true }
    : await parseLog(text, profile);
  const structuredBy = supplied ? 'client' : parsed ? 'server' : 'none';

  const written = await insertEvents(user.id, profile, events, { rawInput: text });
  const hungry = needsMacros(written, events);

  const kinds = [...new Set(written.map(e => e.event_type))];
  const day = await dayFacts(user.id, profile, localDateFor(profile.timezone));

  return {
    recorded: written.map(e => ({ id: e.id, type: e.event_type, summary: e.summary, estimated: e.estimated })),
    count: written.length,
    parsed,
    structured_by: structuredBy,
    running_total_today: {
      food: day.food.say,
      training: day.training.say,
      estimated: day.food.estimated,
    },
    say: args.quiet
      ? `Logged: ${written.map(e => e.summary).join('; ')}.`
      : `Logged ${written.length} thing${written.length === 1 ? '' : 's'}: ${written.map(e => e.summary).join('; ')}.` +
        (day.food.meals ? ` Today so far: ${day.food.say}.` : ''),
    // A named food stored with no macros is barely stored at all, and the model
    // is the only thing that can fix it — it read the words. Asking here, in the
    // response it is currently reading, beats hoping the tool description landed.
    needs_macros: hungry.length ? hungry : undefined,
    note: hungry.length
      ? `Recorded, but ${hungry.map(h => `"${h.summary}"`).join(' and ')} went in with no calories or macros, so ${hungry.length === 1 ? 'it counts' : 'they count'} for nothing in every total. You named the food, so you can estimate ${hungry.length === 1 ? 'it' : 'them'}: call amend_last NOW with your best figures and estimated: true. Do it without asking permission${args.quiet ? ', silently, and say nothing about it' : ' and mention the figures in one short line'}. Only leave macros null when the food itself was never named — "had lunch" stays empty, "two pepperettes" does not.`
      : args.quiet
        ? 'Caught in passing. Acknowledge in a short clause at most and return immediately to what they were actually talking about. No totals, no follow-up questions, no coaching.'
        : parsed
          ? 'Read the recorded summaries back in one short line so a mis-heard word gets caught now, not next week.'
          : 'Could not parse this into structured entries — it was kept verbatim as a note so nothing was lost. Tell the user it was saved but not broken down.',
    next_actions: ['undo_last if anything came back wrong', 'brief for the day\'s read', 'whats_next if they are deciding what to eat'],
  };
}

async function logWeight(args, user) {
  const profile = await getProfile(user.id);
  const value = Number(args.value);
  if (!Number.isFinite(value) || value <= 0) return { error: 'A positive weight is required.' };

  const unit = args.unit || (profile.units === 'imperial' ? 'lb' : 'kg');
  const kg = unit === 'lb' ? lbToKg(value) : Math.round(value * 100) / 100;

  await insertEvents(user.id, profile, [{
    event_type: 'weight',
    summary: `${value} ${unit}`,
    detail: { value_kg: kg, reported: `${value} ${unit}` },
    estimated: false,
  }], { rawInput: `${value} ${unit}` });

  const today = localDateFor(profile.timezone);
  const range = await rangeFacts(user.id, profile, addDays(today, -29), today);
  const trend = summariseRange(range, profile).weight;

  return {
    logged: sayWeight(kg, profile.units),
    trend,
    say: `${sayWeight(kg, profile.units)} logged. ${trend.say}`,
    note: 'Report the trend, not the change since the last weigh-in. Bodyweight swings on salt, sleep and water — reacting to one reading is how people quit.',
    next_actions: ['progress for the full curve', 'brief for today\'s read'],
  };
}

async function logMeasurement(args, user) {
  const profile = await getProfile(user.id);
  const site = String(args.site || '').toLowerCase();
  const value = Number(args.value);
  if (!Number.isFinite(value) || value <= 0) return { error: 'A positive measurement is required.' };

  const unit = args.unit || (profile.units === 'imperial' ? 'in' : 'cm');
  const cm = unit === 'in' ? inToCm(value) : Math.round(value * 10) / 10;

  // The change since the last time this same site was measured is the number
  // that matters — especially in the weeks when the scale refuses to move.
  const { data: prior } = await supabase.from('wrought_events')
    .select('detail, local_date')
    .eq('user_id', user.id).eq('event_type', 'measurement')
    .contains('detail', { metric: site })
    .order('occurred_at', { ascending: false }).limit(1);

  await insertEvents(user.id, profile, [{
    event_type: 'measurement',
    summary: `${site} ${value} ${unit}`,
    detail: { metric: site, value_cm: cm, reported: `${value} ${unit}` },
    estimated: false,
  }], { rawInput: `${site} ${value} ${unit}` });

  const last = prior?.[0];
  const lastCm = last ? Number(last.detail?.value_cm) : null;
  const deltaCm = lastCm != null ? Math.round((cm - lastCm) * 10) / 10 : null;

  return {
    logged: `${site}: ${sayLength(cm, profile.units)}`,
    previous: lastCm != null ? { value: sayLength(lastCm, profile.units), date: last.local_date, days_ago: daysBetween(last.local_date, localDateFor(profile.timezone)) } : null,
    change: deltaCm != null ? sayLength(Math.abs(deltaCm), profile.units) + (deltaCm < 0 ? ' down' : deltaCm > 0 ? ' up' : '') : null,
    say: deltaCm != null
      ? `${site} at ${sayLength(cm, profile.units)} — ${Math.abs(deltaCm) < 0.05 ? 'unchanged' : `${sayLength(Math.abs(deltaCm), profile.units)} ${deltaCm < 0 ? 'down' : 'up'}`} from ${daysBetween(last.local_date, localDateFor(profile.timezone))} days ago.`
      : `${site} at ${sayLength(cm, profile.units)} logged — first one, so there is nothing to compare it to yet.`,
    next_actions: ['progress to see it against the weight curve'],
  };
}

async function amendLast(args, user) {
  const profile = await getProfile(user.id);
  const today = localDateFor(profile.timezone);

  let q = supabase.from('wrought_events')
    .select('id, event_type, summary, detail, estimated, raw_input, local_date')
    .eq('user_id', user.id).eq('local_date', today)
    .order('created_at', { ascending: false }).limit(1);
  if (args.type) q = q.eq('event_type', args.type);

  const { data } = await q;
  const prev = data?.[0];

  // Nothing to amend today: this is a first mention, not a correction.
  if (!prev) {
    return log({ text: args.text }, user);
  }

  // Re-parse the original words together with the new detail, so "doing my
  // workout" + "that was legs, 40 minutes" becomes ONE complete entry rather
  // than a vague session and a phantom second one beside it.
  const combined = [prev.raw_input || prev.summary, args.text].filter(Boolean).join('. ');
  const merged = eventsFromClient(args.event ? [args.event] : null);
  let first = merged?.[0];

  if (!first) {
    const { events, parsed } = await parseLog(combined, profile);
    first = parsed ? events.find(e => e.event_type === prev.event_type) || events[0] : null;
    // With neither a client-supplied merge nor a parser, parseLog hands back a
    // note carrying the raw words — and writing that over the entry would turn a
    // logged workout into a note, losing the session. Keep the original type and
    // let the new words extend the summary instead.
    if (!first) first = {
      event_type: prev.event_type,
      summary: `${prev.summary} — ${args.text}`,
      detail: prev.detail || {},
      estimated: prev.estimated,
    };
  }

  const { error } = await supabase.from('wrought_events').update({
    event_type: first.event_type,
    summary: String(first.summary || prev.summary).slice(0, 500),
    // Merge rather than replace: a detail that arrives later must never wipe
    // something already known.
    detail: { ...(prev.detail || {}), ...(first.detail || {}) },
    estimated: !!first.estimated,
    raw_input: combined,
  }).eq('id', prev.id);
  if (error) return { error: error.message };

  return {
    amended: true,
    was: prev.summary,
    now: first.summary,
    type: first.event_type,
    say: `Updated: "${prev.summary}" is now "${first.summary}".`,
    note: 'One entry, not two. Acknowledge briefly and move on.',
    next_actions: ['brief later for the day\'s read'],
  };
}

async function undoLast(args, user) {
  const count = Math.min(Math.max(parseInt(args.count, 10) || 1, 1), 10);
  const { data: recent } = await supabase.from('wrought_events')
    .select('id, summary, event_type')
    .eq('user_id', user.id).order('created_at', { ascending: false }).limit(count);

  if (!recent?.length) return { removed: 0, say: 'Nothing logged yet, so there is nothing to undo.' };

  const { error } = await supabase.from('wrought_events').delete().in('id', recent.map(r => r.id));
  if (error) return { error: error.message };

  return {
    removed: recent.length,
    entries: recent.map(r => r.summary),
    say: `Removed ${recent.length}: ${recent.map(r => r.summary).join('; ')}.`,
    next_actions: ['log to record it correctly'],
  };
}

// ── Tools: reading ──────────────────────────────────────────────────────────

async function brief(args, user) {
  const { profile, goals, memory } = await context(user.id);
  const kind = args.kind === 'morning' ? 'morning' : 'evening';
  const today = localDateFor(profile.timezone);
  // A morning brief is a read on the day that just finished, not on a day that
  // has barely started — asking "how did I do" at 7am means yesterday.
  const date = args.date || (kind === 'morning' ? addDays(today, -1) : today);

  const [day, range] = await Promise.all([
    dayFacts(user.id, profile, date),
    rangeFacts(user.id, profile, addDays(date, -29), date),
  ]);
  const summary = summariseRange(range, profile);
  const flags   = careFlags(range, profile);
  const scored  = scoreGoals(goals, day, summary, profile);

  const facts = {
    date, kind, units: profile.units,
    food: day.food, training: day.training, body: day.body, device: day.device,
    thirty_days: {
      adherence_pct: summary.adherence_pct,
      days_logged: summary.days_logged,
      calories_avg: summary.calories_avg,
      protein_avg: summary.protein_avg,
      training_days: summary.training_days,
      sessions_per_week: summary.sessions_per_week,
      sleep_avg: summary.sleep_avg_minutes ? humanDuration(summary.sleep_avg_minutes) : null,
      weight: summary.weight,
      neglected_muscles: summary.matrix.neglected,
    },
    streak: { current: summary.current_streak, longest: summary.longest_streak },
    goals: scored,
  };

  // Cache the verdict per day so re-asking is free and last Tuesday's read is
  // still recoverable — a month of verdicts is a record of whether the advice
  // was any good.
  let verdict = null;
  if (!args.refresh) {
    const { data: cached } = await supabase.from('wrought_briefs')
      .select('verdict').eq('user_id', user.id).eq('local_date', date).eq('kind', kind).maybeSingle();
    verdict = cached?.verdict || null;
  }
  if (!verdict) {
    verdict = await writeVerdict({ facts, profile, goals, memory, flags, kind });
    if (verdict) {
      await supabase.from('wrought_briefs')
        .upsert({ user_id: user.id, local_date: date, kind, facts, verdict },
                { onConflict: 'user_id,local_date,kind' });
    }
  }

  return {
    date, kind, facts, verdict,
    ...(flags.length ? { care_flags: flags } : {}),
    say: verdict || `${date}: ${day.food.say} · ${day.training.say}`,
    note: flags.length
      ? 'Care flags are up. They override the honesty doctrine — follow their guidance exactly and do not coach intake down.'
      : 'Deliver the verdict as written. It is already pitched to the bluntness they chose; do not soften it or add praise.',
    next_actions: ['progress for the trend and the training matrix', 'whats_next for the immediate move', 'suggest_workout if they are training today'],
  };
}

async function getDay(args, user) {
  const profile = await getProfile(user.id);
  const date = args.date || localDateFor(profile.timezone);
  const day = await dayFacts(user.id, profile, date);
  return {
    ...day,
    say: day.logged
      ? `${date}: ${day.food.say} · ${day.training.say}`
      : `Nothing logged on ${date}.`,
    next_actions: day.logged ? ['brief for the verdict', 'undo_last if something is wrong'] : ['log to fill it in'],
  };
}

async function progress(args, user) {
  const profile = await getProfile(user.id);
  const to   = args.to || localDateFor(profile.timezone);
  const span = Math.min(Math.max(parseInt(args.days, 10) || 30, 3), 400);
  const from = addDays(to, -(span - 1));

  const range   = await rangeFacts(user.id, profile, from, to);
  const summary = summariseRange(range, profile);
  const flags   = careFlags(range, profile);

  // What position in the session is costing them. Nobody else can answer this,
  // because nobody else stores where in the hour a lift happened.
  const { data: setRows } = await supabase.from('wrought_sets')
    .select('exercise, exercise_key, weight_kg, position, session_id, local_date')
    .eq('user_id', user.id).gte('local_date', from).lte('local_date', to)
    .limit(2000);
  const order = orderInsight(setRows || []);

  // Chart-ready: sparse series with the gaps left in, because a missing day is
  // information and silently closing the gap draws a line that never happened.
  const series = {
    weight:   range.days.map(d => ({ date: d.date, value: d.weight_kg == null ? null : (profile.units === 'imperial' ? kgToLb(d.weight_kg) : d.weight_kg) })),
    calories: range.days.map(d => ({ date: d.date, value: d.calories })),
    protein:  range.days.map(d => ({ date: d.date, value: d.protein_g })),
    volume:   range.days.map(d => ({ date: d.date, value: d.volume_kg })),
    steps:    range.days.map(d => ({ date: d.date, value: d.steps })),
    sleep:    range.days.map(d => ({ date: d.date, value: d.sleep_minutes })),
  };

  return {
    from, to, span_days: span,
    units: profile.units,
    weight_unit: profile.units === 'imperial' ? 'lb' : 'kg',
    summary: {
      adherence_pct: summary.adherence_pct,
      days_logged: summary.days_logged,
      calories_avg: summary.calories_avg,
      protein_avg: summary.protein_avg,
      carbs_avg: summary.carbs_avg,
      fat_avg: summary.fat_avg,
      training_days: summary.training_days,
      training_minutes: summary.training_minutes,
      sessions_per_week: summary.sessions_per_week,
      volume_kg: summary.volume_kg,
      steps_avg: summary.steps_avg,
      sleep_avg: summary.sleep_avg_minutes ? humanDuration(summary.sleep_avg_minutes) : null,
      current_streak: summary.current_streak,
      longest_streak: summary.longest_streak,
    },
    weight_trend: summary.weight,
    training_matrix: summary.matrix,
    device_matrix: deviceMatrix(range.days),
    weekday_pattern: weekdayPattern(range.days),
    exercise_order: order,
    series,
    ...(flags.length ? { care_flags: flags } : {}),
    say: [
      `Over ${span} days: logged ${summary.days_logged} of them (${summary.adherence_pct}%).`,
      summary.calories_avg ? `Averaging roughly ${summary.calories_avg} kcal and ${summary.protein_avg}g protein on the days you logged food.` : null,
      summary.training_days ? `${summary.training_days} sessions — about ${summary.sessions_per_week} a week.` : 'No training logged.',
      summary.weight.say,
      summary.matrix.neglected.length ? `Not touched in two weeks: ${summary.matrix.neglected.join(', ')}.` : null,
      order.findings.length ? order.findings[0].say : null,
      weekdayPattern(range.days).findings[0]?.say || null,
    ].filter(Boolean).join(' '),
    note: 'The series arrays are chart-ready with nulls for unlogged days — do not fill the gaps in. Charts render at ' + SITE_URL + '/app.html.',
    next_actions: ['suggest_workout to hit what has been neglected', 'brief for today', 'set_goal if nothing is being scored yet'],
  };
}

async function searchLog(args, user) {
  const profile = await getProfile(user.id);
  const q = String(args.query || '').trim();
  if (!q) return { error: 'A search term is required.' };

  const today = localDateFor(profile.timezone);
  const from  = addDays(today, -(Math.min(parseInt(args.days, 10) || 365, 1500)));

  let query = supabase.from('wrought_events')
    .select('id, event_type, local_date, summary, detail, estimated')
    .eq('user_id', user.id).gte('local_date', from)
    .or(`summary.ilike.%${q}%,raw_input.ilike.%${q}%`)
    .order('local_date', { ascending: false }).limit(60);
  if (args.type) query = query.eq('event_type', args.type);

  const { data, error } = await query;
  if (error) return { error: error.message };

  const hits = data || [];
  const last = hits[0];

  return {
    query: q,
    matches: hits.length,
    last_seen: last ? { date: last.local_date, days_ago: daysBetween(last.local_date, today), summary: last.summary } : null,
    results: hits.map(h => ({
      date: h.local_date, days_ago: daysBetween(h.local_date, today),
      type: h.event_type, summary: h.summary, estimated: h.estimated,
    })),
    say: hits.length
      ? `${hits.length} match${hits.length === 1 ? '' : 'es'} for "${q}". Last one was ${daysBetween(last.local_date, today)} days ago: ${last.summary}.`
      : `Nothing matching "${q}" in the last ${Math.min(parseInt(args.days, 10) || 365, 1500)} days.`,
    next_actions: ['progress to see it against the trend'],
  };
}

// ── Tools: coaching ─────────────────────────────────────────────────────────

async function whatsNext(args, user) {
  const { profile, goals, memory, win } = await context(user.id);
  const today = localDateFor(profile.timezone);
  const nowMin = localMinutesFor(profile.timezone);

  const day = await dayFacts(user.id, profile, today);
  const wStatus = windowStatus(win, profile.timezone);

  // Everything the answer depends on, computed here so the model only narrates.
  const proteinGoal  = goals.find(g => g.metric === 'protein_g' && g.cadence === 'daily');
  const calorieGoal  = goals.find(g => g.metric === 'calories' && g.cadence === 'daily');
  const proteinLeft  = proteinGoal?.target_value != null ? Math.max(0, Math.round(+proteinGoal.target_value - day.food.protein_g)) : null;
  const caloriesLeft = calorieGoal?.target_value != null ? Math.round(+calorieGoal.target_value - day.food.calories) : null;

  const situation = {
    now: clockString(nowMin),
    eaten_today: day.food,
    trained_today: day.training.sessions > 0,
    training_say: day.training.say,
    protein_remaining_g: proteinLeft,
    calories_remaining: caloriesLeft,
    over_calorie_target: caloriesLeft != null && caloriesLeft < 0,
    eating_window: wStatus,
    has_window: !!wStatus,
  };

  const range = await rangeFacts(user.id, profile, addDays(today, -13), today);
  const flags = careFlags(range, profile);

  let recommendation = null;
  if (openai) {
    const guard = flags.length
      ? `\nSAFETY OVERRIDE — these fired and outrank everything: ${flags.map(f => `${f.detail} ${f.guidance}`).join(' ')} Do not suggest eating less or waiting longer.`
      : '';
    try {
      const res = await openai.chat.completions.create({
        model: MODEL, temperature: 0.4, max_tokens: 260,
        messages: [{ role: 'user', content:
`You are WROUGHT. The user is deciding what to do right now. Everything below is already calculated — do not recalculate, do not invent numbers.

SITUATION:
${JSON.stringify(situation, null, 2)}

${memory.length ? `CONSTRAINTS (honour these absolutely):\n${memory.slice(0, 10).map(m => `- ${m.fact}`).join('\n')}` : ''}
${profile.dietary?.length ? `Diet: ${profile.dietary.join(', ')}` : ''}
${args.context ? `They said: "${args.context}"` : ''}${guard}

Answer in 2-4 short sentences: what to do right now and why, in their units. If they have protein left to hit, name specific foods that would close it. If the window is shut, say how long until it opens rather than lecturing. Be ${profile.bluntness}. No lists, no headings, no disclaimers.` }],
      });
      recommendation = res.choices[0].message.content.trim();
    } catch { /* the computed situation still answers on its own */ }
  }

  return {
    situation,
    recommendation,
    ...(flags.length ? { care_flags: flags } : {}),
    say: recommendation || [
      wStatus?.say,
      proteinLeft != null ? `${proteinLeft}g of protein left to hit today.` : null,
      caloriesLeft != null ? (caloriesLeft < 0 ? `${Math.abs(caloriesLeft)} kcal over target.` : `${caloriesLeft} kcal left.`) : null,
      day.training.sessions ? 'Already trained today.' : 'Nothing trained yet today.',
    ].filter(Boolean).join(' '),
    note: 'Numbers here are computed — relay them. Food totals are estimates, so say "roughly".',
    next_actions: ['log once they eat', 'suggest_workout if they have not trained', 'set_eating_window if late eating keeps happening and they have no window'],
  };
}

async function suggestWorkout(args, user) {
  const { profile, memory } = await context(user.id);
  const today = localDateFor(profile.timezone);

  const range   = await rangeFacts(user.id, profile, addDays(today, -27), today);
  const summary = summariseRange(range, profile);

  // Days since each muscle group was last touched — this is what makes the
  // suggestion follow the actual history instead of a generic split.
  const lastTouched = {};
  for (const d of range.days) {
    for (const m of d.muscles) lastTouched[m] = d.date;
  }
  const staleness = Object.fromEntries(
    Object.entries(lastTouched).map(([m, d]) => [m, daysBetween(d, today)]));

  const lastSession = [...range.days].reverse().find(d => d.sessions > 0);

  const state = {
    trained_today: range.days[range.days.length - 1]?.sessions > 0,
    days_since_last_session: lastSession ? daysBetween(lastSession.date, today) : null,
    last_session_muscles: lastSession?.muscles || [],
    sessions_last_4_weeks: summary.training_days,
    sessions_per_week: summary.sessions_per_week,
    neglected: summary.matrix.neglected,
    days_since_each_muscle: staleness,
    equipment: args.equipment || profile.equipment || ['unknown'],
    minutes_available: args.minutes || null,
    target_days_per_week: profile.train_days || null,
    training_age: profile.training_age || null,
    requested_focus: args.focus || null,
  };

  let session = null;
  if (openai) {
    try {
      const res = await openai.chat.completions.create({
        model: MODEL, temperature: 0.5, max_tokens: 700,
        messages: [{ role: 'user', content:
`You are WROUGHT, programming one training session. Everything below is computed from what this person has actually done — follow it rather than a textbook split.

STATE:
${JSON.stringify(state, null, 2)}

${memory.length ? `HARD CONSTRAINTS — injuries and refusals. Honour every one, never work around them:\n${memory.map(m => `- ${m.fact}`).join('\n')}` : ''}

Write the session: a one-line rationale tied to what is actually stale or overdue, then 4-6 exercises with sets and reps. Only prescribe loads if their recent history supports a number; otherwise give an RPE or a rep target. Respect the equipment listed and the time available. If they have trained hard with no rest for days, prescribe rest instead and say why — a rest day is a legitimate answer.

No preamble, no disclaimers, no warm-up boilerplate unless it matters for a named injury.` }],
      });
      session = res.choices[0].message.content.trim();
    } catch { /* state alone is still useful */ }
  }

  return {
    state,
    session,
    say: session || `Neglected: ${summary.matrix.neglected.join(', ') || 'nothing obvious'}. Last session was ${state.days_since_last_session ?? 'never'} days ago.`,
    note: 'The staleness numbers come from their real log. If they train it, call log with what they actually did — not what was prescribed.',
    next_actions: ['log the session afterwards', 'progress to see the matrix fill in'],
  };
}

// ── Tools: the live session ─────────────────────────────────────────────────
// The state lives here, on the server, and never in the conversation. A chat
// gets cleared, a phone dies between sets, somebody talks to you at the rack —
// any of those must not lose the workout. The model asks "what's next" and is
// told; it is never responsible for remembering where anybody is.

async function startSession(args, user) {
  const { profile, memory } = await context(user.id);
  const today = localDateFor(profile.timezone);

  // One workout at a time. Starting another means the first was abandoned —
  // said out loud rather than leaving two half-sessions fighting over which
  // one the next set belongs to.
  const { data: existing } = await supabase.from('wrought_sessions')
    .select('id, name, started_at').eq('user_id', user.id).eq('status', 'active').maybeSingle();
  if (existing) {
    await supabase.from('wrought_sessions')
      .update({ status: 'abandoned', ended_at: new Date().toISOString() }).eq('id', existing.id);
  }

  let routine = null;
  if (args.routine) {
    const { data } = await supabase.from('wrought_routines')
      .select('*').eq('user_id', user.id).eq('active', true)
      .ilike('name', args.routine).maybeSingle();
    routine = data || null;
  }

  // No saved routine: build one from what the log says is actually stale,
  // rather than from a generic split that ignores the last month.
  let plan, name, kind, tier = routine?.tier || profile.training_age === 'beginner' ? 'beginner' : 'intermediate';
  if (routine) {
    // Order is honoured as saved — the user built it deliberately and a routine
    // that silently rearranges itself is not a routine.
    plan = planFromRoutine(routine);
    name = routine.name;
    kind = routine.kind;
    tier = routine.tier;
  } else {
    const built = await buildPlan(args, user, profile, memory, today);
    plan = built.plan; name = built.name; kind = 'strength'; tier = built.tier;
    if (!plan.length) {
      return { error: 'could_not_build_session',
        say: 'Could not put a session together automatically. Tell me what you want to train and roughly how long you have.' };
    }
  }

  // Today's loads, computed per exercise from their own history.
  const first = plan[0];
  const opener = await loadCallFor(user.id, first, tier);

  const { data: session, error } = await supabase.from('wrought_sessions').insert([{
    user_id: user.id, routine_id: routine?.id || null,
    name, kind, plan, cursor_index: 0, local_date: today,
  }]).select('id').single();
  if (error) return { error: error.message };

  if (routine) {
    await supabase.from('wrought_routines').update({
      times_used: (routine.times_used || 0) + 1, last_used_on: today,
    }).eq('id', routine.id);
  }

  return {
    session_id: session.id,
    name, tier,
    exercises: plan.map(e => `${e.name} — ${e.sets}×${e.reps}`),
    total_exercises: plan.length,
    up_next: { ...first, set: 1, of: first.sets, load: opener },
    coaching: TIERS[tier]?.doctrine,
    say: `${name}. ${plan.length} exercises. First up: ${first.name}, ${first.sets} sets of ${first.reps}. ${opener.say}`,
    note: 'Call log_set after EVERY set they report, even a bare "done". The server tracks their position — never try to hold it yourself, and never re-state the whole plan between sets.',
    next_actions: ['log_set when they finish a set', 'end_session when they are done'],
  };
}

// A session assembled from the log rather than a textbook split.
async function buildPlan(args, user, profile, memory, today) {
  const tier = profile.training_age === 'beginner' ? 'beginner'
             : profile.training_age === 'advanced' ? 'advanced' : 'intermediate';

  const range   = await rangeFacts(user.id, profile, addDays(today, -27), today);
  const summary = summariseRange(range, profile);
  const minutes = args.minutes || 45;

  if (!openai) return { plan: [], name: 'Session', tier };

  try {
    const res = await openai.chat.completions.create({
      model: MODEL, temperature: 0.4, max_tokens: 800,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content:
`Build one training session as JSON: {"name": "...", "exercises": [{"name","sets","reps","muscles":[],"rest_s","cue"}]}

Person: ${tier}. ${minutes} minutes. Equipment: ${args.equipment || (profile.equipment || ['unknown']).join(', ')}.
Requested focus: ${args.focus || 'whatever is most overdue'}.
Not trained in the last two weeks: ${summary.matrix.neglected.join(', ') || 'nothing obvious'}.
Sessions in the last four weeks: ${summary.training_days}.
${memory.length ? `HARD CONSTRAINTS — injuries and refusals, honour every one:\n${memory.map(m => `- ${m.fact}`).join('\n')}` : ''}

${TIERS[tier].doctrine}
Sets ${TIERS[tier].sets}, reps ${TIERS[tier].reps}. Fit it to the time. Do NOT set loads — those are computed from their own history. Name the session something short and human.` }],
    });
    const out = JSON.parse(res.choices[0].message.content || '{}');
    // Safety net over the model: compounds first, isolation last. Getting this
    // backwards means the heaviest lift of the day happens on a fatigued
    // nervous system, and the session is worth less for no reason.
    return {
      plan: orderPlan(planFromRoutine({ exercises: out.exercises || [], tier })),
      name: out.name || 'Session',
      tier,
    };
  } catch {
    return { plan: [], name: 'Session', tier };
  }
}

async function loadCallFor(userId, exercise, tier) {
  const key = exercise.key || exerciseKey(exercise.name);
  const last = await lastPerformance(userId, key);
  const target = parseInt(String(exercise.reps), 10) || 8;
  // A load the routine states explicitly wins — the user set it deliberately.
  if (exercise.load_kg != null) {
    return { verdict: 'prescribed', weight_kg: exercise.load_kg,
             say: `${exercise.load_kg}kg, as written.`, last };
  }
  return { ...progressionCall({ last, targetReps: target, tier, key }), last };
}

async function logSet(args, user) {
  const profile = await getProfile(user.id);
  const today = localDateFor(profile.timezone);

  const { data: session } = await supabase.from('wrought_sessions')
    .select('*').eq('user_id', user.id).eq('status', 'active').maybeSingle();

  if (!session) {
    return { error: 'no_active_session',
      say: 'No workout is running right now. Start one with start_session, or log it afterwards with log.',
      next_actions: ['start_session'] };
  }

  const plan = Array.isArray(session.plan) ? session.plan : [];
  const current = plan[session.cursor_index] || null;
  if (!current) {
    return { done: true, say: 'That was the last exercise on the plan.', next_actions: ['end_session'] };
  }

  // How many sets of this exercise are already down, so the cursor advances on
  // count rather than on the model's guess about where they are.
  const { count: doneCount } = await supabase.from('wrought_sets')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', session.id).eq('exercise_key', current.key);

  let setsDone = doneCount || 0;

  if (args.skip) {
    setsDone = current.sets;                    // force the move on
  } else {
    const name = args.exercise || current.name;
    const key  = args.exercise ? exerciseKey(args.exercise) : current.key;
    const { error } = await supabase.from('wrought_sets').insert([{
      user_id: user.id, session_id: session.id,
      exercise: name, exercise_key: key,
      set_number: setsDone + 1,
      // Where this lift sat in the session. Cheap to store, and the only way
      // to later answer "is my bench stalling, or is it just always third?"
      position: session.cursor_index + 1,
      reps: args.reps != null ? Math.round(Number(args.reps)) : (parseInt(String(current.reps), 10) || null),
      weight_kg: args.weight_kg != null ? Number(args.weight_kg) : null,
      rpe: args.rpe != null ? Number(args.rpe) : null,
      muscles: current.muscles || [],
      // Verbatim. "Left shoulder pinched on the third set" is the whole reason
      // a number went the way it did, and it is worthless paraphrased.
      note: args.note ? String(args.note).slice(0, 500) : null,
      local_date: today,
    }]);
    if (error) return { error: error.message };
    setsDone += 1;
  }

  const moreSetsHere = setsDone < current.sets;
  let cursor = session.cursor_index;
  if (!moreSetsHere) cursor += 1;
  if (cursor !== session.cursor_index) {
    await supabase.from('wrought_sessions').update({ cursor_index: cursor }).eq('id', session.id);
  }

  const finished = cursor >= plan.length;
  if (finished) {
    return {
      recorded: true, session_complete: true,
      say: 'That is the plan finished.',
      note: 'Call end_session now to file it and give them the totals.',
      next_actions: ['end_session'],
    };
  }

  const nextExercise = moreSetsHere ? current : plan[cursor];
  const load = moreSetsHere
    ? { verdict: 'same', weight_kg: args.weight_kg ?? null,
        say: args.weight_kg != null ? `Same ${args.weight_kg}kg.` : 'Same weight.' }
    : await loadCallFor(user.id, nextExercise, session.plan[0]?.tier || 'intermediate');

  const setNo = moreSetsHere ? setsDone + 1 : 1;

  // The rest gap is dead time — two or three minutes, several times a session,
  // where the user is holding a phone with nothing to do. Filling it with the
  // running total costs nothing and is the only moment in a workout anybody
  // actually wants a number.
  const { data: sofar } = await supabase.from('wrought_sets')
    .select('exercise, reps, weight_kg').eq('session_id', session.id);
  const running = sessionTotals(sofar || []);
  const elapsed = Math.round((Date.now() - new Date(session.started_at).getTime()) / 60000);

  return {
    recorded: !args.skip,
    rest_seconds: nextExercise.rest_s,
    up_next: {
      exercise: nextExercise.name,
      set: setNo, of: nextExercise.sets,
      reps: nextExercise.reps,
      load,
      cue: setNo === 1 ? nextExercise.cue : null,
    },
    so_far: {
      sets: running.sets, volume_kg: running.volume_kg, minutes: elapsed,
      exercise: `${cursor + 1} of ${plan.length}`,
    },
    say: `${moreSetsHere ? 'Logged' : `${current.name} done`}. Rest ${nextExercise.rest_s}s, then ${nextExercise.name} set ${setNo} of ${nextExercise.sets}, ${nextExercise.reps} reps. ${load.say}`,
    note: 'One or two lines only — they are standing in a gym holding a phone, not reading a report. The so_far numbers are there for the rest gap: offer them if they ask or if the moment fits, never after every single set.',
    next_actions: ['log_set for the next set', 'end_session if they stop early'],
  };
}

async function endSession(args, user) {
  const profile = await getProfile(user.id);
  const today = localDateFor(profile.timezone);

  const { data: session } = await supabase.from('wrought_sessions')
    .select('*').eq('user_id', user.id).eq('status', 'active').maybeSingle();
  if (!session) return { error: 'no_active_session', say: 'No workout is running.' };

  const { data: sets } = await supabase.from('wrought_sets')
    .select('exercise, exercise_key, reps, weight_kg, rpe, muscles')
    .eq('session_id', session.id).order('logged_at', { ascending: true });

  const rows = sets || [];
  const totals = sessionTotals(rows);
  const minutes = Math.max(1, Math.round((Date.now() - new Date(session.started_at).getTime()) / 60000));
  const muscles = [...new Set(rows.flatMap(s => s.muscles || []))];

  // File it as an ordinary workout event so the brief, the matrix and the
  // trends see it exactly like anything else. A session that lives only in its
  // own table is invisible to everything that matters.
  const [written] = await insertEvents(user.id, profile, [{
    event_type: 'workout',
    summary: `${session.name} — ${totals.sets} sets, ${minutes} min`,
    detail: {
      kind: session.kind, minutes, muscles,
      exercises: totals.top_sets.map(t => ({
        name: t.exercise, sets: rows.filter(r => r.exercise === t.exercise).length,
        reps: t.reps, weight_kg: t.weight_kg,
      })),
      volume_kg: totals.volume_kg,
      session_id: session.id,
      note: args.note || null,
    },
    estimated: false,
  }], { rawInput: args.note || null });

  await supabase.from('wrought_sessions').update({
    status: 'done', ended_at: new Date().toISOString(), event_id: written?.id || null,
  }).eq('id', session.id);

  // Anything that beat last time — the only part of a summary anybody reads.
  const beats = [];
  for (const t of totals.top_sets) {
    if (t.weight_kg == null) continue;
    const prior = await previousBest(user.id, exerciseKey(t.exercise), session.id);
    if (prior != null && Number(t.weight_kg) > prior) {
      beats.push(`${t.exercise} ${t.weight_kg}kg (was ${prior})`);
    }
  }

  const day = await dayFacts(user.id, profile, today);
  const balance = await balanceFor(user.id, profile, today, day);

  return {
    session: session.name,
    minutes, ...totals, muscles,
    beat_last_time: beats,
    day_so_far: { food: day.food.say, energy: balance.say },
    say: `${session.name} done — ${minutes} minutes, ${totals.sets} sets, ${totals.volume_kg}kg moved.` +
         (beats.length ? ` Up on last time: ${beats.join('; ')}.` : '') +
         ` ${balance.say}`,
    note: 'Lead with anything in beat_last_time — that is the only part of a session summary anyone actually cares about.',
    next_actions: ['log what they eat next', 'brief tonight for the full read'],
  };
}

async function previousBest(userId, key, excludeSessionId) {
  const { data } = await supabase.from('wrought_sets')
    .select('weight_kg, session_id').eq('user_id', userId).eq('exercise_key', key)
    .not('session_id', 'is', null).neq('session_id', excludeSessionId)
    .order('weight_kg', { ascending: false }).limit(1);
  return data?.[0]?.weight_kg != null ? Number(data[0].weight_kg) : null;
}

async function saveRoutine(args, user) {
  const profile = await getProfile(user.id);
  const name = String(args.name || '').trim();
  if (!name) return { error: 'A name is required.' };

  const shape = e => ({
    name: String(e.name || '').trim(),
    sets: Number(e.sets) || 3,
    reps: e.reps ?? 8,
    load_kg: e.load_kg ?? null,
    rest_s: Number(e.rest_s) || 120,
    muscles: Array.isArray(e.muscles) ? e.muscles : [],
    cue: e.cue || null,
  });

  let exercises = (Array.isArray(args.exercises) ? args.exercises : []).map(shape).filter(e => e.name);

  const tier = args.tier || (profile.training_age === 'beginner' ? 'beginner' : 'intermediate');

  // Saving the same name updates it. Two indistinguishable "leg day" routines
  // is worse than no routine at all.
  const { data: existing } = await supabase.from('wrought_routines')
    .select('id, exercises').eq('user_id', user.id).eq('active', true).ilike('name', name).maybeSingle();

  // Nobody authors a twelve-week programme upfront. They have one good session
  // and want it again. Capturing what actually happened — in the order it
  // happened — is how a plan really gets built.
  if (args.from_last_session) {
    const { data: last } = await supabase.from('wrought_sessions')
      .select('id').eq('user_id', user.id).eq('status', 'done')
      .order('ended_at', { ascending: false }).limit(1).maybeSingle();

    if (!last) {
      return { error: 'no_finished_session',
        say: 'No finished session to capture yet. Run one with start_session and save it afterwards.' };
    }

    const { data: sets } = await supabase.from('wrought_sets')
      .select('exercise, reps, weight_kg, muscles, position, set_number')
      .eq('session_id', last.id).order('position', { ascending: true });

    // Collapse sets back into exercises, preserving the order actually trained.
    const byExercise = new Map();
    for (const s of (sets || [])) {
      const k = s.exercise;
      if (!byExercise.has(k)) {
        byExercise.set(k, { name: k, sets: 0, reps: s.reps ?? 8, muscles: s.muscles || [], position: s.position ?? 99 });
      }
      byExercise.get(k).sets += 1;
    }
    exercises = [...byExercise.values()]
      .sort((a, b) => a.position - b.position)
      .map(shape);

    if (!exercises.length) {
      return { error: 'nothing_logged',
        say: 'That session has no sets recorded, so there is nothing to save.' };
    }
  }

  // A plan grows over weeks. Making somebody rebuild the whole thing to add one
  // movement is exactly how a routine stops being used.
  if (Array.isArray(args.add) && args.add.length) {
    const base = exercises.length ? exercises : (existing?.exercises || []);
    exercises = [...base, ...args.add.map(shape).filter(e => e.name)];
  }

  const row = {
    user_id: user.id, name, kind: args.kind || 'strength', tier,
    exercises, equipment: args.equipment || profile.equipment || null,
    est_minutes: args.est_minutes || null, updated_at: new Date().toISOString(),
  };

  const { error } = existing
    ? await supabase.from('wrought_routines').update(row).eq('id', existing.id)
    : await supabase.from('wrought_routines').insert([row]);
  if (error) return { error: error.message };

  return {
    saved: name, updated: !!existing, exercises: exercises.length, tier,
    captured_from_session: !!args.from_last_session,
    exercise_names: exercises.map(e => e.name),
    say: `${existing ? 'Updated' : 'Saved'} "${name}" — ${exercises.map(e => `${e.name} ${e.sets}×${e.reps}`).join(', ')}. Say the name any time and it starts.`,
    note: 'Read the exercise list back once so a mis-captured lift gets caught now. They can add to this later with save_routine and the add field — never make them rebuild it.',
    next_actions: [`start_session with routine "${name}"`, 'save_routine with add[] to grow it later'],
  };
}

async function listRoutines(_args, user) {
  const profile = await getProfile(user.id);
  const today = localDateFor(profile.timezone);

  const { data } = await supabase.from('wrought_routines')
    .select('name, kind, tier, exercises, est_minutes, times_used, last_used_on')
    .eq('user_id', user.id).eq('active', true)
    .order('last_used_on', { ascending: false, nullsFirst: false });

  const routines = (data || []).map(r => ({
    name: r.name, kind: r.kind, tier: r.tier,
    exercises: (r.exercises || []).length,
    minutes: r.est_minutes,
    times_used: r.times_used,
    last_used: r.last_used_on,
    days_since: r.last_used_on ? daysBetween(r.last_used_on, today) : null,
  }));

  const stale = routines.filter(r => r.days_since != null && r.days_since >= 7);

  return {
    routines, count: routines.length,
    overdue: stale.map(r => `${r.name} (${r.days_since} days)`),
    say: routines.length
      ? `${routines.length} saved: ${routines.map(r => r.name).join(', ')}.` +
        (stale.length ? ` Not run in a while: ${stale.map(r => `${r.name}, ${r.days_since} days`).join('; ')}.` : '')
      : 'Nothing saved yet. Build a session and save_routine keeps it for good.',
    note: 'The answer to "what should I train" is usually a routine they already have and have not run in ten days. Check here before building anything new.',
    next_actions: ['start_session with one of these'],
  };
}

async function balanceFor(userId, profile, date, day) {
  // Bodyweight for the burn calculation: today's if there is one, otherwise
  // the most recent — nobody weighs in daily and the maths should not stop.
  let weightKg = day.body.weight_kg;
  if (weightKg == null) {
    const { data } = await supabase.from('wrought_events')
      .select('detail').eq('user_id', userId).eq('event_type', 'weight')
      .order('occurred_at', { ascending: false }).limit(1);
    weightKg = data?.[0]?.detail?.value_kg ?? null;
  }
  return energyBalance({
    profile, weightKg,
    caloriesIn: day.food.calories,
    activeCalories: day.device.active_calories,
    foodEstimated: day.food.estimated,
  });
}

async function energyBalanceTool(args, user) {
  const profile = await getProfile(user.id);
  const date = args.date || localDateFor(profile.timezone);
  const day = await dayFacts(user.id, profile, date);
  const balance = await balanceFor(user.id, profile, date, day);

  return {
    date, ...balance,
    logged: { food: day.food.say, training: day.training.say, steps: day.device.steps },
    say: balance.say,
    note: balance.known
      ? 'Say "roughly" and "about" — both halves are estimates. Never present the net as a measurement, and steer them to the weekly scale trend to correct it rather than to a single day.'
      : 'Ask once for whatever is missing, save it with set_profile, and do not ask again.',
    next_actions: balance.known
      ? ['progress to check it against the actual weight trend']
      : ['set_profile with what is missing'],
  };
}

async function earnedRoomTool(args, user) {
  const { profile, goals } = await context(user.id);
  const to   = args.date || localDateFor(profile.timezone);
  const from = addDays(to, -6);

  const range = await rangeFacts(user.id, profile, from, to);
  const flags = careFlags(range, profile);

  // A stated calorie goal wins. Failing that, derive maintenance from their own
  // body and treat that as the line — better than refusing to answer, and it is
  // the number they would have picked anyway.
  const goal = goals.find(g => g.metric === 'calories' && g.cadence === 'daily');
  let dailyTarget = goal?.target_value != null ? Number(goal.target_value) : null;
  let derived = false;

  if (dailyTarget == null) {
    const today = await dayFacts(user.id, profile, to);
    const balance = await balanceFor(user.id, profile, to, today);
    if (balance.known) { dailyTarget = balance.calories_out; derived = true; }
  }

  const room = earnedRoom({
    days: range.days, dailyTarget, flags,
    honestyDays: range.days.filter(d => d.logged).length,
  });

  return {
    week: { from, to },
    ...room,
    target_source: dailyTarget == null ? null : derived ? 'estimated maintenance' : 'their stated goal',
    ...(flags.length ? { care_flags: flags } : {}),
    note: room.guidance,
    next_actions: room.available
      ? ['log whatever they end up eating — spending it is not a failure']
      : ['brief for the fuller picture'],
  };
}

async function nutrition(args, user) {
  const profile = await getProfile(user.id);
  const today = localDateFor(profile.timezone);

  // Everything ever logged, because year-over-year is the whole point and it
  // cannot be answered from a rolling window.
  const { data: events } = await supabase.from('wrought_events')
    .select('event_type, local_date, detail, estimated')
    .eq('user_id', user.id).in('event_type', ['food', 'drink'])
    .order('local_date', { ascending: false }).limit(8000);

  const evs = events || [];
  const since = args.since || addDays(today, -89);

  const totals = nutritionTotals(evs, { today });
  const comp   = composition(evs, { since });
  const grid   = macroMatrix(evs, { weeks: 12, today });
  const yoy    = yearOverYear(evs, { today });

  const focus = args.period === 'today' ? totals.today
              : args.period === 'week'  ? totals.this_week
              : args.period === 'month' ? totals.this_month
              : args.period === 'year'  ? totals.this_year
              : args.period === 'all'   ? totals.all_time
              : totals.this_week;

  return {
    totals, composition: comp, macro_matrix: grid, year_over_year: yoy,
    composition_since: since,
    say: [
      `Roughly ${focus.calories_per_day} kcal a day across ${focus.days_logged} logged days` +
        ` — ${focus.protein_g_per_day}g protein, ${focus.carbs_g_per_day}g carbs (${focus.sugar_g_per_day}g of it sugar), ${focus.fat_g_per_day}g fat.`,
      comp.say,
      yoy.comparison?.say || null,
    ].filter(Boolean).join(' '),
    note: 'Every macro is estimated from described meals — say "roughly". Composition is a count of MEALS, not weights: "meat in 71% of meals" is honest, "you ate 4kg of meat" is not. Never moralise about a category; report the share and let them decide what it means.',
    next_actions: ['progress for the training side', 'set_goal if they want a number to be scored against'],
  };
}

// ── Tools: setup ────────────────────────────────────────────────────────────

async function getProfileTool(_args, user) {
  const { profile, goals, memory, win, today } = await context(user.id);

  const [{ data: conns }, { count }, { data: first }] = await Promise.all([
    supabase.from('wrought_connections').select('provider, mode, status, last_sync_at').eq('user_id', user.id),
    supabase.from('wrought_events').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
    supabase.from('wrought_events').select('local_date').eq('user_id', user.id)
      .order('local_date', { ascending: true }).limit(1),
  ]);

  return {
    profile: {
      timezone: profile.timezone, units: profile.units,
      height_cm: profile.height_cm, birth_year: profile.birth_year, sex: profile.sex,
      training_age: profile.training_age, equipment: profile.equipment,
      train_days: profile.train_days, dietary: profile.dietary,
      bluntness: profile.bluntness, notes: profile.notes,
      configured: profile._exists,
    },
    goals: goals.map(g => ({ goal: g.goal, metric: g.metric, target: g.target_value, unit: g.target_unit, direction: g.direction, cadence: g.cadence, target_date: g.target_date })),
    eating_window: windowStatus(win, profile.timezone),
    devices: (conns || []).map(c => ({ provider: c.provider, mode: c.mode, status: c.status, last_sync: c.last_sync_at })),
    memory: memory.map(m => ({ fact: m.fact, category: m.category })),
    history: {
      total_entries: count || 0,
      logging_since: first?.[0]?.local_date || null,
      days_on_wrought: first?.[0]?.local_date ? daysBetween(first[0].local_date, today) : 0,
    },
    say: profile._exists
      ? `Set up: ${profile.units}, ${profile.timezone}, ${profile.bluntness} feedback. ${count || 0} entries logged${first?.[0]?.local_date ? ` since ${first[0].local_date}` : ''}.`
      : 'Nothing set up yet — WROUGHT still works, it just reads everything back in metric on Toronto time until told otherwise.',
    note: 'Read this before asking the user anything. Never ask for something already here.',
    next_actions: (conns || []).length ? [] : ['connect_device to get the watch feeding it automatically'],
  };
}

async function setProfile(args, user) {
  const fields = ['timezone','units','height_cm','birth_year','sex','training_age','equipment','train_days','dietary','bluntness','notes'];
  const patch = {};
  for (const f of fields) if (args[f] !== undefined) patch[f] = args[f];
  if (!Object.keys(patch).length) return { error: 'Nothing to save.' };

  patch.user_id = user.id;
  patch.updated_at = new Date().toISOString();

  const { error } = await supabase.from('wrought_profile').upsert(patch, { onConflict: 'user_id' });
  if (error) return { error: error.message };

  return {
    saved: Object.keys(patch).filter(k => !['user_id','updated_at'].includes(k)),
    say: 'Saved.',
    note: 'Acknowledge in a few words and move on. Do not read the whole profile back at them.',
  };
}

async function setGoal(args, user) {
  const goal = String(args.goal || '').trim();
  if (!goal) return { error: 'A goal is required.' };

  const row = {
    user_id: user.id, goal,
    metric: args.metric || null,
    target_value: args.target != null ? Number(args.target) : null,
    target_unit: args.metric === 'protein_g' ? 'g'
               : args.metric === 'weight_kg' ? 'kg'
               : args.metric === 'calories' ? ' kcal' : null,
    direction: args.direction || 'at_least',
    cadence: args.cadence || 'daily',
    target_date: args.target_date || null,
  };

  const { error } = await supabase.from('wrought_goals').insert([row]);
  if (error) return { error: error.message };

  return {
    goal: row,
    say: `Goal set: ${goal}.` + (row.target_value != null ? ' It gets scored in every brief from now on.' : ''),
    note: row.target_value == null
      ? 'No number attached, so the brief will mention it but cannot score it. Offer to attach one, once.'
      : 'Every brief will now score this automatically.',
    next_actions: ['brief to see it scored against today'],
  };
}

async function setEatingWindow(args, user) {
  const profile = await getProfile(user.id);
  const patch = { user_id: user.id, updated_at: new Date().toISOString() };
  if (args.opens_at)   patch.opens_at  = args.opens_at;
  if (args.closes_at)  patch.closes_at = args.closes_at;
  if (args.strictness) patch.strictness = args.strictness;
  if (args.active !== undefined) patch.active = !!args.active;

  const { error } = await supabase.from('wrought_eating_window').upsert(patch, { onConflict: 'user_id' });
  if (error) return { error: error.message };

  const status = windowStatus(await getWindow(user.id), profile.timezone);
  return {
    window: status,
    say: status ? `Window set: ${status.opens_at} to ${status.closes_at}. ${status.say}` : 'Eating window turned off.',
    note: 'From now on whats_next counts down to it. Give them the countdown, never a lecture about snacking.',
    next_actions: ['whats_next when they are deciding whether to eat'],
  };
}

async function programmes(args, user) {
  const profile = await getProfile(user.id);
  const tier = profile.training_age === 'beginner' ? 'beginner'
             : profile.training_age === 'advanced' ? 'advanced' : 'intermediate';

  // Asking about one pattern is the mid-session case — the bench is taken and
  // they want the next best thing — so it answers narrowly and gets out.
  if (args.pattern) {
    const list = movementsFor(String(args.pattern).toLowerCase(), { equipment: profile.equipment, tier });
    if (!list.length) {
      return {
        pattern: args.pattern,
        movements: [],
        say: `Nothing in the library matches "${args.pattern}" for the kit on file.`,
        note: 'Do not invent a movement to fill the gap. Ask what equipment they actually have.',
      };
    }
    return {
      pattern: args.pattern,
      movements: list.map(m => ({ name: m.name, tier: m.tier, muscles: m.muscles, equipment: m.equipment, cue: m.cue })),
      say: `${list.length} good option${list.length === 1 ? '' : 's'} for ${args.pattern}: ${list.map(m => m.name).join(', ')}.`,
      note: 'These are movements, not a prescription. No weight is attached to any of them and none should be suggested from here.',
      next_actions: ['log_set once they have done it', 'save_routine if they want it kept'],
    };
  }

  const chosen = args.programme
    ? (PROGRAMMES.find(p => p.id === args.programme)
        ? buildProgramme(PROGRAMMES.find(p => p.id === args.programme), { tier, equipment: profile.equipment })
        : null)
    : pickProgramme({ days: args.days ?? profile.train_days, tier, equipment: profile.equipment });

  if (!chosen) return { error: 'no_such_programme', say: 'No programme by that name. Call with no arguments to be matched to one.' };

  if (!args.adopt) {
    return {
      programme: chosen,
      available: PROGRAMMES.map(p => ({ id: p.id, name: p.name, days: p.days, tier: p.tier })),
      say: `${chosen.name} — ${chosen.days} days a week, about ${chosen.est_minutes} minutes. ${chosen.why}`,
      note: 'Read back the session names and roughly what each covers, not all thirty exercises. Offer to adopt it — that saves the sessions as routines they can start by name. No weights appear here and none should be invented; the first time they run a lift, the session tools work the load out from what they actually do.',
      next_actions: ['programmes with adopt: true if they want it saved', 'start_session once adopted'],
    };
  }

  // Adopting writes one routine per session. Same-name routines are updated
  // rather than duplicated — two indistinguishable "Upper A"s is worse than
  // none, and the unique index would refuse the second anyway.
  const saved = [];
  for (const s of chosen.sessions) {
    const row = {
      user_id: user.id,
      name: s.name,
      kind: s.kind,
      tier: chosen.tier,
      exercises: s.exercises,
      equipment: profile.equipment || null,
      est_minutes: chosen.est_minutes,
      notes: `From ${chosen.name}.`,
      active: true,
      updated_at: new Date().toISOString(),
    };
    const { data: existing } = await supabase.from('wrought_routines')
      .select('id').eq('user_id', user.id).eq('active', true).ilike('name', s.name).maybeSingle();

    if (existing) await supabase.from('wrought_routines').update(row).eq('id', existing.id);
    else await supabase.from('wrought_routines').insert([row]);
    saved.push(s.name);
  }

  return {
    adopted: chosen.name,
    routines: saved,
    say: `Saved ${saved.length} routines: ${saved.join(', ')}. Say the name and I'll run the session.`,
    note: 'Still no weights anywhere in this. The first working set of each lift gets prescribed from their history, or as an RPE if there is none.',
    next_actions: ['start_session with one of the names', 'list_routines to see them all'],
  };
}

async function logFast(args, user) {
  const from = String(args.from || '').trim();
  if (!/^\d{1,2}:\d{2}$/.test(from)) return { error: 'from must be HH:MM, 24-hour.' };
  const to = /^\d{1,2}:\d{2}$/.test(String(args.to || '')) ? String(args.to).trim() : null;

  const profile = await getProfile(user.id);
  const today = localDateFor(profile.timezone);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(args.date || '')) ? args.date : today;

  const hours = fastLength(from, to);
  const summary = to
    ? `fasted ${hours}h — ${from} to ${to}`
    : `fasting since ${from}`;

  await insertEvents(user.id, profile, [{
    event_type: 'fast',
    summary,
    detail: { from, to, hours, open: !to, ...(args.note ? { note: args.note } : {}) },
    // Nothing here is inferred. They said when they stopped and when they
    // started, and the arithmetic between two clock times is not a guess.
    estimated: false,
    time_hint: to || null,
  }], { rawInput: `fast ${from}${to ? `–${to}` : ''}` });

  const since = addDays(today, -89);
  const { data: past } = await supabase.from('wrought_events')
    .select('detail, local_date')
    .eq('user_id', user.id).eq('event_type', 'fast')
    .gte('local_date', since).order('local_date', { ascending: false }).limit(90);

  const history = fastingSummary(past || []);

  return {
    recorded: { date, from, to, hours, open: !to },
    history,
    say: to
      ? `Logged: ${hours}h, ${from} to ${to}.`
      : `Logged: fasting since ${from}. Tell me when you eat and I'll close it.`,
    note: args.quiet
      ? 'Caught in passing. One short clause at most, then straight back to what they were talking about.'
      : 'Report the hours and the average. Do NOT congratulate a long one or query a short one — a fast that gets graded becomes a reason to skip breakfast to keep a number alive. It is a record, not a score.',
    next_actions: ['brief for the day\'s read', 'set_eating_window only if they ask for a plan rather than a record'],
  };
}

async function connectDevice(args, user) {
  const { data: conns } = await supabase.from('wrought_connections')
    .select('provider, mode, status, last_sync_at').eq('user_id', user.id);

  const connected = (conns || []).map(c => ({
    provider: c.provider, mode: c.mode, status: c.status, last_sync: c.last_sync_at,
  }));

  if (!args.provider) {
    const route = recommendRoute(args.devices || []);
    return {
      connected,
      // The registry drives this so the assistant and the website can never
      // drift into telling a user two different stories about the same device.
      available: Object.fromEntries(
        Object.keys(PROVIDERS).map(k => [k, providerSummary(k).say])),
      recommended: route,
      the_shortcut: 'Almost nobody needs more than one connection. Apple Health and Health Connect are already aggregators — Nike Run Club, Strava, Peloton, Oura, Whoop and Samsung Health all write into whichever one is on their phone. Connect the phone and the rest arrives with it.',
      say: connected.length
        ? `Connected: ${connected.map(c => c.provider).join(', ')}.`
        : route.say,
      note: 'Do not walk them through connecting six services one at a time. Ask what phone they carry, then set up that one door.',
      next_actions: [`connect_device with provider "${route.door}"`],
    };
  }

  const p = providerSummary(args.provider);
  if (!p) return { error: `Unknown provider: ${args.provider}` };

  // ── The two doors: mint a key and hand over the setup ─────────────────────
  if (p.status === 'live') {
    // A Shortcut cannot run a PKCE dance, so it gets one long random bearer,
    // stored hashed, scoped to writing this user's health data and nothing else.
    const token = newToken();
    await supabase.from('wrought_ingest_keys')
      .insert([{ user_id: user.id, token_hash: hashToken(token), label: p.name }]);
    await supabase.from('wrought_connections')
      .upsert({ user_id: user.id, provider: args.provider, mode: 'push', status: 'active' },
              { onConflict: 'user_id,provider' });

    const ios = args.provider === 'apple_health';

    return {
      provider: args.provider,
      mode: 'push',
      why_push: p.why,
      picks_up_automatically: p.aggregates,
      ingest_url: `${SITE_URL}/ingest`,
      ingest_key: token,
      setup: ios ? [
        'Open the Shortcuts app on the iPhone and make a new Personal Automation.',
        'Trigger: Time of Day → 11:00 pm → Run Immediately.',
        'Add "Find Health Samples" — Steps, today. Repeat for Sleep Analysis, Resting Heart Rate, Heart Rate Variability, Active Energy, Body Mass and Workouts.',
        `Add "Get Contents of URL" → ${SITE_URL}/ingest, Method POST.`,
        `Headers: Authorization = "Bearer ${token}", Content-Type = "application/json".`,
        'Request Body → JSON: source "apple_health", a "metrics" array of {metric, value, unit, measured_at}, and optionally a "workouts" array of {kind, minutes, distance_km, occurred_at}.',
        'Run it once to confirm, then leave it alone. It fills in overnight from then on.',
      ] : [
        'Install Health Connect from the Play Store if it is not already on the phone (it is built in on Android 14+).',
        'In Samsung Health / Fitbit / Nike Run Club, turn on writing to Health Connect. That is what puts everything in one place.',
        'Install Health Sync, or set up a Tasker/Macrodroid job, to post once a night.',
        `Endpoint: ${SITE_URL}/ingest, Method POST.`,
        `Headers: Authorization = "Bearer ${token}", Content-Type = "application/json".`,
        'Body → JSON: source "health_connect", a "metrics" array of {metric, value, unit, measured_at}, and optionally a "workouts" array.',
      ],
      ...(ios ? { easier_option: `The "Health Auto Export" app posts the same JSON on a schedule with no Shortcut building at all — point its REST endpoint at ${SITE_URL}/ingest with the same bearer header.` } : {}),
      web_setup: `${SITE_URL}/connect.html — the same steps with screenshots, and where to revoke this key.`,
      security: 'This key can only write health data for this account. It cannot read anything back and cannot touch the login. Revoke it any time from the connect page.',
      say: `${p.name} set up. The key below goes into the automation on their phone. Because it is an aggregator, this one connection also picks up ${p.aggregates.slice(0, 4).join(', ')} and anything else already writing to it — they do not need to connect those separately.`,
      note: 'Show the key ONCE and say plainly it cannot be recovered. Point at the web setup page if they would rather follow screenshots than build a Shortcut in a chat window.',
      next_actions: ['brief tomorrow morning, once the first push has landed'],
    };
  }

  // ── Everything else: say what is actually true ────────────────────────────
  // Nothing here fakes an OAuth flow that does not exist yet, and nothing
  // implies the user is waiting on something they are not.
  await supabase.from('wrought_connections')
    .upsert({ user_id: user.id, provider: args.provider, mode: p.mode, status: 'requested' },
            { onConflict: 'user_id,provider' });

  const door = PROVIDERS[p.aggregated_via];

  return {
    provider: args.provider,
    mode: p.mode,
    status: p.status,
    works_today_via: p.aggregated_via || null,
    say: p.say + (door ? ` Connecting ${door.name} gets you their data today.` : ''),
    note: p.status === 'aggregated'
      ? 'This one has no API for anybody — going through the phone is the only route that exists, not a compromise. Say that plainly rather than apologising for it.'
      : 'Do not imply this is connected or pending on their side. It is a build item on ours, and the aggregator route is a genuine answer in the meantime.',
    next_actions: [`connect_device with provider "${p.aggregated_via || 'apple_health'}"`],
  };
}

// ── Tools: memory ───────────────────────────────────────────────────────────

async function remember(args, user) {
  const fact = String(args.fact || '').trim();
  if (!fact) return { error: 'A fact is required.' };
  await rememberFact(user.id, fact, args.category || 'general');
  return {
    remembered: fact,
    category: args.category || 'general',
    say: 'Noted — you will not have to say that again.',
    note: 'Acknowledge in a few words. This fact now shapes every future suggestion.',
  };
}

async function recall(args, user) {
  const memory = await getMemory(user.id, args.category);
  return {
    memory: memory.map(m => ({ fact: m.fact, category: m.category, since: m.created_at?.slice(0, 10) })),
    count: memory.length,
    say: memory.length
      ? `${memory.length} thing${memory.length === 1 ? '' : 's'} remembered: ${memory.slice(0, 5).map(m => m.fact).join('; ')}${memory.length > 5 ? '…' : ''}`
      : 'Nothing remembered yet.',
    note: 'Honour every constraint here without renegotiating it, especially injuries.',
  };
}

// ── Protocol ────────────────────────────────────────────────────────────────

const IMPL = {
  log, brief, progress,
  whats_next: whatsNext,
  suggest_workout: suggestWorkout,
  start_session: startSession,
  log_set: logSet,
  end_session: endSession,
  save_routine: saveRoutine,
  list_routines: listRoutines,
  energy_balance: energyBalanceTool,
  nutrition,
  earned_room: earnedRoomTool,
  get_day: getDay,
  search_log: searchLog,
  log_weight: logWeight,
  log_measurement: logMeasurement,
  amend_last: amendLast,
  undo_last: undoLast,
  get_profile: getProfileTool,
  set_profile: setProfile,
  set_goal: setGoal,
  set_eating_window: setEatingWindow,
  log_fast: logFast,
  programmes,
  connect_device: connectDevice,
  remember, recall,
};

export async function handleRpc(msg, authUser) {
  const { id, method, params = {} } = msg;

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: params.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'wrought', title: 'WROUGHT — training and nutrition memory', version: '1.0.0' },
        instructions: SERVER_INSTRUCTIONS,
      });

    case 'ping':
      return rpcResult(id, {});

    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });

    case 'tools/call': {
      const impl = IMPL[params.name];
      if (!impl) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
      // Auth is checked before server config on purpose: an anonymous caller
      // gets the 401 challenge that triggers "Sign in with Wrought" either way,
      // and a stranger has no business learning whether we are configured.
      if (!authUser) return { __unauthorized: true, id };
      if (!supabase) return rpcError(id, -32603, 'Server not configured');

      try {
        const out = await impl(params.arguments || {}, authUser);
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          isError: Boolean(out && out.error),
        });
      } catch (err) {
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify({ error: 'tool_failed', detail: err.message }) }],
          isError: true,
        });
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  if (event.httpMethod === 'GET' || event.httpMethod === 'DELETE') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'This MCP server is stateless — POST JSON-RPC messages here.' }) };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  }

  const rawBody = event.isBase64Encoded && event.body
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : (event.body || '{}');

  let msg;
  try { msg = JSON.parse(rawBody || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify(rpcError(null, -32700, 'Parse error')) }; }

  // Notifications carry no id and get accepted with no body.
  if (msg && msg.method && msg.id === undefined) {
    return { statusCode: 202, headers: CORS, body: '' };
  }
  if (!msg || !msg.method) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify(rpcError(msg?.id ?? null, -32600, 'Invalid request')) };
  }

  // The handshake answers without auth so any client can discover the toolset.
  // Actually using a tool requires sign-in, and that 401 is what makes
  // "Sign in with Wrought" appear inside ChatGPT and Claude.
  const authUser = await getAuthUser(event);
  const response = await handleRpc(msg, authUser);
  if (response && response.__unauthorized) return unauthorized(response.id);

  return { statusCode: 200, headers: CORS, body: JSON.stringify(response) };
};

export { TOOLS, SERVER_INSTRUCTIONS };
