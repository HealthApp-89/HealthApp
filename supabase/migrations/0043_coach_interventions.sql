-- 0043_coach_interventions.sql
-- Durable record of coaching interventions + their measured outcomes.
-- Powers Coach Responsiveness Memory (Phase 3 #1).

create table if not exists public.coach_interventions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('reactive_deload','exercise_swap','nutrition_change')),
  source text not null check (source in ('explicit','inferred')),
  started_on date not null,
  context jsonb not null default '{}'::jsonb,
  outcome jsonb,
  outcome_evaluated_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.coach_interventions enable row level security;

create policy coach_interventions_self on public.coach_interventions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Sweep query: unevaluated rows past their window, per user.
create index if not exists coach_interventions_pending_idx
  on public.coach_interventions (user_id, started_on)
  where outcome_evaluated_at is null;

-- Composer + dedup lookups by (user, kind, date).
create index if not exists coach_interventions_lookup_idx
  on public.coach_interventions (user_id, kind, started_on desc);
