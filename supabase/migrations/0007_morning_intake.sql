-- 0007_morning_intake.sql — morning intake bot
--
-- Adds structured slots (sick, fatigue, soreness areas/severity, bloating,
-- sickness_notes), the per-day state-machine column intake_state, plus
-- chat_messages.kind discriminator and ui jsonb for chip-rendering turns.

-- ── checkins: structured slots + state machine ────────────────────────────────
alter table public.checkins
  add column if not exists sick              boolean not null default false,
  add column if not exists sickness_notes    text,
  add column if not exists fatigue           text,            -- 'none' | 'some' | 'heavy'
  add column if not exists bloating          boolean,         -- nullable: not asked = null
  add column if not exists soreness_areas    text[],          -- ['chest','back','legs','shoulders','arms','core']
  add column if not exists soreness_severity text,            -- 'mild' | 'sharp'
  add column if not exists intake_state      text not null default 'pending';

-- Drop and re-add the check constraint so re-applies are idempotent (the
-- constraint name is auto-generated; we name it explicitly here so the
-- migration is replay-safe).
alter table public.checkins
  drop constraint if exists checkins_intake_state_check;

alter table public.checkins
  add constraint checkins_intake_state_check
  check (intake_state in (
    'pending',
    'awaiting_feel',
    'awaiting_sickness_notes',  -- transient: between declare_sick chip tap and the user's text reply
    'awaiting_whoop',
    'delivered'
  ));

-- ── chat_messages: discriminator + chip jsonb ─────────────────────────────────
alter table public.chat_messages
  add column if not exists kind text not null default 'coach',
  add column if not exists ui   jsonb;

alter table public.chat_messages
  drop constraint if exists chat_messages_kind_check;

alter table public.chat_messages
  add constraint chat_messages_kind_check
  check (kind in ('coach', 'morning_intake'));

-- Index for kind-filtered history queries (per-user, ordered by time desc).
create index if not exists chat_messages_user_kind_created_idx
  on public.chat_messages (user_id, kind, created_at desc);
