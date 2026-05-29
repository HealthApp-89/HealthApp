-- supabase/migrations/0039_user_food_items_metadata.sql
-- Adds metadata jsonb column on user_food_items for the Nora suggestion-engine
-- recipe-discovery tight loop (spec §9.6). Records the source of recipe creation
-- so the engine can boost newly-saved discovery recipes for 7 days.

alter table user_food_items
  add column if not exists metadata jsonb;

comment on column user_food_items.metadata is
  'Per-row metadata. Recipe-discovery nudges write { source: "recipe_discovery", combo_signature: "..." }; manual saves leave NULL.';
