// netlify/functions/card-image.js
// GET /c/:id.png — a reply's day card, drawn as a picture.
//
// The chat that cannot draw Wrought's card itself (a ChatGPT that has not
// reloaded Wrought's tools) shows this instead: the same card, the same
// figures, in Wrought's colours, as a PNG the reply links to. See
// lib/cardimage.js for the drawing and lib/picture.js for the link.
//
// The address is the key — 128 random bits, nothing guessable — and the view
// behind it is frozen as the reply carried it, so the response never changes
// and can be cached for good. Nothing else is served from here: no listing,
// no lookup by user, no lookup by date.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { supabase as db } from './lib/wrought.js';
import { renderCardPng } from './lib/cardimage.js';
import { PICTURE_ID } from './lib/picture.js';

// Where the bundle keeps the renderer's wasm and the fonts. Netlify ships
// included_files and external modules at their paths under the bundle root;
// every place that root can be is tried, so a change in how the bundle is laid
// out costs a lookup, never a broken picture.
function roots() {
  const out = [process.cwd(), process.env.LAMBDA_TASK_ROOT, path.resolve('.')];
  try { out.unshift(path.dirname(new URL(import.meta.url).pathname)); } catch { /* not ESM */ }
  return [...new Set(out.filter(Boolean))];
}
const ASSETS = {
  wasm: ['node_modules/@resvg/resvg-wasm/index_bg.wasm', '../../node_modules/@resvg/resvg-wasm/index_bg.wasm'],
  font: f => [`netlify/functions/assets/fonts/${f}`, `assets/fonts/${f}`],
};
const found = new Map();
export function assetPath(name) {
  if (found.has(name)) return found.get(name);
  const rels = name === 'wasm' ? ASSETS.wasm : ASSETS.font(name);
  for (const root of roots()) {
    for (const rel of rels) {
      const p = path.resolve(root, rel);
      if (existsSync(p)) { found.set(name, p); return p; }
    }
  }
  throw new Error(`asset not in the bundle: ${name}`);
}
const load = async name => readFileSync(assetPath(name));

const text = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, body });

export const handler = async (event) => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'HEAD') return text(405, 'GET only');
  // /c/<id>.png arrives through the redirect as the last path segment.
  const seg = String(event.path || '').split('/').pop() || '';
  const id = seg.replace(/\.png$/i, '');
  if (!PICTURE_ID.test(id)) return text(404, 'Not found');
  if (!db) return text(503, 'Not configured');

  const { data: row, error } = await db.from('wrought_card_pictures').select('view, first_seen_at').eq('id', id).maybeSingle();
  if (error) return text(503, 'Could not read the picture just now');
  if (!row) return text(404, 'Not found');

  let png;
  try {
    png = await renderCardPng(row.view, load);
  } catch (e) {
    console.log(JSON.stringify({ picture: 'render_failed', message: String(e?.message || e).slice(0, 200) }));
    return text(500, 'Could not draw the picture');
  }
  // The first fetch is the only proof a chat drew it. Recorded once, and never
  // allowed to cost the picture.
  if (!row.first_seen_at) {
    await db.from('wrought_card_pictures').update({ first_seen_at: new Date().toISOString() })
      .eq('id', id).is('first_seen_at', null).then(() => {}, () => {});
  }
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'image/png',
      // Frozen behind an unguessable address: the bytes never change.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
    },
    body: event.httpMethod === 'HEAD' ? '' : png.toString('base64'),
    isBase64Encoded: event.httpMethod !== 'HEAD',
  };
};
