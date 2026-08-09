-- 010_wrought_profile_web.sql
-- A profile somebody can actually look at and edit.
--
-- Everything in wrought_profile was reachable only through the assistant, via
-- set_profile. That is the right way to CAPTURE it — five facts asked once, in
-- passing, never as an interrogation — but it is the wrong and only way to
-- CHECK it. "What does it think my height is" had no answer you could go and
-- read, and a memory product that cannot show you what it remembers is asking
-- for trust it has not earned.
--
-- A settings screen is not a form somebody has to fill in. It is a place to
-- look. Nothing here is required and nothing is asked for at signup.

alter table public.wrought_profile
  add column if not exists display_name text;

alter table public.wrought_profile
  add column if not exists avatar_path text;

comment on column public.wrought_profile.display_name is
  'What they want to be called. Used in the greeting and nowhere else — there is no social surface in this product for a name to leak onto.';
comment on column public.wrought_profile.avatar_path is
  'Object path in the private wrought-avatars bucket. Nothing ever reads this image, exactly as with progress photos.';

-- ── Avatars ─────────────────────────────────────────────────────────────────
-- A separate bucket from progress photos, and not because of tidiness: the two
-- have genuinely different lifetimes. Somebody deleting every progress photo
-- should not lose their profile picture, and a bulk operation on one bucket
-- must never be able to reach the other.
--
-- Private, like everything else here. A profile picture on a health product has
-- no reason to be publicly addressable — there is nowhere in WROUGHT it is
-- shown to another person, so a public URL would exist purely as a liability.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('wrought-avatars', 'wrought-avatars', false, 4194304,
        array['image/jpeg','image/png','image/webp','image/heic'])
on conflict (id) do update
  set public = false,
      file_size_limit = 4194304,
      allowed_mime_types = array['image/jpeg','image/png','image/webp','image/heic'];

do $$
begin
  if not exists (select 1 from pg_policies
                  where tablename = 'objects' and policyname = 'wrought avatars are private to their owner') then
    create policy "wrought avatars are private to their owner" on storage.objects
      for all
      using (bucket_id = 'wrought-avatars' and (storage.foldername(name))[1] = auth.uid()::text)
      with check (bucket_id = 'wrought-avatars' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
end $$;
