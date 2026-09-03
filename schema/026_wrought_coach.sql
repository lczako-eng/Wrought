-- 026_wrought_coach.sql
-- A standing coach: the trainer style every built session comes in unless
-- somebody names a different one for the day.
--
-- The founder, on the twenty-one styles: "where can I find them on the app or
-- website and change it?" They could be picked per session and never kept.
-- One column. The value is a STYLES key from lib/design.js ("fight_camp",
-- "conjugate_method") — validated in code rather than by a constraint, because
-- the list of styles lives in the code and a constraint would have to be
-- migrated every time one is added. Null means no standing coach: the plain
-- trainer, exactly as before.

alter table public.wrought_profile add column if not exists coach_style text;

comment on column public.wrought_profile.coach_style is
  'A STYLES key from lib/design.js — the tradition every built session is coached in unless one is named for the day. Null is the plain trainer. Delivery and session shape only; never a load.';
