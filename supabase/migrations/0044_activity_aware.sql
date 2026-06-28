-- 0044_activity_aware.sql — activity-aware planning.
alter table public.training_weeks
  add column if not exists planned_activities jsonb not null default '[]'::jsonb;
alter table public.profiles
  add column if not exists recurring_activities jsonb not null default '[]'::jsonb;
