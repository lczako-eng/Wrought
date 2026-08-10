-- 012_wrought_link_codes.sql
-- Joining two accounts without an email or a password.
--
-- The founder's problem, said plainly and repeatedly: "you can merge multiple
-- emails. If the website is your Gmail and your GTP is iCloud, it should still
-- recognise the same person."
--
-- Merging already does exactly that, and it moves the live connector grant so
-- nothing has to be reconnected. The thing that kept blocking it was PROOF: the
-- merge demands control of both accounts, and the only proofs on offer were a
-- password nobody remembered and a reset email that never arrived.
--
-- But there is a third proof sitting right there. The assistant is already
-- holding a live token for the other account — that IS control of it, more
-- current than any password. So the assistant mints a short code, the person
-- reads it across to the dashboard, and the two halves are joined.
--
-- WHY A CODE IS SAFE HERE. It is minted only by an authenticated tool call, so
-- it cannot be requested for an account somebody does not already hold. It
-- lasts ten minutes, is single use, and is worthless on its own — redeeming it
-- also requires being signed in on the surviving account. Two proofs, same as
-- before; one of them is just no longer a password.

create table if not exists public.wrought_link_codes (
  code        text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);

comment on table public.wrought_link_codes is
  'Short-lived codes proving control of an account, minted by the assistant so two accounts can be joined without a password or an email round trip.';

create index if not exists wrought_link_codes_user_idx
  on public.wrought_link_codes (user_id);
create index if not exists wrought_link_codes_expiry_idx
  on public.wrought_link_codes (expires_at) where used_at is null;

alter table public.wrought_link_codes enable row level security;
-- No policy: nothing in a browser ever reads or writes this. Minting happens
-- through the MCP tool and redemption through the merge endpoint, both of which
-- run as the service role after verifying who is asking.

-- Redeeming, in one locked step, so a code cannot be spent twice by two
-- requests arriving together.
create or replace function public.wrought_claim_link_code(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  row public.wrought_link_codes;
begin
  select * into row from wrought_link_codes
   where upper(code) = upper(p_code) for update;

  if row.code is null then return null; end if;
  if row.used_at is not null then return null; end if;
  if row.expires_at < now() then return null; end if;

  update wrought_link_codes set used_at = now() where code = row.code;
  return row.user_id;
end $$;

revoke all on function public.wrought_claim_link_code(text) from public;
revoke all on function public.wrought_claim_link_code(text) from anon;
revoke all on function public.wrought_claim_link_code(text) from authenticated;
grant execute on function public.wrought_claim_link_code(text) to service_role;
