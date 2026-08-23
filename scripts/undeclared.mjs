// scripts/undeclared.mjs
// Identifiers that are READ but declared nowhere in the file.
//
// WHY THIS EXISTS. `log_set` and `end_session` were both throwing ReferenceError
// in production — `moreSetsHere` in one, `muscles` in the other — because two
// refactors moved the logic that used to declare them and left the reads behind.
// In an ES module a read of an undeclared identifier is a hard runtime error,
// and both of these threw AFTER the database write had already landed. So the
// set was inserted, the workout was filed, and the assistant was handed a
// failure and an instruction to retry — which wrote the same set again.
//
// It shipped, and 631 tests stayed green, because the harness tests arithmetic
// and never invokes an MCP tool handler. That is the gap: a function nothing
// calls is a function nothing can prove even PARSES into working code.
//
// This is deliberately the SIMPLEST check that has no false positives: every
// name declared anywhere in the file, in any scope, counts as declared. It
// therefore cannot catch a shadowing or temporal-dead-zone mistake — but it
// catches the entire class that has actually bitten this project, and a check
// nobody trusts because it cries wolf is a check that gets deleted.

import { readFileSync } from 'node:fs';
import * as acorn from 'acorn';

// Anything the runtime provides. Not exhaustive by design — an unknown global
// shows up as a finding, which is the safe direction: it gets read once and
// added here, rather than a real bug being waved through.
export const GLOBALS = new Set([
  'globalThis', 'console', 'process', 'Buffer', 'URL', 'URLSearchParams',
  'JSON', 'Math', 'Date', 'Number', 'String', 'Boolean', 'Array', 'Object',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'BigInt', 'Proxy',
  'Reflect', 'RegExp', 'Error', 'TypeError', 'RangeError', 'ReferenceError',
  'SyntaxError', 'AggregateError', 'Infinity', 'NaN', 'undefined',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'btoa', 'atob',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  'structuredClone', 'crypto', 'Intl', 'fetch', 'Response', 'Request', 'Headers',
  'FormData', 'Blob', 'File', 'AbortController', 'AbortSignal', 'TextEncoder',
  'TextDecoder', 'ReadableStream', 'WritableStream', 'TransformStream',
  'arguments', 'require', 'module', 'exports', '__dirname', '__filename',
  // Browser, for public/*.html
  'window', 'document', 'navigator', 'location', 'history', 'localStorage',
  'sessionStorage', 'indexedDB', 'alert', 'confirm', 'prompt', 'Notification',
  'PushManager', 'ServiceWorker', 'Image', 'Audio', 'Option', 'Event',
  'CustomEvent', 'MutationObserver', 'IntersectionObserver', 'ResizeObserver',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle',
  'addEventListener', 'removeEventListener', 'DOMParser', 'XMLHttpRequest',
  'WebSocket', 'CSS', 'Element', 'HTMLElement', 'Node', 'NodeList', 'self',
  'caches', 'clients', 'skipWaiting', 'registration', 'importScripts', 'matchMedia',
  'FileReader', 'FileList', 'innerHeight', 'innerWidth', 'scrollX', 'scrollY',
  'devicePixelRatio', 'performance', 'screen', 'frames', 'parent', 'top', 'open',
  'close', 'print', 'scrollTo', 'scrollBy', 'getSelection', 'CanvasRenderingContext2D',
  // Typed arrays and binary
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array',
]);

function collect(node, declared, read) {
  const decl = (pat) => {
    if (!pat) return;
    switch (pat.type) {
      case 'Identifier': declared.add(pat.name); return;
      case 'ObjectPattern':
        for (const p of pat.properties) {
          if (p.type === 'RestElement') decl(p.argument);
          else { decl(p.value); if (p.computed) walk(p.key); }
        }
        return;
      case 'ArrayPattern': for (const e of pat.elements) decl(e); return;
      case 'AssignmentPattern': decl(pat.left); walk(pat.right); return;
      case 'RestElement': decl(pat.argument); return;
      default: walk(pat);
    }
  };

  const walk = (n) => {
    if (!n || typeof n.type !== 'string') return;
    switch (n.type) {
      case 'VariableDeclarator': decl(n.id); walk(n.init); return;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        if (n.id) declared.add(n.id.name);
        for (const p of n.params) decl(p);
        walk(n.body);
        return;
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (n.id) declared.add(n.id.name);
        walk(n.superClass); walk(n.body);
        return;
      case 'CatchClause': decl(n.param); walk(n.body); return;
      case 'ImportDeclaration':
        for (const s of n.specifiers) declared.add(s.local.name);
        return;
      case 'ExportSpecifier': return;                    // local is a read, handled below
      case 'LabeledStatement': walk(n.body); return;
      case 'BreakStatement': case 'ContinueStatement': return;
      case 'MemberExpression':
        walk(n.object);
        if (n.computed) walk(n.property);                // obj.foo — foo is not a read
        return;
      case 'Property':
        // { foo: bar } — foo is a key, bar is a read. { foo } — foo IS a read.
        if (n.computed) walk(n.key);
        walk(n.value);
        return;
      case 'PropertyDefinition':
        if (n.computed) walk(n.key);
        walk(n.value);
        return;
      case 'MethodDefinition':
        if (n.computed) walk(n.key);
        walk(n.value);
        return;
      case 'Identifier': read.set(n.name, (read.get(n.name) || 0) + 1); return;
      case 'MetaProperty': return;
    }
    for (const k of Object.keys(n)) {
      if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  };

  walk(node);
}

/** @returns Map<name, count> of identifiers read but declared nowhere. */
export function undeclaredIn(source, { ecmaVersion = 2023 } = {}) {
  const ast = acorn.parse(source, { ecmaVersion, sourceType: 'module', allowAwaitOutsideFunction: true });
  const declared = new Set();
  const read = new Map();
  collect(ast, declared, read);
  const out = new Map();
  for (const [name, n] of read) if (!declared.has(name) && !GLOBALS.has(name)) out.set(name, n);
  return out;
}

// The dashboard is one 300KB inline module inside app.html, and it is exactly
// as capable of this bug as the server is — public/app.html has already shipped
// a panel reading a field the server does not send. Inline scripts only; a
// `src=` tag is somebody else's file.
export function scriptsFrom(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1]).join('\n;\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let bad = 0;
  for (const f of process.argv.slice(2)) {
    const raw = readFileSync(f, 'utf8');
    const found = undeclaredIn(/\.html?$/i.test(f) ? scriptsFrom(raw) : raw);
    if (found.size) {
      bad += found.size;
      console.log(`${f}:`);
      for (const [n, c] of found) console.log(`  ${n} — read ${c}x, declared nowhere`);
    }
  }
  console.log(bad ? `\n${bad} undeclared identifier(s).` : 'clean');
  process.exit(bad ? 1 : 0);
}
