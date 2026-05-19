-- 0023_food_log_favorites_and_library.sql
--
-- v1.1 of in-app food logging. Adds:
--   - food_log_entries.is_favorite for meal-level favorites
--   - food_log_entries.kind constraint extended with 'copy' and 'library'
--   - food_item_favorites table for item-level favorites (independent from meals)
--   - food_recent_items + food_frequent_items SQL helpers (derived from
--     food_log_entries.items jsonb)
--   - food_cache_search SQL helper (trigram search across food_db_cache)
--
-- All additive; no breaking changes. Pairs with /api/food/library endpoint.
--
-- Note on numbering: originally planned as 0022 but renumbered to 0023
-- because the parallel feat/session-structure branch took 0022 with
-- 0022_exercise_overrides.sql before this v1.1 work landed.

-- ── Meal-level favorite (boolean flag) ────────────────────────────────────
alter table food_log_entries
  add column is_favorite boolean not null default false;

create index food_log_entries_user_favorites_idx
  on food_log_entries (user_id, is_favorite, meal_slot, eaten_at desc)
  where is_favorite = true;

-- ── Extend kind check constraint to include 'copy' and 'library' ──────────
alter table food_log_entries
  drop constraint if exists food_log_entries_kind_check;
alter table food_log_entries
  add constraint food_log_entries_kind_check
  check (kind in ('text', 'barcode', 'photo', 'voice', 'copy', 'library'));

-- ── Item-level favorites (separate table) ─────────────────────────────────
create table food_item_favorites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  qty_g numeric not null check (qty_g > 0),
  per_100g jsonb not null,
  source text not null check (source in ('db', 'llm')),
  db_ref jsonb,
  default_meal_slot text
    check (default_meal_slot in ('breakfast', 'lunch', 'dinner', 'snack')),
  display_order int not null default 0,
  created_at timestamptz not null default now()
);

-- Case-insensitive unique on name per user. Must be a CREATE UNIQUE INDEX
-- (not an inline UNIQUE constraint) because Postgres disallows function
-- expressions like lower(name) inside table-level UNIQUE clauses.
create unique index food_item_favorites_user_lower_name_idx
  on food_item_favorites (user_id, lower(name));

create index food_item_favorites_user_order_idx
  on food_item_favorites (user_id, display_order, created_at desc);

alter table food_item_favorites enable row level security;

create policy "user reads own item favorites" on food_item_favorites
  for select using (auth.uid() = user_id);
create policy "user writes own item favorites" on food_item_favorites
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── food_recent_items: last N distinct items from user's committed entries ─
create or replace function food_recent_items(
  p_user_id uuid,
  p_days int default 30,
  p_limit int default 20
) returns table (
  name text,
  qty_g numeric,
  per_100g jsonb,
  source text,
  db_ref jsonb,
  last_eaten_at timestamptz,
  meal_slot text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with expanded as (
    select
      lower(item->>'name') as name_key,
      item->>'name' as name,
      (item->>'qty_g')::numeric as qty_g,
      item->'per_100g' as per_100g,
      item->>'source' as source,
      item->'db_ref' as db_ref,
      e.eaten_at,
      e.meal_slot,
      row_number() over (
        partition by lower(item->>'name')
        order by e.eaten_at desc
      ) as rn
    from food_log_entries e,
         lateral jsonb_array_elements(e.items) as item
    where e.user_id = p_user_id
      and e.status = 'committed'
      and e.eaten_at >= now() - (p_days || ' days')::interval
  )
  select name, qty_g, per_100g, source, db_ref, eaten_at as last_eaten_at, meal_slot
  from expanded
  where rn = 1
  order by eaten_at desc
  limit p_limit;
$$;

-- ── food_frequent_items: top N items by count in last p_days ──────────────
create or replace function food_frequent_items(
  p_user_id uuid,
  p_days int default 30,
  p_limit int default 20
) returns table (
  name text,
  qty_g numeric,
  per_100g jsonb,
  source text,
  db_ref jsonb,
  occurrence_count int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with expanded as (
    select
      lower(item->>'name') as name_key,
      item->>'name' as name,
      (item->>'qty_g')::numeric as qty_g,
      item->'per_100g' as per_100g,
      item->>'source' as source,
      item->'db_ref' as db_ref,
      e.eaten_at,
      row_number() over (
        partition by lower(item->>'name')
        order by e.eaten_at desc
      ) as rn_latest
    from food_log_entries e,
         lateral jsonb_array_elements(e.items) as item
    where e.user_id = p_user_id
      and e.status = 'committed'
      and e.eaten_at >= now() - (p_days || ' days')::interval
  ),
  counted as (
    select
      name_key,
      count(*)::int as occurrence_count,
      max(name) filter (where rn_latest = 1) as name,
      max(qty_g) filter (where rn_latest = 1) as qty_g,
      max(per_100g::text) filter (where rn_latest = 1) as per_100g_str,
      max(source) filter (where rn_latest = 1) as source,
      max(db_ref::text) filter (where rn_latest = 1) as db_ref_str
    from expanded
    group by name_key
  )
  select
    name,
    qty_g,
    per_100g_str::jsonb as per_100g,
    source,
    db_ref_str::jsonb as db_ref,
    occurrence_count
  from counted
  order by occurrence_count desc, name asc
  limit p_limit;
$$;

-- ── food_cache_search: trigram search across the shared food DB cache ─────
create or replace function food_cache_search(
  q text,
  p_limit int default 20
) returns setof food_db_cache
language sql
stable
as $$
  select *
  from food_db_cache
  where similarity(name, q) >= 0.3
  order by similarity(name, q) desc
  limit p_limit;
$$;
