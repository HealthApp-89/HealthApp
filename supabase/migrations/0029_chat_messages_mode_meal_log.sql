-- ============================================================================
-- 0029_chat_messages_mode_meal_log.sql
--
-- Migration 0008 set chat_messages_mode_check to allow only
--   ('default', 'plan_week', 'setup_block')
-- but subsequent surfaces (onboarding intake chat, the meal-log chat thread
-- from migration 0028) write 'intake' and 'meal_log' into the same column.
-- Inserts of those rows were rejected by the CHECK constraint silently
-- whenever the caller didn't read the supabase error (the MealLoggerChatTab
-- happy-path didn't), producing the "send button does nothing" symptom on
-- the new Nora meal-log composer.
--
-- This migration extends the allowlist to include both. No data backfill
-- needed — existing rows already conform to the prior subset.
-- ============================================================================

alter table public.chat_messages
  drop constraint if exists chat_messages_mode_check;

alter table public.chat_messages
  add constraint chat_messages_mode_check
  check (mode in ('default', 'plan_week', 'setup_block', 'intake', 'meal_log'));

comment on column public.chat_messages.mode is
  'Conversation mode: ''default'' (free-form Q&A), ''plan_week'' (Sunday weekly planning), ''setup_block'' (block creation), ''intake'' (onboarding wizard chat), ''meal_log'' (MealLoggerSheet CHAT tab). Resolved server-side from request param OR inherited from prior turn.';
