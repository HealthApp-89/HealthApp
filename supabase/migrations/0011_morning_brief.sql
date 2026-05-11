-- 0011_morning_brief.sql — morning brief
--
-- Extends the morning intake state machine with assembling_brief,
-- brief_delivered, brief_failed. Adds 'morning_brief' to chat_messages.kind.
-- The brief itself is a single chat_messages row with kind='morning_brief'
-- and a structured ui jsonb payload of shape MorningBriefCard.

-- ── checkins.intake_state: add new states ────────────────────────────────────
alter table public.checkins
  drop constraint if exists checkins_intake_state_check;

alter table public.checkins
  add constraint checkins_intake_state_check
  check (intake_state in (
    'pending',
    'awaiting_feel',
    'awaiting_sickness_notes',
    'awaiting_whoop',
    'delivered',           -- legacy: existing rows from pre-brief era stay here
    'assembling_brief',    -- transient: AI generation in flight
    'brief_delivered',     -- terminal: brief successfully written
    'brief_failed'         -- recoverable: AI failed; user can retry
  ));

-- ── chat_messages.kind: add 'morning_brief' ──────────────────────────────────
alter table public.chat_messages
  drop constraint if exists chat_messages_kind_check;

alter table public.chat_messages
  add constraint chat_messages_kind_check
  check (kind in ('coach', 'morning_intake', 'morning_brief'));

-- ── Comments ─────────────────────────────────────────────────────────────────
comment on column public.chat_messages.kind is
  'Message variant: coach (default chat), morning_intake (slot-filling chips), morning_brief (post-intake daily plan card).';

comment on column public.checkins.intake_state is
  'Morning intake state machine: pending → awaiting_feel → [awaiting_sickness_notes] → awaiting_whoop → delivered → assembling_brief → brief_delivered (or brief_failed on AI failure). delivered is kept as a state for backwards compatibility with rows written before the brief feature.';
