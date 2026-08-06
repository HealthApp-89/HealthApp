-- 0055_food_history_windows.sql
--
-- Fixes the "no past food entries" audit (2026-08-06).
--
-- Symptom: after a 41-day logging gap the Library tab's Recent/Frequent
-- sections and the history picker showed nothing, despite 143 committed
-- food_log_entries rows spanning 2026-05-21 → today.
--
-- Root cause: every "past entries" surface was windowed relative to now().
-- food_recent_items/food_frequent_items defaulted to a 30-day window, so any
-- gap longer than 30 days reported "you have never eaten anything".
--
-- Changes here:
--   1. food_recent_items  — p_days becomes NULL-able and defaults to NULL,
--      meaning "no time window". Recency is now an ordering concern (last N
--      distinct items by eaten_at desc), not a calendar-window concern, which
--      is what "Recent" means to a user returning after a break.
--   2. food_frequent_items — default window widened 30d → 180d. Frequency
--      genuinely needs a time basis, so this keeps a window but makes it wide
--      enough to survive a normal gap. NULL is also accepted for "all time".
--   3. sum_food_entries — day attribution moves from hardcoded UTC to the
--      athlete's profiles.timezone, per the CLAUDE.md rule that
--      profiles.timezone is authoritative for every day-boundary computation.
--
-- Backfill: none required. All 143 existing committed rows were verified to
-- carry the same calendar day under UTC and Asia/Dubai attribution (nothing
-- was logged between 00:00 and 04:00 local), so change 3 is a no-op against
-- current data and only affects rows written from here on.
--
-- CREATE OR REPLACE resets a function's SET configuration, so every definition
-- below re-declares `set search_path = public, pg_temp` (the convention from
-- 0005_chat.sql / 0019_food_logging_hotfix.sql).

-- ── 1. food_recent_items: no time window by default ───────────────────────
create or replace function food_recent_items(
  p_user_id uuid,
  p_days int default null,
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
      -- NULL p_days => no lower bound. "Recent" is an ordering, not a window.
      and (p_days is null
           or e.eaten_at >= now() - (p_days || ' days')::interval)
  )
  select name, qty_g, per_100g, source, db_ref, eaten_at as last_eaten_at, meal_slot
  from expanded
  where rn = 1
  order by eaten_at desc
  limit p_limit;
$$;

-- ── 2. food_frequent_items: 30d → 180d default window ─────────────────────
create or replace function food_frequent_items(
  p_user_id uuid,
  p_days int default 180,
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
      and (p_days is null
           or e.eaten_at >= now() - (p_days || ' days')::interval)
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

-- ── 3. sum_food_entries: attribute days in the athlete's timezone ─────────
create or replace function sum_food_entries(
  p_user_id uuid,
  p_date date
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  result jsonb;
  v_tz text;
begin
  -- profiles.timezone is authoritative (migration 0042). Fall back to UTC so
  -- the function stays total if a profile row is somehow missing.
  select coalesce(timezone, 'UTC') into v_tz
  from profiles
  where user_id = p_user_id;
  v_tz := coalesce(v_tz, 'UTC');

  select jsonb_build_object(
    'kcal',      coalesce(sum((totals->>'kcal')::numeric), 0),
    'protein_g', coalesce(sum((totals->>'protein_g')::numeric), 0),
    'carbs_g',   coalesce(sum((totals->>'carbs_g')::numeric), 0),
    'fat_g',     coalesce(sum((totals->>'fat_g')::numeric), 0),
    'fiber_g',   coalesce(sum((totals->>'fiber_g')::numeric), 0)
  ) into result
  from food_log_entries
  where user_id = p_user_id
    and status = 'committed'
    and (eaten_at at time zone v_tz)::date = p_date;
  return coalesce(result, '{}'::jsonb);
end;
$$;
