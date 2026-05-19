-- 0020_food_log_meal_slot.sql
--
-- Adds meal_slot to food_log_entries (breakfast/lunch/dinner/snack) as a
-- durable attribution dimension for the meal-first journal UI on /meal and
-- the meal_slot filter on the query_food_log coach tool.
--
-- meal_slot is an ATTRIBUTION dimension, not an ownership change — the
-- daily_logs nutrition aggregation in sum_food_entries stays slot-agnostic.
-- See CLAUDE.md "Data sources & precedence".

alter table food_log_entries
  add column meal_slot text
    check (meal_slot in ('breakfast','lunch','dinner','snack')) not null
    default 'snack';

-- Backfill existing rows by time-of-day. UTC-bucketed to match
-- sum_food_entries day-keying.
update food_log_entries
set meal_slot = case
  when extract(hour from eaten_at) between 4 and 10 then 'breakfast'
  when extract(hour from eaten_at) between 11 and 14 then 'lunch'
  when extract(hour from eaten_at) between 15 and 16 then 'snack'
  when extract(hour from eaten_at) between 17 and 21 then 'dinner'
  else 'snack'
end;

create index on food_log_entries (user_id, eaten_at, meal_slot);
