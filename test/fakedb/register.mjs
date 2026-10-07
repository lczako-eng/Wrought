// test/fakedb/register.mjs
// `node --import ./test/fakedb/register.mjs script.mjs` — swaps the Supabase
// client for the in-memory one in ./supabase.mjs, so a tool can be run end to
// end with no network and no database. Used by the harness, in a child
// process, so the harness's own no-environment run is untouched.
import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
