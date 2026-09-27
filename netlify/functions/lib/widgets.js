// netlify/functions/lib/widgets.js
// The one card a chat host can draw: the workout, with its pictures.
//
// MCP Apps: a tool names a `ui://` resource on its descriptor, the host reads
// that resource once (`resources/read`, text/html;profile=mcp-app), renders it
// in a sandboxed frame, and hands it each result of the tool. ChatGPT and
// Claude both read the standard `_meta.ui.resourceUri`; the legacy ChatGPT
// keys ride beside it. A host that draws no widget ignores all of it and
// answers from the reply's `say` and `card_md`, so nothing is lost.
//
// SELF-CONTAINED, AND THAT IS A SECURITY PROPERTY. No external script, style,
// font or image; both CSP dialects list no domain at all. The card cannot
// fetch anything — not a signed progress-photo URL, not a tracker, not a
// newer copy of itself — and every picture is drawn inside it from an id.
//
// THE URI CARRIES THE CONTENT'S HASH, because ChatGPT caches a template by its
// address and only picks up a new one after a Refresh. And ANY such address is
// answered with the CURRENT page: a message from last month re-renders with
// today's script, which is why the script tolerates a view with fields it does
// not know and renders one neutral line for a view it cannot read.

import { createHash } from 'node:crypto';
import { PICTURES, PICTURE_IDS, PICTURE_RUNTIME, wpSvg } from '../../../public/exercise-pictures.js';
import { WIDGET_RUNTIME, WIDGET_CSS } from './widget_runtime.js';

export const RESOURCE_MIME = 'text/html;profile=mcp-app';
export const WIDGET_URI_RE = /^ui:\/\/wrought\/workout-[0-9a-f]{6,16}\.html$/;

// JSON inside a <script> may never close the script.
const inScript = v => JSON.stringify(v).replace(/</g, '\\u003c');

/** The card's whole page. */
export function widgetHtml() {
  const script = [
    `const WR_PICTURES = ${inScript(PICTURES)};`,
    `const WR_PICTURE_IDS = ${inScript(PICTURE_IDS)};`,
    ...PICTURE_RUNTIME.map(String),
    ...WIDGET_RUNTIME.map(String),
    `wrBridge({ table: WR_PICTURES, ids: WR_PICTURE_IDS, svg: ${wpSvg.name} });`,
  ].join('\n');
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<meta name="color-scheme" content="light dark"><style>${WIDGET_CSS}</style></head>` +
    `<body><main id="wr-root" aria-live="polite"></main>\n<script>${script}</script></body></html>`;
}

const html = widgetHtml();
const uri = `ui://wrought/workout-${createHash('sha256').update(html).digest('hex').slice(0, 10)}.html`;
const meta = {
  ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true },
  'openai/widgetCSP': { connect_domains: [], resource_domains: [], redirect_domains: ['https://wrought.fit'] },
  'openai/widgetPrefersBorder': true,
  'openai/widgetDescription': 'Shows one workout as a card: each movement with a small moving figure, sets × reps or minutes, rest, the style credit, and during a session which ones are done. It never shows a weight. The reply\'s `say` is the only text needed — do not add a second list or any figure of your own.',
};

export const WIDGETS = {
  workout: {
    html, uri, meta,
    listing: {
      uri, name: 'wrought-workout', title: 'WROUGHT workout card',
      description: 'One workout drawn as a card, with a small moving figure for each movement. Never a weight.',
      mimeType: RESOURCE_MIME, _meta: meta,
    },
  },
};

/** The widget behind a `ui://` address — any hash, answered with today's page. */
export function widgetFor(requested) {
  return typeof requested === 'string' && WIDGET_URI_RE.test(requested) ? WIDGETS.workout : null;
}
