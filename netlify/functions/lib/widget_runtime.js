// netlify/functions/lib/widget_runtime.js
// The chat card's own script — browser code, shipped as TEXT.
//
// widgets.js composes the card's single <script> from String() of the
// functions below plus the picture generator's two functions, so every one of
// them is SELF-CONTAINED: it reads only its parameters, the other wr*
// functions, and what a browser provides (window, document, parent,
// ResizeObserver). A function shipped as a string cannot see this module's
// other names, and the harness runs the exact composed script in a bare
// context to prove it.
//
// WHAT THE CARD MAY DO, and it is short on purpose:
//
// - PRINT. Every figure on it arrived as a string the server computed. No
//   arithmetic, no formatting of numbers, no counting — "Show all 7" arrives
//   written. The progress width is the server's own percentage.
// - ESCAPE. Every string from the view goes through wrEsc, text and
//   attributes alike. A picture is drawn only for an id on the list of
//   drawings that exist; nothing that looks like markup arrives in data.
// - OPEN ONE KIND OF LINK. The rack screen on wrought.fit, through the host,
//   and only if the address starts https://wrought.fit/. Anything else is shown
//   as plain text.
// - NOTHING ELSE. It calls no tool, posts nothing to the model and asks for no
//   other display mode — every tool is callable from a widget by default, and a
//   card that cannot call anything cannot be made to call undo_last.

/** HTML-escape, for text and attributes alike. */
export function wrEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** A drawing for an id on the list, or nothing. */
export function wrPicture(id, pics, still) {
  if (typeof id !== 'string' || !pics || !pics.ids || pics.ids.indexOf(id) === -1) return '';
  const spec = pics.table && pics.table[id];
  if (!spec) return '';
  try { return pics.svg(spec, id, !!still); } catch (e) { return ''; }
}

/** Only the rack screen on wrought.fit is ever opened. */
export function wrSafeLink(url) {
  return typeof url === 'string' && url.indexOf('https://wrought.fit/') === 0 && !/[\s"'<>]/.test(url);
}

/**
 * The card as HTML. Prints the view's strings and nothing else; a view it
 * does not recognise renders one neutral line, never an old card.
 */
export function wrRenderWorkout(view, pics) {
  if (!view || typeof view !== 'object' || view.kind !== 'workout') {
    return '<p class="wr-none">Couldn\'t draw this one — the reply above has it in words.</p>';
  }
  const h = [];
  if (view.flag) {
    h.push('<div class="wr-flag" role="note" tabindex="0" data-wr-flag><b>' + wrEsc(view.flag.title) + '</b><span>' + wrEsc(view.flag.say) + '</span></div>');
  }
  h.push('<header class="wr-head"><h1 class="wr-title">' + wrEsc(view.title) + '</h1>');
  if (view.credit_name) {
    h.push('<p class="wr-credit"><small>In the tradition of</small><span class="wr-credit-name">' + wrEsc(view.credit_name) + '</span></p>');
  } else if (view.credit) {
    h.push('<p class="wr-credit">' + wrEsc(view.credit) + '</p>');
  }
  if (view.subtitle) h.push('<p class="wr-sub">' + wrEsc(view.subtitle) + '</p>');
  h.push('</header>');
  if (view.state === 'none') {
    h.push('<p class="wr-empty">' + wrEsc(view.empty) + '</p>');
    return h.join('');
  }
  if (view.aim) h.push('<p class="wr-aim"><small>Today</small>' + wrEsc(view.aim) + '</p>');
  if (view.progress && typeof view.progress.percent === 'number') {
    h.push('<div class="wr-prog"><div class="wr-bar"><i style="width:' + view.progress.percent + '%"></i></div><p>' +
      wrEsc(view.progress.text) + '</p></div>');
  }
  if (view.notes) h.push('<p class="wr-notes">' + wrEsc(view.notes) + '</p>');
  const rows = Array.isArray(view.exercises) ? view.exercises : [];
  const shown = typeof view.visible_rows === 'number' ? view.visible_rows : 5;
  // One figure moves when the card arrives — the movement on now, or the
  // first — and every other one is still until it is tapped.
  let firstMoving = null, patternNote = null;
  rows.forEach(function (e, i) {
    if (!e || typeof e !== 'object') return;
    if (firstMoving === null && (e.status === 'current' || !e.status)) firstMoving = i;
    if (patternNote === null && typeof e.picture_note === 'string' && e.picture_note) patternNote = e.picture_note;
  });
  h.push('<ol class="wr-list">');
  rows.forEach(function (e, i) {
    if (!e || typeof e !== 'object') return;
    const pic = wrPicture(e.picture, pics, i !== firstMoving);
    const bits = [e.prescription, e.rest, e.finisher, e.sets_text, e.detail].filter(function (b) { return typeof b === 'string' && b; });
    const info = (typeof e.cue === 'string' && e.cue ? '<span class="wr-cue">' + wrEsc(e.cue) + '</span>' : '');
    // Which rows fold is the server's (a running workout keeps the movement on
    // now in view); an older view with no word on it folds from the bottom.
    const folded = typeof e.folded === 'boolean' ? e.folded : i >= shown;
    h.push('<li class="wr-row' + (e.status ? ' wr-' + wrEsc(e.status) : '') + (folded ? ' wr-more' : '') +
      (pic && e.picture_note ? ' wr-pat' : '') + (i === firstMoving ? ' wr-opened' : '') + '"' +
      (pic || info ? ' data-wr-row="' + wrEsc(pic ? e.picture : '') + '" role="button" tabindex="0" aria-label="' + wrEsc(e.name) + '"' : '') + '>' +
      '<span class="wr-pic" aria-hidden="true">' + (pic || '') + '</span>' +
      '<span class="wr-body"><b class="wr-name">' + wrEsc(e.name) + '</b>' +
      '<span class="wr-rx">' + bits.map(wrEsc).join(' · ') + '</span>' + info + '</span></li>');
  });
  h.push('</ol>');
  h.push('<footer class="wr-foot"><div class="wr-actions">');
  if (view.more_label) h.push('<button type="button" class="wr-btn" data-wr-more>' + wrEsc(view.more_label) + '</button>');
  const rack = view.links && view.links.rack;
  if (wrSafeLink(rack)) h.push('<button type="button" class="wr-btn" data-wr-open="' + wrEsc(rack) + '">Open the rack screen</button>');
  h.push('</div>');
  if (typeof rack === 'string' && rack && !wrSafeLink(rack)) h.push('<p class="wr-url">' + wrEsc(rack) + '</p>');
  if (view.taken_out_line) h.push('<p>' + wrEsc(view.taken_out_line) + '</p>');
  if (view.loads_line) h.push('<p>' + wrEsc(view.loads_line) + '</p>');
  if (patternNote) h.push('<p class="wr-pn">' + wrEsc(patternNote) + '</p>');
  h.push('</footer>');
  return h.join('');
}

/** Post one ui/open-link request (or ChatGPT's own door) for an allowed link. */
export function wrOpen(url, post, nextId) {
  if (!wrSafeLink(url)) return false;
  const oa = window.openai;
  if (oa && typeof oa.openExternal === 'function') { try { oa.openExternal({ href: url }); return true; } catch (e) { /* fall through */ } }
  post({ jsonrpc: '2.0', id: nextId(), method: 'ui/open-link', params: { url: url } });
  return true;
}

/** Host theming: the theme name, and only colour, font and radius variables. */
export function wrTheme(ctx) {
  if (!ctx || typeof ctx !== 'object') return;
  const root = document.documentElement;
  // The theme reaches color-scheme too. Left at "light dark" it follows the
  // phone, not the host: a light host on a dark phone drew light text on a
  // light page, and a dark host on a light phone painted a white box behind
  // the card.
  if (ctx.theme === 'light' || ctx.theme === 'dark') { root.setAttribute('data-theme', ctx.theme); root.style.colorScheme = ctx.theme; }
  const vars = ctx.styles && ctx.styles.variables;
  if (vars && typeof vars === 'object') {
    Object.keys(vars).forEach(function (k) {
      const v = vars[k];
      if (/^--(color|font|border-radius)-[a-z0-9-]+$/i.test(k) && (typeof v === 'string' || typeof v === 'number')) {
        root.style.setProperty(k, String(v));
      }
    });
  }
}

/** Mount: draw, then wire the two buttons and the tap-to-play pictures. */
export function wrMount(root, view, pics, open) {
  if (!root) return;
  // A new card starts folded, whatever the last one was opened to.
  if (root.classList && typeof root.classList.remove === 'function') root.classList.remove('wr-all');
  root.innerHTML = wrRenderWorkout(view, pics);
  if (typeof root.querySelector !== 'function') return;
  const more = root.querySelector('[data-wr-more]');
  if (more) more.addEventListener('click', function () { root.classList.add('wr-all'); more.remove(); });
  // The flag is folded to three lines on a card that has to fit 400px; a tap
  // opens it, and the whole sentence already leads the reply's own words.
  const flag = root.querySelector('[data-wr-flag]');
  if (flag) flag.addEventListener('click', function () { flag.classList.add('wr-opened'); });
  const btn = root.querySelector('[data-wr-open]');
  if (btn) btn.addEventListener('click', function () { open(btn.getAttribute('data-wr-open')); });
  // A tap on a movement opens its cue and plays its two repetitions again.
  root.querySelectorAll('[data-wr-row]').forEach(function (el) {
    const tap = function () {
      el.classList.add('wr-opened');
      const holder = el.querySelector('.wr-pic');
      const svg = wrPicture(el.getAttribute('data-wr-row'), pics, false);
      if (holder && svg) holder.innerHTML = svg;
    };
    el.addEventListener('click', tap);
    el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); tap(); } });
  });
}

/**
 * The MCP Apps handshake, with ChatGPT's window.openai as the fallback.
 * All state is declared before any listener, so a message that arrives while
 * the script is still starting never meets an uninitialised binding.
 */
export function wrBridge(pics) {
  const state = { id: 1, ready: false, pending: {}, view: null, drawn: false, seen: null };
  const root = document.getElementById('wr-root');
  const post = function (m) { try { parent.postMessage(m, '*'); } catch (e) { /* no host */ } };
  const nextId = function () { state.id += 1; return state.id; };
  const open = function (url) { return wrOpen(url, post, nextId); };
  const draw = function (view) { state.view = view; state.drawn = true; wrMount(root, view, pics, open); };
  const fromResult = function (res) { draw(res && res.structuredContent ? res.structuredContent.view : null); };

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
    if (m.method === 'ui/notifications/tool-result') fromResult(m.params);
    else if (m.method === 'ui/notifications/host-context-changed') wrTheme(m.params);
    else if (m.method === 'ui/resource-teardown') post({ jsonrpc: '2.0', id: m.id, result: {} });
  });

  const oa = window.openai;
  if (oa && typeof oa === 'object') {
    if (oa.theme) wrTheme({ theme: oa.theme });
    // The same view compared as text: a host may hand back a fresh copy of an
    // unchanged output, and that is not a new card either.
    const seen = function (o) { try { return JSON.stringify(o.view); } catch (e) { return null; } };
    if (oa.toolOutput && typeof oa.toolOutput === 'object') { state.seen = seen(oa.toolOutput); draw(oa.toolOutput.view); }
    // set_globals fires for the theme, the height and the display mode too.
    // Only a NEW tool output redraws: redrawing on every one replayed the
    // figure, shut an opened row and put "Show all" back over an open list.
    window.addEventListener('openai:set_globals', function (ev) {
      const g = (ev && ev.detail && ev.detail.globals) || {};
      if (g.theme) wrTheme({ theme: g.theme });
      const out = g.toolOutput || (window.openai && window.openai.toolOutput);
      if (out && typeof out === 'object' && seen(out) !== state.seen) { state.seen = seen(out); draw(out.view); }
    });
  }

  const report = function () {
    const r = document.documentElement.getBoundingClientRect();
    const h = Math.ceil(r.height), w = Math.ceil(r.width);
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
export const WIDGET_RUNTIME = [wrEsc, wrPicture, wrSafeLink, wrRenderWorkout, wrOpen, wrTheme, wrMount, wrBridge];

// The card's stylesheet. Tokens fall back to the host's own variables where
// the host sends them; the body stays transparent so the host's surface shows.
// The credit's name is set at the TITLE's size, never larger — the method is
// the product's and the person is the credit.
export const WIDGET_CSS = [
  ':root{color-scheme:light dark;--wr-ink:#F7F3EE;--wr-dim:#A79A90;--wr-line:#332B27;--wr-panel:rgba(30,25,23,.55);--wr-heat:#F26419;--wr-kit:#7A6E67;--wr-floor:#332B27;--wr-plate:#1E1917;--wr-title:17px;--wr-small:12px}',
  ':root[data-theme=light]{--wr-ink:#1E1917;--wr-dim:#6B5F57;--wr-line:#E2D8CA;--wr-panel:rgba(240,232,218,.7);--wr-kit:#8F8278;--wr-floor:#D8CCBB;--wr-plate:#F0E8DA}',
  '@media (prefers-color-scheme:light){:root:not([data-theme=dark]){--wr-ink:#1E1917;--wr-dim:#6B5F57;--wr-line:#E2D8CA;--wr-panel:rgba(240,232,218,.7);--wr-kit:#8F8278;--wr-floor:#D8CCBB;--wr-plate:#F0E8DA}}',
  '*{box-sizing:border-box}',
  'html,body{margin:0;padding:0;background:transparent}',
  'body{font-family:var(--font-sans,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif);color:var(--color-text-primary,var(--wr-ink));font-size:14px;line-height:1.35;-webkit-text-size-adjust:100%}',
  '#wr-root{padding:10px 14px 8px;max-width:768px}',
  '.wr-none,.wr-empty{margin:4px 0;color:var(--color-text-secondary,var(--wr-dim))}',
  '.wr-flag{display:flex;gap:8px;align-items:baseline;margin:0 0 10px;padding:8px 10px;border:1px solid var(--wr-line);border-radius:var(--border-radius-md,10px);background:var(--wr-panel)}',
  '.wr-flag b{font-size:var(--wr-small);letter-spacing:.08em;color:var(--color-text-primary,var(--wr-ink))}',
  '.wr-flag span{font-size:13px;color:var(--color-text-secondary,var(--wr-dim));display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
  '.wr-all .wr-flag span,.wr-flag.wr-opened span{-webkit-line-clamp:unset;display:block}',
  '.wr-head{margin:0 0 6px}',
  '.wr-title{margin:0;font-size:var(--wr-title);font-weight:700;line-height:1.2}',
  '.wr-credit{margin:2px 0 0;color:var(--color-text-secondary,var(--wr-dim));font-size:var(--wr-small)}',
  '.wr-credit small{display:block;font-size:10px;letter-spacing:.08em;text-transform:uppercase}',
  '.wr-credit-name{display:block;font-size:var(--wr-title);font-weight:600;color:var(--color-text-primary,var(--wr-ink))}',
  '.wr-sub,.wr-aim{margin:2px 0 0;color:var(--color-text-secondary,var(--wr-dim));font-size:var(--wr-small)}',
  '.wr-aim small{margin-right:6px;letter-spacing:.08em;text-transform:uppercase;font-size:10px}',
  '.wr-notes{margin:4px 0 0;font-size:var(--wr-small);color:var(--color-text-secondary,var(--wr-dim));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.wr-all .wr-notes{white-space:normal}',
  '.wr-prog{margin:6px 0 0}',
  '.wr-bar{height:5px;border-radius:3px;background:var(--wr-line);overflow:hidden}',
  '.wr-bar i{display:block;height:100%;background:var(--wr-heat)}',
  '.wr-prog p{margin:3px 0 0;font-size:var(--wr-small);color:var(--color-text-secondary,var(--wr-dim))}',
  '.wr-list{list-style:none;margin:6px 0 0;padding:0}',
  '.wr-row{display:flex;gap:10px;align-items:center;padding:2px 0;border-top:1px solid var(--wr-line);cursor:pointer}',
  '.wr-row.wr-more{display:none}',
  '.wr-all .wr-row.wr-more{display:flex}',
  '.wr-row.wr-current{box-shadow:inset 3px 0 0 var(--wr-heat);padding-left:8px}',
  '.wr-row.wr-done .wr-name{opacity:.62}',
  '.wr-pic{flex:none;width:36px;height:36px;border-radius:8px;background:var(--wr-panel);color:var(--color-text-primary,var(--wr-ink));--wp-kit:var(--wr-kit);--wp-heat:var(--wr-heat);--wp-floor:var(--wr-floor);--wp-bg:var(--wr-plate)}',
  '.wr-pat .wr-pic{outline:1px dashed var(--wr-kit);outline-offset:-1px}',
  '.wr-pic:empty{background:transparent}',
  '.wr-pic svg{display:block;width:100%;height:100%}',
  '.wr-body{min-width:0;flex:1;display:flex;flex-direction:column}',
  '.wr-name{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.wr-rx,.wr-cue{font-size:var(--wr-small);color:var(--color-text-secondary,var(--wr-dim))}',
  '.wr-rx{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.wr-cue{display:none}',
  '.wr-opened .wr-cue,.wr-all .wr-cue{display:block}',
  '.wr-opened .wr-rx,.wr-all .wr-rx,.wr-opened .wr-name,.wr-all .wr-name{white-space:normal}',
  '.wr-foot{margin-top:6px}',
  '.wr-actions{display:flex;flex-wrap:wrap;gap:6px}',
  '.wr-btn{font:inherit;font-size:13px;padding:5px 10px;border-radius:var(--border-radius-md,10px);border:1px solid var(--wr-line);background:transparent;color:var(--color-text-primary,var(--wr-ink));cursor:pointer}',
  '.wr-foot p{margin:3px 0 0;font-size:10.5px;line-height:1.25;color:var(--color-text-secondary,var(--wr-dim))}',
  '.wr-pn::before{content:"";display:inline-block;width:9px;height:9px;margin-right:5px;border:1px dashed var(--wr-kit);vertical-align:-1px}',
  '.wr-url{word-break:break-all}',
].join('');
