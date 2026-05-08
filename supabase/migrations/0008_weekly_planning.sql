-- 0008_weekly_planning.sql — weekly coach planning v1
--
-- Two new tables (training_blocks, training_weeks) plus a mode column on
-- chat_messages for the plan_week / setup_block conversation modes.

-- ── training_blocks ──────────────────────────────────────────────────────────
create table if not exists public.training_blocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  status text not null default 'active'
    check (status in ('active', 'completed', 'abandoned')),
  start_date date not null,
  end_date date not null,
  goal_text text not null,
  primary_lift text
    check (primary_lift in ('squat','bench','deadlift','ohp') or primary_lift is null),
  target_metric text
    check (target_metric in ('e1rm','working_weight') or target_metric is null),
  target_value numeric,
  target_unit text not null default 'kg',
  diet_goal jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (end_date > start_date),
  check ((target_metric is null) = (target_value is null))
);

create unique index if not exists training_blocks_one_active_per_user
  on public.training_blocks (user_id) where status = 'active';

create index if not exists training_blocks_user_status_idx
  on public.training_blocks (user_id, status);

alter table public.training_blocks enable row level security;

drop policy if exists "training_blocks self" on public.training_blocks;
create policy "training_blocks self" on public.training_blocks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── training_weeks ───────────────────────────────────────────────────────────
create table if not exists public.training_weeks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  block_id uuid references public.training_blocks on delete set null,
  week_start date not null,
  session_plan jsonb not null,
  weekly_focus text,
  intensity_modifier jsonb default '{}'::jsonb,
  rir_target int
    check (rir_target between 1 and 4 or rir_target is null),
  research_phase text
    check (research_phase in ('accumulate','deload') or research_phase is null),
  proposed_by text not null default 'coach'
    check (proposed_by in ('coach', 'user')),
  chat_message_id uuid references public.chat_messages on delete set null,
  committed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists training_weeks_user_week_idx
  on public.training_weeks (user_id, week_start);

alter table public.training_weeks enable row level security;

drop policy if exists "training_weeks self" on public.training_weeks;
create policy "training_weeks self" on public.training_weeks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── chat_messages: mode discriminator ────────────────────────────────────────
alter table public.chat_messages
  add column if not exists mode text not null default 'default';

alter table public.chat_messages
  drop constraint if exists chat_messages_mode_check;

alter table public.chat_messages
  add constraint chat_messages_mode_check
  check (mode in ('default','plan_week','setup_block'));

create index if not exists chat_messages_user_mode_created_idx
  on public.chat_messages (user_id, mode, created_at desc);

-- ── Re-application safety: bring existing columns up to current shape ────────
-- Idempotent ALTERs for users who applied an earlier version of this migration.
update public.training_blocks set target_unit = 'kg' where target_unit is null;
alter table public.training_blocks alter column target_unit set not null;

-- ── Comments (load-bearing context for future contributors) ──────────────────
comment on column public.training_blocks.diet_goal is
  'Reserved-null in v1. v2 populates with calorie/macro targets.';

comment on column public.training_blocks.status is
  'Auto-flips to ''completed'' at read time when today > end_date — see /api/coach/block-progress and query_training_blocks executor.';

comment on column public.training_weeks.session_plan is
  'jsonb {Mon:"Chest", Tue:"Legs", ...} — values are session-type strings keyed in lib/coach/sessionPlans.ts:SESSION_PLANS plus "REST".';

comment on column public.training_weeks.intensity_modifier is
  'jsonb {squat: 0.95, bench: 1.0, ...} — multipliers applied to baseKg in SESSION_PLANS for the named primary_lift. Missing keys default to 1.0.';

comment on column public.chat_messages.mode is
  'Conversation mode: ''default'' (free-form Q&A), ''plan_week'' (Sunday weekly planning), ''setup_block'' (block creation). Resolved server-side from request param OR inherited from prior turn.';
