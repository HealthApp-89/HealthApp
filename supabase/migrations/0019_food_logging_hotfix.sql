-- 0019_food_logging_hotfix.sql
--
-- Hotfix for 0018: harden sum_food_entries SECURITY DEFINER function with an
-- explicit search_path. Without this, a caller with control over their session's
-- search_path could redirect the unqualified `food_log_entries` reference inside
-- the function to a table in another schema, bypassing RLS as the function owner.
--
-- Matches the convention from 0005_chat.sql and 0016_chat_message_timestamp_collision.sql.

alter function sum_food_entries(uuid, date) set search_path = public, pg_temp;
