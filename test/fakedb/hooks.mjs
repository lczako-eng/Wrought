// test/fakedb/hooks.mjs — module resolution hook: @supabase/supabase-js is
// answered by the in-memory stand-in. Nothing else is touched.
export async function resolve(specifier, context, next) {
  if (specifier === '@supabase/supabase-js') {
    return { url: new URL('./supabase.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
