-- 007_wrought_push.sql
-- Where a notification is allowed to go.
--
-- An MCP server can never make ChatGPT speak first — the protocol is strictly
-- request/response and no amount of cleverness changes it. So the phone has to
-- carry the nightly read, and this is the address book for that.
--
-- A subscription is not a secret in the usual sense, but it is very close to
-- one: anybody holding the endpoint plus the two keys can put words on the
-- lock screen of a named person's phone. RLS keeps it to its owner, and nothing
-- in the browser ever selects another user's row.

create table if not exists public.wrought_push_subs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  endpoint     text not null,
  p256dh       text not null,          -- the browser's public key, base64url
  auth         text not null,          -- the 16-byte auth secret, base64url
  label        text,                   -- "iPhone", "Pixel" — whatever the user called it
  created_at   timestamptz not null default now(),
  last_sent_at timestamptz,
  failures     integer not null default 0
);

comment on table public.wrought_push_subs is
  'Browser push subscriptions. The payload is encrypted to p256dh/auth before it leaves us, so the push service routes the notification without ever being able to read it — which matters when the message is a line about somebody''s eating.';

-- One row per endpoint. Re-subscribing on the same device must update rather
-- than accumulate, or a fortnight of reinstalls turns one verdict into six
-- notifications for the same night.
create unique index if not exists wrought_push_subs_endpoint_idx
  on public.wrought_push_subs (endpoint);

create index if not exists wrought_push_subs_user_idx
  on public.wrought_push_subs (user_id);

alter table public.wrought_push_subs enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                  where tablename = 'wrought_push_subs' and policyname = 'own push subs') then
    create policy "own push subs" on public.wrought_push_subs
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

-- ── When to send ────────────────────────────────────────────────────────────
-- brief-nightly runs hourly, not nightly, because 22:00 is a different instant
-- for every user. This is the hour each person wants it, in their own timezone,
-- and null means the default. A notification that arrives at the wrong hour is
-- how somebody turns notifications off for good, and they never come back on.

alter table public.wrought_profile
  add column if not exists brief_hour integer;

alter table public.wrought_profile
  add column if not exists push_enabled boolean not null default true;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wrought_profile_brief_hour_valid') then
    alter table public.wrought_profile add constraint wrought_profile_brief_hour_valid
      check (brief_hour is null or (brief_hour >= 0 and brief_hour <= 23));
  end if;
end $$;

comment on column public.wrought_profile.brief_hour is
  'Local hour to send the nightly read, 0-23. Null means 22:00.';
comment on column public.wrought_profile.push_enabled is
  'Off means no push, ever, whatever subscriptions exist. A per-device unsubscribe is a device decision; this is the person''s decision.';
