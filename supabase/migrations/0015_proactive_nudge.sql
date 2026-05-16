-- supabase/migrations/0015_proactive_nudge.sql
--
-- Sub-project #4: chat-side proactive coach reach-out.
-- Extends chat_messages.kind union to include 'proactive_nudge'.
--
-- The 'proactive_nudge' kind is written by the /api/coach/proactive/check
-- cron when a trigger (plateau / off-pace weight / HRV below baseline)
-- fires. Dedup is enforced via chat_messages lookup (7-day window per
-- ui.trigger_key); no separate dedup table.

alter table public.chat_messages
  drop constraint if exists chat_messages_kind_check;

alter table public.chat_messages
  add constraint chat_messages_kind_check check (
    kind in (
      'coach',
      'morning_intake',
      'morning_brief',
      'weekly_review',
      'proactive_nudge'
    )
  );

comment on column public.chat_messages.kind is
  'Discriminator: coach (default conversational), morning_intake (chip turns), morning_brief (daily card), weekly_review (Sunday recap card), proactive_nudge (trigger-fired alert card).';
