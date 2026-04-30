-- Apex Health OS — initial schema
-- Run this in Supabase Dashboard → SQL Editor → New Query → paste → Run.
-- Single-user app: every row is scoped to auth.users via user_id.

create extension if not exists pgcrypto;

-- ── profile ───────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  user_id uuid primary key references auth.users on delete cascade,
  name text,
  age int,
  height_cm numeric,
  goal text,
  whoop_baselines jsonb,
  training_plan jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── daily logs (one row per day per user) ─────────────────────────────────────
create table if not exists public.daily_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  date date not null,
  hrv numeric,
  resting_hr numeric,
  sleep_hours numeric,
  sleep_score numeric,
  deep_sleep_hours numeric,
  rem_sleep_hours numeric,
  strain numeric,
  recovery numeric,
  steps int,
  calories int,
  weight_kg numeric,
  body_fat_pct numeric,
  spo2 numeric,
  skin_temp_c numeric,
  notes text,
  source text,           -- 'whoop' | 'apple_health' | 'manual' | 'merged'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, date)
);

-- ── workouts ──────────────────────────────────────────────────────────────────
create table if not exists public.workouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  date date not null,
  type text,             -- 'Chest' | 'Legs' | 'Back' | 'Mobility' | etc
  duration_min int,
  notes text,
  source text,
  created_at timestamptz not null default now()
);

create table if not exists public.exercises (
  id uuid primary key default gen_random_uuid(),
  workout_id uuid not null references public.workouts on delete cascade,
  name text not null,
  position int not null default 0
);

create table if not exists public.exercise_sets (
  id uuid primary key default gen_random_uuid(),
  exercise_id uuid not null references public.exercises on delete cascade,
  set_index int not null,
  kg numeric,
  reps int,
  duration_seconds int,
  warmup boolean not null default false,
  failure boolean not null default false
);

-- ── morning check-in (subjective feel) ────────────────────────────────────────
create table if not exists public.checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  date date not null,
  readiness int,         -- 1-10
  energy int,
  soreness text,
  notes text,
  created_at timestamptz not null default now(),
  unique (user_id, date)
);

-- ── WHOOP OAuth tokens (one row per user) ─────────────────────────────────────
create table if not exists public.whoop_tokens (
  user_id uuid primary key references auth.users on delete cascade,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  scope text,
  whoop_user_id text,
  updated_at timestamptz not null default now()
);

-- ── indexes ───────────────────────────────────────────────────────────────────
create index if not exists daily_logs_user_date_idx on public.daily_logs (user_id, date desc);
create index if not exists workouts_user_date_idx on public.workouts (user_id, date desc);
create index if not exists exercises_workout_idx on public.exercises (workout_id);
create index if not exists sets_exercise_idx on public.exercise_sets (exercise_id);

-- ── row-level security ────────────────────────────────────────────────────────
alter table public.profiles      enable row level security;
alter table public.daily_logs    enable row level security;
alter table public.workouts      enable row level security;
alter table public.exercises     enable row level security;
alter table public.exercise_sets enable row level security;
alter table public.checkins      enable row level security;
alter table public.whoop_tokens  enable row level security;

-- profiles
drop policy if exists "profiles self" on public.profiles;
create policy "profiles self" on public.profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- daily_logs
drop policy if exists "daily_logs self" on public.daily_logs;
create policy "daily_logs self" on public.daily_logs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- workouts
drop policy if exists "workouts self" on public.workouts;
create policy "workouts self" on public.workouts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- exercises (via workout)
drop policy if exists "exercises self" on public.exercises;
create policy "exercises self" on public.exercises
  for all using (exists (select 1 from public.workouts w where w.id = workout_id and w.user_id = auth.uid()))
  with check (exists (select 1 from public.workouts w where w.id = workout_id and w.user_id = auth.uid()));

-- exercise_sets (via exercise → workout)
drop policy if exists "sets self" on public.exercise_sets;
create policy "sets self" on public.exercise_sets
  for all using (exists (
    select 1 from public.exercises e
    join public.workouts w on w.id = e.workout_id
    where e.id = exercise_id and w.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.exercises e
    join public.workouts w on w.id = e.workout_id
    where e.id = exercise_id and w.user_id = auth.uid()
  ));

-- checkins
drop policy if exists "checkins self" on public.checkins;
create policy "checkins self" on public.checkins
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- whoop_tokens — read by user, writes go through service_role (server only)
drop policy if exists "whoop_tokens read self" on public.whoop_tokens;
create policy "whoop_tokens read self" on public.whoop_tokens
  for select using (auth.uid() = user_id);
