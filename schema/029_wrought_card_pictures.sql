-- 029_wrought_card_pictures.sql
-- Wrought's day card as a picture, for the chat that cannot draw the card.
--
-- ChatGPT draws Wrought's own card only after it reloads Wrought's tool list,
-- and that reload is a Refresh button not every ChatGPT has. What every
-- ChatGPT draws is a picture the reply carries. So a reply that carries the
-- day also carries a link to that day's card as a PNG, and this table holds
-- what the picture shows.
--
-- FROZEN, ON PURPOSE. The row keeps the view exactly as the reply had it, so
-- the picture in a chat from last Tuesday still shows last Tuesday as it was
-- said — never a figure that changed afterwards and never a figure the reply
-- did not carry.
--
-- The address is the only key: 128 random bits, never a user id and never a
-- date, so a link cannot be guessed and one link cannot be walked to another.
-- Read only through the picture function with the service role; nobody reads
-- this table from a browser, so there is no policy that grants anything.
-- Deleted with the account.

create table if not exists public.wrought_card_pictures (
  id            text primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  view          jsonb not null,
  created_at    timestamptz not null default now(),
  -- The first time the picture was fetched: the only proof a chat actually
  -- drew it, since a host that drops an image says nothing.
  first_seen_at timestamptz
);

create index if not exists wrought_card_pictures_user_idx
  on public.wrought_card_pictures (user_id, created_at desc);

alter table public.wrought_card_pictures enable row level security;

comment on table public.wrought_card_pictures is
  'Each day card sent to a chat as a picture, frozen as the reply carried it. Read only by the picture function (service role).';
