-- 0040_endurance_pillar.sql — Phase 1 of endurance pillar
-- Apply via: supabase db push  (or Dashboard → SQL Editor)
--
-- Note on numbering: spec/plan were drafted assuming this would land as 0038,
-- but parallel arcs claimed 0038 (nora_suggestion_engine) and 0039
-- (user_food_items_metadata) on this branch before merge. Endurance numbering
-- jumped to 0040.

-- ── Strava OAuth tokens (one row per user, mirrors whoop_tokens shape) ────────
create table if not exists public.strava_tokens (
  user_id uuid primary key references auth.users on delete cascade,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  scope text,
  strava_athlete_id text,
  updated_at timestamptz not null default now()
);

alter table public.strava_tokens enable row level security;
drop policy if exists "strava_tokens read self" on public.strava_tokens;
create policy "strava_tokens read self" on public.strava_tokens
  for select using (auth.uid() = user_id);
-- writes via service_role only

-- ── endurance_activities — one row per Strava activity ───────────────────────
create table if not exists public.endurance_activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('strava','manual')),
  external_id text,
  sport text not null check (sport in ('cycling','running','swimming','other')),
  started_at timestamptz not null,
  local_date date not null,
  duration_s int not null,
  distance_m numeric,
  elevation_gain_m numeric,
  avg_hr int,
  max_hr int,
  hr_zone_distribution jsonb,
  avg_power_w int,
  normalized_power_w int,
  intensity_factor numeric,
  tss numeric,
  avg_pace_s_per_km int,
  avg_speed_kmh numeric,
  calories int,
  raw jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.endurance_activities enable row level security;
drop policy if exists "endurance_activities self" on public.endurance_activities;
create policy "endurance_activities self" on public.endurance_activities
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create unique index if not exists endurance_activities_external_id_uniq
  on public.endurance_activities (user_id, source, external_id)
  where external_id is not null;

create index if not exists endurance_activities_user_local_date_idx
  on public.endurance_activities (user_id, local_date desc);

-- ── daily_logs day-level endurance aggregates ────────────────────────────────
alter table public.daily_logs add column if not exists endurance_load numeric;
alter table public.daily_logs add column if not exists endurance_minutes int;
alter table public.daily_logs add column if not exists endurance_z2_minutes int;

-- ── athlete_profile_documents.endurance_profile ──────────────────────────────
alter table public.athlete_profile_documents
  add column if not exists endurance_profile jsonb;

-- ── training_weeks.endurance_session_plan ────────────────────────────────────
alter table public.training_weeks
  add column if not exists endurance_session_plan jsonb;

-- ── training_blocks.endurance_focus ──────────────────────────────────────────
alter table public.training_blocks
  add column if not exists endurance_focus jsonb;

-- ── Aggregation function used by ingest + audit script ───────────────────────
create or replace function public.sum_endurance_for_day(p_user_id uuid, p_date date)
returns table (
  tss_sum numeric,
  duration_minutes_sum int,
  z2_minutes_sum int
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    coalesce(sum(tss), 0)::numeric as tss_sum,
    coalesce(sum(duration_s) / 60, 0)::int as duration_minutes_sum,
    coalesce(sum( ((hr_zone_distribution->>'z2_s')::int) / 60 ), 0)::int as z2_minutes_sum
  from public.endurance_activities
  where user_id = p_user_id
    and local_date = p_date
    and deleted_at is null;
$$;
