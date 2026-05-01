-- 0003_integrations.sql — Withings OAuth + Apple Health / Strong / Yazio ingest
-- Apply via Supabase Dashboard → SQL Editor.

-- ── Withings OAuth tokens (one row per user) ──────────────────────────────────
create table if not exists public.withings_tokens (
  user_id uuid primary key references auth.users on delete cascade,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  scope text,
  withings_user_id text,
  updated_at timestamptz not null default now()
);

alter table public.withings_tokens enable row level security;
drop policy if exists "withings_tokens read self" on public.withings_tokens;
create policy "withings_tokens read self" on public.withings_tokens
  for select using (auth.uid() = user_id);
-- writes via service_role only

-- ── Body composition columns (Withings scale) ─────────────────────────────────
alter table public.daily_logs add column if not exists muscle_mass_kg numeric;
alter table public.daily_logs add column if not exists bone_mass_kg numeric;
alter table public.daily_logs add column if not exists hydration_kg numeric;
alter table public.daily_logs add column if not exists fat_free_mass_kg numeric;
alter table public.daily_logs add column if not exists fat_mass_kg numeric;

-- ── Active calories vs total (Apple Health distinguishes) ─────────────────────
alter table public.daily_logs add column if not exists active_calories int;
alter table public.daily_logs add column if not exists distance_km numeric;
alter table public.daily_logs add column if not exists exercise_min int;

-- ── Workouts: external_id for idempotent ingest from Strong / Apple Health ────
alter table public.workouts add column if not exists external_id text;
create unique index if not exists workouts_user_external_id_idx
  on public.workouts (user_id, external_id)
  where external_id is not null;

-- ── Ingest tokens (per-user shared secret for iOS Shortcut / curl) ────────────
-- Token is hashed (sha256, hex) before storage; raw token is shown to the user
-- exactly once after creation/rotation.
create table if not exists public.ingest_tokens (
  user_id uuid primary key references auth.users on delete cascade,
  token_hash text not null,
  token_prefix text not null,    -- first 8 chars, for display ("ah_xxxxxxxx…")
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  last_used_source text          -- 'apple_health' | 'strong' | 'yazio'
);

alter table public.ingest_tokens enable row level security;
drop policy if exists "ingest_tokens read self" on public.ingest_tokens;
create policy "ingest_tokens read self" on public.ingest_tokens
  for select using (auth.uid() = user_id);
-- writes via service_role only (token rotation goes through API route)

-- ── Index for token lookup (service-role queries by hash) ─────────────────────
create index if not exists ingest_tokens_hash_idx on public.ingest_tokens (token_hash);
