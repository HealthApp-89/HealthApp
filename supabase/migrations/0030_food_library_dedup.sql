-- 0029_food_library_dedup.sql
--
-- Dedup floor for the personal food library.
--
-- The 2026-05-21 Nora-chat session surfaced a re-save loop: the UI didn't show
-- save_to_library completions, the user said "nothing saved", the model
-- couldn't see prior tool_results across turns, so it re-fired save_to_library
-- × 8 on each retry. Result: 24+ duplicate rows in user_food_items for a
-- single conversational request.
--
-- The chat-stream / UI fixes (visible result chips, idempotent executor) ride
-- alongside this migration; this is the database-side floor that turns repeat
-- saves into no-ops regardless of whether the upstream paths regress.
--
-- Why lower(name): users naturally type "Grilled Salmon" once and "grilled
-- salmon" the next time — they're the same item. Trigram search already
-- normalizes case for retrieval; the unique index does the same for writes.

-- 1. Dedupe existing rows. Keep the oldest row per (user_id, lower(name));
--    delete the rest. food_log_entries.recipe_id has ON DELETE SET NULL
--    (migration 0028), so any entries pointing at duplicates simply lose the
--    back-reference — the food data on those entries stays intact.
with ranked as (
  select id,
         row_number() over (
           partition by user_id, lower(name)
           order by created_at asc, id asc
         ) as rn
  from public.user_food_items
)
delete from public.user_food_items
where id in (select id from ranked where rn > 1);

-- 2. Add the unique index now that duplicates are gone.
create unique index if not exists user_food_items_user_name_unique
  on public.user_food_items (user_id, lower(name));
