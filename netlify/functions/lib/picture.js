// netlify/functions/lib/picture.js
// The link from a reply to its day card as a picture — the connector's half.
//
// The renderer lives in lib/cardimage.js and is loaded only by the picture
// function, so the connector never pays to start it. This half mints the
// address, keeps the view the reply carried, and builds the one markdown line
// a chat shows.

import { randomBytes } from 'node:crypto';
import { DAY_CARD_NOTE, PICTURE_NOTE } from './dayread.js';

// 128 random bits, base64url: 22 characters. The whole of the key.
export const PICTURE_ID = /^[A-Za-z0-9_-]{22}$/;
export const newPictureId = () => randomBytes(16).toString('base64url');

// The site's own address — Netlify's primary URL, which is wrought.fit.
export const pictureBase = () => (process.env.URL || 'https://wrought.fit').replace(/\/+$/, '');
export const pictureUrl = id => `${pictureBase()}/c/${id}.png`;

/** The alt text: what the picture is, for anyone who cannot see it. */
export function pictureAlt(view) {
  const title = typeof view?.intake?.title === 'string' ? view.intake.title : 'the day';
  const fig = typeof view?.intake?.figure === 'string' ? `${view.intake.figure} calories` : null;
  return ['Wrought day card', title, fig].filter(Boolean).join(' — ').replace(/[[\]\n]/g, ' ');
}

/** The one line a chat renders as the picture. */
export const pictureMarkdown = (url, view) => `![${pictureAlt(view)}](${url})`;

/**
 * Keep the view a reply carried and return its picture's address — or null,
 * on anything short of a row that is certainly there. Bounded, because a reply
 * must never wait on a picture: with no picture the reply keeps day_card, the
 * table it has always had.
 */
export async function savePicture(db, userId, view, { timeoutMs = 1500 } = {}) {
  if (!db || !userId || !view || view.kind !== 'day') return null;
  const id = newPictureId();
  try {
    const { error } = await db.from('wrought_card_pictures')
      .insert({ id, user_id: userId, view })
      .abortSignal(AbortSignal.timeout(timeoutMs));
    return error ? null : pictureUrl(id);
  } catch {
    return null;
  }
}

/**
 * The reply with its day card as a picture: `card_image` directly above
 * `day_card` (which stays, as data, for anything that reads it), and the
 * note's show-the-table instruction swapped for show-the-picture. A reply
 * with no day_card is returned as it was — the picture only ever stands in
 * for the card, never arrives on a reply that did not carry one.
 */
export function pictured(body, md) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.day_card !== 'string' || !md) return body;
  const swapped = typeof body.note === 'string' && body.note.includes(DAY_CARD_NOTE);
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'day_card') {
      out.card_image = md;
      // A note that never said "show day_card" gets the rule beside the picture.
      if (!swapped) out.card_image_note = PICTURE_NOTE;
    }
    out[k] = k === 'note' && swapped ? v.split(DAY_CARD_NOTE).join(PICTURE_NOTE) : v;
  }
  return out;
}
