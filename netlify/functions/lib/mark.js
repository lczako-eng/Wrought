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

/**
 * The reply with its say line marked, as a COPY — the tool's own object is
 * left untouched, because the drawn card is built from it and must not pick
 * the square up. No say, nothing to mark. Pure.
 */
export function markReply(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  if (typeof body.say !== 'string' || !body.say.trim()) return body;
  const say = body.say.startsWith(MARK) ? body.say : `${MARK} ${body.say}`;
  const out = { ...body, say };
  if (typeof out.note === 'string') {
    if (!out.note.includes(MARK_NOTE)) out.note = `${out.note.trimEnd()} ${MARK_NOTE}`;
  } else if (out.note === undefined) {
    out.note = MARK_NOTE;
  }
  return out;
}
