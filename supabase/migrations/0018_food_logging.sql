-- 0018_food_logging.sql
--
-- In-app food logging foundation (Spec A).
--
-- Adds:
--   - food_log_entries: per-event item-level log (text, barcode, photo, voice)
--   - food_db_cache: shared cache of external food-DB lookups
--   - sum_food_entries(user_id, date): aggregation helper called from commit route
--   - profiles.disable_yazio_ingest: per-user opt-out for the legacy Yazio path
--   - daily_logs.fiber_g: in-app logging tracks fiber per item
--   - food_cache_similar(q, threshold): trigram similarity lookup used by lib/food/lookup.ts
--
-- Source-of-truth precedence (see CLAUDE.md "Data sources & precedence"):
--   When any committed food_log_entries row exists for a date, that day's
--   daily_logs nutrition columns (calories_eaten, protein_g, carbs_g, fat_g,
--   fiber_g) are owned by the food_log aggregation. Yazio CSV ingest must
--   check + skip in this case.

create extension if not exists pg_trgm;

-- ── food_log_entries ───────────────────────────────────────────────────────
create table food_log_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  eaten_at timestamptz not null,
  kind text not null check (kind in ('text', 'barcode', 'photo', 'voice')),
  raw_input jsonb not null,
  -- raw_input shapes:
  --   text:    { text: string }
  --   barcode: { upc: string, qty_g: number }
  --   photo:   { photo_path: string }              -- Spec B
  --   voice:   { audio_path: string, transcript: string }  -- Spec C
  items jsonb not null,
  -- items: array of:
  --   { name, qty_g,
  --     kcal, protein_g, carbs_g, fat_g, fiber_g,
  --     per_100g: { kcal, protein_g, carbs_g, fat_g, fiber_g },
  --     source: 'db'|'llm',
  --     db_ref: { source: 'usda'|'openfoodfacts'|'manual', canonical_id: uuid } | null,
  --     confidence: 'high'|'medium'|'low' | null }
  totals jsonb not null,
  -- totals: { kcal, protein_g, carbs_g, fat_g, fiber_g }
  is_estimated boolean not null default false,
  status text not null default 'draft' check (status in ('draft','committed','rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index on food_log_entries (user_id, eaten_at desc);
create index on food_log_entries (user_id, status, eaten_at desc);

alter table food_log_entries enable row level security;

create policy "user reads own food entries" on food_log_entries
  for select using (auth.uid() = user_id);

create policy "user writes own food entries" on food_log_entries
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── food_db_cache ──────────────────────────────────────────────────────────
create table food_db_cache (
  canonical_id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('usda', 'openfoodfacts', 'manual')),
  upc text,
  name text not null,
  per_100g jsonb not null,
  serving_size_g numeric,
  raw_payload jsonb not null,
  last_fetched_at timestamptz not null default now()
);

create unique index food_db_cache_source_upc_unique
  on food_db_cache (source, upc)
  where upc is not null;

create index food_db_cache_name_trgm
  on food_db_cache using gin (name gin_trgm_ops);

alter table food_db_cache enable row level security;

-- Cache is shared across all authenticated users (food macros aren't user-scoped).
-- Writes happen via service_role from the parse/barcode routes only.
create policy "authenticated reads food_db_cache" on food_db_cache
  for select using (auth.role() = 'authenticated');

-- ── sum_food_entries function ─────────────────────────────────────────────
-- Pure aggregation. Called from /api/food/commit and from the audit script.
-- Day-bucketing uses UTC; callers pass p_date computed in the user's local TZ.
create or replace function sum_food_entries(
  p_user_id uuid,
  p_date date
) returns jsonb
language plpgsql
security definer
as $$
declare
  result jsonb;
begin
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
    and (eaten_at at time zone 'UTC')::date = p_date;
  return coalesce(result, '{}'::jsonb);
end;
$$;

-- ── profiles.disable_yazio_ingest ──────────────────────────────────────────
alter table profiles
  add column disable_yazio_ingest boolean not null default false;

-- ── daily_logs.fiber_g — in-app food logging tracks fiber per item ────────
alter table daily_logs add column if not exists fiber_g numeric;

-- ── Trigram similarity lookup used by lib/food/lookup.ts ──────────────────
-- Returns the single best match above threshold (null when none qualify).
create or replace function food_cache_similar(
  q text,
  threshold real default 0.6
) returns food_db_cache
language sql
stable
as $$
  select *
  from food_db_cache
  where similarity(name, q) >= threshold
  order by similarity(name, q) desc
  limit 1
$$;
