-- 0035_athlete_goal_structured.sql
-- Structured goal fields for the Peter Dashboard's Goal-distance theme.
-- The existing free-form goal narrative on athlete_profile_documents
-- stays as the "why" text; these columns add the "what + by when" so
-- projection math can run.
--
-- goal_metric is required when goal_kind = 'lift_e1rm' (the lift name);
-- null otherwise. Validation lives in app code, not a partial constraint
-- (Phase 1 wizard enforces it).
--
-- Note: spec/plan labelled this 0032 but parallel arcs took 0031-0033.
-- Bumped to 0035 (companion to 0034_peter_dashboard.sql).

alter table athlete_profile_documents
  add column goal_kind        text
    check (goal_kind in ('lift_e1rm', 'bodyweight_kg', 'bodyfat_pct')),
  add column goal_metric      text,
  add column goal_target      numeric,
  add column goal_target_date date;
