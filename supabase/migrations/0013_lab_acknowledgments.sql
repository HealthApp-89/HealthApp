-- supabase/migrations/0012_lab_acknowledgments.sql
-- Adds a jsonb column to profiles holding lab/check acknowledgment state
-- for the GLP-1 lab-prompt card. Shape:
--   {
--     "b12_baseline": "2026-05-12",          -- ISO date when acknowledged
--     "vit_d_baseline": "2026-05-12",
--     "magnesium_baseline": "2026-05-12",
--     "ferritin_baseline": "2026-05-12",
--     "b12_6mo": null,                        -- not yet acknowledged
--     "grip_strength_q": "2026-05-15",        -- quarterly slot
--     "bone_density_12mo": null
--   }
--
-- Keys are app-defined; the column is a free-form jsonb to allow Phase 3
-- to add new check slots without schema changes.

ALTER TABLE profiles
  ADD COLUMN lab_acknowledgments jsonb NOT NULL DEFAULT '{}'::jsonb;
