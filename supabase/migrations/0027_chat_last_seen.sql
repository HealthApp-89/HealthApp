-- 0027_chat_last_seen.sql
--
-- Adds `profiles.chat_last_seen jsonb` storing per-thread "last seen"
-- timestamps. Used by the BottomNav unread-dot indicator on Strength,
-- Diet, Health, Metrics tabs — a dot shows when a thread has assistant
-- messages newer than the user's last visit to that coach's page.
--
-- Shape: { peter?: ISO, carter?: ISO, nora?: ISO, remi?: ISO }
-- NULL/missing key = never seen → all messages are unread.

alter table profiles
  add column if not exists chat_last_seen jsonb not null default '{}'::jsonb;
