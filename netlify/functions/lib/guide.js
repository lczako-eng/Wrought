// lib/guide.js
// How to use it, in the words somebody would actually say.
//
// The founder, before his first session with it: "can you get any prompts,
// questions and stuff? It's my first workout with it." And then the fix:
// put them IN THE APP.
//
// THE MANUAL IS EXAMPLE SENTENCES, NOT A FEATURE LIST. Nobody reads "supports
// natural-language logging with automatic macro inference" and knows what to
// type. They read "had a steak and a baked potato" and know immediately. The
// whole product is that you talk normally, so the manual has to be made of the
// talking — anything else teaches somebody a command language that does not
// exist and makes the thing look harder than it is.
//
// Shared by the `guide` tool and the app's own Guide tab, because a manual that
// disagrees with itself in two places is worse than one place.

export const GUIDE = {
  name: 'WROUGHT',

  meaning:
    'Wrought is the old past tense of "work" — what iron is called after enough ' +
    'fire and hammer to hold a shape. Nothing about wrought iron happened in one ' +
    'session. A body is the same: worked, repeatedly, honestly, over a long time. ' +
    'This holds the record of that work.',

  what_it_is:
    'The memory your AI does not have. Mention food, training, weight, sleep or a ' +
    'symptom in ANY conversation and it is kept — filed under the right day, ' +
    'forever — then read back honestly.',

  // Ordered the way somebody actually meets the product, not the way the code
  // is organised. Logging first, because it is the thing that costs nothing and
  // makes everything else work.
  sections: [
    {
      title: 'Just say it',
      note: 'One sentence is a complete log. Never a form, never "what were the macros".',
      lines: [
        'had a steak and a baked potato',
        'two eggs and black coffee',
        '330 this morning',
        'slept about six hours, badly',
        'just did ten push-ups',
        'worked at the petting zoo, about four hours on task',
      ],
      after:
        'It works in any conversation, not just this one. Mention push-ups while ' +
        'asking about a tax form and the push-ups get filed — quietly — and the ' +
        'tax conversation carries on.',
    },
    {
      title: 'Set it up — once',
      note: 'Five facts and a plan. Asked once, in passing, never as a signup form.',
      lines: [
        "I'm 6'3\", 330lb, born 1982, male, on my feet most days",
        'I want to lose weight, steady pace, four days a week, normal push',
        'make it aggressive',
        'ease off, this is too much',
        'stop nagging me about training',
      ],
      after:
        'Pace and push are separate on purpose. Pace is how fast the plan aims; ' +
        'push is how often training gets raised unprompted. Turning down the ' +
        'nagging must not turn down the honesty.',
    },
    {
      title: 'Get a workout',
      note: 'One line back with a proposal in it, not three questions.',
      lines: [
        "I'm going to the gym",
        "let's do legs tonight, an hour",
        'what should I train',
        "let's do S-Tier",
        "I'm at the home gym today",
        'give me a proper programme',
      ],
      after:
        'It picks what is most overdue from your own log. If your resting heart ' +
        'rate is up or you slept badly it says so BEFORE the plan and tells you to ' +
        'go lighter — the body gets a veto, never a spur.',
    },
    {
      title: 'At the rack',
      note: 'Say what happened. Anything about how it FELT is worth more than the number.',
      lines: [
        'got 8',
        '92.5 for 6',
        'failed at 5',
        'third set I rushed it',
        "someone's on the bench",
        "what's left",
        'that was legs, forty minutes',
      ],
      after:
        'You do not have to say "end session". Finish the last set and walk out — ' +
        'a session with sets in it is filed as training whether or not anybody ' +
        'closed it.',
    },
    {
      title: 'Save a workout you like',
      note: 'A name, the movements, and the reason it is in that order.',
      lines: [
        'save this as my S-Tier workout',
        "save a routine called S-Tier: bench 4×8, incline dumbbell 3×10, dips 3× to failure, " +
        "cable flyes 3×12. It's for chest volume — go heavy on bench, leave a rep in on the rest",
        'add incline treadmill, 10+ incline at 2–3mph for 25 minutes, to S-Tier',
        'what routines do I have',
      ],
      after:
        'The write-up is what makes it a workout rather than a list, and it is ' +
        'shown at the top every time you start it. It survives adding exercises later.',
    },
    {
      title: 'Show it your gym',
      note: 'A photograph of a gym is an equipment list.',
      lines: [
        'here are some pictures of my gym',
        "this is the hotel gym I'm in this week",
        'what can I actually do with this',
      ],
      after:
        'The AI reads the photographs — this server never sees them — and saves ' +
        'the equipment as it goes, so plans get built around machines that are ' +
        'actually there. More than one gym is normal; name them and it keeps them apart.',
    },
    {
      title: 'Ask how it is going',
      note: 'Every number is computed on the server. Nothing here is a language model guessing.',
      lines: [
        'gym bro',
        "what's the damage",
        'hit me',
        'how am I doing this week',
        "what's my plan",
        "I'm hungry",
        "it's late and I'm at the fridge",
        'talk me out of it',
      ],
      after:
        'The honesty is the point and the register is yours: gentle, honest or ' +
        'brutal. Say which. It is never about your body, only about what you did.',
    },
    {
      title: 'Fix something',
      note: 'Changing your mind is one sentence and never a negotiation.',
      lines: [
        'that was 28 minutes, not 20',
        'that steak was more like 400 grams',
        'undo that',
        'change my step goal to 12,000',
        'drop the protein goal',
      ],
      after:
        'A target you keep missing is a target set wrong. Lowering it gets no ' +
        'remark about commitment and no question about why.',
    },
  ],

  refuses: [
    'Flattery. The read is honest, in the register you chose.',
    'A guessed working weight. No history means an effort level, never an invented number.',
    'A calorie figure it made up. Every target is computed from your own body, floored at 1,200.',
    'Guilt. Sessions never roll over, fasts are never scored, a missed week is information.',
    'Coaching past a care flag. Eating too little, losing too fast, or no rest in 14 days stops the coaching entirely.',
    'Reading your photographs. Nothing ever estimates anything from a progress photo.',
    'Medicine. It is not a medical device, it says so, and it points at a doctor.',
  ],

  your_data:
    'Everything comes back on demand as JSON or CSV from the dashboard — always, ' +
    'even lapsed, even revoked.',
};

/** The tool's shape: the same content, flattened for reading aloud. */
export function guideRead() {
  return {
    name: GUIDE.name,
    meaning: GUIDE.meaning,
    what_it_is: GUIDE.what_it_is,
    how_to_use: GUIDE.sections.map(s => `${s.title}: ${s.lines.slice(0, 3).map(l => `"${l}"`).join(', ')}. ${s.note}`),
    examples: Object.fromEntries(GUIDE.sections.map(s => [s.title, s.lines])),
    what_it_refuses: GUIDE.refuses,
    your_data: `${GUIDE.your_data} More at wrought.fit/about and wrought.fit/privacy.html, and the same guide is in the app under Guide.`,
    say:
      'WROUGHT is the memory your AI does not have — say what you ate or lifted in ' +
      'any conversation and it is kept and read back honestly. The name is the old ' +
      'past tense of "work": what iron is called once it has been worked enough to ' +
      'hold a shape.',
    note:
      'Answer WHAT THEY ASKED, in their register, from these fields — do not recite ' +
      'the whole manual. If they are brand new, the one thing to land is: talk ' +
      'normally, one sentence is enough. Give example SENTENCES rather than naming ' +
      'tools; nobody says "call the brief tool".',
    next_actions: ['get_profile to see what is set up', 'brief for their first read once anything is logged'],
  };
}
