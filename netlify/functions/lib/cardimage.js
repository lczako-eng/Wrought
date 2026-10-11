// netlify/functions/lib/cardimage.js
// Wrought's card as a PICTURE — for the chat that cannot draw the card itself.
//
// ChatGPT draws Wrought's own card (lib/widgets.js) only after it has reloaded
// Wrought's tool list, and that reload is a Refresh button the founder's
// ChatGPT does not have. What every ChatGPT does draw, on every platform and
// with nothing reloaded, is an image the reply carries. So the same view the
// card is drawn from is drawn here as a PNG, and the reply carries its link.
//
// THE PICTURE COMPUTES NOTHING. It is handed the view `dayView` built — every
// leaf a string, the only numbers a bar's `share` and a ring's `arc`, both
// held to 0–100 on the server — and it prints those strings where the card
// prints them. A figure on the picture is a figure in the reply.
//
// NOTHING ON IT PRETENDS TO BE A BUTTON. A picture cannot be tapped, so the
// card's "Open your record" and "Show 2 earlier" do not appear: every row is
// drawn, and the foot names wrought.fit instead of offering a door.
//
// The colours are read off the card's own stylesheet, so the picture and the
// drawn card cannot drift apart: one palette, defined once.

import { WIDGET_CSS } from './widget_runtime.js';

// ── The palette, read from the card's :root ─────────────────────────────────
const ROOT = /:root\{([^}]*)\}/.exec(WIDGET_CSS)?.[1] || '';
export const TOKENS = Object.fromEntries([...ROOT.matchAll(/--wr-([a-z-]+):(#[0-9A-Fa-f]{3,8})/g)].map(m => [m[1], m[2]]));
const C = TOKENS;

export const WIDTH = 390;   // the phone layout, the one ChatGPT's column is closest to
export const SCALE = 2;     // drawn at 2x so it is sharp on a phone

const SANS = 'Inter';
const SLAB = 'Roboto Slab';
const MONO = 'JetBrains Mono';

/** The fonts the picture is set in — file names under assets/fonts. */
export const FONT_FILES = [
  { name: SANS, weight: 400, style: 'normal', file: 'inter-latin-400-normal.woff' },
  { name: SANS, weight: 400, style: 'italic', file: 'inter-latin-400-italic.woff' },
  { name: SANS, weight: 600, style: 'normal', file: 'inter-latin-600-normal.woff' },
  { name: SANS, weight: 700, style: 'normal', file: 'inter-latin-700-normal.woff' },
  { name: SANS, weight: 800, style: 'normal', file: 'inter-latin-800-normal.woff' },
  { name: SANS, weight: 900, style: 'normal', file: 'inter-latin-900-normal.woff' },
  // Latin Extended — ő, ű, ł and the rest, for a food named in its own language.
  { name: SANS, weight: 400, style: 'normal', file: 'inter-latin-ext-400-normal.woff' },
  { name: SANS, weight: 600, style: 'normal', file: 'inter-latin-ext-600-normal.woff' },
  { name: SANS, weight: 700, style: 'normal', file: 'inter-latin-ext-700-normal.woff' },
  { name: SLAB, weight: 700, style: 'normal', file: 'roboto-slab-latin-700-normal.woff' },
  { name: MONO, weight: 400, style: 'normal', file: 'jetbrains-mono-latin-400-normal.woff' },
  { name: MONO, weight: 700, style: 'normal', file: 'jetbrains-mono-latin-700-normal.woff' },
];

// ── Elements ────────────────────────────────────────────────────────────────
// Satori takes React-shaped objects. Every box with more than one child is a
// flex box — satori's own rule.
const str = x => (typeof x === 'string' ? x : '');
const list = x => (Array.isArray(x) ? x : []);
const share = x => (typeof x === 'number' && x >= 0 && x <= 100 ? x : null);
function el(type, style, ...kids) {
  const children = kids.flat().filter(k => k !== null && k !== undefined && k !== false && k !== '');
  return { type, props: { style: { display: 'flex', ...style }, children: children.length === 1 ? children[0] : children } };
}
const txt = (style, s) => (str(s) ? el('div', style, str(s)) : null);
const svgImg = (svg, w, h) => ({ type: 'img', props: { src: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, width: w, height: h, style: { width: w, height: h } } });

const cap = s => txt({ fontFamily: MONO, fontWeight: 700, fontSize: 9.5, lineHeight: 1.25, letterSpacing: 1.33, textTransform: 'uppercase', color: C.label, marginBottom: 5 }, s);
const rule = (style = {}) => ({ borderTop: `1px solid ${C.edge}`, ...style });

// The W tile, the same paths as the card's.
const TILE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F5A623"/><stop offset=".55" stop-color="#F26419"/><stop offset="1" stop-color="#C3350D"/></linearGradient></defs>' +
  '<rect width="512" height="512" rx="112" fill="#14110F"/><rect x="56" y="56" width="400" height="400" rx="76" fill="url(#g)"/>' +
  '<path fill="#14110F" d="M104 150 L206 150 L206 178 L182 183 L212 306 L238 183 L214 178 L214 150 L298 150 L298 178 L274 183 L304 306 L330 183 L306 178 L306 150 L408 150 L408 178 L386 184 L330 366 L276 366 L256 268 L236 366 L182 366 L126 184 L104 178 Z"/></svg>';

function ringSvg(arc, state) {
  const stroke = state === 'met' ? C.moss : state === 'over' ? C.heat : C.temper;
  const a = share(arc);
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36">' +
    `<circle cx="18" cy="18" r="15.9155" fill="none" stroke="${C.track}" stroke-width="4"/>` +
    // No arc at 0%: a zero-length dash with round caps still paints a dot.
    (a ? `<circle cx="18" cy="18" r="15.9155" fill="none" stroke="${stroke}" stroke-width="4" stroke-linecap="round" pathLength="100" stroke-dasharray="${a} 100" transform="rotate(-90 18 18)"/>` : '') +
    '</svg>';
}

// ── The sections ────────────────────────────────────────────────────────────
function strip(v) {
  const badge = str(v.badge);
  return el('div', { alignItems: 'center', gap: 8, padding: '11px 14px 8px', borderBottom: `1px solid ${C.edge}` },
    svgImg(TILE_SVG, 22, 22),
    el('div', { fontFamily: SLAB, fontWeight: 700, fontSize: 13, letterSpacing: 1.3, color: C.bright }, 'WROUGHT'),
    badge ? el('div', { fontFamily: MONO, fontWeight: 700, fontSize: 9.5, letterSpacing: 1.33, textTransform: 'uppercase', color: C['on-heat'], backgroundColor: C.heat, padding: '4px 6px 3px', borderRadius: 4 }, badge) : null,
    v.review ? el('div', { fontFamily: MONO, fontWeight: 700, fontSize: 9.5, letterSpacing: 1.33, color: C['amber-ink'], border: `1px solid ${C.amber}`, padding: '3px 5px 2px', borderRadius: 4 }, 'REVIEW') : null);
}

function justSection(just) {
  const rows = list(just?.rows).filter(r => r && typeof r === 'object');
  if (!rows.length) return null;
  return el('div', { flexDirection: 'column', padding: '9px 14px 9px 17px', borderBottom: `1px solid ${C.edge}`, borderLeft: `3px solid ${C.heat}`, backgroundImage: 'linear-gradient(90deg, rgba(242,100,25,0.08), rgba(242,100,25,0) 72%)' },
    cap(just.caption),
    ...rows.map((r, i) => {
      const meta = [r.at, r.macros, r.est].filter(x => typeof x === 'string' && x);
      return el('div', { flexDirection: 'column', marginTop: i ? 8 : 0 },
        el('div', { alignItems: 'baseline', gap: 10 },
          el('div', { flex: 1, fontSize: 14.5, lineHeight: 1.3, fontWeight: 600, color: C.bright }, str(r.what)),
          r.figure ? el('div', { fontWeight: 800, fontSize: 18, letterSpacing: -0.36, color: C.bright }, str(r.figure))
            : r.flag ? el('div', { fontFamily: MONO, fontWeight: 700, fontSize: 9.5, letterSpacing: 1.14, textTransform: 'uppercase', color: C['heat-ink'], border: `1px solid ${C.heat}`, padding: '3px 5px 2px', borderRadius: 4 }, str(r.flag)) : null),
        meta.length ? txt({ marginTop: 4, fontFamily: MONO, fontSize: 11, lineHeight: 1.45, color: C.ash }, meta.join(' · ')) : null,
        txt({ marginTop: 6, fontSize: 13, lineHeight: 1.4, color: C.bright }, r.gap));
    }));
}

function intakeSection(inn) {
  const rows = list(inn?.rows).filter(r => r && typeof r === 'object');
  if (!rows.length) {
    return el('div', { flexDirection: 'column', padding: '9px 14px', borderBottom: `1px solid ${C.edge}` },
      cap(inn?.title), txt({ fontSize: 13, lineHeight: 1.35, color: C.ash }, inn?.empty));
  }
  const fig = str(inn.figure)
    ? el('div', { alignItems: 'baseline' },
      el('div', { fontWeight: 900, fontSize: 40, lineHeight: 0.9, letterSpacing: -1.8, color: C.bright }, str(inn.figure)),
      str(inn.unit) ? el('div', { marginLeft: 7, fontWeight: 800, fontSize: 21, letterSpacing: -0.42, color: C.heat }, str(inn.unit)) : null)
    : el('div', { fontWeight: 800, fontSize: 22, lineHeight: 1.1, color: C.ash, fontStyle: 'italic' }, str(inn.figure_missing));
  const head = inn.head && typeof inn.head === 'object' ? inn.head : null;
  const tiles = list(inn.tiles).filter(t => t && ['protein', 'carbs', 'fat'].includes(t.key));
  const bar = { protein: C.temper, carbs: C.heat, fat: C['heat-hi'] };
  const total = inn.total && typeof inn.total === 'object' ? inn.total : null;
  return el('div', { flexDirection: 'column', padding: '9px 14px', borderBottom: `1px solid ${C.edge}` },
    el('div', { justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
      el('div', { flexDirection: 'column', flex: 1 }, cap(inn.title), el('div', { marginTop: 1 }, fig)),
      str(inn.pill) ? el('div', { padding: '5px 10px', borderRadius: 999, fontWeight: 600, fontSize: 12, color: C['heat-ink'], backgroundColor: 'rgba(242,100,25,0.1)', border: '1px solid rgba(242,100,25,0.35)' }, str(inn.pill)) : null),
    head ? el('div', { justifyContent: 'space-between', gap: 10, marginTop: 11, paddingBottom: 5, borderBottom: `1px solid ${C['edge-lit']}`, fontSize: 13, fontWeight: 700, color: C.bright },
      el('div', {}, str(head.what)), el('div', {}, str(head.kcal))) : null,
    ...rows.map((r, i) => el('div', { justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, padding: '5px 0', ...(i ? rule() : {}), fontSize: 14, lineHeight: 1.3 },
      // A picture has no inline flow, so the time sits under the item rather
      // than trailing it — the same small mono line the card sets it in.
      el('div', { flex: 1, flexDirection: 'column', color: C.bright, fontWeight: r.fresh ? 600 : 400 },
        el('div', {}, str(r.what)),
        str(r.at) ? el('div', { marginTop: 1, fontFamily: MONO, fontSize: 10.5, fontWeight: 400, color: r.fresh ? C['heat-ink'] : C.label }, str(r.at)) : null),
      r.uncounted
        ? el('div', { fontSize: 13, fontStyle: 'italic', color: C.ash }, str(r.kcal))
        : el('div', { fontWeight: 600, color: C.bright }, str(r.kcal)))),
    total ? el('div', { justifyContent: 'space-between', alignItems: 'baseline', gap: 12, paddingTop: 7, borderTop: `2px solid ${C['edge-lit']}`, fontSize: 14, fontWeight: 700, color: C.bright },
      el('div', {}, str(total.label)),
      total.unset ? el('div', { fontStyle: 'italic', fontWeight: 400, fontSize: 13, color: C.ash }, str(total.kcal))
        : el('div', { fontWeight: 800, fontSize: 18 }, str(total.kcal))) : null,
    tiles.length ? el('div', { gap: 8, marginTop: 10 }, ...tiles.map(t => el('div', { position: 'relative', flex: 1, flexDirection: 'column', gap: 3, padding: '8px 10px 11px', borderRadius: 12, backgroundColor: C.raise, border: `1px solid ${C.edge}`, overflow: 'hidden' },
      el('div', { fontSize: 12, lineHeight: 1.2, color: C.ash }, str(t.label)),
      el('div', { alignItems: 'baseline' },
        el('div', { fontWeight: 800, fontSize: 22, letterSpacing: -0.44, color: C.bright }, str(t.value)),
        el('div', { marginLeft: 3, fontWeight: 700, fontSize: 13, color: C.ash }, str(t.unit))),
      txt({ fontFamily: MONO, fontSize: 10, lineHeight: 1.25, color: C.label }, t.share_label),
      share(t.share) !== null ? el('div', { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, backgroundColor: C.track },
        el('div', { width: `${share(t.share)}%`, height: 3, backgroundColor: bar[t.key] })) : null))) : null,
    ...list(inn.captions).map(c => txt({ marginTop: 4, fontSize: 11, lineHeight: 1.35, color: C.ash }, c)));
}

function balanceSection(v) {
  const bal = v.balance && typeof v.balance === 'object' ? v.balance : {};
  const brow = (label, value, i, extra = {}) => el('div', { justifyContent: 'space-between', alignItems: 'baseline', gap: 10, padding: '2px 0', ...(i ? rule() : {}), fontSize: 12.5, lineHeight: 1.25, ...extra.row },
    el('div', { flex: 1, color: extra.strong ? C.bright : C.ash, fontWeight: extra.strong ? 600 : 400 }, str(label)),
    el('div', { fontWeight: 600, color: C.bright, ...extra.value }, str(value)));
  const rows = list(bal.rows).filter(r => r && typeof r === 'object');
  const net = bal.net && typeof bal.net === 'object' ? bal.net : null;
  const tone = net && { down: C['temper-ink'], over: C['heat-ink'], level: C['amber-ink'] }[net.tone];
  const notes = list(v.notes).filter(x => x && typeof x === 'object' && (x.text || x.strong));
  const rings = list(v.targets).filter(t => t && typeof t === 'object');
  return el('div', { flexDirection: 'column', padding: '9px 14px', borderBottom: `1px solid ${C.edge}` },
    cap(bal.title),
    str(bal.missing) ? txt({ fontSize: 11, lineHeight: 1.35, color: C.ash }, bal.missing) : el('div', { flexDirection: 'column' },
      ...rows.map((r, i) => brow(r.label, r.kcal, i)),
      bal.burn ? brow(bal.burn.label, bal.burn.kcal, 1, { strong: true, row: { borderTop: `1px solid ${C['edge-lit']}` } }) : null,
      net ? brow(net.label, net.value, 1, { strong: true, value: { fontWeight: 800, fontSize: 19, letterSpacing: -0.38, color: tone || C.bright } }) : null),
    txt({ marginTop: 8, fontSize: 12.5, lineHeight: 1.4, color: C.ash, fontStyle: 'italic' }, v.held),
    // The lead stays on the left and the sentence wraps under itself.
    notes.length ? el('div', { flexDirection: 'column', marginTop: 6, gap: 3 }, ...notes.map(x => el('div', { alignItems: 'flex-start', fontSize: 12, lineHeight: 1.3, color: C.ash },
      str(x.lead) ? el('div', { width: 46, flexShrink: 0, paddingTop: 2, fontFamily: MONO, fontWeight: 700, fontSize: 9.5, letterSpacing: 1.14, textTransform: 'uppercase', color: C.label }, str(x.lead)) : null,
      el('div', { flex: 1, flexWrap: 'wrap', alignItems: 'baseline' },
        str(x.strong) ? el('div', { marginRight: 4, color: C.bright, fontWeight: 600 }, str(x.strong)) : null,
        str(x.text) ? el('div', {}, str(x.text)) : null)))) : null,
    rings.length ? el('div', { flexWrap: 'wrap', gap: 6, marginTop: 6 }, ...rings.map(t => {
      const state = t.state === 'met' || t.state === 'over' ? t.state : 'way';
      const ink = state === 'met' ? C['moss-ink'] : state === 'over' ? C['heat-ink'] : C.bright;
      return el('div', { width: 116, alignItems: 'center', gap: 7, padding: '5px 8px 5px 7px', borderRadius: 11, backgroundColor: C.raise, border: `1px solid ${state === 'met' ? 'rgba(111,166,114,0.3)' : C.edge}` },
        svgImg(ringSvg(t.arc, state), 26, 26),
        el('div', { flexDirection: 'column', gap: 2, flex: 1 },
          el('div', { fontWeight: 800, fontSize: 15, color: ink }, str(t.value)),
          txt({ fontFamily: MONO, fontSize: 10, lineHeight: 1.2, color: C.label }, t.of),
          txt({ fontFamily: MONO, fontWeight: 700, fontSize: 9, lineHeight: 1.2, letterSpacing: 0.9, textTransform: 'uppercase', color: C.ash }, t.label)));
    })) : null,
    txt({ marginTop: 4, fontSize: 11, lineHeight: 1.35, color: C.ash }, v.targets_more));
}

function foot(v) {
  const rev = v.review && typeof v.review === 'object' ? v.review : null;
  return el('div', { flexDirection: 'column', padding: '7px 14px 10px' },
    txt({ fontSize: 10.5, lineHeight: 1.35, fontStyle: 'italic', color: C.ash }, v.foot),
    rev && str(rev.say) ? el('div', { marginTop: 8, flexWrap: 'wrap', alignItems: 'baseline', fontSize: 11.5, lineHeight: 1.4, color: C.ash },
      el('div', { marginRight: 4, fontFamily: MONO, fontWeight: 700, fontSize: 9, letterSpacing: 1.08, color: C['amber-ink'] }, 'REVIEW'),
      el('div', {}, str(rev.say))) : null,
    // No account line: a picture's link can travel further than the reply it
    // came in, and an email address on it would travel with it. The reply
    // names the account in words.
    el('div', { justifyContent: 'flex-end', marginTop: 6 },
      el('div', { fontFamily: SLAB, fontWeight: 700, fontSize: 11, letterSpacing: 0.6, color: C['heat-ink'] }, 'wrought.fit')));
}

/**
 * The picture's element tree for a view. Pure: strings in, boxes out. A view
 * it cannot read draws the header alone, as the card does.
 */
export function cardTree(view) {
  const v = view && typeof view === 'object' ? view : {};
  const day = v.kind === 'day';
  const plate = {
    position: 'relative', flexDirection: 'column', width: WIDTH, borderRadius: 18, overflow: 'hidden',
    border: '1px solid rgba(242,100,25,0.28)', color: C.bright, fontFamily: SANS, fontSize: 14, lineHeight: 1.45,
    backgroundColor: C.paper,
    backgroundImage: 'radial-gradient(120% 80% at 100% 0%, rgba(242,100,25,0.05), rgba(242,100,25,0) 58%)',
  };
  // The forge rule along the top, the tile's own gradient.
  const forge = el('div', { position: 'absolute', top: 0, left: 0, right: 0, height: 3, backgroundImage: `linear-gradient(90deg, ${C['heat-hi']}, ${C.heat} 55%, ${C['heat-lo']})` });
  if (!day) {
    return el('div', plate, forge, strip(v),
      str(v.line) ? el('div', { padding: '10px 14px 12px', borderTop: `1px solid ${C.edge}`, fontSize: 13.5, lineHeight: 1.45, color: C.bright }, str(v.line)) : null);
  }
  return el('div', plate, forge, strip(v), justSection(v.just), intakeSection(v.intake), balanceSection(v), foot(v));
}

// ── Rendering ───────────────────────────────────────────────────────────────
// Loaded once per container; the picture function is the only thing that
// pays for the renderer, never the connector.
let ready = null;
async function engine(load) {
  if (!ready) {
    ready = (async () => {
      const [{ default: satori }, resvg, wasm, fonts] = await Promise.all([
        import('satori'), import('@resvg/resvg-wasm'), load('wasm'),
        Promise.all(FONT_FILES.map(async f => ({ name: f.name, weight: f.weight, style: f.style, data: await load(f.file) }))),
      ]);
      await resvg.initWasm(wasm);
      return { satori, Resvg: resvg.Resvg, fonts };
    })();
    ready.catch(() => { ready = null; });
  }
  return ready;
}

/**
 * The PNG for a view. `load(name)` returns the bytes of 'wasm' (resvg's) or
 * of a font file — the caller knows where its bundle keeps them.
 */
export async function renderCardPng(view, load) {
  const { satori, Resvg, fonts } = await engine(load);
  const svg = await satori(cardTree(view), { width: WIDTH, fonts });
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'zoom', value: SCALE } }).render().asPng());
}
