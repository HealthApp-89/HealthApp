-- 0058_fused_strain.sql
--
-- Per-activity heart-rate records, and the sampling-density marker that makes
-- a sensor change visible instead of silent.
--
-- Why a new table rather than endurance_activities: that table is Strava-owned
-- with hrTSS semantics and feeds daily_logs.endurance_*. Folding Garmin rows in
-- would double-count every ride present in both services and change what the
-- endurance pillar reads.
--
-- hr_samples holds the raw [[epoch_ms, bpm]] stream. Storing it is deliberate:
-- recalibrating the strain model later must not require re-fetching years of
-- history through an unofficial API.

create table if not exists public.garmin_activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  external_id text not null,
  local_date date not null,
  activity_type text,
  started_at timestamptz not null,
  duration_s int not null,
  avg_hr numeric,
  max_hr numeric,
  device_id text,
  hr_source text not null default 'unknown'
    check (hr_source in ('wrist', 'arm', 'chest', 'unknown')),
  hr_sample_count int not null default 0,
  hr_median_gap_s numeric,
  zone_seconds jsonb,
  garmin_load numeric,
  aerobic_te numeric,
  anaerobic_te numeric,
  body_battery_diff numeric,
  trimp numeric,
  hr_samples jsonb,
  superseded_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, external_id)
);

create index if not exists garmin_activities_user_date_idx
  on public.garmin_activities (user_id, local_date);

comment on column public.garmin_activities.superseded_by is
  'external_id of the activity that won cross-device dedup. Non-null rows are excluded from strain computation but retained for audit.';
comment on column public.garmin_activities.garmin_load is
  'Garmin activityTrainingLoad. Metadata only — never a strain model input; it fit WHOOP labels worse than our own TRIMP.';

alter table public.garmin_activities enable row level security;

create policy "garmin_activities self select" on public.garmin_activities
  for select using (auth.uid() = user_id);
create policy "garmin_activities self insert" on public.garmin_activities
  for insert with check (auth.uid() = user_id);
create policy "garmin_activities self update" on public.garmin_activities
  for update using (auth.uid() = user_id);
create policy "garmin_activities self delete" on public.garmin_activities
  for delete using (auth.uid() = user_id);

-- Median gap between all-day HR samples, in seconds. Records what the ingest
-- actually received so a device swap shows up as an annotation rather than a
-- phantom fitness change.
alter table public.daily_logs add column if not exists hr_sample_density numeric;

comment on column public.daily_logs.hr_sample_density is
  'Median gap between all-day HR samples in seconds (120 for the Fenix wellness stream). NULL when no HR arrived that day.';
