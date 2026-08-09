-- 011_wrought_membership.sql
-- Memberships, trials and the codes that grant them.
--
-- Two things this has to get right, and they pull in opposite directions.
--
-- RUNNING A BUSINESS needs an operator who can see who signed up, who is still
-- here, who is on a trial and when it ends, and who has been cut off. None of
-- that is health data — it is the same metadata any service keeps about its own
-- customers, and refusing to keep it does not make anybody safer, it just makes
-- the thing unrunnable.
--
-- BEING TRUSTED WITH A HEALTH RECORD means the operator still cannot read one.
-- Not the food, not the weight, not the training, not a symptom. The admin
-- endpoint enforces that, and it is the reason this table holds counts and
-- dates and nothing else.
--
-- The other line that must not move: A REVOKED MEMBERSHIP NEVER TAKES SOMEBODY'S
-- DATA. They can still sign in and they can still export every row. A hub you
-- cannot leave is a trap, and that stays true whether or not somebody is paying.

create table if not exists public.wrought_memberships (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  plan        text not null default 'free',      -- free | trial | pro | comp
  status      text not null default 'active',    -- active | revoked
  started_on  date not null default current_date,
  expires_on  date,                              -- null = does not expire
  source      text,                              -- code | manual | signup
  code_used   text,
  note        text,                              -- operator's note, never shown to the user
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

comment on table public.wrought_memberships is
  'What plan somebody is on. NO row means free and active — the default is permissive on purpose, so a missing row can never lock anybody out of their own health record.';
comment on column public.wrought_memberships.status is
  'active | revoked. Only an explicit revoke blocks anything, and even then the export endpoint keeps working — see lib/membership.js.';
comment on column public.wrought_memberships.note is
  'For the operator. Never returned to the member it is about.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wrought_memberships_plan_valid') then
    alter table public.wrought_memberships add constraint wrought_memberships_plan_valid
      check (plan in ('free','trial','pro','comp'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'wrought_memberships_status_valid') then
    alter table public.wrought_memberships add constraint wrought_memberships_status_valid
      check (status in ('active','revoked'));
  end if;
end $$;

create index if not exists wrought_memberships_status_idx
  on public.wrought_memberships (status, plan);
create index if not exists wrought_memberships_expiry_idx
  on public.wrought_memberships (expires_on) where expires_on is not null;

alter table public.wrought_memberships enable row level security;

-- A member may READ their own plan and nothing else. Writing is service-role
-- only: an account that could set its own plan is not a plan.
do $$
begin
  if not exists (select 1 from pg_policies
                  where tablename = 'wrought_memberships' and policyname = 'read own membership') then
    create policy "read own membership" on public.wrought_memberships
      for select using (auth.uid() = user_id);
  end if;
end $$;

-- ── Codes ───────────────────────────────────────────────────────────────────
-- A trial code is a coupon, not a credential: it is meant to be written on a
-- card and handed to somebody, so it is stored as it reads. That is the
-- opposite of wrought_ingest_keys, which are secrets and are stored hashed.
-- The protection here is not secrecy, it is a use count and an expiry.

create table if not exists public.wrought_codes (
  code        text primary key,
  plan        text not null default 'trial',
  days        integer not null default 30,
  max_uses    integer not null default 1,
  used_count  integer not null default 0,
  expires_on  date,
  active      boolean not null default true,
  note        text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

comment on table public.wrought_codes is
  'Trial and comp codes. Stored in the clear because they are meant to be handed out; the limit is max_uses and expires_on, not secrecy.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wrought_codes_plan_valid') then
    alter table public.wrought_codes add constraint wrought_codes_plan_valid
      check (plan in ('trial','pro','comp'));
  end if;
end $$;

create index if not exists wrought_codes_active_idx
  on public.wrought_codes (active) where active;

alter table public.wrought_codes enable row level security;
-- No policy at all: nobody reaches this table from a browser. Redemption goes
-- through the server, which is also the only thing that can increment a count
-- without a race.

-- One row per redemption, so "who used that code" is answerable and a single
-- code cannot be spent twice by the same person.
create table if not exists public.wrought_code_uses (
  code       text not null references public.wrought_codes(code) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  used_at    timestamptz not null default now(),
  primary key (code, user_id)
);

alter table public.wrought_code_uses enable row level security;

-- Redeeming safely. Doing this in the browser or across two round trips means
-- a code with one use left can be spent twice by two people pressing at once.
create or replace function public.wrought_redeem_code(p_code text, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.wrought_codes;
  ends date;
begin
  -- Locked for the duration of the transaction, which is the whole point of
  -- doing this in one function.
  select * into c from wrought_codes
   where lower(code) = lower(p_code) for update;

  if c.code is null then return jsonb_build_object('ok', false, 'error', 'no_such_code'); end if;
  if not c.active then return jsonb_build_object('ok', false, 'error', 'code_inactive'); end if;
  if c.expires_on is not null and c.expires_on < current_date then
    return jsonb_build_object('ok', false, 'error', 'code_expired');
  end if;
  if c.used_count >= c.max_uses then
    return jsonb_build_object('ok', false, 'error', 'code_used_up');
  end if;
  if exists (select 1 from wrought_code_uses where code = c.code and user_id = p_user) then
    return jsonb_build_object('ok', false, 'error', 'already_redeemed');
  end if;

  ends := current_date + (c.days || ' days')::interval;

  insert into wrought_code_uses (code, user_id) values (c.code, p_user);
  update wrought_codes set used_count = used_count + 1 where code = c.code;

  insert into wrought_memberships (user_id, plan, status, started_on, expires_on, source, code_used)
  values (p_user, c.plan, 'active', current_date, ends, 'code', c.code)
  on conflict (user_id) do update set
    plan = excluded.plan,
    -- Redeeming a code un-revokes. If an operator hands somebody a code, that
    -- is the operator letting them back in.
    status = 'active',
    -- Never shorten what somebody already has. Stacking two trials extends.
    expires_on = greatest(coalesce(wrought_memberships.expires_on, current_date), excluded.expires_on),
    source = 'code',
    code_used = excluded.code_used,
    updated_at = now();

  return jsonb_build_object('ok', true, 'plan', c.plan, 'expires_on', ends, 'days', c.days);
end $$;

revoke all on function public.wrought_redeem_code(text, uuid) from public;
revoke all on function public.wrought_redeem_code(text, uuid) from anon;
revoke all on function public.wrought_redeem_code(text, uuid) from authenticated;
grant execute on function public.wrought_redeem_code(text, uuid) to service_role;
