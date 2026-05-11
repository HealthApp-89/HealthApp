-- 0012_schedule_flexibility.sql — schedule flexibility
--
-- One nullable column on training_weeks to capture the originally committed
-- session_plan on first mutation. Adherence math reads
-- coalesce(original_session_plan, session_plan) so swaps don't retroactively
-- flatter recap numbers.

alter table public.training_weeks
  add column if not exists original_session_plan jsonb;

comment on column public.training_weeks.original_session_plan is
  'Snapshot of session_plan at the moment of the first mid-week edit. NULL on rows that have never been edited. Set by the /swap endpoint on first mutation; never updated thereafter. Reset to NULL when an identity-restore swap returns session_plan to the original state. Adherence reads coalesce(original_session_plan, session_plan).';
