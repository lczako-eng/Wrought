-- 009_wrought_photos.sql
-- Progress photos, which are the most sensitive thing this product will ever
-- hold and are treated accordingly.
--
-- WHY THEY EARN THEIR PLACE. The scale is a bad instrument over months: it
-- moves with salt, sleep, hydration and the time of day, and it cannot tell
-- three kilos of muscle from three kilos of anything else. Two photographs
-- eight weeks apart answer the question the number keeps getting wrong. This is
-- also the one place where somebody who has been doing everything right and
-- seeing a flat line finally gets to see that it worked.
--
-- WHY THEY ARE DANGEROUS. A photograph of somebody's body, dated, in a series,
-- next to their weight, is the single most exposing row in this database. So:
--
--   - The bucket is PRIVATE. Nothing is ever publicly readable, and no URL
--     exists that works without a signed token that expires.
--   - The path is namespaced by user id and RLS is enforced on the object, not
--     just on this table. A leaked row id must not be enough to fetch a file.
--   - NOTHING EVER READS THE IMAGE. No body-fat estimate, no pose scoring, no
--     "AI analysis". A number invented from a photograph of somebody's torso
--     would break the estimates-are-labelled doctrine in the place it would do
--     the most harm, and there is no version of it that is honest.
--   - No sharing feature. Not now, not later. Export gives them their own files
--     and what they do with them is their business.

create table if not exists public.wrought_photos (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  path        text not null,                       -- object path inside the private bucket
  local_date  date not null,
  pose        text not null default 'front',       -- front | side | back | other
  weight_kg   numeric,                             -- what the scale said that day, if known
  note        text,
  created_at  timestamptz not null default now()
);

comment on table public.wrought_photos is
  'Progress photos. The files live in a private Storage bucket; this table holds only the path and the date. Nothing in this system ever reads the image itself — no body composition estimate is derived from a photograph, ever.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wrought_photos_pose_valid') then
    alter table public.wrought_photos add constraint wrought_photos_pose_valid
      check (pose in ('front','side','back','other'));
  end if;
end $$;

create index if not exists wrought_photos_user_idx
  on public.wrought_photos (user_id, local_date desc);

-- One photo per pose per day. Twelve near-identical shots from one morning make
-- the comparison worse, not better.
create unique index if not exists wrought_photos_user_day_pose_idx
  on public.wrought_photos (user_id, local_date, pose);

alter table public.wrought_photos enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                  where tablename = 'wrought_photos' and policyname = 'own photos') then
    create policy "own photos" on public.wrought_photos
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

-- ── Storage ─────────────────────────────────────────────────────────────────
-- Private bucket. `public = false` is the load-bearing argument here: a public
-- bucket means every object is one guessed path away from the open internet.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('wrought-photos', 'wrought-photos', false, 12582912,
        array['image/jpeg','image/png','image/webp','image/heic'])
on conflict (id) do update
  set public = false,
      file_size_limit = 12582912,
      allowed_mime_types = array['image/jpeg','image/png','image/webp','image/heic'];

-- Objects are namespaced by user id — wrought-photos/<uid>/<uuid>.jpg — and the
-- policy compares that first path segment to the caller. A leaked row id is
-- then not enough to fetch anything, because the object itself refuses.
do $$
begin
  if not exists (select 1 from pg_policies
                  where tablename = 'objects' and policyname = 'wrought photos are private to their owner') then
    create policy "wrought photos are private to their owner" on storage.objects
      for all
      using (bucket_id = 'wrought-photos' and (storage.foldername(name))[1] = auth.uid()::text)
      with check (bucket_id = 'wrought-photos' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
end $$;
