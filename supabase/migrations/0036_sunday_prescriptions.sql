-- 0036_sunday_prescriptions.sql
-- Adds target_hit_at_week to training_blocks (consolidation trigger) and
-- session_prescriptions to training_weeks (Sunday-committed per-exercise plan).
-- Both columns are nullable; existing rows behave unchanged (resolution chain
-- falls through). See docs/superpowers/specs/2026-05-28-sunday-prescription-system-design.md.

alter table public.training_blocks
  add column target_hit_at_week int;

comment on column public.training_blocks.target_hit_at_week is
  'When the active block''s primary-lift working_kg first crossed target_value. Sets the block into consolidation phase — propose_week_plan refuses further load increases on the primary lift. NULL = pre-target; non-NULL = post-target. Set by evaluateAndStampTargetHit on every commit_logger_session.';

alter table public.training_weeks
  add column session_prescriptions jsonb;

comment on column public.training_weeks.session_prescriptions is
  'Full per-exercise per-day plan committed by Carter on Sunday. jsonb shape: { Monday: PlannedExercise[], Tuesday: PlannedExercise[], … } keyed by full weekday names (Monday-Sunday). Each PlannedExercise carries name, baseKg, baseReps, sets, key, increment, note. NULL = no Sunday plan committed yet; the resolution chain falls through to the next layer. Becomes the new top of the resolution chain consumed by getEffectiveSessionPlan.';
