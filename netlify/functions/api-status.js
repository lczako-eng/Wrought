// netlify/functions/api-status.js
// "Is this thing actually set up?"
//
// Every other endpoint in here names the one migration IT needs when IT fails.
// That is right, but it means finding out what is missing costs a tour of the
// whole product, one broken screen at a time. This answers it in one look.
//
// Open https://wrought.fit/status in a browser and read the list.
//
// WHAT IT DELIBERATELY WILL NOT SAY. No environment variable VALUES, ever — only
// whether something is set. No admin addresses. No row counts, no user data, not
// even how many accounts exist: a setup checklist is not a reason to publish how
// busy a health product is. Everything here is presence or absence of plumbing,
// which is the same thing an attacker learns by hitting any other endpoint and
// reading its error.

import { supabase } from './lib/wrought.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

// Each migration, and one thing that only exists once it has run. Checking a
// table rather than a version number means this cannot drift from reality — if
// somebody ran the SQL by hand in pieces, this still tells the truth.
const MIGRATIONS = [
  { file: '001_wrought_core.sql',        probe: t('wrought_events'),                gives: 'the log itself — everything depends on this' },
  { file: '002_wrought_oauth.sql',       probe: t('wrought_oauth_clients'),         gives: 'sign in with WROUGHT inside ChatGPT and Claude' },
  { file: '003_wrought_training.sql',    probe: t('wrought_sets'),                  gives: 'sessions, sets, routines, progression' },
  { file: '004_wrought_fasting.sql',     probe: typeIsAccepted('fast'),             gives: 'log_fast' },
  { file: '005_wrought_activity.sql',    probe: col('wrought_profile', 'activity_level'), gives: 'calories out counting a working day as more than zero' },
  { file: '006_wrought_identity.sql',    probe: fn('wrought_merge_accounts'),       gives: 'merging two accounts back into one' },
  { file: '007_wrought_push.sql',        probe: t('wrought_push_subs'),             gives: 'notifications on your phone' },
  { file: '008_wrought_blocks.sql',      probe: t('wrought_blocks'),                gives: 'multi-week training blocks' },
  { file: '009_wrought_photos.sql',      probe: t('wrought_photos'),                gives: 'progress photos' },
  { file: '010_wrought_profile_web.sql', probe: col('wrought_profile', 'display_name'), gives: 'the profile screen and your picture' },
  { file: '011_wrought_membership.sql',  probe: t('wrought_memberships'),           gives: 'plans, trials, codes and the admin people list' },
  { file: '012_wrought_link_codes.sql',  probe: t('wrought_link_codes'),            gives: 'joining two accounts with a code instead of a password' },
  // Like 004, this widens a check constraint rather than creating anything, and
  // a constraint is not visible through PostgREST. It is no longer ASSUMED: one
  // stored 'activity' row is the constraint answering for itself, and with none
  // the row says unproven rather than showing a tick nobody earned.
  { file: '013_wrought_work.sql',        probe: typeIsAccepted('activity'),         gives: 'log_activity — a work shift counted as its own burn' },
  { file: '014_wrought_plan.sql',        probe: col('wrought_profile', 'plan_pace'), gives: 'the plan — how fast it is paced and how hard it pushes' },
  // An index rebuild, so there is genuinely nothing PostgREST can see — not the
  // index, and not a consequence of it, because /ingest now has a fallback that
  // writes correctly either way. So this one says outright that it was not
  // checked. /ingest reports events_error and names this file when it falls back.
  { file: '015_wrought_ingest_dedupe_fix.sql', probe: cannotProbe(), gives: 'workouts from a watch actually landing' },
  { file: '016_wrought_set_source.sql',  probe: col('wrought_sets', 'event_id'),    gives: 'after-the-fact workouts counting toward lifts without doubling on re-edits' },
  { file: '017_wrought_session_aim.sql', probe: col('wrought_sessions', 'aim'),    gives: 'what each session is FOR, kept on the record rather than said once and lost' },
  { file: '018_wrought_alerts.sql',     probe: t('wrought_alerts'),                gives: 'notifications you set by talking — the AI writes the rule, the hourly job sends it' },
  { file: '019_wrought_morning.sql',    probe: col('wrought_profile', 'morning_hour'), gives: 'the morning briefing — where you stand before the day, not a verdict on one that is over' },
  { file: '020_wrought_morning_opens.sql', probe: col('wrought_profile', 'morning_opens'), gives: 'tapping the morning brief opening your assistant with the day already asked for' },
];

// A probe that treats EVERY error as "not run" lies twice over: a timeout reads
// as a missing migration, and PostgREST's schema cache lagging behind fresh DDL
// reads as SQL that never ran. Both send somebody back to the SQL editor to fix
// something that is not broken.
//
// So the three answers are kept apart: it is there, it is genuinely absent, or
// we could not tell.
const MISSING = /does not exist|could not find the (table|column|relation)|schema cache/i;

// AN ASSUMPTION DRAWN AS A TICK IS THE MOST EXPENSIVE ROW ON THIS PAGE.
//
// 004, 013 and 015 widen a check constraint or rebuild an index, and neither is
// visible through PostgREST — so they were marked `assume: true` and rendered
// with the same green tick as a migration that had genuinely been probed. The
// page then said "Everything is set up."
//
// It cost the founder days. 013 is the migration that decides whether a work
// shift can be stored at all; he read a tick beside it, so every hunt for why
// his petting-zoo hours were worth nothing went somewhere else — and the one
// screen built to answer "is this thing set up" was the thing asserting it was.
// The whole point of this file is that it "cannot drift from reality"; an
// assumption is drift with a tick on it.
//
// A CONSTRAINT CANNOT BE READ, BUT ITS CONSEQUENCE CAN. If a single row in the
// table is stored under a type, the constraint permits that type — that is
// proof, not inference, and it costs one counting query that returns a number
// rather than any row. The absence of such a row proves nothing (nobody may
// have logged one), and that is reported as unproven rather than as a fault.
function typeIsAccepted(type) {
  return async () => {
    const { count, error } = await supabase.from('wrought_events')
      .select('id', { count: 'exact', head: true }).eq('event_type', type).limit(1);
    if (error) return verdict(error);
    // One row of this type anywhere is the constraint answering for itself.
    return count > 0 ? true : 'assumed';
  };
}

// And where there is no consequence to read either — an index rebuild leaves
// nothing PostgREST can see — the honest answer is that it was not checked.
// A declaration rather than a const arrow: MIGRATIONS is built at module load
// and calls this above its own line, which a const would meet as a dead zone.
function cannotProbe() { return async () => 'assumed'; }

function verdict(error) {
  if (!error) return true;
  if (MISSING.test(error.message || '')) {
    // PostgREST says the same thing for "you never ran this" and "I have not
    // reloaded since you did". The second resolves itself within a minute.
    return /schema cache/i.test(error.message) ? 'stale' : false;
  }
  return 'unknown';
}

function t(table) {
  return async () => {
    const { error } = await supabase.from(table).select('*', { count: 'exact', head: true }).limit(1);
    return verdict(error);
  };
}

function col(table, column) {
  return async () => {
    const { error } = await supabase.from(table).select(column, { head: true }).limit(1);
    return verdict(error);
  };
}

function fn(name) {
  return async () => {
    // A missing function and a function that rejected its arguments are
    // different answers. Only the first means the migration has not run.
    const { error } = await supabase.rpc(name, { keep: null, absorb: null });
    if (!error) return true;
    if (/schema cache/i.test(error.message || '')) return 'stale';
    return !/could not find the function|does not exist/i.test(error.message || '');
  };
}

const ENV = [
  { key: 'SUPABASE_URL',              needed: 'everything', hard: true },
  { key: 'SUPABASE_SERVICE_ROLE_KEY', needed: 'everything', hard: true },
  { key: 'SUPABASE_ANON_KEY',         needed: 'signing in on the website', hard: true },
  { key: 'WROUGHT_SITE_URL',          needed: 'OAuth redirects and device callbacks' },
  { key: 'WROUGHT_ADMIN_EMAILS',      needed: 'the Admin tab' },
  { key: 'WROUGHT_VAPID_PUBLIC',      needed: 'notifications' },
  { key: 'WROUGHT_VAPID_PRIVATE',     needed: 'notifications' },
  { key: 'RESEND_API_KEY',            needed: 'the nightly email' },
];

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const env = ENV.map(e => ({ ...e, set: !!process.env[e.key] }));

  // A trailing slash makes Kong answer "Invalid path specified in request URL"
  // and nothing anywhere says why. It has cost this project an evening already,
  // so it gets checked by name.
  const url = process.env.SUPABASE_URL || '';
  const trailingSlash = url.endsWith('/');

  // Which sign-in doors Supabase actually has switched on. The pages hide any
  // provider that is off — showing a button that dumps somebody on raw JSON is
  // worse than not showing it — but that leaves "where is Sign in with Apple?"
  // with no answer anywhere. This is the answer.
  let providers = null;
  if (url && !trailingSlash && (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY)) {
    try {
      const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
      const r = await fetch(`${url.replace(/\/$/, '')}/auth/v1/settings`, { headers: { apikey: key } });
      if (r.ok) {
        const j = await r.json();
        const ext = j.external || {};
        providers = ['email', 'apple', 'google'].map(id => ({ id, on: ext[id] === true }));
      }
    } catch { /* left null, reported as unknown */ }
  }

  let migrations = [];
  let reachable = false;
  if (supabase && !trailingSlash) {
    try {
      // NO BYPASS. This used to read `m.assume ? true : await m.probe()`, which
      // is what turned three unchecked migrations into three green ticks. Every
      // row now comes from a probe, and a probe that cannot prove anything says
      // 'assumed' rather than being handed a `true` it never earned.
      migrations = await Promise.all(MIGRATIONS.map(async m => ({
        file: m.file, gives: m.gives, run: await m.probe(),
      })));
      // `true` only. 'assumed' is not evidence the database answered, and
      // counting it here would make an unreachable database look reachable.
      reachable = migrations.some(m => m.run === true);
    } catch { /* reported as unreachable below */ }
  }

  // Only a definite `false` counts as missing. 'stale' and 'unknown' are not
  // instructions to go and run something again.
  const missingMigrations = migrations.filter(m => m.run === false).map(m => m.file);
  const unsure = migrations.filter(m => m.run === 'stale' || m.run === 'unknown');
  // Kept APART from `unsure`, because they are a different sentence. 'stale'
  // resolves itself in a minute and the advice is to reload; 'assumed' never
  // resolves and reloading will not touch it — it is a check this page cannot
  // perform, and saying "reload in a moment" about it is a small permanent lie.
  const assumed = migrations.filter(m => m.run === 'assumed');
  const missingHardEnv = env.filter(e => e.hard && !e.set).map(e => e.key);

  const ready = reachable && !missingHardEnv.length && !trailingSlash
    && !migrations.slice(0, 3).some(m => m.run === false);

  const say = trailingSlash
    ? 'SUPABASE_URL has a trailing slash. Remove it — Supabase answers "Invalid path specified in request URL" and nothing explains why.'
    : missingHardEnv.length ? `Not configured: ${missingHardEnv.join(' and ')} ${missingHardEnv.length === 1 ? 'is' : 'are'} not set.`
    : !reachable ? 'Cannot reach the database. Check SUPABASE_URL and the service role key.'
    : missingMigrations.length ? `Working. Still to run: ${missingMigrations.join(', ')}.`
    : unsure.length ? `Everything that could be checked is set up. ${unsure.length} check${unsure.length === 1 ? '' : 's'} could not be confirmed just now — reload in a moment.`
    // NOT "everything is set up". These were never checked, and saying so was
    // what sent the founder looking everywhere except the one migration that
    // was actually the problem.
    : assumed.length ? `Everything that can be checked is set up. ${assumed.length} cannot be checked from here — see below.`
    : 'Everything is set up.';

  const body = {
    ready,
    say,
    database: { reachable, trailing_slash_on_url: trailingSlash },
    migrations,
    // Presence only. A value never appears here, on purpose.
    environment: env.map(e => ({ key: e.key, set: e.set, needed_for: e.needed })),
    sign_in_providers: providers,
    next: nextStep({ trailingSlash, missingHardEnv, reachable, migrations, env, unsure, assumed, providers, appleWanted: false }),
  };

  const wantsHtml = /text\/html/.test(event.headers?.accept || event.headers?.Accept || '');
  if (!wantsHtml) return { statusCode: 200, headers: CORS, body: JSON.stringify(body) };

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    body: page(body),
  };
};

// One thing to do next, not a list. A checklist with eleven open items is a
// checklist nobody starts.
function nextStep({ trailingSlash, missingHardEnv, reachable, migrations, env, unsure = [], assumed = [], providers = null, appleWanted = false }) {
  if (trailingSlash) return 'Remove the trailing slash from SUPABASE_URL in Netlify, then redeploy.';
  if (missingHardEnv.length) return `Set ${missingHardEnv.join(' and ')} in Netlify, then redeploy.`;
  if (!reachable) return 'Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY against the Supabase project settings.';
  const nextMigration = migrations.find(m => m.run === false);
  if (nextMigration) return `Run schema/${nextMigration.file} in the Supabase SQL editor — it gives you ${nextMigration.gives}.`;
  if (providers && !providers.find(pr => pr.id === 'apple')?.on && appleWanted) {
    return 'Apple is not enabled in Supabase → Authentication → Providers. Until it is, the Apple button stays hidden rather than failing with raw JSON.';
  }
  if (unsure.length) return 'Reload this page in a moment — a check could not be confirmed, which usually means Supabase has not refreshed since the last SQL ran.';
  // Reloading will never resolve an assumption, so it must not be offered as
  // the answer. The way to settle it is to run the file — these are all safe to
  // run twice, which is what makes "just run it" the honest advice rather than
  // a shrug.
  if (assumed.length) {
    return `Cannot be checked from here: ${assumed.map(m => m.file).join(', ')}. ` +
      'A constraint and an index are invisible through the API, so this page can only report that it did not look. ' +
      'Running them again in the Supabase SQL editor is safe and settles it.';
  }
  if (!env.find(e => e.key === 'WROUGHT_VAPID_PUBLIC')?.set) {
    return 'Optional: run node scripts/vapid.mjs and set the three VAPID variables to turn on notifications.';
  }
  return 'Nothing. Connect your phone at /connect.html.';
}

function page(d) {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Three states, not two. A tick, a cross, and "could not tell" — which must
  // not look like a cross, or somebody re-runs SQL that already ran.
  const row = (ok, name, note) =>
    `<li class="${ok === true ? 'y' : ok === false ? 'n' : 'q'}"><b>${esc(name)}</b><span>${esc(note)}</span></li>`;

  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>WROUGHT — setup</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>
:root{--bg:#14110F;--panel:#1E1917;--line:#332B27;--text:#F4EFE9;--dim:#9A8D84;--faint:#6B615A;
--ok:#6FA672;--no:#F26419}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);padding:28px 20px 60px;
font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:620px;margin:0 auto}
h1{font-family:Rockwell,"Roboto Slab",Georgia,serif;font-size:26px;margin:0 0 4px;letter-spacing:.02em}
.state{font-size:15px;color:var(--dim);margin:0 0 22px}
.next{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--no);
border-radius:11px;padding:16px 18px;margin:0 0 26px}
.next b{display:block;font-size:11.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin-bottom:6px}
.next.done{border-left-color:var(--ok)}
h2{font-size:11.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin:26px 0 10px}
ul{list-style:none;margin:0;padding:0}
li{display:flex;align-items:baseline;gap:10px;padding:9px 0;border-top:1px solid var(--line);font-size:14.5px}
li:first-child{border-top:0}
li::before{content:'\\2717';color:var(--no);font-weight:700;width:14px;flex:none}
li.y::before{content:'\\2713';color:var(--ok)}
li.q::before{content:'?';color:var(--dim);font-weight:700}
li b{font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
li span{color:var(--faint);font-size:13px;margin-left:auto;text-align:right}
a{color:var(--no)}
p.foot{color:var(--faint);font-size:12.5px;margin-top:30px;line-height:1.55}
</style>
<main>
<h1>Setup</h1>
<p class="state">${esc(d.say)}</p>

<div class="next${d.ready && d.next.startsWith('Nothing') ? ' done' : ''}">
  <b>Do this next</b>${esc(d.next)}
</div>

<h2>Migrations</h2>
<ul>${d.migrations.length
  ? d.migrations.map(m => row(m.run === true ? true : m.run === false ? false : null, m.file,
      m.run === true ? ''
      : m.run === false ? m.gives
      // Said in as many words. It used to draw the same green tick as a real
      // probe, and that tick is why 013 was ruled out for days.
      : m.run === 'assumed' ? 'not checked — cannot be seen through the API'
      : 'could not check just now')).join('')
  : '<li class="n"><b>could not check</b><span>database unreachable</span></li>'}</ul>

<h2>Sign-in</h2>
<ul>${d.sign_in_providers
  ? d.sign_in_providers.map(pr => row(pr.on, pr.id,
      pr.on ? '' : 'switched off in Supabase — Authentication → Providers')).join('')
  : '<li class="q"><b>could not check</b><span>needs SUPABASE_ANON_KEY</span></li>'}</ul>

<h2>Environment</h2>
<ul>${d.environment.map(e => row(e.set, e.key, e.set ? '' : e.needed_for)).join('')}</ul>

<p class="foot">This page shows whether things are set, never what they are set to.
No key, no address and no data from anybody's log appears here.
<br><a href="/connect.html">Connect a phone</a> · <a href="/app.html">Dashboard</a></p>
</main>`;
}
