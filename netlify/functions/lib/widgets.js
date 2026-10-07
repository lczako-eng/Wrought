// netlify/functions/lib/widgets.js
// Wrought's own card in the chat — the registry a host reads it from.
//
// MCP Apps: a tool names a `ui://` resource on its descriptor, the host reads
// that resource once (`resources/read`, text/html;profile=mcp-app), renders it
// in a sandboxed frame, and hands it each result of the tool. ChatGPT and
// Claude both read the standard `_meta.ui.resourceUri`; the legacy ChatGPT
// keys ride beside it. A host that draws no card ignores all of it and answers
// from the reply's `say` and `day_card`, so nothing is lost.
//
// THE VIEW RIDES IN THE RESULT'S _meta, never in the text and never in
// structuredContent. Both the MCP Apps specification and OpenAI's reference
// say result _meta reaches the card and not the model — so the model reads
// exactly what it read before, with nothing new to contradict, and the custom
// GPT's Actions door (which reads content[0].text only) never sees it. No
// structuredContent at all: Claude Code hands the model structuredContent
// INSTEAD of the text, so a partial object there would replace the reply.
// A tool attaches its view under the CARD symbol, which JSON.stringify never
// writes; handleRpc moves it to _meta['wrought/card'].
//
// SELF-CONTAINED, AND THAT IS A SECURITY PROPERTY. No external script, style,
// font or image; both CSP dialects list no domain at all. The card cannot
// fetch anything — not a signed photo URL, not a tracker, not a newer copy of
// itself.
//
// THE URI CARRIES THE CONTENT'S HASH, because ChatGPT caches a template by its
// address and only picks up a new one after a Refresh. And ANY such address is
// answered with the CURRENT page: a message from last month re-renders with
// today's script, which is why the script tolerates fields it does not know
// and draws the header alone for a view it cannot read.

import { createHash } from 'node:crypto';
import { WIDGET_RUNTIME, WIDGET_CSS } from './widget_runtime.js';

export const RESOURCE_MIME = 'text/html;profile=mcp-app';
// Tool implementations attach their view here. A Symbol, so it is never
// serialised into the text a model reads.
export const CARD = Symbol('wrought.card');
// The result _meta key the card reads its view from.
export const CARD_META = 'wrought/card';
const URI_RE = /^ui:\/\/wrought\/([a-z]+)-[0-9a-f]{6,16}\.html$/;

// Surfaced to the model by ChatGPT when the card loads — the one place it is
// told a card is on screen, so it can stop pasting the table under it.
export const WIDGET_DESCRIPTION = 'Wrought\'s card for this reply, drawn in the person\'s view: on a write the item just logged with its figures, then the day — each food with its calories and macros, the total, the energy balance row by row, the net when one can be given, steps, what is left and the week. When it shows the day, do not paste day_card or repeat the card\'s figures: say the reply\'s say line (it opens "Logged in Wrought" on a write) and only what the card does not show, never a figure that differs from it. When it shows only a one-line stamp, it carries none of the day: answer as the reply\'s note says.';

/** The card's whole page. */
function page() {
  const script = [...WIDGET_RUNTIME.map(String), 'wrBridge();'].join('\n');
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    // light dark, not dark: the frame's canvas has to match the host's scheme
    // or it paints an opaque box behind the plate; wrTheme sets the host's.
    `<meta name="color-scheme" content="light dark"><style>${WIDGET_CSS}</style></head>` +
    `<body><main id="wr-root" aria-live="polite"></main>\n<script>${script}</script></body></html>`;
}

function build(kind, { title, description, widgetDescription }) {
  const html = page();
  const uri = `ui://wrought/${kind}-${createHash('sha256').update(html).digest('hex').slice(0, 10)}.html`;
  // The plate is the frame, so the host is asked not to draw a second one.
  const meta = {
    ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false },
    'openai/widgetCSP': { connect_domains: [], resource_domains: [], redirect_domains: ['https://wrought.fit'] },
    'openai/widgetPrefersBorder': false,
    'openai/widgetDescription': widgetDescription,
  };
  return { kind, html, uri, meta, listing: { uri, name: `wrought-${kind}`, title, description, mimeType: RESOURCE_MIME, _meta: meta } };
}

export const WIDGETS = {
  day: build('day', {
    title: 'WROUGHT day card',
    description: 'The day from your Wrought record: what was logged, the food with its calories, the energy balance, steps, what is left and the week.',
    widgetDescription: WIDGET_DESCRIPTION,
  }),
};

/** The widget behind a `ui://` address — any hash of a known kind, answered with today's page. */
export function widgetFor(requested) {
  const m = typeof requested === 'string' && requested.match(URI_RE);
  return m && Object.hasOwn(WIDGETS, m[1]) ? WIDGETS[m[1]] : null;
}

/**
 * A card tool's descriptor _meta. The invocation lines are shown whatever the
 * outcome, so they never claim a write: "Logged in Wrought" lives in `say`
 * only, after the write landed. Model-only, and not callable from a card.
 */
export function templateMeta(kind, { invoking, invoked }) {
  const u = WIDGETS[kind].uri;
  return {
    ui: { resourceUri: u, visibility: ['model'] },
    'ui/resourceUri': u,
    'openai/outputTemplate': u,
    'openai/widgetAccessible': false,
    'openai/toolInvocation/invoking': invoking,
    'openai/toolInvocation/invoked': invoked,
  };
}

/** Attach a view to a tool's result, under the symbol. */
export const withCard = view => (view ? { [CARD]: view } : {});

/**
 * The one-strip card: the header, a badge and one line. No door: a stamp is
 * the small receipt (a capture in passing, a fill-in, a failure) and a 44px
 * button would be most of it. The view carries only what is drawn.
 */
export function stampView({ badge = null, line = null, tone = 'ok', date_label = null } = {}) {
  return { v: 1, kind: 'stamp', badge, line, tone, date_label };
}

/**
 * The view a card tool's result carries — pure. The tool's own view when it
 * attached one; a NOT SAVED / NO ANSWER stamp, with the server's own sentence,
 * when it failed; otherwise the header alone. It never claims a write it was
 * not handed: a failed write must never look like a receipt.
 */
export function cardFor(out, { write = false, email = null } = {}) {
  const own = out && typeof out === 'object' ? out[CARD] : null;
  const view = own || (out && typeof out === 'object' && out.error
    ? stampView({ badge: write ? 'NOT SAVED' : 'NO ANSWER', tone: 'warn', line: typeof out.say === 'string' && out.say ? out.say : String(out.error) })
    : stampView());
  // Whose record it is rides on the day card's foot. A stamp draws no foot,
  // so it carries no account.
  return view.kind === 'day' ? { ...view, account: email || null } : view;
}
