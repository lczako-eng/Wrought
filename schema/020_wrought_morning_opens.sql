-- 020_wrought_morning_opens.sql
-- Where tapping the morning brief lands you.
--
-- The founder: "from the morning prompt or notification it should bring you
-- directly to your GTP — whatever AI that's connected — and that should
-- trigger the AI knowing that this is for Wrought and how we're gonna start
-- our day. What workouts do you have planned, if any, today? More preemptive."
--
-- THIS IS THE ONE LEGAL BRIDGE ACROSS MCP'S HARD LIMIT. The server can never
-- make ChatGPT speak first — the protocol is strictly request/response and no
-- cleverness changes that. But a push notification is allowed to speak first,
-- and a HUMAN TAP on it is allowed to open anything. So the notification
-- carries a pre-written opener into the assistant, the person's tap delivers
-- it, and the assistant's first act of the day is calling the brief. Nothing
-- here violates the protocol: the server pushed words it already computed, and
-- a person chose to hand them to their AI.
--
-- 'app' is the DEFAULT, deliberately. Sending every new account's morning tap
-- to ChatGPT assumes an assistant they may not use — the dashboard is the one
-- destination every account verifiably has. Somebody who wants their AI says
-- so once and it is stored.

alter table public.wrought_profile
  add column if not exists morning_opens text not null default 'app';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wrought_profile_morning_opens_valid') then
    alter table public.wrought_profile
      add constraint wrought_profile_morning_opens_valid
      check (morning_opens in ('app', 'chatgpt', 'claude'));
  end if;
end $$;
