-- 0032_workout_debrief.sql
--
-- Adds 'workout_debrief' to chat_messages.kind allowlist and a partial index
-- on (user_id, ui->>'workout_id') for the idempotency check used by
-- /api/coach/workout-debrief.
--
-- Pattern matches 0015_proactive_nudge.sql and 0014_weekly_reviews.sql.
--
-- NOTE: The prior allowlist (from 0028_meal_logging_chat_revamp.sql) uses
-- 'coach' and 'morning_intake' — the plan's template used 'free_text' and
-- 'morning_check' which are wrong. This migration preserves the correct names.

alter table chat_messages
  drop constraint if exists chat_messages_kind_check;

alter table chat_messages
  add constraint chat_messages_kind_check
  check (kind in (
    'coach',
    'morning_intake',
    'morning_brief',
    'weekly_review',
    'proactive_nudge',
    'system_routing',
    'meal_log',
    'workout_debrief'
  ));

create index if not exists chat_messages_workout_debrief_idx
  on chat_messages (user_id, (ui->>'workout_id'))
  where kind = 'workout_debrief';
