-- 0037_block_outcomes.sql
-- Adds block_outcomes table (one row per closed block, written by daily cron),
-- widens chat_messages.kind allowlist for 'block_outcome', and adds
-- profiles.rotation_priority_lift for the persistent priority knob.
-- See docs/superpowers/specs/2026-05-29-block-outcomes-rotation-engine-design.md.

create table public.block_outcomes (
  id uuid primary key default gen_random_uuid(),
  block_id uuid not null references training_blocks(id) on delete cascade,
  user_id uuid not null references auth.users on delete cascade,

  primary_lift text not null check (primary_lift in ('squat','bench','deadlift','ohp')),
  target_value_kg numeric,
  target_metric text check (target_metric in ('e1rm','working_weight')),

  end_working_kg numeric,
  target_hit boolean not null,
  target_hit_at_week int,
  block_phase_at_end text not null
    check (block_phase_at_end in ('hit_early','hit_on_pace','off_pace','underperformed')),

  lessons jsonb not null default '{}'::jsonb,

  recommended_next_focus text
    check (recommended_next_focus in ('squat','bench','deadlift','ohp') or recommended_next_focus is null),
  recommended_target_value_kg numeric,

  athlete_acknowledged_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (block_id)
);

create index if not exists block_outcomes_user_created_idx
  on public.block_outcomes (user_id, created_at desc);

alter table public.block_outcomes enable row level security;
create policy "block_outcomes self" on public.block_outcomes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

comment on column public.block_outcomes.block_phase_at_end is
  'Four-way summary derived at evaluation time: hit_early (target reached before end_date — consolidation kicked in), hit_on_pace (target reached at or near end_date — clean execution), off_pace (end_working_kg < target × 0.90 — meaningful miss), underperformed (within 10% of target — narrow miss).';

comment on column public.block_outcomes.lessons is
  'Deterministically composed jsonb. Shape: { observed_step_kg_per_wk, projected_kg_at_end, gap_kg, gap_pct, calibration_note, secondary_lifts: [{lift, end_kg, clamp_held: boolean}], rotation_context: { ideal_next, athlete_overrode_rotation, override_reason } }. NO AI narrative.';

alter table chat_messages drop constraint chat_messages_kind_check;
alter table chat_messages add constraint chat_messages_kind_check
  check (kind in (
    'coach','morning_intake','morning_brief','weekly_review',
    'proactive_nudge','system_routing','meal_log','workout_debrief',
    'block_outcome'
  ));

alter table public.profiles
  add column rotation_priority_lift text
  check (rotation_priority_lift in ('squat','bench','deadlift','ohp') or rotation_priority_lift is null);

comment on column public.profiles.rotation_priority_lift is
  'Optional persistent priority lift that biases the 4-lift rotation. NULL = standard D → B → S → OHP rotation. Set = injection pattern: every other rotation slot becomes the priority lift, with a non-priority lift between for recovery. No two priority focuses in a row.';
