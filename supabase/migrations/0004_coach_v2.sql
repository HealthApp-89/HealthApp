-- 0004_coach_v2.sql — weekly review + per-week recommendations
-- Apply via Supabase Dashboard → SQL Editor.

-- ── Allow weekly_review as an ai_insights kind ────────────────────────────────
alter table public.ai_insights drop constraint if exists ai_insights_kind_check;
alter table public.ai_insights
  add constraint ai_insights_kind_check
  check (kind in ('coach', 'strength', 'weekly_review'));

-- ── Coach recommendations (one row per actionable item, scoped to a week) ─────
create table if not exists public.coach_recommendations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  week_start date not null,                -- Monday (UTC) of the target week
  text text not null,
  category text,                           -- 'training' | 'sleep' | 'nutrition' | 'recovery' | 'habits'
  priority text,                           -- 'high' | 'medium' | 'low'
  position int not null default 0,
  done boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists coach_recs_user_week_idx
  on public.coach_recommendations (user_id, week_start desc);

alter table public.coach_recommendations enable row level security;

drop policy if exists "coach_recs self" on public.coach_recommendations;
create policy "coach_recs self" on public.coach_recommendations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
