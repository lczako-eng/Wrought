// netlify/functions/lib/style_routines.js
// Twenty-one written sessions, one in each tradition.
//
// The founder: "build the 21 — what you think their exact workouts would be —
// and put it into our database." So each STYLE in design.js, which shapes a
// session from patterns, now also has a fully WRITTEN session beside it: the
// movements, the sets and reps or the minutes, the rests, and a write-up that
// says what the session is for and how that tradition runs it.
//
// THE SAME HONESTY RULE AS THE STYLES, in every write-up: this is a session
// composed from that person's PUBLISHED methodology, in their tradition. It is
// not their programme, they did not write it, and nothing here is an
// endorsement. The name of the routine says "tradition" for exactly that
// reason. A test asserts every write-up carries the disclaimer.
//
// NOT ONE LOAD ANYWHERE. A written session from a famous tradition is the
// single most tempting place to put a working weight, because it would read
// as pedigree. The rack computes every load from the person's own history or
// hands them an RPE, exactly as it does for a session they wrote themselves.
// The harness greps every field for a weight.
//
// Movements are named the way the library names them where the library has
// them, so the record, the progression call and the volume count all match;
// where a tradition needs a movement the library does not carry (a heavy bag,
// a box squat, a Turkish get-up), it is named plainly — a saved routine is the
// person's own plan and "their gym has machines ours does not" already holds.
//
// Muscles use the library's vocabulary — legs, glutes, core, back, chest,
// shoulders, arms, full body — so the weekly dose counts these sessions.

const DISCLAIMER = 'Published methodology in his tradition — not his programme, and not an endorsement. No loads are written here: the rack works every weight out from your own history, or gives you an RPE.';

const lift = (name, sets, reps, rest_s, muscles, detail = null, cue = null) =>
  ({ name, sets, reps, minutes: null, detail, rest_s, muscles, cue });
const timed = (name, minutes, detail, muscles = ['full body'], cue = null) =>
  ({ name, sets: null, reps: null, minutes, detail, rest_s: 60, muscles, cue });

export const STYLE_ROUTINES = {
  // ── Boxing ─────────────────────────────────────────────────────────────
  boxing_camp: {
    name: 'Fight camp (Freddie Roach tradition)',
    kind: 'hybrid', tier: 'intermediate', est_minutes: 55,
    equipment: ['jump rope', 'heavy bag', 'exercise mat', 'treadmill'],
    notes: 'In the tradition of Freddie Roach: a camp session builds the engine by doing the work in rounds — three minutes on, one off, the way a fight is scored. Rope first to get the feet moving, shadowboxing to rehearse, then the bag for volume rather than power: relaxed hands, high output, breathe. Core after the rounds, roadwork last. Push the bag rounds; leave nothing in the tank on the last one. ' + DISCLAIMER,
    exercises: [
      timed('Jump rope', 9, '3 × 3-min rounds, 30 s off — light feet, stay on the toes'),
      timed('Shadowboxing', 9, '3 × 3-min rounds — footwork and head movement, every punch with a step'),
      timed('Heavy bag rounds', 12, '4 × 3-min rounds, 1 min rest — volume not power, hands relaxed'),
      timed('Mitt-work or bag combinations', 9, '3 × 3-min rounds of set combinations: 1-2, 1-2-3, 1-2-slip-2'),
      lift('Medicine ball slam', 3, 15, 45, ['core', 'full body'], null, 'Full extension overhead, slam through the floor.'),
      lift('Hanging Knee Raise', 3, 15, 45, ['core']),
      timed('Incline Walk', 12, 'roadwork finish — brisk, incline up, no hands on the rails', ['legs']),
    ],
  },
  drilled_fundamentals: {
    name: "Drilled fundamentals (Cus D'Amato tradition)",
    kind: 'hybrid', tier: 'intermediate', est_minutes: 50,
    equipment: ['heavy bag', 'slip rope', 'exercise mat'],
    notes: "In the tradition of Cus D'Amato: the same three combinations, thousands of times, until they are reflex — and the head never stops moving. Nothing new is added; the point is that what is already known cannot be done wrong under pressure. Shadowbox the numbered combinations, then the same three on the bag, then head movement on the rope until the slip is automatic. Core and push-ups for the frame. Quality on every single rep; if it gets sloppy, slow down. " + DISCLAIMER,
    exercises: [
      timed('Shadowboxing', 12, '4 × 3-min rounds — three numbered combinations only, slip and weave after every one'),
      timed('Heavy bag rounds', 12, '4 × 3-min rounds — the same three combinations, exact form, no free-styling'),
      timed('Slip rope', 6, '2 × 3-min rounds — slip, weave, slip, weave under the rope, hands up'),
      lift('Hanging Knee Raise', 4, 12, 45, ['core']),
      lift('Press-Up', 4, 15, 45, ['chest', 'arms']),
      timed('Plank', 4, '4 × 60 s holds, 30 s between', ['core']),
      timed('Incline Walk', 10, 'easy roadwork to finish', ['legs']),
    ],
  },
  corner_craft: {
    name: 'Corner craft (Angelo Dundee tradition)',
    kind: 'hybrid', tier: 'intermediate', est_minutes: 50,
    equipment: ['jump rope', 'heavy bag', 'medicine ball', 'rowing machine'],
    notes: 'In the tradition of Angelo Dundee: everything in the session serves the rounds. Rope, shadowbox, bag — then the trunk and the pulling muscles that keep the hands up in the ninth, and an interval on the rower to build the recovery between rounds. No bodybuilding, nothing decorative. Push the rower intervals; the bag rounds are for rhythm. ' + DISCLAIMER,
    exercises: [
      timed('Jump rope', 9, '3 × 3-min rounds, 30 s off'),
      timed('Shadowboxing', 9, '3 × 3-min rounds — rhythm, angles, in and out'),
      timed('Heavy bag rounds', 12, '4 × 3-min rounds, 1 min rest — work the body, then come upstairs'),
      lift('Medicine ball rotational throw', 3, 12, 45, ['core'], 'each side, against a wall', 'Turn the hips first; the arms only finish it.'),
      lift('Inverted Row', 3, 12, 60, ['back', 'arms']),
      timed('Plank', 3, '3 × 60 s', ['core']),
      timed('Rowing Machine', 10, '10 × (1 min hard, 1 min easy) — the recovery between rounds is what this builds', ['full body']),
    ],
  },
  sparring_volume: {
    name: 'Sparring-volume camp (Emanuel Steward tradition)',
    kind: 'hybrid', tier: 'advanced', est_minutes: 55,
    equipment: ['jump rope', 'heavy bag', 'exercise mat', 'rowing machine'],
    notes: 'In the tradition of Emanuel Steward: the engine is built by high technical volume — long rounds, short rests, and more of them than feels reasonable. Six rounds on the bag with thirty seconds between is the centre of the session; everything else is there to let the hands keep going. High-rep push-ups and knee raises at short rest, then a hard finish on the rower. Push the round count, not the power. ' + DISCLAIMER,
    exercises: [
      timed('Jump rope', 12, '4 × 3-min rounds, 30 s off — build to double-unders if you have them'),
      timed('Heavy bag rounds', 18, '6 × 3-min rounds, 30 s rest — long, technical, keep the output up in round six'),
      timed('Shadowboxing', 9, '3 × 3-min rounds at high output — this is the "sparring" round without a partner'),
      lift('Press-Up', 4, 20, 45, ['chest', 'arms']),
      lift('Hanging Knee Raise', 4, 20, 45, ['core']),
      timed('Rowing Machine', 8, '8 min hard, steady — empty the tank', ['full body']),
    ],
  },

  // ── Powerlifting and strength ──────────────────────────────────────────
  conjugate: {
    name: 'Conjugate method (Louie Simmons tradition)',
    kind: 'strength', tier: 'advanced', est_minutes: 60,
    equipment: ['barbell', 'rack', 'box', 'ab wheel'],
    notes: 'In the tradition of Louie Simmons: a max-effort lift first — worked up over several sets to a heavy triple on a VARIATION, which is rotated week to week so the top set stays fresh — then a speed lift done as many fast doubles with short rest, then the assistance that props both up: hamstrings, glutes and lower back, and a trunk that can brace. Push the max-effort top set; the speed doubles are about bar speed, so if it slows, stop. Rotate the variation next week (box squat → front squat → safety-bar squat). ' + DISCLAIMER,
    exercises: [
      lift('Box Squat', 5, 3, 180, ['legs', 'glutes'], 'max effort: work up over five sets to a heavy triple — this week\'s variation', 'Sit back to the box, pause, drive the hips through.'),
      lift('Deadlift', 8, 2, 45, ['legs', 'glutes', 'back'], 'dynamic effort: eight fast doubles, 45 s rest — bar speed is the point', 'If a double slows down, the set is over.'),
      lift('Romanian Deadlift', 3, 8, 120, ['glutes', 'legs', 'back']),
      lift('Hip Thrust', 3, 12, 90, ['glutes']),
      lift('Ab Wheel', 3, 10, 90, ['core']),
      lift("Farmer's Carry", 3, 1, 90, ['full body'], '40 m per set — heavy, upright, short steps'),
    ],
  },
  high_frequency: {
    name: 'High-frequency technique (Boris Sheiko tradition)',
    kind: 'strength', tier: 'advanced', est_minutes: 65,
    equipment: ['barbell', 'rack', 'bench'],
    notes: 'In the tradition of Boris Sheiko: the competition lifts practised OFTEN at moderate loads, in plenty of sets, so that the technique cannot be done wrong. Nothing here is near failure — every set should look identical to the first one. Squat, bench, then the deadlift, then a row for balance. The whole session is technique practice with weight on the bar; if a rep drifts, drop the load rather than the set. ' + DISCLAIMER,
    exercises: [
      lift('Back Squat', 5, 4, 150, ['legs', 'glutes'], 'moderate load — every rep textbook, none of them hard', 'Same depth, same bar path, all twenty reps.'),
      lift('Bench Press', 5, 4, 150, ['chest', 'shoulders', 'arms'], 'moderate load — pause on the chest, competition grip'),
      lift('Deadlift', 4, 4, 180, ['legs', 'glutes', 'back'], 'moderate load — reset every rep'),
      lift('Barbell Row', 4, 8, 120, ['back', 'arms']),
      timed('Plank', 3, '3 × 60 s', ['core']),
    ],
  },
  five_by_five: {
    name: 'Five by five (Bill Starr tradition)',
    kind: 'strength', tier: 'intermediate', est_minutes: 55,
    equipment: ['barbell', 'rack', 'bench'],
    notes: 'In the tradition of Bill Starr: five sets of five on three big lifts, and that is the whole session. The classic three are the squat, the bench and the power clean; the row stands in for the clean where nobody is coaching it. Work up across the five sets to the top set. This is the HEAVY day of the week — the light day is the same session at roughly four-fifths of the loads, the medium day in between; set those by day. Push the top set of squats; keep the bench honest. ' + DISCLAIMER,
    exercises: [
      lift('Back Squat', 5, 5, 180, ['legs', 'glutes'], 'work up across the five sets to a top set of five'),
      lift('Bench Press', 5, 5, 180, ['chest', 'shoulders', 'arms'], 'work up across the five sets'),
      lift('Barbell Row', 5, 5, 180, ['back', 'arms'], 'the clean\'s stand-in — pull explosively from the floor each rep'),
      lift('Hanging Knee Raise', 3, 12, 60, ['core']),
    ],
  },
  novice_linear: {
    name: 'Novice linear progression (Mark Rippetoe tradition)',
    kind: 'strength', tier: 'intermediate', est_minutes: 45,
    equipment: ['barbell', 'rack', 'bench', 'bars'],
    notes: 'In the tradition of Mark Rippetoe: a handful of barbell compounds, three sets of five, and a little more on the bar every session for as long as that keeps working. Two warm-up sets then three working sets on the squat and the bench; the deadlift is ONE work set, because it recovers slowest. Chin-ups to finish. Nothing else — the point is that the big lifts get all the recovery. Push the squat; add the smallest jump the bar allows next time. ' + DISCLAIMER,
    exercises: [
      lift('Back Squat', 3, 5, 180, ['legs', 'glutes'], 'three working sets after two warm-ups', 'Below parallel, every rep.'),
      lift('Bench Press', 3, 5, 180, ['chest', 'shoulders', 'arms'], 'three working sets'),
      lift('Deadlift', 1, 5, 180, ['legs', 'glutes', 'back'], 'ONE work set of five — it recovers slowest'),
      lift('Chin-Up', 3, 8, 120, ['back', 'arms'], 'as many clean reps as you have, up to eight'),
    ],
  },
  submax_monthly: {
    name: 'Sub-max monthly progression (Jim Wendler tradition)',
    kind: 'strength', tier: 'intermediate', est_minutes: 50,
    equipment: ['barbell', 'rack', 'bars'],
    notes: 'In the tradition of Jim Wendler: one main lift, three working sets that are deliberately sub-maximal, with the last set taken for as many good reps as are there — stopping with one left, never grinding. The bar goes up a little once a MONTH, not once a session, which is why it keeps going up. Assistance is plain: a push, a pull and a core movement at five sets of ten. This session\'s main lift is the press; rotate squat, bench and deadlift through the week. Push the last set of the press; leave the assistance easy. ' + DISCLAIMER,
    exercises: [
      lift('Overhead Press', 3, 5, 150, ['shoulders', 'arms'], 'three working sets, sub-max; the last set is a plus set — stop with a rep in hand', 'Nothing here should ever be a grind.'),
      lift('Dip', 5, 10, 90, ['chest', 'arms'], 'assistance push — easy'),
      lift('Chin-Up', 5, 10, 90, ['back', 'arms'], 'assistance pull — band if needed'),
      lift('Hanging Knee Raise', 5, 15, 60, ['core'], 'assistance core'),
    ],
  },

  // ── Strength and conditioning ──────────────────────────────────────────
  tempo_structural: {
    name: 'Tempo and structural balance (Charles Poliquin tradition)',
    kind: 'strength', tier: 'advanced', est_minutes: 55,
    equipment: ['barbell', 'rack', 'bars', 'dumbbells'],
    notes: 'In the tradition of Charles Poliquin: every rep is on a tempo — the numbers in each detail are seconds down, pause at the bottom, seconds up, pause at the top — and the session brings up the weak links so the big lifts can keep going. Front squat over back squat, supinated chins over pulldowns, and rotator-cuff work as a real movement rather than an afterthought. The tempo IS the load: if you cannot hold four seconds down, the weight is wrong. Short phases — change the movements every three weeks. ' + DISCLAIMER,
    exercises: [
      lift('Front Squat', 4, 8, 90, ['legs', 'glutes', 'core'], 'tempo 4-0-1-0', 'Four full seconds down, no pause, drive up, straight into the next.'),
      lift('Romanian Deadlift', 4, 8, 90, ['glutes', 'legs', 'back'], 'tempo 3-0-1-0'),
      lift('Chin-Up', 4, 6, 90, ['back', 'arms'], 'supinated grip, tempo 4-0-1-0'),
      lift('Dip', 4, 8, 90, ['chest', 'arms'], 'tempo 3-1-1-0'),
      lift('Dumbbell external rotation', 3, 12, 60, ['shoulders'], 'structural balance — elbow on the knee, slow', 'This is why the pressing keeps going up.'),
      lift("Farmer's Carry", 3, 1, 90, ['full body'], '30 m per set'),
    ],
  },
  periodised_block: {
    name: 'Periodised block — accumulation week (Tudor Bompa tradition)',
    kind: 'strength', tier: 'intermediate', est_minutes: 55,
    equipment: ['barbell', 'rack', 'bench', 'dumbbells'],
    notes: 'In the tradition of Tudor Bompa: training in PHASES, each with a purpose and an end. This is an accumulation-phase session — volume first, moderate loads, fours sets of ten on the compounds — which is followed by an intensification phase (fewer reps, heavier) and a planned deload before it is needed. The session on its own is only one week of a plan: start_block puts the phases in the calendar with the deload already in it. Push the volume; nothing here is near failure. ' + DISCLAIMER,
    exercises: [
      lift('Back Squat', 4, 10, 120, ['legs', 'glutes'], 'accumulation: moderate load, all forty reps clean'),
      lift('Bench Press', 4, 10, 120, ['chest', 'shoulders', 'arms']),
      lift('Barbell Row', 4, 10, 120, ['back', 'arms']),
      lift('Walking Lunge', 3, 12, 90, ['legs', 'glutes'], 'per leg'),
      timed('Plank', 3, '3 × 60 s', ['core']),
    ],
  },
  hard_easy: {
    name: 'Hard day (Bill Bowerman tradition)',
    kind: 'hybrid', tier: 'intermediate', est_minutes: 55,
    equipment: ['treadmill', 'dumbbells', 'exercise mat'],
    notes: 'In the tradition of Bill Bowerman: a hard day is earned by an easy one, and recovery is training. THIS is the hard day — intervals that take the engine somewhere uncomfortable, a walk to come down, and light strength for the legs that carry the running. TOMORROW IS THE EASY DAY: a walk or an easy twenty to thirty minutes, logged in a sentence, and it is not optional. Push the intervals; keep the strength work light and quick. ' + DISCLAIMER,
    exercises: [
      timed('Run intervals', 25, '6 × 3 min hard, 2 min easy — hard means you cannot speak in sentences', ['legs', 'full body'], 'The sixth should be as fast as the first.'),
      timed('Incline Walk', 10, 'come down — easy, incline up', ['legs']),
      lift('Goblet Squat', 3, 8, 90, ['legs', 'glutes'], 'light, quick'),
      lift('Step-Up', 3, 10, 60, ['legs', 'glutes'], 'per leg, light'),
      timed('Plank', 3, '3 × 45 s', ['core']),
    ],
  },
  aerobic_base: {
    name: 'Aerobic base (Arthur Lydiard tradition)',
    kind: 'cardio', tier: 'intermediate', est_minutes: 60,
    equipment: ['treadmill', 'exercise mat'],
    notes: 'In the tradition of Arthur Lydiard: the engine is built with months of easy miles before any speed is added, and the single rule is that it stays EASY — conversational the whole way; if you cannot talk, slow down. Most of the hour is one long steady effort. A few relaxed strides at the end keep the legs remembering how to turn over, and the strength work is light support, not a session of its own. Nothing here should feel hard; that is the point, and it is the part people get wrong. ' + DISCLAIMER,
    exercises: [
      timed('Easy run', 45, 'conversational pace throughout — walk breaks are allowed, hard efforts are not', ['legs', 'full body'], 'Slower than feels necessary is correct.'),
      timed('Strides', 5, '6 × 20 s relaxed and fast, walk back between — form, not effort', ['legs']),
      timed('Plank', 3, '3 × 45 s', ['core']),
      lift('Walking Lunge', 2, 12, 60, ['legs', 'glutes'], 'light support work, per leg'),
    ],
  },

  // ── Kettlebell and simplicity ──────────────────────────────────────────
  never_to_failure: {
    name: 'Strength, never to failure (Pavel Tsatsouline tradition)',
    kind: 'strength', tier: 'intermediate', est_minutes: 40,
    equipment: ['kettlebell', 'bars', 'exercise mat'],
    notes: 'In the tradition of Pavel Tsatsouline: strength is PRACTISED, not tested. Low reps, many sets, and every set ends while it is still crisp — reps in the tank on every one, never a grind, never near failure. Swings for the hinge and the engine, the get-up for the whole body, presses and squats for strength, and pull-ups at a rep count you could do again immediately. Stop each set fresh; the volume comes from the number of sets, not from how hard any one of them is. ' + DISCLAIMER,
    exercises: [
      lift('Kettlebell Swing', 10, 10, 60, ['glutes', 'legs', 'back'], 'two-hand or one-arm — every rep crisp, hips not arms', 'Stand tall at the top; the bell floats, you do not lift it.'),
      lift('Turkish get-up', 5, 1, 90, ['full body', 'core', 'shoulders'], 'per side, slow — one rep is one full get-up and down'),
      lift('Kettlebell press', 5, 3, 120, ['shoulders', 'arms'], 'per side — stop fresh'),
      lift('Goblet Squat', 5, 5, 90, ['legs', 'glutes']),
      lift('Pull-Up', 5, 3, 120, ['back', 'arms'], 'grease the groove — a number you could repeat straight away'),
    ],
  },
  easy_strength: {
    name: 'Easy strength (Dan John tradition)',
    kind: 'strength', tier: 'intermediate', est_minutes: 30,
    equipment: ['barbell', 'bars', 'dumbbells'],
    notes: 'In the tradition of Dan John: a few fundamental movements — a hinge, a push, a pull, a carry — done well, done often, and never turned into a grind. Two sets of five, EASY, leave three reps in the tank on every set, and go home. It feels like too little. It is not: the point is that you can do it again tomorrow, and the day after, and the strength arrives from showing up rather than from any one session. Do not add sets. Do not add movements. ' + DISCLAIMER,
    exercises: [
      lift('Deadlift', 2, 5, 120, ['legs', 'glutes', 'back'], 'easy — three reps in the tank', 'If it felt hard, it was too heavy.'),
      lift('Overhead Press', 2, 5, 120, ['shoulders', 'arms'], 'easy'),
      lift('Pull-Up', 2, 5, 120, ['back', 'arms'], 'easy — band if needed'),
      lift("Farmer's Carry", 2, 1, 90, ['full body'], '40 m per set, heavy enough to notice, light enough to walk tall'),
    ],
  },

  // ── Bodybuilding ───────────────────────────────────────────────────────
  bodybuilding_principles: {
    name: 'Bodybuilding principles — chest and back (Joe Weider tradition)',
    kind: 'strength', tier: 'intermediate', est_minutes: 55,
    equipment: ['barbell', 'bench', 'dumbbells', 'cable machine'],
    notes: 'In the tradition of Joe Weider: the published principles applied to a chest-and-back day — pyramid the loads up across the sets of the first movement, superset chest with back so one rests while the other works, hit each muscle from more than one angle, and finish with a peak-contraction movement where the squeeze is the rep. Sets of ten, a minute between supersets. Push the last set of each pair; the pump is information, not the goal. ' + DISCLAIMER,
    exercises: [
      lift('Bench Press', 4, 10, 60, ['chest', 'shoulders', 'arms'], 'pyramid up each set — superset with the row'),
      lift('Barbell Row', 4, 10, 60, ['back', 'arms'], 'superset with the bench'),
      lift('Dumbbell Bench Press', 3, 12, 60, ['chest', 'shoulders'], 'incline — a second angle on the chest; superset with the pulldown'),
      lift('Lat Pulldown', 3, 12, 60, ['back', 'arms'], 'superset with the incline'),
      lift('Dumbbell flye', 3, 15, 60, ['chest'], 'peak contraction — squeeze at the top for a count', 'The squeeze is the rep.'),
      lift('Seated Cable Row', 3, 12, 60, ['back'], 'hold the contraction for a count'),
      lift('Hanging Knee Raise', 3, 15, 60, ['core']),
    ],
  },
  strict_isolation: {
    name: 'Strict isolation — eight by eight (Vince Gironda tradition)',
    kind: 'strength', tier: 'advanced', est_minutes: 45,
    equipment: ['dumbbells', 'bench', 'cable machine'],
    notes: 'In the tradition of Vince Gironda: eight sets of eight on a few isolation-leaning movements, with only thirty seconds between sets — strict form, no momentum, no arch, the muscle doing all of it. The loads are lighter than you think and get lighter still as the sets pile up; that is the method, not a failure. Four movements, and the session is short because the rests are. Push the strictness, never the weight. ' + DISCLAIMER,
    exercises: [
      lift('Dumbbell Bench Press', 8, 8, 30, ['chest', 'arms'], 'strict — elbows wide, no arch, no bounce', 'Light. Thirty seconds. Go again.'),
      lift('Lat Pulldown', 8, 8, 30, ['back', 'arms'], 'to the chest, elbows down and back, strict'),
      lift('Sissy squat', 8, 8, 30, ['legs'], 'bodyweight or a light hold — quads only, hips forward', 'Hold a rack for balance; lean back, not down.'),
      lift('Dumbbell curl', 8, 8, 30, ['arms'], 'strict, no swing'),
    ],
  },
  one_hard_set: {
    name: 'One hard set — full body (Arthur Jones tradition)',
    kind: 'strength', tier: 'intermediate', est_minutes: 35,
    equipment: ['machines', 'ab wheel'],
    notes: 'In the tradition of Arthur Jones: one working set per movement, taken slowly — four seconds down — to the rep that will not come, then straight on to the next movement. Machines where possible, because failure on a machine is safe. Full body, biggest muscles first, and the whole thing is over in about half an hour. It is brief because it is hard; if you could do a second set, the first was not the set. Two or three of these a week, never on consecutive days. ' + DISCLAIMER,
    exercises: [
      lift('Leg Press', 1, 12, 120, ['legs', 'glutes'], 'one set: 4 s down, 2 s up, to the rep that will not come', 'The last rep is the one you cannot finish.'),
      lift('Leg curl', 1, 12, 120, ['legs'], 'one set, same tempo'),
      lift('Seated Cable Row', 1, 12, 120, ['back', 'arms'], 'one set, same tempo'),
      lift('Chest press machine', 1, 12, 120, ['chest', 'shoulders', 'arms'], 'one set, same tempo'),
      lift('Lat Pulldown', 1, 12, 120, ['back', 'arms'], 'one set, same tempo'),
      lift('Seated Dumbbell Press', 1, 12, 120, ['shoulders', 'arms'], 'one set, same tempo'),
      lift('Ab Wheel', 1, 15, 120, ['core'], 'one set, slow'),
    ],
  },
  brief_and_infrequent: {
    name: 'Brief and infrequent (Mike Mentzer tradition)',
    kind: 'strength', tier: 'advanced', est_minutes: 30,
    equipment: ['machines', 'bars'],
    notes: 'In the tradition of Mike Mentzer: very few sets, very hard, and more days off than most people are comfortable with. One warm-up set, then ONE all-out working set per movement on a slow tempo — four seconds down, two-second pause, four up — and a pre-exhaust pairing where the isolation movement empties the muscle before the compound finishes it. Five movements, half an hour, and the next session is four to seven days away. If you are tempted to add a set, you have missed the method. ' + DISCLAIMER,
    exercises: [
      lift('Leg extension', 1, 8, 60, ['legs'], 'pre-exhaust: one all-out set, 4-2-4 tempo, straight into the leg press'),
      lift('Leg Press', 1, 8, 180, ['legs', 'glutes'], 'one all-out set after the extension, 4-2-4 tempo'),
      lift('Lat Pulldown', 1, 6, 180, ['back', 'arms'], 'one all-out set, 4-2-4 tempo'),
      lift('Dip', 1, 6, 180, ['chest', 'arms'], 'one all-out set, 4-2-4 tempo'),
      lift('Seated Dumbbell Press', 1, 6, 180, ['shoulders', 'arms'], 'one all-out set, 4-2-4 tempo'),
    ],
  },
  seven_set_finisher: {
    name: 'Seven-set finisher — chest (Hany Rambod tradition)',
    kind: 'strength', tier: 'intermediate', est_minutes: 50,
    equipment: ['barbell', 'bench', 'dumbbells', 'cable machine', 'bars'],
    notes: 'In the tradition of Hany Rambod: ordinary heavy working sets first — a compound, a second angle, dips — and then the LAST movement for the muscle done as seven sets with only thirty to forty-five seconds between them, stretching at the bottom and squeezing at the top, so the muscle finishes full. The seven are the method; the sets before them are normal. Push the compound; on the seven, the load is light and the rest is short — do not lengthen it. ' + DISCLAIMER,
    exercises: [
      lift('Bench Press', 4, 10, 90, ['chest', 'shoulders', 'arms'], 'the heavy compound — normal working sets'),
      lift('Dumbbell Bench Press', 4, 10, 90, ['chest', 'shoulders'], 'incline — second angle'),
      lift('Dip', 3, 12, 90, ['chest', 'arms']),
      lift('Cable flye', 7, 12, 30, ['chest'], 'THE SEVEN: 30-45 s between sets, stretch at the bottom, squeeze at the top', 'Light. Short rest. Full at the end.'),
      lift('Hanging Knee Raise', 3, 15, 60, ['core']),
    ],
  },
  golden_era: {
    name: 'Golden-era chest and back (Arnold Schwarzenegger tradition)',
    kind: 'strength', tier: 'advanced', est_minutes: 70,
    equipment: ['barbell', 'bench', 'dumbbells', 'bars'],
    notes: 'In the tradition of the 1970s golden era Arnold Schwarzenegger trained in: chest and back on the same day, supersetted — a press with a pull, back and forth — five sets of ten on nearly everything, more movements than most people would use, ninety seconds between pairs. This is a lot of work and it is meant to be. Flat, incline and flye for the chest; wide chins, rows and a deadlift to finish for the back. Push the supersets; the deadlift at the end is three sets of eight, not a max. ' + DISCLAIMER,
    exercises: [
      lift('Bench Press', 5, 10, 90, ['chest', 'shoulders', 'arms'], 'superset with wide pull-ups'),
      lift('Pull-Up', 5, 10, 90, ['back', 'arms'], 'wide grip — superset with the bench'),
      lift('Dumbbell Bench Press', 5, 10, 90, ['chest', 'shoulders'], 'incline — superset with the row'),
      lift('Barbell Row', 5, 10, 90, ['back', 'arms'], 'superset with the incline'),
      lift('Dumbbell flye', 5, 10, 90, ['chest'], 'superset with the T-bar or dumbbell row'),
      lift('Dumbbell Row', 5, 10, 90, ['back', 'arms'], 'superset with the flye'),
      lift('Deadlift', 3, 8, 150, ['legs', 'glutes', 'back'], 'to finish — three sets of eight, not a max'),
    ],
  },
};

export const STYLE_ROUTINE_KEYS = Object.keys(STYLE_ROUTINES);

/** The written session for a style key, or null. */
export function styleRoutine(key) {
  return STYLE_ROUTINES[key] || null;
}
