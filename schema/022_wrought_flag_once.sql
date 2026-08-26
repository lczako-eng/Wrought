-- 022_wrought_flag_once.sql
-- A care flag reaches the lock screen once a day, not three times.
--
-- The founder's screenshot: six identical WROUGHT notifications across three
-- evenings, every one the same care-flag sentence. "It's always the same
-- bullshit three times a day." He was counting correctly — the morning brief,
-- and the evening read, each carry the flag as their ENTIRE message (that
-- doctrine holds and is not touched here), so one standing flag became the
-- same sentence at 7:30, and again at night.
--
-- A repeated identical notification trains dismissal, and a dismissed care
-- flag is as dangerous as a missing one. So: the flag still outranks
-- everything, still is the whole message, and still goes out EVERY DAY it
-- stands — but the same sentence is delivered once per day, not once per
-- check-in. A flag whose text CHANGES (a new flag firing, a count moving) is
-- never suppressed: only the exact sentence already on the lock screen today.

alter table public.wrought_profile
  add column if not exists flag_sent_on   date,
  add column if not exists flag_sent_text text;

comment on column public.wrought_profile.flag_sent_on is
  'Local date a care-flag-only notification last actually delivered. With flag_sent_text, stops the '
  'identical flag sentence going out at every check-in of the same day. Never suppresses across days '
  'and never suppresses a flag whose wording changed.';
comment on column public.wrought_profile.flag_sent_text is
  'The exact flag sentence that delivered on flag_sent_on. A different sentence — a new flag, a moved '
  'count — always goes out, whatever the date says.';
