-- 0048_repatch_log.sql
-- Mid-week feed-forward repatch audit trail. Append-only jsonb array of
-- { at, reason, workout_date, changes: [{weekday, exercise, field, from, to}] }.
-- Written by lib/coach/prescription/repatch-week.ts ONLY when a repatch
-- actually changed a future day's prescription. Read by the workout debrief
-- ("plan updated" note) and by audit tooling. NULL / absent = no repatches.

alter table public.training_weeks
  add column if not exists repatch_log jsonb;

comment on column public.training_weeks.repatch_log is
  'Append-only log of mid-week prescription repatches (engine re-runs triggered by workout commits). Each entry: {at, reason, workout_date, changes[]}. NULL = never repatched.';
