// netlify/functions/lib/widget_runtime.js
// Wrought's card in the chat — browser code, shipped as TEXT.
//
// widgets.js composes the card's single <script> from String() of the
// functions below, so every one of them is SELF-CONTAINED: it reads only its
// parameters, the other wr* functions, and what a browser provides (window,
// document, parent, ResizeObserver). A function shipped as a string cannot see
// this module's other names, and the harness runs the exact composed script
// in a bare context to prove it.
//
// The founder: "it used to have a fancy background … I'd like to use Wrought
// colours. It should be so distinctive that it tells you, in like a framing,
// that it's using the connector." So the card owns its plate — iron, the W
// tile, the word in the slab, a forge rule across the top — in a light host
// and a dark one alike, and never takes the host's colours: a host's black
// text painted onto iron is unreadable.
//
// WHAT THE CARD MAY DO, and it is short on purpose:
//
// - PRINT. Every figure on it arrived as a string the server computed. No
//   arithmetic, no formatting of numbers, no counting — "Show 3 earlier"
//   arrives written. The only numbers it touches are a bar segment's share
//   and a ring's arc, already 0–100, and each is checked before it is used.
// - ESCAPE. Every string from the view goes through wrEsc, text and
//   attributes alike.
// - OPEN ONE KIND OF LINK. The record on wrought.fit, through the host, and
//   only if the address starts https://wrought.fit/. Anything else draws no
//   button at all.
// - NOTHING ELSE. It calls no tool, posts nothing to the model and asks for no
//   other display mode — and every tool is model-only besides, so a card that
//   cannot call anything cannot be made to call undo_last.

/** HTML-escape, for text and attributes alike. */
export function wrEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Only the record on wrought.fit is ever opened. */
export function wrSafeLink(url) {
  return typeof url === 'string' && url.indexOf('https://wrought.fit/') === 0 && !/[\s"'<>]/.test(url);
}

/** Post one ui/open-link request (or ChatGPT's own door) for an allowed link. */
export function wrOpen(url, post, nextId) {
  if (!wrSafeLink(url)) return false;
  const oa = window.openai;
  if (oa && typeof oa.openExternal === 'function') { try { oa.openExternal({ href: url }); return true; } catch (e) { /* fall through */ } }
  post({ jsonrpc: '2.0', id: nextId(), method: 'ui/open-link', params: { url: url } });
  return true;
}

/**
 * The host's theme, and nothing else of the host's. The plate is iron in
 * either theme; the theme changes only the plate's edge, and it reaches
 * color-scheme so the frame's own canvas matches the host — a scheme that
 * differs from the embedding page paints an opaque box behind the plate's
 * rounded corners. The host's colour and font variables are never read.
 */
export function wrTheme(ctx) {
  if (!ctx || typeof ctx !== 'object') return;
  const root = document.documentElement;
  if (ctx.theme === 'light' || ctx.theme === 'dark') {
    root.setAttribute('data-theme', ctx.theme);
    if (root.style) root.style.colorScheme = ctx.theme;
  }
}

/** The card's view out of whatever envelope the host handed over, or null. */
export function wrViewOf(x) {
  const key = 'wrought/card';
  const tries = [
    x && x[key],
    x && x._meta && x._meta[key],
    x && x.mcp_tool_result && x.mcp_tool_result._meta && x.mcp_tool_result._meta[key],
    x && x.call_tool_result && x.call_tool_result._meta && x.call_tool_result._meta[key],
  ];
  let found = null;
  tries.forEach(function (v) { if (!found && v && typeof v === 'object' && typeof v.kind === 'string') found = v; });
  return found;
}

/** The W tile — the same path as public/icon.svg, inline because the card may load nothing. */
export function wrTile() {
  return '<svg class="wr-tile" viewBox="0 0 512 512" width="22" height="22" aria-hidden="true" focusable="false">' +
    '<defs><linearGradient id="wr-heat" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F5A623"/><stop offset=".55" stop-color="#F26419"/><stop offset="1" stop-color="#C3350D"/></linearGradient></defs>' +
    '<rect width="512" height="512" rx="112" fill="#14110F"/><rect x="56" y="56" width="400" height="400" rx="76" fill="url(#wr-heat)"/>' +
    '<path fill="#14110F" d="M104 150 L206 150 L206 178 L182 183 L212 306 L238 183 L214 178 L214 150 L298 150 L298 178 L274 183 L304 306 L330 183 L306 178 L306 150 L408 150 L408 178 L386 184 L330 366 L276 366 L256 268 L236 366 L182 366 L126 184 L104 178 Z"/></svg>';
}

/** The header every card carries: the tile, the word, what this reply was, and REVIEW under a care flag. */
export function wrStrip(view) {
  const v = view && typeof view === 'object' ? view : {};
  return '<header class="wr-strip">' + wrTile() + '<span class="wr-word">WROUGHT</span>' +
    (v.badge ? '<span class="wr-kind">' + wrEsc(v.badge) + '</span>' : '') +
    (v.review ? '<span class="wr-rev">REVIEW</span>' : '') +
    (v.date_label ? '<span class="wr-when">' + wrEsc(v.date_label) + '</span>' : '') +
    '</header>';
}

/** The one-strip card: the header, and one line when there is one. */
export function wrRenderStamp(view) {
  const v = view && typeof view === 'object' ? view : {};
  return wrStrip(v) + (v.line ? '<p class="wr-line">' + wrEsc(v.line) + '</p>' : '');
}

/** The day: what was just written, what was eaten, the balance, the targets. Prints strings only. */
export function wrRenderDay(view) {
  const v = view;
  const h = [wrStrip(v)];
  const share = x => typeof x === 'number' && x >= 0 && x <= 100;
  const list = x => (Array.isArray(x) ? x : []);

  // The write itself — heat on the left edge, the one place heat marks a row.
  const just = v.just && typeof v.just === 'object' ? v.just : null;
  if (just && list(just.rows).some(Boolean)) {
    h.push('<section class="wr-sec wr-just"><p class="wr-cap">' + wrEsc(just.caption) + '</p>');
    list(just.rows).forEach(function (r) {
      if (!r || typeof r !== 'object') return;
      h.push('<div class="wr-it"><span class="nm">' + wrEsc(r.what) + '</span>' +
        (r.figure ? '<span class="kc">' + wrEsc(r.figure) + '</span>' : r.flag ? '<span class="wr-nofig">' + wrEsc(r.flag) + '</span>' : '') + '</div>');
      const meta = [r.at, r.macros, r.est].filter(function (x) { return typeof x === 'string' && x; });
      if (meta[0]) h.push('<p class="wr-mac">' + meta.map(wrEsc).join(' · ') + '</p>');
      if (r.gap) h.push('<p class="wr-gap">' + wrEsc(r.gap) + '</p>');
    });
    h.push('</section>');
  }

  h.push('<div class="wr-split">');
  // What was eaten.
  const inn = v.intake && typeof v.intake === 'object' ? v.intake : {};
  h.push('<section class="wr-sec wr-in">');
  if (list(inn.rows).some(Boolean)) {
    // The section's title rides beside the figure it titles.
    h.push('<div class="wr-hero">' +
      (inn.figure ? '<b class="wr-fig">' + wrEsc(inn.figure) + '<small>kcal</small></b>'
        : '<b class="wr-fig wr-unset">' + wrEsc(inn.figure_missing) + '</b>') +
      '<span class="wr-figcap"><span class="wr-cap">' + wrEsc(inn.title) + '</span>' + wrEsc(inn.caption) + '</span></div>');
    const bar = list(inn.bar).filter(function (b) { return b && share(b.share) && (b.key === 'protein' || b.key === 'carbs' || b.key === 'fat'); });
    if (bar[0]) {
      h.push('<div class="wr-mbar" aria-hidden="true">' + bar.map(function (b) {
        return '<span class="wr-' + b.key + '" style="width:' + b.share + '%"></span>';
      }).join('') + '</div>');
    }
    // The bar's key rides under the total it splits: the grams, each with its swatch.
    const keys = bar[0] ? '<span class="wr-mkeys">' + bar.map(function (b) {
      return '<span><i class="wr-' + b.key + '"></i>' + wrEsc(b.label) + '</span>';
    }).join('') + '</span>' : '';
    h.push('<ol class="wr-rows">');
    list(inn.rows).forEach(function (r) {
      if (!r || typeof r !== 'object') return;
      h.push('<li class="wr-row' + (r.fresh ? ' wr-new' : '') + (r.folded ? ' wr-more' : '') + '"' +
        (r.macros ? ' data-wr-row tabindex="0" role="button" aria-expanded="false"' : '') + '>' +
        '<span class="tm">' + wrEsc(r.at) + '</span>' +
        '<span class="nm">' + wrEsc(r.what) + (r.macros ? '<small>' + wrEsc(r.macros) + '</small>' : '') + '</span>' +
        '<span class="kc' + (r.uncounted ? ' wr-unset' : '') + '">' + wrEsc(r.kcal) + '</span></li>');
    });
    h.push('</ol>');
    if (inn.more_label) h.push('<button type="button" class="wr-earlier" data-wr-more>' + wrEsc(inn.more_label) + '</button>');
    if (inn.total && typeof inn.total === 'object') {
      h.push('<div class="wr-total"><span>' + wrEsc(inn.total.label) + keys + '</span><b' + (inn.total.unset ? ' class="wr-unset"' : '') + '>' + wrEsc(inn.total.kcal) + '</b></div>');
    }
    list(inn.captions).forEach(function (c) { if (c) h.push('<p class="wr-note">' + wrEsc(c) + '</p>'); });
  } else {
    h.push('<p class="wr-cap">' + wrEsc(inn.title) + '</p><p class="wr-note wr-empty">' + wrEsc(inn.empty) + '</p>');
  }
  h.push('</section>');

  // The balance, row by row, and the notes under it.
  const bal = v.balance && typeof v.balance === 'object' ? v.balance : {};
  h.push('<section class="wr-sec wr-out"><p class="wr-cap">' + wrEsc(bal.title) + '</p>');
  if (bal.missing) {
    h.push('<p class="wr-note">' + wrEsc(bal.missing) + '</p>');
  } else {
    h.push('<ol class="wr-brows">');
    list(bal.rows).forEach(function (r) {
      if (r && typeof r === 'object') h.push('<li class="wr-brow"><span>' + wrEsc(r.label) + '</span><b>' + wrEsc(r.kcal) + '</b></li>');
    });
    if (bal.burn && typeof bal.burn === 'object') h.push('<li class="wr-brow wr-burn"><span>' + wrEsc(bal.burn.label) + '</span><b>' + wrEsc(bal.burn.kcal) + '</b></li>');
    const net = bal.net && typeof bal.net === 'object' ? bal.net : null;
    if (net) {
      const tone = net.tone === 'down' || net.tone === 'over' || net.tone === 'level' ? ' wr-' + net.tone : '';
      h.push('<li class="wr-brow wr-net' + tone + '"><span>' + wrEsc(net.label) + '</span><b>' + wrEsc(net.value) + '</b></li>');
    }
    h.push('</ol>');
  }
  if (v.held) h.push('<p class="wr-held">' + wrEsc(v.held) + '</p>');
  const notes = list(v.notes).filter(function (x) { return x && typeof x === 'object' && (x.text || x.strong); });
  if (notes[0]) {
    h.push('<ul class="wr-notes">' + notes.map(function (x) {
      return '<li>' + (x.lead ? '<span class="ld">' + wrEsc(x.lead) + '</span>' : '') +
        (x.strong ? '<b>' + wrEsc(x.strong) + '</b> ' : '') + wrEsc(x.text) + '</li>';
    }).join('') + '</ul>');
  }
  // Targets — the dashboard's verdict rings, under the balance they answer.
  // The arc is the server's own percentage, held to 0–100; the figures beside
  // it are its strings.
  const rings = list(v.targets).filter(function (t) { return t && typeof t === 'object'; });
  if (rings[0]) {
    h.push('<div class="wr-goals" role="list" aria-label="Targets">');
    rings.forEach(function (t) {
      const state = t.state === 'met' || t.state === 'over' ? t.state : 'way';
      h.push('<div class="wr-g wr-' + state + '" role="listitem"><svg viewBox="0 0 36 36" aria-hidden="true" focusable="false">' +
        '<circle class="trk" cx="18" cy="18" r="15.9155"/>' +
        // No arc at 0%: a zero-length dash with round caps still paints a dot.
        (share(t.arc) && t.arc > 0 ? '<circle class="arc" cx="18" cy="18" r="15.9155" pathLength="100" stroke-dasharray="' + t.arc + ' 100" transform="rotate(-90 18 18)"/>' : '') +
        '</svg><span class="tx"><b>' + wrEsc(t.value) + '</b><small>' + wrEsc(t.of) + '</small><em>' + wrEsc(t.label) + '</em></span></div>');
    });
    h.push('</div>' + (v.targets_more ? '<p class="wr-note">' + wrEsc(v.targets_more) + '</p>' : ''));
  }
  h.push('</section></div>');

  // The foot: what every figure is, a standing review in small type, whose
  // record this is, and the one door out.
  h.push('<footer class="wr-foot">');
  if (v.foot) h.push('<p class="wr-fine">' + wrEsc(v.foot) + '</p>');
  const rev = v.review && typeof v.review === 'object' ? v.review : null;
  if (rev && rev.say) h.push('<p class="wr-review" data-wr-flag tabindex="0" role="button"><span>REVIEW</span> ' + wrEsc(rev.say) + '</p>');
  h.push('<div class="wr-door">' + (v.account ? '<p class="wr-acct">' + wrEsc(v.account) + '</p>' : '<p class="wr-acct"></p>') + '<span class="wr-btns">');
  if (rev && wrSafeLink(rev.link)) h.push('<button type="button" class="wr-btn wr-btn-rev" data-wr-open="' + wrEsc(rev.link) + '">' + wrEsc(rev.link_label || 'Review') + '</button>');
  if (wrSafeLink(v.open)) h.push('<button type="button" class="wr-btn" data-wr-open="' + wrEsc(v.open) + '">' + wrEsc(v.open_label || 'Open your record') + '</button>');
  h.push('</span></div></footer>');
  return h.join('');
}

/** A day card, a stamp, or — for anything it does not know — the header alone. Never an old card. */
export function wrRender(view) {
  if (view && typeof view === 'object' && view.kind === 'day') return wrRenderDay(view);
  if (view && typeof view === 'object' && view.kind === 'stamp') return wrRenderStamp(view);
  return wrRenderStamp({});
}

/** Draw, then wire the folds, the rows and the doors. */
export function wrMount(root, view, open) {
  if (!root) return;
  // A new card starts folded, whatever the last one was opened to.
  if (root.classList && typeof root.classList.remove === 'function') root.classList.remove('wr-all');
  const cls = view && typeof view === 'object' && view.kind === 'stamp' ? 'wr wr-stamp' : view && typeof view === 'object' && view.kind === 'day' ? 'wr wr-day' : 'wr wr-stamp';
  const warn = view && typeof view === 'object' && view.tone === 'warn' ? ' wr-warn' : '';
  root.innerHTML = '<article class="' + cls + warn + '" aria-label="WROUGHT">' + wrRender(view) + '</article>';
  if (typeof root.querySelector !== 'function') return;
  const more = root.querySelector('[data-wr-more]');
  if (more) more.addEventListener('click', function () { root.classList.add('wr-all'); more.remove(); });
  // The review sentence is clamped to three lines. A tap goes where a review
  // button would — when the view gives one — and otherwise opens the sentence:
  // a tap that only unfolds text must never pass for the review itself.
  const flag = root.querySelector('[data-wr-flag]');
  const rev = view && typeof view === 'object' && view.review && typeof view.review === 'object' ? view.review : null;
  if (flag) {
    const go = function () { if (!(rev && wrSafeLink(rev.link) && open(rev.link))) flag.classList.add('wr-opened'); };
    flag.addEventListener('click', go);
    flag.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
  }
  // A row's macros are the detail under its calories: a tap opens them.
  root.querySelectorAll('[data-wr-row]').forEach(function (el) {
    const tap = function () { el.classList.toggle('wr-open'); el.setAttribute('aria-expanded', el.classList.contains('wr-open') ? 'true' : 'false'); };
    el.addEventListener('click', tap);
    el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); tap(); } });
  });
  root.querySelectorAll('[data-wr-open]').forEach(function (btn) {
    btn.addEventListener('click', function () { open(btn.getAttribute('data-wr-open')); });
  });
}

/**
 * The MCP Apps handshake, with ChatGPT's window.openai as the fallback.
 * All state is declared before any listener, so a message that arrives while
 * the script is still starting never meets an uninitialised binding.
 */
export function wrBridge() {
  const state = { id: 1, ready: false, pending: {}, seen: undefined };
  const root = document.getElementById('wr-root');
  const post = function (m) { try { parent.postMessage(m, '*'); } catch (e) { /* no host */ } };
  const nextId = function () { state.id += 1; return state.id; };
  const open = function (url) { return wrOpen(url, post, nextId); };
  const key = function (v) { try { return JSON.stringify(v === undefined ? null : v); } catch (e) { return null; } };
  // The same view compared as text, on BOTH doors: a host may hand back a
  // fresh copy of an unchanged result, and redrawing it would shut an opened
  // row and put "Show 3 earlier" back over an open list. A missing view is a
  // change like any other — the header replaces the old card.
  const draw = function (view) {
    const k = key(view);
    if (k === state.seen) return;
    state.seen = k;
    wrMount(root, view, open);
  };

  window.addEventListener('message', function (e) {
    if (e.source !== parent) return;
    const m = e.data;
    if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') return;
    if (m.id !== undefined && m.id !== null && !m.method) {
      const done = state.pending[m.id];
      delete state.pending[m.id];
      if (done) done(m.result || null, m.error || null);
      return;
    }
    // A result this door cannot read a view out of falls back to what
    // ChatGPT's door holds, never to nothing: on a host that speaks both, one
    // door's empty envelope must not wipe the card the other drew.
    if (m.method === 'ui/notifications/tool-result') draw(wrViewOf(m.params) || (window.openai && wrViewOf(window.openai.toolResponseMetadata)) || null);
    else if (m.method === 'ui/notifications/host-context-changed') wrTheme(m.params);
    else if (m.method === 'ui/resource-teardown') post({ jsonrpc: '2.0', id: m.id, result: {} });
  });

  const oa = window.openai;
  if (oa && typeof oa === 'object') {
    if (oa.theme) wrTheme({ theme: oa.theme });
    if (oa.toolResponseMetadata && typeof oa.toolResponseMetadata === 'object') draw(wrViewOf(oa.toolResponseMetadata));
    // set_globals fires for the theme, the height and the display mode too.
    // Only an update that CARRIES toolResponseMetadata can change the card,
    // and only a view read out of it redraws: an envelope this door cannot
    // read (the nesting is ChatGPT's and unverified) leaves the card the
    // other door drew exactly where it is, rather than wiping it on the
    // first height change.
    window.addEventListener('openai:set_globals', function (ev) {
      const g = (ev && ev.detail && ev.detail.globals) || {};
      if (g.theme) wrTheme({ theme: g.theme });
      if (!Object.prototype.hasOwnProperty.call(g, 'toolResponseMetadata')) return;
      const v = wrViewOf(g.toolResponseMetadata);
      if (v) draw(v);
    });
  }
  // Nothing from either door yet: the header, so the frame is never empty.
  if (state.seen === undefined) draw(null);

  const report = function () {
    const el = document.documentElement;
    const h = el.offsetHeight, w = el.offsetWidth;
    if (state.ready) post({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { width: w, height: h } });
    if (window.openai && typeof window.openai.notifyIntrinsicHeight === 'function') window.openai.notifyIntrinsicHeight(h);
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(report).observe(document.documentElement);

  // The handshake. Nothing else is posted until the host answers it.
  state.pending[1] = function (result) {
    state.ready = true;
    if (result && result.hostContext) wrTheme(result.hostContext);
    post({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
    report();
  };
  post({
    jsonrpc: '2.0', id: 1, method: 'ui/initialize',
    params: { appInfo: { name: 'wrought', version: '1.0.0' }, appCapabilities: { availableDisplayModes: ['inline'] }, protocolVersion: '2026-01-26' },
  });
}

// The order the card's script is composed in. wrBridge runs last.
export const WIDGET_RUNTIME = [wrEsc, wrSafeLink, wrOpen, wrTheme, wrViewOf, wrTile, wrStrip, wrRenderStamp, wrRenderDay, wrRender, wrMount, wrBridge];

// The card's stylesheet — the plate. Every colour is a literal Wrought token
// on :root and none is the host's: the card is iron in a light host and a dark
// one alike, which is the frame the founder asked for, and a token swap is all
// a host-following skin would ever need. No web font: the CSP is empty, so the
// slab is Rockwell where the phone has it and a system serif where it does not.
// Every grid track is minmax(0,…) — a track is min-width:auto by default, and
// that is how a caption was once pushed out of its own panel. Nothing but the
// row's time refuses to wrap, and no ::before/::after reaches past its box: a
// glow ten pixels outside its parent made a whole page slide sideways.
export const WIDGET_CSS = [
  ':root{color-scheme:light dark;--wr-iron:#14110F;--wr-plate:#1E1917;--wr-raise:#262020;--wr-edge:#332B27;--wr-edge-lit:#4A3E37;--wr-track:#2A2220;' +
    '--wr-bright:#F7F3EE;--wr-ash:#A79A90;--wr-label:#94867D;--wr-heat:#F26419;--wr-heat-hi:#F5A623;--wr-heat-lo:#C3350D;--wr-on-heat:#1A0A02;' +
    '--wr-temper:#5B90B0;--wr-moss:#6FA672;--wr-amber:#E8B64C;' +
    '--wr-stamp:Rockwell,"Roboto Slab","Bookman Old Style","Iowan Old Style",Georgia,serif;' +
    '--wr-grotesk:-apple-system,BlinkMacSystemFont,"Helvetica Neue","Arial Narrow",system-ui,sans-serif;' +
    '--wr-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;' +
    '--wr-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}',
  '*{box-sizing:border-box}',
  'html,body{margin:0;padding:0;background:transparent}',
  'body{padding:1px 1px 2px;-webkit-text-size-adjust:100%}',
  '#wr-root{max-width:768px}',
  // THE PLATE — iron in either host theme; only its edge changes.
  '.wr{position:relative;overflow:hidden;isolation:isolate;border-radius:18px;color:var(--wr-bright);font:14px/1.45 var(--wr-sans);-webkit-font-smoothing:antialiased;' +
    'background:radial-gradient(120% 80% at 100% 0,rgba(242,100,25,.06),transparent 58%),linear-gradient(180deg,var(--wr-plate),var(--wr-iron) 62%);' +
    'border:1px solid rgba(242,100,25,.24);box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}',
  ':root[data-theme=light] .wr{border-color:#2A2220}',
  // The forge rule: the tile's own gradient, across the top, inside the plate.
  '.wr::before{content:"";position:absolute;inset:0 0 auto;height:3px;z-index:1;background:linear-gradient(90deg,var(--wr-heat-hi),var(--wr-heat) 55%,var(--wr-heat-lo))}',
  '.wr p{margin:0}',
  // THE STRIP — the framing on every card: tile, word, what this reply was.
  '.wr-strip{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:11px 14px 8px;border-bottom:1px solid var(--wr-edge)}',
  '.wr-stamp .wr-strip{border-bottom:0}',
  '.wr-tile{display:block;flex:none;width:22px;height:22px;border-radius:23%;box-shadow:0 6px 14px -7px rgba(242,100,25,.9),0 0 0 1px rgba(255,255,255,.08)}',
  '.wr-word{font:700 13px/1 var(--wr-stamp);letter-spacing:.1em;text-transform:uppercase}',
  '.wr-kind,.wr-rev{font:700 9.5px/1 var(--wr-mono);letter-spacing:.14em;text-transform:uppercase;padding:4px 6px 3px;border-radius:4px;white-space:nowrap}',
  '.wr-kind{color:var(--wr-on-heat);background:var(--wr-heat)}',
  '.wr-rev{color:var(--wr-amber);box-shadow:inset 0 0 0 1px rgba(232,182,76,.7)}',
  '.wr-warn .wr-kind{color:var(--wr-heat-hi);background:transparent;box-shadow:inset 0 0 0 1px rgba(245,166,35,.75)}',
  '.wr-when{margin-left:auto;font:10.5px/1 var(--wr-mono);letter-spacing:.04em;color:var(--wr-label);white-space:nowrap}',
  '.wr-line{padding:10px 14px 12px;border-top:1px solid var(--wr-edge);font-size:13.5px;line-height:1.45;color:var(--wr-bright);overflow-wrap:anywhere}',
  '.wr-sec{padding:9px 14px;border-bottom:1px solid var(--wr-edge);min-width:0}',
  '.wr-cap{margin:0 0 5px!important;font:700 9.5px/1.25 var(--wr-mono);letter-spacing:.14em;text-transform:uppercase;color:var(--wr-label)}',
  // JUST LOGGED — the one place heat marks a row.
  '.wr-just{background:linear-gradient(90deg,rgba(242,100,25,.08),transparent 72%);box-shadow:inset 3px 0 0 var(--wr-heat)}',
  '.wr-just .wr-cap{color:var(--wr-ash)}',
  '.wr-it{display:flex;align-items:baseline;gap:10px}',
  '.wr-it+.wr-it,.wr-mac+.wr-it,.wr-gap+.wr-it{margin-top:8px}',
  '.wr-it .nm{flex:1;min-width:0;font-size:14.5px;line-height:1.3;font-weight:600;overflow-wrap:anywhere}',
  '.wr-it .kc{flex:none;font:800 18px/1 var(--wr-grotesk);letter-spacing:-.02em;font-variant-numeric:tabular-nums;white-space:nowrap}',
  '.wr-nofig{flex:none;font:700 9.5px/1 var(--wr-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--wr-heat-hi);padding:4px 6px 3px;border-radius:4px;box-shadow:inset 0 0 0 1px rgba(245,166,35,.7);white-space:nowrap}',
  '.wr-mac{margin-top:4px!important;font:11px/1.45 var(--wr-mono);color:var(--wr-ash);overflow-wrap:anywhere}',
  '.wr-gap{margin-top:6px!important;font-size:13px;line-height:1.4;color:var(--wr-bright)}',
  // THE DAY
  // The caption wraps under the figure rather than shrinking past its longest
  // word: a five-digit figure at 560px squeezed it to a column narrower than
  // "BREAKDOWN", which then ran into the balance beside it.
  '.wr-hero{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:4px 12px}',
  // The figure and its unit never break: "kcal" split into "K / CAL" at
  // 560–600px, and a five-digit figure split across two lines.
  '.wr-fig{flex:none;font:900 38px/.82 var(--wr-grotesk);letter-spacing:-.055em;font-variant-numeric:tabular-nums;white-space:nowrap}',
  '.wr-fig small{margin-left:4px;font:700 10px/1 var(--wr-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--wr-label)}',
  '.wr-fig.wr-unset{max-width:62%;white-space:normal;font:800 22px/1.1 var(--wr-grotesk);letter-spacing:-.01em;color:var(--wr-ash)}',
  '.wr-figcap{flex:1 1 72px;min-width:0;text-align:right;font:700 9.5px/1.35 var(--wr-mono);letter-spacing:.1em;text-transform:uppercase;color:var(--wr-ash)}',
  '.wr-figcap .wr-cap{display:block;margin:0 0 2px!important;color:var(--wr-label);text-wrap:balance}',
  '.wr-mbar{display:flex;height:7px;margin:9px 0 2px;border-radius:999px;overflow:hidden;background:var(--wr-raise);box-shadow:inset 0 0 0 1px var(--wr-edge);transform-origin:0 50%}',
  '.wr-mbar span{display:block;height:100%}',
  '.wr-mbar .wr-protein,.wr-mkeys i.wr-protein{background:var(--wr-temper)}',
  '.wr-mbar .wr-carbs,.wr-mkeys i.wr-carbs{background:var(--wr-heat)}',
  '.wr-mbar .wr-fat,.wr-mkeys i.wr-fat{background:var(--wr-heat-hi)}',
  '.wr-mkeys{display:flex;flex-wrap:wrap;gap:1px 12px;margin-top:3px;font-size:12px;font-weight:600;color:var(--wr-bright);font-variant-numeric:tabular-nums}',
  '.wr-mkeys span{display:inline-flex;align-items:center;gap:5px}',
  '.wr-mkeys i{display:block;width:7px;height:7px;border-radius:2px}',
  '.wr-rows{list-style:none;margin:6px 0 0;padding:0}',
  '.wr-row{display:grid;grid-template-columns:58px minmax(0,1fr) auto;gap:10px;align-items:baseline;padding:2px 0;border-top:1px solid var(--wr-edge);font-size:13px;line-height:1.3}',
  '.wr-row[data-wr-row]{cursor:pointer}',
  '.wr-row .tm{white-space:nowrap;font:10.5px/1.3 var(--wr-mono);color:var(--wr-label);font-variant-numeric:tabular-nums}',
  '.wr-row .nm{min-width:0;overflow-wrap:anywhere}',
  '.wr-row .nm small{display:none;margin-top:2px;font:10.5px/1.4 var(--wr-mono);color:var(--wr-ash)}',
  '.wr-row.wr-open .nm small{display:block}',
  '.wr-row .kc{font-weight:650;font-variant-numeric:tabular-nums;text-align:right}',
  '.wr-row.wr-new .nm{font-weight:650}',
  '.wr-row.wr-new .tm{color:var(--wr-heat)}',
  '.wr-unset{font-style:italic;font-weight:400!important;color:var(--wr-ash)}',
  '.wr-row.wr-more{display:none}',
  '.wr-all .wr-row.wr-more{display:grid}',
  '.wr-earlier{display:block;width:100%;margin:0;padding:8px 0;border:0;border-top:1px solid var(--wr-edge);background:none;text-align:left;font:11.5px/1.3 var(--wr-mono);color:var(--wr-ash);cursor:pointer}',
  '.wr-total{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding-top:6px;border-top:2px solid var(--wr-edge-lit);font-weight:650}',
  '.wr-total b{font:800 16px/1 var(--wr-grotesk);font-variant-numeric:tabular-nums}',
  '.wr-total b.wr-unset{font:italic 400 13px/1.3 var(--wr-sans);color:var(--wr-ash)}',
  '.wr-note{margin-top:4px!important;font-size:11px;line-height:1.35;color:var(--wr-ash)}',
  '.wr-empty{margin-top:0!important;font-size:13px}',
  // THE BALANCE — every row with its figure, the burn under a rule, the net.
  '.wr-brows{list-style:none;margin:0;padding:0}',
  '.wr-brow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:baseline;padding:2px 0;border-top:1px solid var(--wr-edge);font-size:12.5px;line-height:1.25}',
  '.wr-brow:first-child{border-top:0}',
  '.wr-brow span{min-width:0;overflow-wrap:anywhere;color:var(--wr-ash)}',
  '.wr-brow b{font-weight:650;font-variant-numeric:tabular-nums;text-align:right}',
  '.wr-brow.wr-burn{border-top:1px solid var(--wr-edge-lit)}',
  '.wr-brow.wr-burn span,.wr-brow.wr-net span{color:var(--wr-bright);font-weight:650}',
  '.wr-brow.wr-net b{font:800 19px/1 var(--wr-grotesk);letter-spacing:-.02em}',
  '.wr-net.wr-down b{color:var(--wr-temper)}',
  '.wr-net.wr-over b{color:var(--wr-heat)}',
  '.wr-net.wr-level b{color:var(--wr-amber)}',
  '.wr-held{margin-top:8px!important;font-size:12.5px;line-height:1.4;color:var(--wr-ash);font-style:italic}',
  '.wr-notes{list-style:none;margin:6px 0 0;padding:0}',
  '.wr-notes li{font-size:12px;line-height:1.3;color:var(--wr-ash);overflow-wrap:anywhere}',
  '.wr-notes li+li{margin-top:2px}',
  '.wr-notes .ld{margin-right:6px;font:700 9.5px/1 var(--wr-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--wr-label)}',
  '.wr-notes b{color:var(--wr-bright);font-weight:650}',
  // TARGETS — dial and figure side by side, so no number crosses a stroke.
  // A grid of equal tracks: a wrapping flex row stretched a fourth ring across
  // the whole width on its own. auto-FILL, not auto-fit and not a fixed two:
  // a lone ring keeps a tile's width, and three still sit in one row at 390 —
  // two columns put a five-row card 60px over the one-screen budget.
  '.wr-goals{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:6px;margin-top:6px}',
  '.wr-g{display:grid;grid-template-columns:26px minmax(0,1fr);gap:7px;align-items:center;padding:5px 8px 5px 7px;border-radius:11px;background:rgba(20,17,15,.62);border:1px solid rgba(255,255,255,.05);min-width:0}',
  '.wr-g.wr-met{border-color:rgba(111,166,114,.3)}',
  '.wr-g svg{display:block;width:26px;height:26px}',
  '.wr-g circle{fill:none;stroke-width:4}',
  '.wr-g .trk{stroke:var(--wr-track)}',
  '.wr-g .arc{stroke:var(--wr-temper);stroke-linecap:round}',
  '.wr-g.wr-met .arc{stroke:var(--wr-moss)}',
  '.wr-g.wr-over .arc{stroke:var(--wr-heat)}',
  '.wr-g .tx{min-width:0;display:flex;flex-direction:column;gap:2px}',
  '.wr-g b{font:800 15px/1 var(--wr-grotesk);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}',
  '.wr-g.wr-met b{color:var(--wr-moss)}',
  '.wr-g.wr-over b{color:var(--wr-heat)}',
  '.wr-g small{font:10px/1.2 var(--wr-mono);color:var(--wr-label);overflow-wrap:anywhere}',
  '.wr-g em{font:700 9px/1.2 var(--wr-mono);font-style:normal;letter-spacing:.1em;text-transform:uppercase;color:var(--wr-ash);overflow-wrap:anywhere}',
  // THE FOOT
  '.wr-foot{padding:7px 14px 9px}',
  '.wr-fine{font-size:10.5px;line-height:1.35;font-style:italic;color:var(--wr-ash)}',
  '.wr-review{margin-top:8px!important;font-size:11.5px;line-height:1.4;color:var(--wr-ash);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer}',
  '.wr-review.wr-opened{display:block;-webkit-line-clamp:unset}',
  '.wr-review span{margin-right:4px;font:700 9px/1 var(--wr-mono);letter-spacing:.12em;color:var(--wr-amber)}',
  '.wr-door{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;margin-top:6px}',
  '.wr-btns{flex:0 1 auto;margin-left:auto;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;min-width:0}',
  '.wr-acct{flex:1 1 140px;min-width:0;font:10px/1.4 var(--wr-mono);letter-spacing:.04em;color:var(--wr-label);overflow-wrap:anywhere}',
  '.wr-btn{flex:none;max-width:100%;min-height:44px;padding:0 16px;font:600 13px/1 var(--wr-sans);color:var(--wr-bright);background:rgba(255,255,255,.035);border:1px solid var(--wr-edge-lit);border-radius:999px;cursor:pointer}',
  '.wr-btn-rev{color:var(--wr-amber);border-color:rgba(232,182,76,.45)}',
  '.wr-btn:focus-visible,.wr-row:focus-visible,.wr-review:focus-visible,.wr-earlier:focus-visible{outline:2px solid var(--wr-heat-hi);outline-offset:2px}',
  // WIDER: the day and the balance side by side.
  '@media (min-width:560px){.wr-split{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);border-bottom:1px solid var(--wr-edge)}' +
    '.wr-split>.wr-sec{border-bottom:0}.wr-split>.wr-sec+.wr-sec{border-left:1px solid var(--wr-edge)}.wr-fig{font-size:52px}}',
  // A phone drops the day card's date (its title carries it) — never a
  // stamp's, where the date is the only thing beside the badge.
  '@media (max-width:419px){.wr-when{display:none}.wr-stamp .wr-when{display:inline}}',
  '@media (max-width:359px){.wr-strip{gap:6px}.wr-strip,.wr-sec,.wr-foot{padding-left:12px;padding-right:12px}.wr-fig{font-size:38px}' +
    '.wr-row{grid-template-columns:52px minmax(0,1fr) auto;gap:8px}.wr-row .tm{font-size:9.5px}' +
    '.wr-goals{grid-template-columns:repeat(auto-fill,minmax(96px,1fr))}.wr-g{gap:6px}.wr-g b{font-size:14px}.wr-btn{padding:0 12px}}',
  // MOTION — the arc and the bar may arrive; no figure ever counts up, and
  // nothing loops. Names are the card's own.
  '@media (prefers-reduced-motion:no-preference){.wr-g .arc{animation:wr-sweep .7s cubic-bezier(.22,.61,.36,1) both}.wr-mbar{animation:wr-grow .6s cubic-bezier(.22,.61,.36,1) both}}',
  '@keyframes wr-sweep{from{stroke-dashoffset:100}to{stroke-dashoffset:0}}',
  '@keyframes wr-grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}',
  '@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}',
].join('');
