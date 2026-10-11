// netlify/functions/lib/picture.js
// The link from a reply to its day card as a picture — the connector's half.
//
// The renderer lives in lib/cardimage.js and is loaded only by the picture
// function, so the connector never pays to start it. This half mints the
// address, keeps the view the reply carried, and builds the one markdown line
// a chat shows.

import { randomBytes } from 'node:crypto';

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
