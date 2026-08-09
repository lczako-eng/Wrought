-- 008_wrought_blocks.sql
-- Multi-week training blocks — the last structural piece of the training side.
--
-- Routines already exist and per-exercise progression already works against
-- real history, so a block is an ordered schedule over them plus a rule for how
-- the volume moves. What it adds is the two things a person cannot do for
-- themselves week to week:
--
--   A DELOAD THAT WAS SCHEDULED BEFORE IT WAS NEEDED. Anybody who waits until
--   they feel like they need one takes it a fortnight late, in the form of an
--   injury or a month off. It is the most skipped thing in training and the
--   only fix is that something else already put it in the calendar.
--
--   AN END. "Week 4 of 8" is a reason to show up on the days nobody wants to.
--   A plan that finishes is finishable; an endless one is quit.
--
-- The plan is frozen at the moment it starts, exactly as sessions freeze their
-- routine. Editing the library must never rewrite a block somebody is halfway
-- through — that would change what they already did.

create table if not exists public.wrought_blocks (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  programme_id  text,                                  -- which library programme it came from
  goal          text not null default 'general',
  tier          text not null default 'intermediate',
  weeks         integer not null,
  days_per_week integer not null,
  plan          jsonb not null default '{}'::jsonb,    -- the whole frozen block
  started_on    date not null,
  status        text not null default 'active',        -- active | done | abandoned
  ended_at      timestamptz,
  created_at    timestamptz not null default now()
);

comment on table public.wrought_blocks is
  'A multi-week training block. plan is a frozen copy of the schedule at the moment it started — editing the library must never rewrite a block somebody is halfway through.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wrought_blocks_status_valid') then
    alter table public.wrought_blocks add constraint wrought_blocks_status_valid
      check (status in ('active','done','abandoned'));
  end if;
end $$;

-- One block at a time. Running two is not a plan, it is two plans, and the
-- deload in each falls in a different week.
create unique index if not exists wrought_blocks_one_active_idx
  on public.wrought_blocks (user_id) where status = 'active';

create index if not exists wrought_blocks_user_idx
  on public.wrought_blocks (user_id, started_on desc);

alter table public.wrought_blocks enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                  where tablename = 'wrought_blocks' and policyname = 'own blocks') then
    create policy "own blocks" on public.wrought_blocks
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

-- Which block a session belonged to. Counted rather than dated, because
-- MISSING A WEEK MUST NOT SKIP A WEEK — advancing the block by the calendar
-- would punish a chest infection by deleting the training, and the block would
-- read as finished having never happened.
alter table public.wrought_sessions
  add column if not exists block_id uuid references public.wrought_blocks(id) on delete set null;

create index if not exists wrought_sessions_block_idx
  on public.wrought_sessions (block_id) where block_id is not null;

comment on column public.wrought_sessions.block_id is
  'The block this session counted towards. Position in a block is the count of completed sessions carrying its id, never the date — a missed week is a missed week, not a skipped one.';
