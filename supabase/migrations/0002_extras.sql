-- 0002_extras.sql — additive columns + AI insights cache + indexes
-- Apply via Supabase Dashboard → SQL Editor, or the script in this repo.

-- daily_logs: nutrition macros, eaten calories, respiratory rate
alter table public.daily_logs add column if not exists respiratory_rate numeric;
alter table public.daily_logs add column if not exists calories_eaten int;
alter table public.daily_logs add column if not exists protein_g numeric;
alter table public.daily_logs add column if not exists carbs_g numeric;
alter table public.daily_logs add column if not exists fat_g numeric;

-- checkins: morning-feel extras
alter table public.checkins add column if not exists mood text;
alter table public.checkins add column if not exists energy_label text;
alter table public.checkins add column if not exists feel_notes text;

-- exercises: case-insensitive name lookups (per-exercise trends)
create index if not exists exercises_name_idx on public.exercises (lower(name));

-- ai_insights cache (one row per user × date × kind)
create table if not exists public.ai_insights (
  user_id uuid not null references auth.users on delete cascade,
  generated_for_date date not null,
  kind text not null check (kind in ('coach','strength')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, generated_for_date, kind)
);

alter table public.ai_insights enable row level security;
drop policy if exists "ai_insights read self" on public.ai_insights;
create policy "ai_insights read self" on public.ai_insights
  for select using (auth.uid() = user_id);
-- writes are service_role only (server routes); no insert/update policy needed for client.
