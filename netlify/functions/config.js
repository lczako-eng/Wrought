// netlify/functions/config.js
// The two public values the browser needs, served as JavaScript.
//
// The pages read window.WROUGHT_SUPABASE_URL and window.WROUGHT_SUPABASE_ANON,
// and until now nothing set them. That meant every sign-in screen on a fresh
// deploy said "this deploy is missing its Supabase keys" and the only fix was
// snippet injection buried in Netlify's build settings — a manual step nobody
// would guess, failing in a way that reads like the product is broken.
//
// Now the environment variables alone are enough. Both values here are public
// by design: the URL is in every request the browser makes, and the anon key is
// the publishable one, which is why row level security exists on every table.
// The service role key is the secret and never comes anywhere near this file.

const KEY = () =>
  process.env.SUPABASE_ANON_KEY
  || process.env.SUPABASE_PUBLISHABLE_KEY      // Supabase's newer name for it
  || process.env.WROUGHT_SUPABASE_ANON
  || '';

export const handler = async () => {
  // No trailing slash, for the same reason the server strips it: Supabase
  // answers "Invalid path specified in request URL" and nothing explains why.
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const anon = KEY();

  // WHICH BUILD AM I LOOKING AT. Three separate bugs have now been reported
  // as "still broken" when the fix was live and the phone was holding an older
  // page — and there was no way for anybody, including the person holding it,
  // to tell those two apart. That is not a caching problem, it is a missing
  // fact: a fix that cannot be confirmed as delivered is a fix that gets
  // re-reported, re-diagnosed and re-shipped.
  //
  // Netlify sets COMMIT_REF and DEPLOY_ID on every build. Neither is secret —
  // the commit is public and the deploy id identifies a build, not an account.
  const build = (process.env.COMMIT_REF || '').slice(0, 7)
    || (process.env.DEPLOY_ID || '').slice(0, 7) || '';

  const body = `// Generated per deploy from the environment. Nothing secret is here.
window.WROUGHT_SUPABASE_URL = ${JSON.stringify(url)};
window.WROUGHT_SUPABASE_ANON = ${JSON.stringify(anon)};
window.WROUGHT_BUILD = ${JSON.stringify(build)};
${url && anon ? '' : `console.warn('WROUGHT: ${!url ? 'SUPABASE_URL' : 'SUPABASE_ANON_KEY'} is not set on this deploy. See /status.');\n`}`;

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      // Short, so rotating a key does not leave browsers on the old one for a
      // week, but long enough that it is not fetched on every navigation.
      'Cache-Control': 'public, max-age=300, must-revalidate',
    },
    body,
  };
};
