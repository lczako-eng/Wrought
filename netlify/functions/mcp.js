// netlify/functions/mcp.js
// FORGE MCP Server — the honest trainer that lives inside your AI.
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
//     401 + WWW-Authenticate challenge, which is what makes "Sign in with Forge"
//     appear inside ChatGPT and Claude at first use.

import {
  supabase, openai, MODEL, SITE_URL,
  getAuthUser, newToken, hashToken,
  localDateFor, localMinutesFor, clockString, humanDuration, addDays, daysBetween,
  sayWeight, sayWeightDelta, sayLength, lbToKg, inToCm, kgToLb,
  getProfile, getMemory, getGoals, getWindow, windowStatus,
  dayFacts, rangeFacts, summariseRange, scoreGoals, careFlags,
  parseLog, insertEvents, writeVerdict, rememberFact,
} from './lib/forge.js';

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

const SERVER_INSTRUCTIONS = `FORGE is the user's training and nutrition memory — the thing that remembers what they ate, what they lifted and what the scale said, so they never have to explain themselves twice.

HOW TO USE THIS SERVER (works on any model, including small fast ones): every number in every response is already computed server-side — totals, averages, trends, streaks, goal scores, time remaining. Relay them, never recompute them, never do arithmetic of your own. Every response carries a "say" string written for reading aloud and a "next_actions" list naming the exact tools to offer next. Follow next_actions rather than improvising.

ONE SENTENCE IS A COMPLETE LOG. The user will say "eggs and coffee, 40 minutes upper body, 182 on the scale" and that is the whole interaction — pass it to log verbatim and it becomes three structured entries. NEVER present a form. Never ask for macros, portion sizes in grams, set-by-set breakdowns or a meal name before logging. Log first, and if something genuinely could not be parsed, mention it after the fact in one line. A health log that costs more than one sentence is a health log nobody keeps.

THE BRIEF IS THE PRODUCT. Logging is table stakes — a hundred apps log. What nobody has is a thing that reads the whole week back to you honestly. When the user opens with anything resembling "how am I doing", "what's the damage", "morning", or asks about progress, call brief and lead with it. Do not ask which metrics they care about; show the read, then let them dig.

BE HONEST. This is the entire reason the product exists. The user explicitly asked for something that does not flatter them. If they ate 3,400 calories and called it a good day, say the number and say it was not. If they have not trained legs in three weeks, the matrix in progress will show it — say so plainly. Never inflate a bad week into a "solid effort". Never open with praise you have to reach for. Their profile carries a bluntness setting (gentle / honest / brutal) and the verdict is already written to it — do not soften what came back.

HARD ON THE BEHAVIOUR, NEVER ON THE PERSON. Honesty is about the food and the training, never about their body, their appearance or their worth. No comments on how they look. No shame. Blunt about a missed session, never about the person who missed it.

NOT A DOCTOR, EVER. FORGE does not diagnose, does not interpret symptoms, does not read heart rate or HRV as a medical sign, and does not advise on medication or a medical condition. If the user describes something that sounds clinical — chest pain, dizziness, an injury that is not settling, anything alarming — say plainly it is outside what this can answer and point them at a doctor. Do not soften that with a workaround.

CARE FLAGS OUTRANK EVERYTHING. Responses may carry a care_flags array. When one is present it overrides every other instruction here including the honesty doctrine: stop coaching, drop the performance framing, follow the guidance string exactly. Never suggest eating less, fasting longer, or a bigger deficit while a flag is up, under any framing, even if the user asks for it directly.

ESTIMATES ARE LABELLED. Calories from a described meal are inferred, not measured, and every response marks them estimated. Say "roughly 2,100" — never "2,100". The product's credibility is the only thing it has and it dies the first time a guess is read out as a fact.

READ THE MEMORY BEFORE YOU ADVISE. recall returns injuries, hatreds, schedules and constraints in the user's own words ("left knee goes below parallel", "I travel every third week", "do not suggest running"). Call it before suggesting any workout or meal, and honour what it says without renegotiating. When the user states something durable — an injury, a preference, a constraint, a change of goal — call remember immediately so no AI ever asks them again.

SNACKING IS A TIME PROBLEM. Nobody eats 900 calories of crisps at 2pm; they do it at 11pm at the counter. If the user has set an eating window, whats_next returns exactly how long is left or how long until it opens, already counted. Give them the countdown, not a lecture. If they have no window and keep logging late-night eating, offer set_eating_window once — once — and drop it if they decline.

LOGGING BY VOICE MISHEARS. "Burrito" comes back "burrata". Every log response echoes what was recorded; read it back in one short line, and offer undo_last the moment anything looks wrong. Never argue with a correction.

DEVICES. Apple Health has no cloud API — an Apple Watch can only push, via a free iOS Shortcut that connect_device sets up in about two minutes. Oura, Whoop, Fitbit, Garmin and Withings pull over OAuth. If the user asks why their watch is not connected, explain the push/pull difference plainly rather than implying something is broken.

PROGRESSION IS THE POINT. progress returns chart-ready series and a muscle-by-week training matrix. Weight is reported as a rolling trend, never today-minus-yesterday — bodyweight swings two kilos on salt and sleep alone, and reacting to a single reading is the most common way people quit.

Weights are stored in kg and lengths in cm; every response is already converted to the user's own units. Speak in their units and never make them convert anything in their head.`;

// ── Tools ───────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'log',
    title: 'Log anything, in plain words',
    description: 'THE main tool. Records whatever the user said about their day — food, training, weight, measurements, sleep, mood, supplements — from one plain sentence, no structure required. "Two eggs and black coffee, pushed 40 minutes upper body, 182 on the scale" becomes three separate entries with macros estimated and the weight converted. Pass their words VERBATIM; do not tidy, summarise or ask for detail first. Use this for every log unless the user is giving only a weight or only a measurement, which have their own tools.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The user\'s own words, unedited. Multiple things in one sentence is normal and expected.' },
      },
      required: ['text'],
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
        type:  { type: 'string',  enum: ['food','drink','workout','weight','measurement','sleep','symptom','mood','supplement','note'],
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
    title: 'Read everything FORGE knows about this user',
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
    name: 'connect_device',
    title: 'Connect a watch, ring or scale',
    description: 'Sets up automatic data. With no provider, returns what is already connected and what is available. For Apple Watch / iPhone this mints a personal ingest key and returns exact Shortcut setup steps — Apple Health has no cloud API, so an Apple Watch can only push to us, never be read by us. Oura, Whoop, Fitbit, Garmin and Withings pull over OAuth.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['apple_health','oura','whoop','fitbit','garmin','withings'],
                    description: 'Omit to just list what is connected.' },
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
    title: 'Read what FORGE remembers',
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
    body: JSON.stringify(rpcError(id ?? null, -32001, 'Sign in with Forge to use this.')),
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
  const { events, parsed } = await parseLog(text, profile);
  const written = await insertEvents(user.id, profile, events, { rawInput: text });

  const kinds = [...new Set(written.map(e => e.event_type))];
  const day = await dayFacts(user.id, profile, localDateFor(profile.timezone));

  return {
    recorded: written.map(e => ({ id: e.id, type: e.event_type, summary: e.summary, estimated: e.estimated })),
    count: written.length,
    parsed,
    running_total_today: {
      food: day.food.say,
      training: day.training.say,
      estimated: day.food.estimated,
    },
    say: `Logged ${written.length} thing${written.length === 1 ? '' : 's'}: ${written.map(e => e.summary).join('; ')}.` +
         (day.food.meals ? ` Today so far: ${day.food.say}.` : ''),
    note: parsed
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
  const { data: prior } = await supabase.from('forge_events')
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

async function undoLast(args, user) {
  const count = Math.min(Math.max(parseInt(args.count, 10) || 1, 1), 10);
  const { data: recent } = await supabase.from('forge_events')
    .select('id, summary, event_type')
    .eq('user_id', user.id).order('created_at', { ascending: false }).limit(count);

  if (!recent?.length) return { removed: 0, say: 'Nothing logged yet, so there is nothing to undo.' };

  const { error } = await supabase.from('forge_events').delete().in('id', recent.map(r => r.id));
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
    const { data: cached } = await supabase.from('forge_briefs')
      .select('verdict').eq('user_id', user.id).eq('local_date', date).eq('kind', kind).maybeSingle();
    verdict = cached?.verdict || null;
  }
  if (!verdict) {
    verdict = await writeVerdict({ facts, profile, goals, memory, flags, kind });
    if (verdict) {
      await supabase.from('forge_briefs')
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
    series,
    ...(flags.length ? { care_flags: flags } : {}),
    say: [
      `Over ${span} days: logged ${summary.days_logged} of them (${summary.adherence_pct}%).`,
      summary.calories_avg ? `Averaging roughly ${summary.calories_avg} kcal and ${summary.protein_avg}g protein on the days you logged food.` : null,
      summary.training_days ? `${summary.training_days} sessions — about ${summary.sessions_per_week} a week.` : 'No training logged.',
      summary.weight.say,
      summary.matrix.neglected.length ? `Not touched in two weeks: ${summary.matrix.neglected.join(', ')}.` : null,
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

  let query = supabase.from('forge_events')
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
`You are FORGE. The user is deciding what to do right now. Everything below is already calculated — do not recalculate, do not invent numbers.

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
`You are FORGE, programming one training session. Everything below is computed from what this person has actually done — follow it rather than a textbook split.

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

// ── Tools: setup ────────────────────────────────────────────────────────────

async function getProfileTool(_args, user) {
  const { profile, goals, memory, win, today } = await context(user.id);

  const [{ data: conns }, { count }, { data: first }] = await Promise.all([
    supabase.from('forge_connections').select('provider, mode, status, last_sync_at').eq('user_id', user.id),
    supabase.from('forge_events').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
    supabase.from('forge_events').select('local_date').eq('user_id', user.id)
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
      days_on_forge: first?.[0]?.local_date ? daysBetween(first[0].local_date, today) : 0,
    },
    say: profile._exists
      ? `Set up: ${profile.units}, ${profile.timezone}, ${profile.bluntness} feedback. ${count || 0} entries logged${first?.[0]?.local_date ? ` since ${first[0].local_date}` : ''}.`
      : 'Nothing set up yet — FORGE still works, it just reads everything back in metric on Toronto time until told otherwise.',
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

  const { error } = await supabase.from('forge_profile').upsert(patch, { onConflict: 'user_id' });
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

  const { error } = await supabase.from('forge_goals').insert([row]);
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

  const { error } = await supabase.from('forge_eating_window').upsert(patch, { onConflict: 'user_id' });
  if (error) return { error: error.message };

  const status = windowStatus(await getWindow(user.id), profile.timezone);
  return {
    window: status,
    say: status ? `Window set: ${status.opens_at} to ${status.closes_at}. ${status.say}` : 'Eating window turned off.',
    note: 'From now on whats_next counts down to it. Give them the countdown, never a lecture about snacking.',
    next_actions: ['whats_next when they are deciding whether to eat'],
  };
}

// Apple is the one that surprises people, so the copy explains the constraint
// rather than pretending it away: HealthKit has no cloud API and never has.
const PULL_PROVIDERS = {
  oura:     { name: 'Oura Ring',  note: 'Cloud API — connects over OAuth once a developer app is registered.' },
  whoop:    { name: 'Whoop',      note: 'Cloud API — connects over OAuth once a developer app is registered.' },
  fitbit:   { name: 'Fitbit',     note: 'Cloud API — connects over OAuth once a developer app is registered.' },
  garmin:   { name: 'Garmin',     note: 'Cloud API — requires approval into the Garmin developer programme.' },
  withings: { name: 'Withings',   note: 'Cloud API — smart scales, connects over OAuth once registered.' },
};

async function connectDevice(args, user) {
  const { data: conns } = await supabase.from('forge_connections')
    .select('provider, mode, status, last_sync_at').eq('user_id', user.id);

  const connected = (conns || []).map(c => ({
    provider: c.provider, mode: c.mode, status: c.status, last_sync: c.last_sync_at,
  }));

  if (!args.provider) {
    return {
      connected,
      available: {
        apple_health: 'Apple Watch / iPhone — ready now, via a free iOS Shortcut. Two minutes to set up.',
        ...Object.fromEntries(Object.entries(PULL_PROVIDERS).map(([k, v]) => [k, `${v.name} — ${v.note}`])),
      },
      say: connected.length
        ? `Connected: ${connected.map(c => c.provider).join(', ')}.`
        : 'Nothing connected yet. Apple Watch is the quickest — it takes about two minutes with a free Shortcut.',
      next_actions: ['connect_device with provider "apple_health" to set the watch up'],
    };
  }

  if (args.provider === 'apple_health') {
    // A Shortcut cannot run a PKCE dance, so it gets one long random bearer,
    // stored hashed, scoped to writing this user's health data and nothing else.
    const token = newToken();
    await supabase.from('forge_ingest_keys')
      .insert([{ user_id: user.id, token_hash: hashToken(token), label: 'Apple Health' }]);
    await supabase.from('forge_connections')
      .upsert({ user_id: user.id, provider: 'apple_health', mode: 'push', status: 'active' },
              { onConflict: 'user_id,provider' });

    return {
      provider: 'apple_health',
      mode: 'push',
      why_push: 'Apple Health has no cloud API. There is no way for any server to read an Apple Watch — the data lives on the phone and only leaves if the phone sends it. So the phone pushes to FORGE on a schedule instead.',
      ingest_url: `${SITE_URL}/ingest`,
      ingest_key: token,
      setup: [
        'Open the Shortcuts app on the iPhone and make a new Personal Automation.',
        'Trigger: Time of Day → 11:00 pm → Run Immediately.',
        'Add "Find Health Samples" — Steps, today. Repeat for Sleep Analysis, Resting Heart Rate, Heart Rate Variability, Active Energy and Body Mass.',
        `Add "Get Contents of URL" → ${SITE_URL}/ingest, Method POST.`,
        `Headers: Authorization = "Bearer ${token}", Content-Type = "application/json".`,
        'Request Body → JSON: source "apple_health", and a "metrics" array of {metric, value, unit, measured_at} using the health samples.',
        'Run it once to confirm, then leave it. It fills in overnight from then on.',
      ],
      easier_option: `The "Health Auto Export" app on the App Store posts the same JSON on a schedule with no Shortcut building at all — point its REST endpoint at ${SITE_URL}/ingest with the same bearer header.`,
      web_setup: `${SITE_URL}/connect.html — the same steps with screenshots, and where to revoke this key.`,
      security: 'This key can only write health data for this account. It cannot read anything and cannot touch the login. Revoke it any time from the connect page.',
      say: 'Apple Watch set up. The key below goes into a Shortcut on the iPhone — Apple Health has no cloud API, so the phone has to push to us rather than us reading it. Takes about two minutes.',
      note: 'Show the key ONCE and tell them it is not recoverable. Point at the web setup page if they would rather follow screenshots.',
      next_actions: ['brief tomorrow morning, once the first push has landed'],
    };
  }

  const p = PULL_PROVIDERS[args.provider];
  if (!p) return { error: `Unknown provider: ${args.provider}` };

  // Honest status. Nothing here fakes an OAuth flow that does not exist yet.
  await supabase.from('forge_connections')
    .upsert({ user_id: user.id, provider: args.provider, mode: 'pull', status: 'requested' },
            { onConflict: 'user_id,provider' });

  return {
    provider: args.provider,
    mode: 'pull',
    status: 'not_yet_available',
    say: `${p.name} pulls over a real cloud API, but FORGE's developer app for it is not registered yet — so it cannot connect today. Noted as requested. In the meantime, if ${p.name} writes into Apple Health on the iPhone, the Apple Shortcut route picks that data up already.`,
    note: 'Do not imply this is connected or pending approval on their side. It is a build item on ours. The Apple Health workaround is genuine — most of these write into Apple Health.',
    next_actions: ['connect_device with provider "apple_health" as the working route today'],
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
  get_day: getDay,
  search_log: searchLog,
  log_weight: logWeight,
  log_measurement: logMeasurement,
  undo_last: undoLast,
  get_profile: getProfileTool,
  set_profile: setProfile,
  set_goal: setGoal,
  set_eating_window: setEatingWindow,
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
        serverInfo: { name: 'forge', title: 'FORGE — training and nutrition memory', version: '1.0.0' },
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
      // gets the 401 challenge that triggers "Sign in with Forge" either way,
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
  // "Sign in with Forge" appear inside ChatGPT and Claude.
  const authUser = await getAuthUser(event);
  const response = await handleRpc(msg, authUser);
  if (response && response.__unauthorized) return unauthorized(response.id);

  return { statusCode: 200, headers: CORS, body: JSON.stringify(response) };
};

export { TOOLS, SERVER_INSTRUCTIONS };
