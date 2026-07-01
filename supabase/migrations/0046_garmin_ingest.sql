-- 0046_garmin_ingest.sql
-- Garmin Fenix 8 ingest: shadow/audit table + cutover knob.

-- Single source-of-truth knob for who owns the recovery/strain cluster on
-- daily_logs. WHOOP and Garmin are mutually exclusive owners.
alter table profiles
  add column if not exists metrics_source text not null default 'whoop'
    check (metrics_source in ('whoop', 'garmin'));

-- Raw + derived per-day Garmin data. Always written by the ingest route (audit
-- trail + Phase-1 shadow store); daily_logs is written separately, gated by
-- profiles.metrics_source.
create table if not exists garmin_daily (
  user_id uuid not null references auth.users (id) on delete cascade,
  date date not null,
  -- raw vitals
  hrv numeric,
  resting_hr numeric,
  training_readiness numeric,      -- 0-100, maps to daily_logs.recovery
  body_battery_low numeric,
  body_battery_peak numeric,
  sleep_hours numeric,
  sleep_score numeric,
  deep_sleep_hours numeric,
  rem_sleep_hours numeric,
  sleep_start_at timestamptz,
  sleep_end_at timestamptz,
  respiratory_rate numeric,
  steps integer,
  distance_km numeric,
  calories integer,
  active_calories integer,
  spo2 numeric,                    -- stored, flagged unreliable, not trusted
  skin_temp_variation numeric,
  acute_load numeric,
  chronic_load numeric,
  vo2max numeric,
  -- derived
  strain numeric,                  -- 0-21, WHOOP-parity, from TRIMP
  trimp_edwards numeric,
  trimp_banister numeric,
  raw jsonb,                       -- full sidecar payload for the day
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, date)
);

alter table garmin_daily enable row level security;

create policy "garmin_daily self select" on garmin_daily
  for select using (auth.uid() = user_id);
create policy "garmin_daily self modify" on garmin_daily
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
