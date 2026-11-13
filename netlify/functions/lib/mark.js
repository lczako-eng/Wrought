// netlify/functions/lib/mark.js
// The orange square: how somebody can tell, in a chat, that Wrought answered.
//
// The founder's call, over the brand rule that nothing stands beside the
// name (14 October): ChatGPT's own text is black and white and no reply can
// colour it, so the one colour a reply CAN carry is a character. "Put the
// orange on it … only on the GPT [and] another AI … I want it always on
// there." So every reply that leaves through an AI door — the MCP connector
// and the custom GPT's Actions, both of which run through handleRpc — opens
// its say line with 🟧. Nowhere else: not the website, not the iPhone app,
// not a notification, not Siri (who would read it aloud), and not Wrought's
// own drawn card, which already carries the W tile.
//
// It rides IN the line the model relays rather than in an instruction alone,
// because an instruction is a request and the line is the text. A reply that
// says "logged" with no orange square in front of it is a reply Wrought did
// not write.

export const MARK = '🟧';

export const MARK_NOTE = `Open your reply with the say line as written, ${MARK} first — the orange square is how the person knows Wrought answered. Never put it on anything Wrought did not send.`;

// THE W ITSELF, where a chat can draw one (13 November). The founder, a month
// after the square: "I need the full symbol, not just an orange block." No
// character is the W, so the only way a chat's own text can carry it is a
// picture: a small banner — the W tile and the word in the slab on white
// paper, the card's own header — as one markdown image line ahead of the
// square. ChatGPT only: Claude draws Wrought's real card, tile and all, and
// does not show a remote image.
//
// A TRIAL, AND SAID AS ONE. Four card pictures went to ChatGPT in October and
// none was ever fetched. This differs in the one way that mattered then: it
// REPLACES nothing. The square still opens the line under it and the table is
// untouched, so a chat that drops the image shows exactly what it showed
// before. A screenshot from his phone is the only proof it draws.
//
// One fixed address, never one per reply: an address that changes every time
// is the shape of a link that smuggles data out, and the likeliest to be
// refused. WROUGHT_MARK_IMAGE=off takes it out without a deploy of code.
export const MARK_IMAGE_URL = 'https://wrought.fit/wrought-mark.png';
export const MARK_IMAGE = `![Wrought](${MARK_IMAGE_URL})`;

export const MARK_IMAGE_NOTE = `Open your reply with the say line as written: its first line is an image, ${MARK_IMAGE} — write that markdown out exactly, on a line of its own, never as a link and never in a code block (it draws Wrought's W) — then ${MARK} and the rest of the line. The W and the orange square are how the person knows Wrought answered. Never put either on anything Wrought did not send.`;

/** Off only when the environment says so. */
export const markImageOn = (env = process.env) => String(env?.WROUGHT_MARK_IMAGE || '').trim().toLowerCase() !== 'off';

/**
 * The reply with its say line marked, as a COPY — the tool's own object is
 * left untouched, because the drawn card is built from it and must not pick
 * the square up. No say, nothing to mark. `image` puts the W banner on a line
 * of its own ahead of the square. Pure.
 */
export function markReply(body, { image = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  if (typeof body.say !== 'string' || !body.say.trim()) return body;
  const bare = body.say.startsWith(MARK_IMAGE) ? body.say.slice(MARK_IMAGE.length).trimStart() : body.say;
  const squared = bare.startsWith(MARK) ? bare : `${MARK} ${bare}`;
  const say = image ? `${MARK_IMAGE}\n\n${squared}` : squared;
  const out = { ...body, say };
  const rule = image ? MARK_IMAGE_NOTE : MARK_NOTE;
  if (typeof out.note === 'string') {
    if (!out.note.includes(rule)) out.note = `${out.note.trimEnd()} ${rule}`;
  } else if (out.note === undefined) {
    out.note = rule;
  }
  return out;
}

/** The say line with Wrought's lead taken off: the image line, if any. For readers that pin how the line opens. */
export const afterImage = say => (typeof say === 'string' && say.startsWith(MARK_IMAGE) ? say.slice(MARK_IMAGE.length).trimStart() : say);
