// scripts/build-all-sql.mjs
// Concatenates every migration, in order, into schema/ALL.sql.
//
// Eleven copy-pastes into the Supabase SQL editor is eleven chances to run one
// out of order or miss one entirely, and the failure that causes turns up later
// as a broken screen rather than an error at the time. This makes it one paste.
//
// Every migration is written to be re-runnable — `if not exists`, `or replace`,
// `on conflict do update` — so running the whole file again is safe and is the
// right move when something has gone wrong and you are not sure how far it got.
//
// A test asserts this file is current, because a stale ALL.sql missing the
// newest migration is worse than not having one at all.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = fileURLToPath(new URL('../schema/', import.meta.url));
const files = readdirSync(dir).filter(f => /^\d{3}_.*\.sql$/.test(f)).sort();

const head = `-- schema/ALL.sql
-- GENERATED — do not edit. Run: node scripts/build-all-sql.mjs
--
-- Every WROUGHT migration, in order, in one file. Paste the whole thing into
-- the Supabase SQL editor and run it once.
--
-- Safe to run again. Every statement in here is idempotent, so re-running after
-- a partial failure picks up where it stopped rather than doubling anything.
--
-- Files included, in order:
${files.map((f, i) => `--   ${String(i + 1).padStart(2, ' ')}. ${f}`).join('\n')}

`;

const body = files.map(f => {
  const bar = '─'.repeat(Math.max(4, 68 - f.length));
  return `\n-- ${bar} ${f} ${'─'.repeat(4)}\n\n${readFileSync(path.join(dir, f), 'utf8').trimEnd()}\n`;
}).join('\n');

writeFileSync(path.join(dir, 'ALL.sql'), `${head}${body}\n`);
console.log(`schema/ALL.sql — ${files.length} migrations, ${(head + body).split('\n').length} lines`);
