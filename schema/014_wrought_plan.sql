-- ============================================================================
-- WROUGHT — schema 014: the plan, named and changeable
--
-- The founder: "your plans to tailor-made plan for you — aggressive,
-- non-aggressive fat burning, both — and how hard this thing's gonna prompt
-- you. This should be explained right when you try your first workout: what
-- plan are you on? Let's build this thing before diving right into it. And it
-- should give you the ability to change it any time."
--
-- Everything needed to ANSWER "what am I doing" already existed in pieces —
-- an intent on a goal, a bluntness setting, days a week, a tier. What did not
-- exist was the thing itself: one named plan a person can ask about, be told
-- about before their first session, and change in one sentence. A plan
-- scattered across four columns is not a plan somebody can hold in their head,
-- and one nobody can state is one nobody is following.
--
-- Two columns, because the two questions are genuinely different:
--
--   plan_pace — HOW FAST. gentle | steady | aggressive. Bounded: every pace
--     still floors intake at 1,200 and still projects under the rate careFlags
--     warns about. Aggressive is the fast end of safe, never a different set of
--     rules — a product that will pace somebody into its own safety warning if
--     they ask nicely does not really have one.
--
--   plan_push — HOW HARD IT CHASES YOU. light | normal | relentless. This
--     changes nothing about any number; it changes how often training gets
--     brought up unprompted. Deliberately separate from bluntness, which is
--     about how a verdict is WORDED: somebody can want the truth delivered flat
--     and still not want chasing every evening. Conflating them means turning
--     down the nagging also turns down the honesty, which is the one thing the
--     product exists to provide.
--
-- Both nullable. No plan is a valid state — it means WROUGHT has not been told
-- and will ask once, at the first workout, rather than assuming.
--
-- Safe to run more than once. Run after 001.
-- ============================================================================

alter table public.wrought_profile
  add column if not exists plan_pace text,
  add column if not exists plan_push text,
  add column if not exists plan_set_on date;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wrought_profile_plan_pace_valid') then
    alter table public.wrought_profile add constraint wrought_profile_plan_pace_valid
      check (plan_pace is null or plan_pace in ('gentle', 'steady', 'aggressive'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'wrought_profile_plan_push_valid') then
    alter table public.wrought_profile add constraint wrought_profile_plan_push_valid
      check (plan_push is null or plan_push in ('light', 'normal', 'relentless'));
  end if;
end $$;

comment on column public.wrought_profile.plan_pace is
  'gentle | steady | aggressive. How fast the body goal is paced. Bounded — every '
  'pace floors intake at 1,200 kcal and stays under the loss rate careFlags warns '
  'about. Null means never chosen; ask once at the first session.';

comment on column public.wrought_profile.plan_push is
  'light | normal | relentless. How hard the assistant brings training up '
  'unprompted. Changes no number. Never overrides a care flag, which silences '
  'the pushing entirely whatever this says.';

comment on column public.wrought_profile.plan_set_on is
  'When the plan was last chosen. Read so a plan that has gone stale can be '
  'offered back for review rather than run forever unexamined.';
