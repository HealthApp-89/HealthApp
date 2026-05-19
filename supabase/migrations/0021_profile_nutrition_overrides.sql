-- 0021_profile_nutrition_overrides.sql
--
-- Adds nutrition_overrides jsonb to profiles. Shape (validated app-side
-- by /api/profile/nutrition-overrides — jsonb fields stay flexible):
--   {
--     kcal?: number,
--     macro_ratios?: { protein_pct, carbs_pct, fat_pct },  // sums to 1.0 ± 0.01
--     meal_ratios?:  { breakfast, lunch, dinner, snacks }  // sums to 1.0 ± 0.01
--   } | null
-- NULL means "no overrides, fall through to plan_payload / intake_payload".
-- Consumed by getTodayTargets at lib/morning/brief/get-today-targets.ts.

alter table profiles
  add column nutrition_overrides jsonb;
