-- 0022_exercise_overrides.sql
--
-- Adds exercise_overrides jsonb to training_weeks. Shape (validated app-side
-- by /api/training-weeks/[week_start]/exercise-overrides — jsonb stays flexible):
--   {
--     "Monday": [ {name, sets?, reps?, baseKg?, warmup?, note?, key?, increment?, baseReps?} ... ],
--     "Tuesday": [...],
--     ...
--   } | null
-- NULL means "no overrides; resolver falls through to SESSION_PLANS[session_plan[weekday]]".
-- Keys use FULL weekday names ("Monday", not "Mon") to match what weekdayInUserTz() returns
-- and what the AI planning bot already writes in session_plan jsonb.
-- Permutation-only: the override list for a day must contain the same set of exercise
-- names as the static SESSION_PLANS[type] for that day; only order may change.

alter table training_weeks
  add column exercise_overrides jsonb;

comment on column training_weeks.exercise_overrides is
  'Per-day reorder of the static SESSION_PLANS exercise list. Shape: {"Monday": [PlannedExercise...], ...}. NULL = no overrides; resolver falls through to SESSION_PLANS[session_plan[weekday]]. Written by /api/training-weeks/[week_start]/exercise-overrides.';
