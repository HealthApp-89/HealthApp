-- ============================================================================
-- 0028_meal_logging_chat_revamp.sql
--
-- Meal logging is moving from a one-shot TEXT tab to a Nora-led chat thread
-- inside MealLoggerSheet. Three schema changes:
--
-- 1. user_food_items — per-user personal library (single foods + recipes
--    in one table, distinguished by which of per_100g vs composite_of is
--    set). Sits at the top of the resolveItemMacros chain (lib/food/lookup.ts).
--
-- 2. food_log_entries.recipe_id — back-reference for meals logged via a
--    saved recipe. The items[] array still carries the expanded ingredients
--    so aggregation stays simple; recipe_id is just for journal-collapse UX.
--
-- 3. chat_messages.kind allowlist gets 'meal_log' (the kind used by every
--    Nora bubble in the meal-log thread), and chat_messages_visible_idx is
--    replaced so the default /coach history reads exclude meal_log rows.
-- ============================================================================

-- pg_trgm is already installed in prior migrations (0018); idempotent here.
create extension if not exists pg_trgm;

-- ── user_food_items ─────────────────────────────────────────────────────────
create table if not exists public.user_food_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  per_100g jsonb,              -- {kcal, protein_g, carbs_g, fat_g, fiber_g}; NULL for recipes
  composite_of jsonb,          -- [{name, qty_g}] expanded ingredients; NULL for single items
  default_serving_g numeric,   -- recipe-only: default "1 serving" gram weight
  source text not null,        -- 'user_manual' | 'user_label' | 'user_recipe'
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_food_items_one_shape_chk
    check ((per_100g is not null) <> (composite_of is not null))
);

create index if not exists user_food_items_user_idx on public.user_food_items (user_id);
create index if not exists user_food_items_name_trgm_idx
  on public.user_food_items using gin (name gin_trgm_ops);

alter table public.user_food_items enable row level security;

drop policy if exists "user reads own items" on public.user_food_items;
create policy "user reads own items" on public.user_food_items
  for select using (auth.uid() = user_id);

drop policy if exists "user writes own items" on public.user_food_items;
create policy "user writes own items" on public.user_food_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- updated_at trigger. search_path pinned to public,pg_temp to match the
-- project's defence-in-depth convention for trigger / SECURITY DEFINER
-- functions (see sum_food_entries in 0019, commit_logger_session in 0026).
create or replace function public.user_food_items_set_updated_at()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end$$;

drop trigger if exists user_food_items_updated_at on public.user_food_items;
create trigger user_food_items_updated_at
  before update on public.user_food_items
  for each row execute function public.user_food_items_set_updated_at();

-- ── food_log_entries.recipe_id ──────────────────────────────────────────────
alter table public.food_log_entries
  add column if not exists recipe_id uuid
  references public.user_food_items(id) on delete set null;

create index if not exists food_log_entries_recipe_idx
  on public.food_log_entries (recipe_id)
  where recipe_id is not null;

-- ── chat_messages.kind allowlist + visible_idx ──────────────────────────────
alter table public.chat_messages
  drop constraint if exists chat_messages_kind_check;
alter table public.chat_messages
  add constraint chat_messages_kind_check check (
    kind in (
      'coach',
      'morning_intake',
      'morning_brief',
      'weekly_review',
      'proactive_nudge',
      'system_routing',
      'meal_log'
    )
  );

-- Replace the partial index so /coach history reads stay lean: filter out both
-- system_routing (audit-only) and meal_log (lives on /meal, not /coach).
drop index if exists public.chat_messages_visible_idx;
create index chat_messages_visible_idx
  on public.chat_messages (user_id, created_at desc)
  where kind not in ('system_routing', 'meal_log');
