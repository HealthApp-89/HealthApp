# Food Logging v1.1 Implementation Plan — Copy, Favorites, Library, History

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v1.1 of in-app food logging — copy past entries, two-level favorites (meal + item), Library tab in MealLoggerSheet with search across user history and shared food DB cache, and a HistoryPickerSheet for multi-source meal assembly across dates.

**Architecture:** All additive. Reuses the existing parse → preview → commit pipeline; the new primitives (copy, favorites, library, history-picker) are just starting points into that pipeline. Backend: one migration (0022) adds `is_favorite` flag, `food_item_favorites` table, and three SQL helpers (`food_recent_items`, `food_frequent_items`, `food_cache_search`). Five new API routes plus extensions to existing ones. Frontend: one new tab in MealLoggerSheet (Library), one new bottom sheet (HistoryPickerSheet), and row-level affordances (☆ favorite, 📋 copy, per-item ☆) on TodaysMeals, MealSlotCard, FoodEntryEditSheet, and MealLoggerTypeTab.

**Tech Stack:** Next.js 15 App Router, Supabase (Postgres + RLS + `pg_trgm` from migration 0018), TanStack Query (hybrid SSR-hydrate), Tailwind v4. No new external integrations. No new Anthropic calls. No test framework in this project — verification uses `npm run typecheck` + manual exercise via `npm run dev` + an audit script.

**Spec:** [docs/superpowers/specs/2026-05-19-food-logging-v1-1-copy-favorites-library-design.md](../specs/2026-05-19-food-logging-v1-1-copy-favorites-library-design.md).

---

## Pre-flight

- [ ] **Pre-flight 1: Create feature branch**

```bash
git checkout main
git pull
git checkout -b feat/food-logging-v1-1
```

- [ ] **Pre-flight 2: Verify clean baseline**

```bash
npm run typecheck
```

Expected: exits 0. If it doesn't, stop and fix unrelated breakage before continuing.

---

## File Structure

**New files (24):**

```
supabase/migrations/0022_food_log_favorites_and_library.sql

app/api/food/entries/[id]/copy/route.ts
app/api/food/entries/[id]/favorite/route.ts
app/api/food/item-favorites/route.ts
app/api/food/item-favorites/[id]/route.ts
app/api/food/library/route.ts
app/api/food/library/draft/route.ts
app/api/food/history/route.ts
app/api/food/yesterday-slot/route.ts

lib/query/fetchers/foodLibrary.ts
lib/query/fetchers/foodItemFavorites.ts
lib/query/fetchers/foodHistory.ts
lib/query/hooks/useFoodLibrary.ts
lib/query/hooks/useFoodItemFavorites.ts
lib/query/hooks/useFoodHistory.ts

components/log/MealLoggerLibraryTab.tsx
components/log/LibrarySection.tsx
components/log/LibraryRow.tsx
components/log/HistoryPickerSheet.tsx
components/log/HistoryPickerDateBar.tsx
components/log/HistoryPickerBucket.tsx
components/log/HistoryPickerSlotCard.tsx

scripts/audit-food-library.mjs
```

**Modified files (9):**

```
lib/food/types.ts                          — add FoodItemFavorite, FoodRecentItem, FoodFrequentItem, FoodLibrarySections, HistoryDay; FoodLogEntry gains is_favorite
lib/query/keys.ts                          — add foodLibrary, foodItemFavorites, foodHistory key families
components/log/MealLoggerSheet.tsx         — add Library tab + Pick-from-history launcher
components/log/MealLoggerTypeTab.tsx       — per-item ☆ on draft preview
components/log/FoodEntryEditSheet.tsx      — per-item ☆ on edit sheet
components/log/TodaysMeals.tsx             — per-row ☆ + 📋 affordances
components/meal/MealSlotCard.tsx           — per-row ☆ + 📋 affordances
components/meal/MealSlotEmptyCard.tsx      — two pills: Copy yesterday + Pick from history
CLAUDE.md                                  — migration 0022 + v1.1 sub-section
```

---

## Task 1: Migration 0022 — favorites + Library SQL helpers

**Files:**
- Create: `supabase/migrations/0022_food_log_favorites_and_library.sql`

- [ ] **Step 1.1: Write the migration**

Create `supabase/migrations/0022_food_log_favorites_and_library.sql` with this exact content:

```sql
-- 0022_food_log_favorites_and_library.sql
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

-- ── Meal-level favorite (boolean flag) ────────────────────────────────────
alter table food_log_entries
  add column is_favorite boolean not null default false;

create index food_log_entries_user_favorites_idx
  on food_log_entries (user_id, is_favorite, meal_slot, eaten_at desc)
  where is_favorite = true;

-- ── Extend kind check constraint to include 'copy' and 'library' ──────────
-- 'copy' is set by /api/food/entries/[id]/copy.
-- 'library' is set by /api/food/library/draft (favorite_meal | favorite_item |
--   recent | frequent | catalog | history_picker source_kinds).
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
  created_at timestamptz not null default now(),
  unique (user_id, lower(name))
);

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
-- Looser threshold than food_cache_similar (0.3 vs 0.6) — exploratory search,
-- not auto-resolve. Caller renders source chip ([usda] / [off]).
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
```

- [ ] **Step 1.2: Apply via Supabase CLI**

```bash
supabase db push
```

Expected: prints `Applying migration 0022_food_log_favorites_and_library.sql...` and exits 0.

If `supabase db push` reports a history mismatch, run:
```bash
supabase migration repair --status applied <previous_migration_id>
```
Then retry push.

- [ ] **Step 1.3: Verify schema**

Run in Supabase Dashboard SQL Editor:
```sql
select food_recent_items(auth.uid(), 30, 5);
select food_frequent_items(auth.uid(), 30, 5);
select food_cache_search('chicken', 5);
```

Expected: each returns rows or an empty result, no error.

- [ ] **Step 1.4: Commit**

```bash
git add supabase/migrations/0022_food_log_favorites_and_library.sql
git commit -m "feat(food-log): migration 0022 — favorites + Library SQL helpers"
```

---

## Task 2: TypeScript types

**Files:**
- Modify: `lib/food/types.ts`

- [ ] **Step 2.1: Add new types**

In `lib/food/types.ts`, append these types after the existing exports:

```ts
export type FoodItemFavorite = {
  id: string;
  user_id: string;
  name: string;
  qty_g: number;
  per_100g: FoodMacros;
  source: "db" | "llm";
  db_ref: { source: "usda" | "openfoodfacts" | "manual"; canonical_id: string } | null;
  default_meal_slot: MealSlot | null;
  display_order: number;
  created_at: string;
};

export type FoodRecentItem = {
  name: string;
  qty_g: number;
  per_100g: FoodMacros;
  source: "db" | "llm";
  db_ref: FoodItem["db_ref"];
  last_eaten_at: string;
  meal_slot: MealSlot;
};

export type FoodFrequentItem = {
  name: string;
  qty_g: number;
  per_100g: FoodMacros;
  source: "db" | "llm";
  db_ref: FoodItem["db_ref"];
  occurrence_count: number;
};

export type FoodLibrarySections = {
  favorite_meals: Array<Pick<FoodLogEntry, "id" | "eaten_at" | "meal_slot" | "items" | "totals"> & { is_favorite: true }>;
  favorite_items: FoodItemFavorite[];
  recent: FoodRecentItem[];
  frequent: FoodFrequentItem[];
  catalog?: FoodDbCacheRow[];
};

export type HistoryDay = {
  date: string;
  slots: Record<MealSlot, FoodLogEntry[]>;
};
```

Locate the `FoodLogEntry` type definition and add `is_favorite: boolean;` (place it after `is_estimated`):

```ts
export type FoodLogEntry = {
  // ...existing fields...
  is_estimated: boolean;
  is_favorite: boolean;  // ADD THIS
  status: FoodLogEntryStatus;
  // ...rest unchanged...
};
```

- [ ] **Step 2.2: Update existing fetcher to select is_favorite**

In `lib/query/fetchers/foodEntries.ts`, find the `COLS` constant:
```ts
const COLS =
  "id, user_id, eaten_at, meal_slot, kind, raw_input, items, totals, is_estimated, status, created_at, updated_at";
```

Add `is_favorite`:
```ts
const COLS =
  "id, user_id, eaten_at, meal_slot, kind, raw_input, items, totals, is_estimated, is_favorite, status, created_at, updated_at";
```

- [ ] **Step 2.3: Typecheck**

```bash
npm run typecheck
```

Expected: exits 0. If a downstream consumer breaks because they instantiate FoodLogEntry without `is_favorite`, add `is_favorite: false` to the default.

- [ ] **Step 2.4: Commit**

```bash
git add lib/food/types.ts lib/query/fetchers/foodEntries.ts
git commit -m "feat(food-log): types for v1.1 (favorites, library sections, history)"
```

---

## Task 3: Copy + favorite-entry endpoints

**Files:**
- Create: `app/api/food/entries/[id]/copy/route.ts`
- Create: `app/api/food/entries/[id]/favorite/route.ts`

- [ ] **Step 3.1: Write copy endpoint**

Create `app/api/food/entries/[id]/copy/route.ts`:

```ts
// app/api/food/entries/[id]/copy/route.ts
//
// POST { eaten_at?, meal_slot? } → clone an existing committed entry as a
// new draft. Defaults: eaten_at = now(), meal_slot = source's slot.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const BodySchema = z.object({
  eaten_at: z.string().datetime().optional(),
  meal_slot: z.enum(["breakfast", "lunch", "dinner", "snack"]).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const json = await req.json().catch(() => ({}));
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  // Fetch the source entry.
  const { data: source, error: fetchError } = await supabase
    .from("food_log_entries")
    .select("items, totals, is_estimated, meal_slot")
    .eq("id", id)
    .eq("user_id", user.id)
    .eq("status", "committed")
    .maybeSingle();
  if (fetchError) {
    console.error("[/api/food/entries/[id]/copy] fetch failed", fetchError);
    return NextResponse.json({ error: "fetch_failed" }, { status: 500 });
  }
  if (!source) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const meal_slot = parsed.data.meal_slot ?? source.meal_slot;
  const eaten_at = parsed.data.eaten_at ?? new Date().toISOString();

  const { data: inserted, error: insertError } = await supabase
    .from("food_log_entries")
    .insert({
      user_id: user.id,
      eaten_at,
      meal_slot,
      kind: "copy",
      raw_input: { kind: "copy", source_id: id },
      items: source.items,
      totals: source.totals,
      is_estimated: source.is_estimated,
      is_favorite: false,
      status: "draft",
    })
    .select("id, eaten_at, meal_slot, kind, items, totals, is_estimated, is_favorite, status")
    .single();
  if (insertError) {
    console.error("[/api/food/entries/[id]/copy] insert failed", insertError);
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  return NextResponse.json({ entry: inserted });
}
```

- [ ] **Step 3.2: Write favorite-entry endpoint**

Create `app/api/food/entries/[id]/favorite/route.ts`:

```ts
// app/api/food/entries/[id]/favorite/route.ts
//
// PATCH { value: boolean } → toggle is_favorite on an entry. Reaggregation
// is NOT called — favoriting doesn't change macros.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const BodySchema = z.object({ value: z.boolean() });

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const { data: updated, error } = await supabase
    .from("food_log_entries")
    .update({ is_favorite: parsed.data.value, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id)
    .select("id, is_favorite")
    .single();
  if (error) {
    console.error("[/api/food/entries/[id]/favorite] update failed", error);
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({ ok: true, is_favorite: updated.is_favorite });
}
```

- [ ] **Step 3.3: Typecheck and commit**

```bash
npm run typecheck
git add app/api/food/entries/[id]/copy app/api/food/entries/[id]/favorite
git commit -m "feat(food-log): copy + favorite-entry endpoints"
```

---

## Task 4: Item-favorites CRUD endpoints

**Files:**
- Create: `app/api/food/item-favorites/route.ts`
- Create: `app/api/food/item-favorites/[id]/route.ts`

- [ ] **Step 4.1: Write list + create endpoint**

Create `app/api/food/item-favorites/route.ts`:

```ts
// app/api/food/item-favorites/route.ts
//
// GET  → list user's favorited food items
// POST → upsert a favorite by (user_id, lower(name))

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const COLS = "id, user_id, name, qty_g, per_100g, source, db_ref, default_meal_slot, display_order, created_at";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("food_item_favorites")
    .select(COLS)
    .eq("user_id", user.id)
    .order("display_order", { ascending: true })
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: "query_failed" }, { status: 500 });
  return NextResponse.json({ favorites: data ?? [] });
}

const MacrosSchema = z.object({
  kcal: z.number().nonnegative(),
  protein_g: z.number().nonnegative(),
  carbs_g: z.number().nonnegative(),
  fat_g: z.number().nonnegative(),
  fiber_g: z.number().nonnegative(),
});

const DbRefSchema = z
  .object({
    source: z.enum(["usda", "openfoodfacts", "manual"]),
    canonical_id: z.string().uuid(),
  })
  .nullable()
  .optional();

const PostSchema = z.object({
  name: z.string().min(1).max(200),
  qty_g: z.number().positive().finite(),
  per_100g: MacrosSchema,
  source: z.enum(["db", "llm"]),
  db_ref: DbRefSchema,
  default_meal_slot: z.enum(["breakfast", "lunch", "dinner", "snack"]).optional(),
});

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = PostSchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  // Upsert on (user_id, lower(name)) — second add with the same name is a no-op (returns existing).
  // Postgres unique on (user_id, lower(name)) — handled via raw insert with ON CONFLICT semantics
  // through Supabase's upsert API.
  const { data, error } = await supabase
    .from("food_item_favorites")
    .upsert(
      {
        user_id: user.id,
        name: parsed.data.name,
        qty_g: parsed.data.qty_g,
        per_100g: parsed.data.per_100g,
        source: parsed.data.source,
        db_ref: parsed.data.db_ref ?? null,
        default_meal_slot: parsed.data.default_meal_slot ?? null,
      },
      { onConflict: "user_id,name", ignoreDuplicates: false },
    )
    .select(COLS)
    .single();
  if (error) {
    console.error("[/api/food/item-favorites POST] upsert failed", error);
    return NextResponse.json({ error: "upsert_failed" }, { status: 500 });
  }

  return NextResponse.json({ favorite: data });
}
```

Note: the unique index in the migration is on `(user_id, lower(name))`. Supabase's upsert `onConflict` doesn't natively support functional indexes — the upsert here uses `(user_id, name)` for the conflict target. Case-sensitive duplicates within the same user (e.g., "Greek yogurt" vs "greek yogurt") will fall through to a unique-violation error. The client should normalize on save (Title Case or all-lowercase); for v1 we accept this small gap.

- [ ] **Step 4.2: Write delete endpoint**

Create `app/api/food/item-favorites/[id]/route.ts`:

```ts
// app/api/food/item-favorites/[id]/route.ts
//
// DELETE → remove a favorite by id.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { error } = await supabase
    .from("food_item_favorites")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);
  if (error) return NextResponse.json({ error: "delete_failed" }, { status: 500 });

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4.3: Typecheck and commit**

```bash
npm run typecheck
git add app/api/food/item-favorites
git commit -m "feat(food-log): item-favorites CRUD endpoints"
```

---

## Task 5: Library endpoint + Library/draft endpoint

**Files:**
- Create: `app/api/food/library/route.ts`
- Create: `app/api/food/library/draft/route.ts`

- [ ] **Step 5.1: Write library sections endpoint**

Create `app/api/food/library/route.ts`:

```ts
// app/api/food/library/route.ts
//
// GET ?slot=&q=&recent_days=30&frequent_days=30&section_limit=20
//   → { favorite_meals, favorite_items, recent, frequent, catalog? }
//
// Catalog renders ONLY when q != "".
// When q != "", dedupe across sections by lowercased name:
//   Favorites > Recent > Frequent > Catalog.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const QuerySchema = z.object({
  slot: z.enum(["breakfast", "lunch", "dinner", "snack"]).nullable().optional(),
  q: z.string().max(200).optional(),
  recent_days: z.coerce.number().int().min(1).max(180).default(30),
  frequent_days: z.coerce.number().int().min(1).max(180).default(30),
  section_limit: z.coerce.number().int().min(1).max(50).default(20),
});

const FAVORITE_MEAL_COLS = "id, eaten_at, meal_slot, items, totals, is_favorite";
const FAVORITE_ITEM_COLS = "id, user_id, name, qty_g, per_100g, source, db_ref, default_meal_slot, display_order, created_at";

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    slot: url.searchParams.get("slot"),
    q: url.searchParams.get("q") ?? undefined,
    recent_days: url.searchParams.get("recent_days") ?? undefined,
    frequent_days: url.searchParams.get("frequent_days") ?? undefined,
    section_limit: url.searchParams.get("section_limit") ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const { slot, q, recent_days, frequent_days, section_limit } = parsed.data;
  const trimmedQ = q?.trim() ?? "";
  const hasQ = trimmedQ.length > 0;

  // Favorite meals — slot-aware ordering done client-side via a single query
  // sorted by eaten_at desc, then we re-sort in JS to place matching slot first.
  const favMealsP = supabase
    .from("food_log_entries")
    .select(FAVORITE_MEAL_COLS)
    .eq("user_id", user.id)
    .eq("is_favorite", true)
    .eq("status", "committed")
    .order("eaten_at", { ascending: false })
    .limit(section_limit * 2); // fetch extra so slot-priority dedupe can still hit limit

  // Favorite items
  const favItemsP = supabase
    .from("food_item_favorites")
    .select(FAVORITE_ITEM_COLS)
    .eq("user_id", user.id)
    .order("display_order", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(section_limit * 2);

  // Recent + Frequent + (optional) Catalog
  const recentP = supabase.rpc("food_recent_items", {
    p_user_id: user.id,
    p_days: recent_days,
    p_limit: section_limit,
  });
  const frequentP = supabase.rpc("food_frequent_items", {
    p_user_id: user.id,
    p_days: frequent_days,
    p_limit: section_limit,
  });
  const catalogP = hasQ
    ? supabase.rpc("food_cache_search", { q: trimmedQ, p_limit: section_limit })
    : Promise.resolve({ data: null, error: null } as const);

  const [favMealsRes, favItemsRes, recentRes, frequentRes, catalogRes] = await Promise.all([
    favMealsP, favItemsP, recentP, frequentP, catalogP,
  ]);

  if (favMealsRes.error) return NextResponse.json({ error: "fav_meals_failed" }, { status: 500 });
  if (favItemsRes.error) return NextResponse.json({ error: "fav_items_failed" }, { status: 500 });
  if (recentRes.error) return NextResponse.json({ error: "recent_failed" }, { status: 500 });
  if (frequentRes.error) return NextResponse.json({ error: "frequent_failed" }, { status: 500 });
  if (catalogRes.error) return NextResponse.json({ error: "catalog_failed" }, { status: 500 });

  // Slot-priority re-sort.
  const favMeals = (favMealsRes.data ?? [])
    .slice()
    .sort((a, b) => {
      if (slot) {
        const aMatch = a.meal_slot === slot ? 0 : 1;
        const bMatch = b.meal_slot === slot ? 0 : 1;
        if (aMatch !== bMatch) return aMatch - bMatch;
      }
      return new Date(b.eaten_at).getTime() - new Date(a.eaten_at).getTime();
    })
    .slice(0, section_limit);

  const favItems = (favItemsRes.data ?? [])
    .slice()
    .sort((a, b) => {
      if (slot) {
        const aMatch = a.default_meal_slot === slot ? 0 : 1;
        const bMatch = b.default_meal_slot === slot ? 0 : 1;
        if (aMatch !== bMatch) return aMatch - bMatch;
      }
      if (a.display_order !== b.display_order) return a.display_order - b.display_order;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    })
    .slice(0, section_limit);

  const recent = recentRes.data ?? [];
  const frequent = frequentRes.data ?? [];
  const catalog = hasQ ? (catalogRes.data ?? []) : undefined;

  // Cross-section dedup ONLY when there's a query.
  if (hasQ) {
    const seen = new Set<string>();
    const note = (n: string) => { seen.add(n.toLowerCase()); };
    favMeals.forEach((m) => m.items.forEach((i: { name: string }) => note(i.name)));
    favItems.forEach((i) => note(i.name));
    const recentDeduped = recent.filter((r) => !seen.has(r.name.toLowerCase()));
    recentDeduped.forEach((r) => note(r.name));
    const frequentDeduped = frequent.filter((f) => !seen.has(f.name.toLowerCase()));
    frequentDeduped.forEach((f) => note(f.name));
    const catalogDeduped = (catalog ?? []).filter((c) => !seen.has(c.name.toLowerCase()));
    return NextResponse.json({
      favorite_meals: favMeals,
      favorite_items: favItems,
      recent: recentDeduped,
      frequent: frequentDeduped,
      catalog: catalogDeduped,
    });
  }

  return NextResponse.json({
    favorite_meals: favMeals,
    favorite_items: favItems,
    recent,
    frequent,
  });
}
```

- [ ] **Step 5.2: Write library draft endpoint**

Create `app/api/food/library/draft/route.ts`:

```ts
// app/api/food/library/draft/route.ts
//
// POST → create a draft food_log_entries row from any library source.
// Supports six source_kinds (see spec §"API routes"). Body validates that
// exactly one of {source_id, item, items} is populated.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { macrosForQty, sumMacros, type FoodItem } from "@/lib/food/types";

const MacrosSchema = z.object({
  kcal: z.number().nonnegative(),
  protein_g: z.number().nonnegative(),
  carbs_g: z.number().nonnegative(),
  fat_g: z.number().nonnegative(),
  fiber_g: z.number().nonnegative(),
});

const DbRefSchema = z
  .object({
    source: z.enum(["usda", "openfoodfacts", "manual"]),
    canonical_id: z.string().uuid(),
  })
  .nullable()
  .optional();

const ItemSchema = z.object({
  name: z.string(),
  qty_g: z.number().positive().finite(),
  kcal: z.number().nonnegative(),
  protein_g: z.number().nonnegative(),
  carbs_g: z.number().nonnegative(),
  fat_g: z.number().nonnegative(),
  fiber_g: z.number().nonnegative(),
  per_100g: MacrosSchema,
  source: z.enum(["db", "llm"]),
  db_ref: DbRefSchema,
  confidence: z.enum(["high", "medium", "low"]).nullable().optional(),
});

const BodySchema = z.object({
  source_kind: z.enum(["favorite_meal", "favorite_item", "recent", "frequent", "catalog", "history_picker"]),
  source_id: z.string().uuid().optional(),
  item: ItemSchema.optional(),
  items: z.array(ItemSchema).min(1).optional(),
  source_entry_ids: z.array(z.string().uuid()).optional(),
  meal_slot: z.enum(["breakfast", "lunch", "dinner", "snack"]),
  eaten_at: z.string().datetime().optional(),
  qty_g: z.number().positive().finite().optional(),
});

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const body = parsed.data;
  const provided = [body.source_id, body.item, body.items].filter((v) => v !== undefined).length;
  if (provided !== 1) {
    return NextResponse.json({ error: "exactly_one_of_source_id_item_items_required" }, { status: 400 });
  }

  // Resolve items.
  let items: FoodItem[];
  if (body.source_kind === "favorite_meal") {
    if (!body.source_id) return NextResponse.json({ error: "source_id_required" }, { status: 400 });
    const { data: src } = await supabase
      .from("food_log_entries")
      .select("items")
      .eq("id", body.source_id)
      .eq("user_id", user.id)
      .eq("is_favorite", true)
      .maybeSingle();
    if (!src) return NextResponse.json({ error: "favorite_meal_not_found" }, { status: 404 });
    items = src.items as FoodItem[];
  } else if (body.source_kind === "favorite_item") {
    if (!body.source_id) return NextResponse.json({ error: "source_id_required" }, { status: 400 });
    const { data: fav } = await supabase
      .from("food_item_favorites")
      .select("name, qty_g, per_100g, source, db_ref")
      .eq("id", body.source_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!fav) return NextResponse.json({ error: "favorite_item_not_found" }, { status: 404 });
    const qty = body.qty_g ?? Number(fav.qty_g);
    const macros = macrosForQty(fav.per_100g as FoodMacros, qty);
    items = [{
      name: fav.name,
      qty_g: qty,
      ...macros,
      per_100g: fav.per_100g as FoodMacros,
      source: fav.source as "db" | "llm",
      db_ref: fav.db_ref as FoodItem["db_ref"],
      confidence: "high",
    }];
  } else if (body.source_kind === "catalog") {
    if (!body.source_id) return NextResponse.json({ error: "source_id_required" }, { status: 400 });
    const { data: cache } = await supabase
      .from("food_db_cache")
      .select("canonical_id, source, name, per_100g, serving_size_g")
      .eq("canonical_id", body.source_id)
      .maybeSingle();
    if (!cache) return NextResponse.json({ error: "catalog_row_not_found" }, { status: 404 });
    const qty = body.qty_g ?? Number(cache.serving_size_g ?? 100);
    const macros = macrosForQty(cache.per_100g as FoodMacros, qty);
    items = [{
      name: cache.name,
      qty_g: qty,
      ...macros,
      per_100g: cache.per_100g as FoodMacros,
      source: "db",
      db_ref: {
        source: cache.source as "usda" | "openfoodfacts" | "manual",
        canonical_id: cache.canonical_id,
      },
      confidence: "high",
    }];
  } else if (body.source_kind === "recent" || body.source_kind === "frequent") {
    if (!body.item) return NextResponse.json({ error: "item_required" }, { status: 400 });
    const qty = body.qty_g ?? body.item.qty_g;
    const macros = macrosForQty(body.item.per_100g, qty);
    items = [{
      ...body.item,
      qty_g: qty,
      ...macros,
      confidence: body.item.confidence ?? "high",
      db_ref: body.item.db_ref ?? null,
    } as FoodItem];
  } else { // history_picker
    if (!body.items) return NextResponse.json({ error: "items_required" }, { status: 400 });
    items = body.items.map((i) => ({
      ...i,
      confidence: i.confidence ?? "high",
      db_ref: i.db_ref ?? null,
    } as FoodItem));
  }

  const totals = sumMacros(items);
  const is_estimated = items.some((it) => it.source === "llm");

  const rawInput: Record<string, unknown> = {
    kind: "library",
    source_kind: body.source_kind,
  };
  if (body.source_id) rawInput.source_id = body.source_id;
  if (body.source_entry_ids) rawInput.source_entry_ids = body.source_entry_ids;

  const { data: inserted, error } = await supabase
    .from("food_log_entries")
    .insert({
      user_id: user.id,
      eaten_at: body.eaten_at ?? new Date().toISOString(),
      meal_slot: body.meal_slot,
      kind: "library",
      raw_input: rawInput,
      items,
      totals,
      is_estimated,
      is_favorite: false,
      status: "draft",
    })
    .select("id, eaten_at, meal_slot, kind, items, totals, is_estimated, is_favorite, status")
    .single();
  if (error) {
    console.error("[/api/food/library/draft] insert failed", error);
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  return NextResponse.json({ entry: inserted });
}
```

Note: the import `import type { FoodMacros } from "@/lib/food/types";` is needed inline if not present. Add it to the import list at top of file.

- [ ] **Step 5.3: Typecheck and commit**

```bash
npm run typecheck
git add app/api/food/library
git commit -m "feat(food-log): library sections endpoint + library/draft endpoint"
```

---

## Task 6: History + yesterday-slot endpoints

**Files:**
- Create: `app/api/food/history/route.ts`
- Create: `app/api/food/yesterday-slot/route.ts`

- [ ] **Step 6.1: Write history endpoint**

Create `app/api/food/history/route.ts`:

```ts
// app/api/food/history/route.ts
//
// GET ?from=YYYY-MM-DD&to=YYYY-MM-DD → committed entries grouped by date+slot.
// Server clamps `from` to today-60d. Powers HistoryPickerSheet.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { MealSlot, FoodLogEntry, HistoryDay } from "@/lib/food/types";

const QuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const COLS = "id, user_id, eaten_at, meal_slot, kind, raw_input, items, totals, is_estimated, is_favorite, status, created_at, updated_at";

function utcDate(iso: string): string {
  return iso.slice(0, 10);
}

function clampLowerBound(from: string): string {
  const min = new Date();
  min.setUTCDate(min.getUTCDate() - 60);
  const minIso = min.toISOString().slice(0, 10);
  return from < minIso ? minIso : from;
}

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
  });
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const from = clampLowerBound(parsed.data.from);
  // `to` is inclusive end-of-day; query uses `< (to + 1 day) 00:00Z`.
  const toExclusiveDate = new Date(`${parsed.data.to}T00:00:00Z`);
  toExclusiveDate.setUTCDate(toExclusiveDate.getUTCDate() + 1);
  const toExclusive = `${toExclusiveDate.toISOString().slice(0, 10)}T00:00:00Z`;

  const { data, error } = await supabase
    .from("food_log_entries")
    .select(COLS)
    .eq("user_id", user.id)
    .eq("status", "committed")
    .gte("eaten_at", `${from}T00:00:00Z`)
    .lt("eaten_at", toExclusive)
    .order("eaten_at", { ascending: false });
  if (error) {
    console.error("[/api/food/history] query failed", error);
    return NextResponse.json({ error: "query_failed" }, { status: 500 });
  }

  // Group by UTC date → slot.
  const dayMap = new Map<string, Record<MealSlot, FoodLogEntry[]>>();
  for (const e of (data ?? []) as FoodLogEntry[]) {
    const d = utcDate(e.eaten_at);
    if (!dayMap.has(d)) {
      dayMap.set(d, { breakfast: [], lunch: [], dinner: [], snack: [] });
    }
    dayMap.get(d)![e.meal_slot].push(e);
  }

  const days: HistoryDay[] = [...dayMap.entries()]
    .map(([date, slots]) => ({ date, slots }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  return NextResponse.json({ days });
}
```

- [ ] **Step 6.2: Write yesterday-slot helper endpoint**

Create `app/api/food/yesterday-slot/route.ts`:

```ts
// app/api/food/yesterday-slot/route.ts
//
// GET ?date=YYYY-MM-DD&slot=breakfast → { has_entries, entry_ids? }
// Powers the per-slot "Copy yesterday's <slot>" pill on MealSlotEmptyCard.
// `date` is the CURRENT date; the route looks up entries for the PRIOR day.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const QuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slot: z.enum(["breakfast", "lunch", "dinner", "snack"]),
});

function priorDate(d: string): string {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    date: url.searchParams.get("date"),
    slot: url.searchParams.get("slot"),
  });
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const yesterday = priorDate(parsed.data.date);
  const dayAfter = parsed.data.date;

  const { data, error } = await supabase
    .from("food_log_entries")
    .select("id")
    .eq("user_id", user.id)
    .eq("status", "committed")
    .eq("meal_slot", parsed.data.slot)
    .gte("eaten_at", `${yesterday}T00:00:00Z`)
    .lt("eaten_at", `${dayAfter}T00:00:00Z`);
  if (error) return NextResponse.json({ error: "query_failed" }, { status: 500 });

  const ids = (data ?? []).map((r) => r.id);
  return NextResponse.json({
    has_entries: ids.length > 0,
    entry_ids: ids.length > 0 ? ids : undefined,
  });
}
```

- [ ] **Step 6.3: Typecheck and commit**

```bash
npm run typecheck
git add app/api/food/history app/api/food/yesterday-slot
git commit -m "feat(food-log): history + yesterday-slot endpoints"
```

---

## Task 7: Client cache layer

**Files:**
- Modify: `lib/query/keys.ts`
- Create: `lib/query/fetchers/foodLibrary.ts`
- Create: `lib/query/fetchers/foodItemFavorites.ts`
- Create: `lib/query/fetchers/foodHistory.ts`
- Create: `lib/query/hooks/useFoodLibrary.ts`
- Create: `lib/query/hooks/useFoodItemFavorites.ts`
- Create: `lib/query/hooks/useFoodHistory.ts`

- [ ] **Step 7.1: Add query keys**

In `lib/query/keys.ts`, add to the `queryKeys` object:

```ts
foodLibrary: {
  all: (userId: string) => ["food-library", userId] as const,
  sections: (userId: string, slot: string | null, q: string) =>
    ["food-library", userId, "sections", slot ?? "no-slot", q] as const,
},
foodItemFavorites: {
  all: (userId: string) => ["food-item-favorites", userId] as const,
},
foodHistory: {
  all: (userId: string) => ["food-history", userId] as const,
  range: (userId: string, from: string, to: string) =>
    ["food-history", userId, "range", from, to] as const,
},
```

- [ ] **Step 7.2: Write fetchers**

Create `lib/query/fetchers/foodLibrary.ts`:

```ts
// lib/query/fetchers/foodLibrary.ts
import type { FoodLibrarySections } from "@/lib/food/types";

export async function fetchFoodLibraryBrowser(
  slot: string | null,
  q: string,
): Promise<FoodLibrarySections> {
  const params = new URLSearchParams();
  if (slot) params.set("slot", slot);
  if (q) params.set("q", q);
  const res = await fetch(`/api/food/library?${params}`);
  if (!res.ok) throw new Error(`food-library ${res.status}`);
  const json = await res.json();
  return json as FoodLibrarySections;
}
```

Create `lib/query/fetchers/foodItemFavorites.ts`:

```ts
// lib/query/fetchers/foodItemFavorites.ts
import type { FoodItemFavorite } from "@/lib/food/types";

export async function fetchFoodItemFavoritesBrowser(): Promise<FoodItemFavorite[]> {
  const res = await fetch("/api/food/item-favorites");
  if (!res.ok) throw new Error(`food-item-favorites ${res.status}`);
  const json = (await res.json()) as { favorites: FoodItemFavorite[] };
  return json.favorites;
}
```

Create `lib/query/fetchers/foodHistory.ts`:

```ts
// lib/query/fetchers/foodHistory.ts
import type { HistoryDay } from "@/lib/food/types";

export async function fetchFoodHistoryBrowser(
  from: string,
  to: string,
): Promise<HistoryDay[]> {
  const res = await fetch(`/api/food/history?from=${from}&to=${to}`);
  if (!res.ok) throw new Error(`food-history ${res.status}`);
  const json = (await res.json()) as { days: HistoryDay[] };
  return json.days;
}
```

- [ ] **Step 7.3: Write hooks**

Create `lib/query/hooks/useFoodLibrary.ts`:

```ts
// lib/query/hooks/useFoodLibrary.ts
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchFoodLibraryBrowser } from "@/lib/query/fetchers/foodLibrary";

export function useFoodLibrary(userId: string, slot: string | null, q: string) {
  return useQuery({
    queryKey: queryKeys.foodLibrary.sections(userId, slot, q),
    queryFn: () => fetchFoodLibraryBrowser(slot, q),
    enabled: !!userId,
    staleTime: 30_000,
  });
}
```

Create `lib/query/hooks/useFoodItemFavorites.ts`:

```ts
// lib/query/hooks/useFoodItemFavorites.ts
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchFoodItemFavoritesBrowser } from "@/lib/query/fetchers/foodItemFavorites";

export function useFoodItemFavorites(userId: string) {
  return useQuery({
    queryKey: queryKeys.foodItemFavorites.all(userId),
    queryFn: fetchFoodItemFavoritesBrowser,
    enabled: !!userId,
  });
}
```

Create `lib/query/hooks/useFoodHistory.ts`:

```ts
// lib/query/hooks/useFoodHistory.ts
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchFoodHistoryBrowser } from "@/lib/query/fetchers/foodHistory";

export function useFoodHistory(userId: string, from: string, to: string) {
  return useQuery({
    queryKey: queryKeys.foodHistory.range(userId, from, to),
    queryFn: () => fetchFoodHistoryBrowser(from, to),
    enabled: !!userId && !!from && !!to,
  });
}
```

- [ ] **Step 7.4: Typecheck and commit**

```bash
npm run typecheck
git add lib/query/keys.ts lib/query/fetchers/foodLibrary.ts lib/query/fetchers/foodItemFavorites.ts lib/query/fetchers/foodHistory.ts lib/query/hooks/useFoodLibrary.ts lib/query/hooks/useFoodItemFavorites.ts lib/query/hooks/useFoodHistory.ts
git commit -m "feat(food-log): client cache — library, item-favorites, history fetchers + hooks"
```

---

## Task 8: Library tab UI

**Files:**
- Create: `components/log/LibraryRow.tsx`
- Create: `components/log/LibrarySection.tsx`
- Create: `components/log/MealLoggerLibraryTab.tsx`
- Modify: `components/log/MealLoggerSheet.tsx`

- [ ] **Step 8.1: Write LibraryRow**

Create `components/log/LibraryRow.tsx`:

```tsx
"use client";

import { fmtNum } from "@/lib/ui/score";
import type { FoodMacros } from "@/lib/food/types";

export type LibraryRowProps = {
  label: string;
  subLabel?: string;
  qty_g?: number;
  macros?: FoodMacros;
  sourceChip?: "usda" | "off" | null;
  onTap: () => void;
  starred?: boolean;
  onStar?: () => void;
};

export function LibraryRow({
  label,
  subLabel,
  qty_g,
  macros,
  sourceChip,
  onTap,
  starred,
  onStar,
}: LibraryRowProps) {
  return (
    <div className="flex items-center gap-2 border-b border-zinc-900 p-3 last:border-b-0">
      <button
        type="button"
        onClick={onTap}
        className="flex-1 text-left"
      >
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-medium text-zinc-100">{label}</span>
          {sourceChip && (
            <span className="ml-2 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400 border border-zinc-800">
              {sourceChip}
            </span>
          )}
        </div>
        {(subLabel || (qty_g !== undefined && macros)) && (
          <div className="text-xs text-zinc-500">
            {qty_g !== undefined && macros && (
              <>
                {fmtNum(qty_g)} g · {fmtNum(macros.kcal)} kcal · {fmtNum(macros.protein_g)} P · {fmtNum(macros.carbs_g)} C · {fmtNum(macros.fat_g)} F
              </>
            )}
            {subLabel && <span className="ml-2">{subLabel}</span>}
          </div>
        )}
      </button>
      {onStar && (
        <button
          type="button"
          onClick={onStar}
          aria-label={starred ? "Unfavorite" : "Favorite"}
          className="px-2 text-lg"
        >
          {starred ? "★" : "☆"}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 8.2: Write LibrarySection**

Create `components/log/LibrarySection.tsx`:

```tsx
"use client";

import type { ReactNode } from "react";

export function LibrarySection({
  title,
  count,
  children,
  empty,
}: {
  title: string;
  count?: number;
  children: ReactNode;
  empty?: string;
}) {
  return (
    <section className="rounded-lg border border-zinc-800">
      <header className="border-b border-zinc-900 px-3 py-2 text-xs uppercase tracking-wider text-zinc-400">
        {title}
        {typeof count === "number" && count > 0 && (
          <span className="ml-2 text-zinc-500">{count}</span>
        )}
      </header>
      {count === 0 && empty ? (
        <div className="px-3 py-4 text-xs text-zinc-500">{empty}</div>
      ) : (
        children
      )}
    </section>
  );
}
```

- [ ] **Step 8.3: Write MealLoggerLibraryTab**

Create `components/log/MealLoggerLibraryTab.tsx`:

```tsx
"use client";

import { useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useDebouncedValue } from "@/lib/ui/use-debounced-value";
import { LibraryRow } from "./LibraryRow";
import { LibrarySection } from "./LibrarySection";
import type { FoodLogEntry, FoodMacros, MealSlot } from "@/lib/food/types";
import { useFoodLibrary } from "@/lib/query/hooks/useFoodLibrary";
import { queryKeys } from "@/lib/query/keys";

export function MealLoggerLibraryTab({
  userId,
  mealSlot,
  eatenAt,
  onCommitted,
  onOpenHistoryPicker,
}: {
  userId: string;
  mealSlot: MealSlot;
  eatenAt: string;
  onCommitted: () => void;
  onOpenHistoryPicker: () => void;
}) {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);
  const { data, isLoading } = useFoodLibrary(userId, mealSlot, debouncedQuery);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lowerQ = debouncedQuery.toLowerCase().trim();
  const filterRow = (name: string) =>
    !lowerQ || name.toLowerCase().includes(lowerQ);

  const tapLibraryDraft = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/food/library/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ meal_slot: mealSlot, eaten_at: eatenAt, ...body }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({ error: "draft_failed" }));
        throw new Error(json.error || "draft_failed");
      }
      // Commit immediately. (No qty-adjust preview for v1 — user can edit after via TodaysMeals/MealSlotCard.)
      const { entry } = await res.json();
      const commitRes = await fetch("/api/food/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entry_id: entry.id }),
      });
      if (!commitRes.ok) {
        const json = await commitRes.json().catch(() => ({ error: "commit_failed" }));
        throw new Error(json.error || "commit_failed");
      }
      onCommitted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const filteredFavMeals = useMemo(
    () => (data?.favorite_meals ?? []).filter((m) =>
      m.items.some((i: { name: string }) => filterRow(i.name)),
    ),
    [data, lowerQ],
  );
  const filteredFavItems = useMemo(
    () => (data?.favorite_items ?? []).filter((i) => filterRow(i.name)),
    [data, lowerQ],
  );
  const filteredRecent = useMemo(
    () => (data?.recent ?? []).filter((r) => filterRow(r.name)),
    [data, lowerQ],
  );
  const filteredFrequent = useMemo(
    () => (data?.frequent ?? []).filter((f) => filterRow(f.name)),
    [data, lowerQ],
  );
  const catalog = data?.catalog ?? [];

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onOpenHistoryPicker}
        className="w-full rounded-md border border-zinc-700 py-2 text-sm text-zinc-100"
      >
        📚 Pick from history
      </button>

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search foods, meals…"
        className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-100 placeholder:text-zinc-500"
      />

      {error && <p className="text-xs text-red-400">{error}</p>}
      {isLoading && <p className="text-xs text-zinc-500">Loading…</p>}

      <LibrarySection title="★ Favorites" count={filteredFavMeals.length + filteredFavItems.length} empty="No favorites yet — star a meal or food.">
        {filteredFavMeals.map((m: FoodLogEntry) => (
          <LibraryRow
            key={`meal-${m.id}`}
            label={m.items.map((i: { name: string }) => i.name).join(", ")}
            subLabel={`meal · ${m.meal_slot}`}
            macros={m.totals}
            onTap={() => tapLibraryDraft({ source_kind: "favorite_meal", source_id: m.id })}
          />
        ))}
        {filteredFavItems.map((i) => (
          <LibraryRow
            key={`item-${i.id}`}
            label={i.name}
            qty_g={Number(i.qty_g)}
            macros={i.per_100g as unknown as FoodMacros}
            onTap={() => tapLibraryDraft({ source_kind: "favorite_item", source_id: i.id })}
          />
        ))}
      </LibrarySection>

      <LibrarySection title="🕓 Recent (last 30 days)" count={filteredRecent.length} empty="No recent items.">
        {filteredRecent.map((r) => (
          <LibraryRow
            key={`recent-${r.name}`}
            label={r.name}
            qty_g={Number(r.qty_g)}
            macros={r.per_100g as unknown as FoodMacros}
            onTap={() => tapLibraryDraft({
              source_kind: "recent",
              item: { ...r, kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
            })}
          />
        ))}
      </LibrarySection>

      <LibrarySection title="📊 Frequent (last 30 days)" count={filteredFrequent.length} empty="Eat more meals to see frequent items.">
        {filteredFrequent.map((f) => (
          <LibraryRow
            key={`freq-${f.name}`}
            label={`${f.name} (×${f.occurrence_count})`}
            qty_g={Number(f.qty_g)}
            macros={f.per_100g as unknown as FoodMacros}
            onTap={() => tapLibraryDraft({
              source_kind: "frequent",
              item: { ...f, name: f.name, kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
            })}
          />
        ))}
      </LibrarySection>

      {debouncedQuery.length > 0 && (
        <LibrarySection title="📚 Catalog" count={catalog.length} empty="No catalog matches.">
          {catalog.map((c) => (
            <LibraryRow
              key={`cat-${c.canonical_id}`}
              label={c.name}
              sourceChip={c.source === "openfoodfacts" ? "off" : c.source === "usda" ? "usda" : null}
              macros={c.per_100g as unknown as FoodMacros}
              onTap={() => tapLibraryDraft({ source_kind: "catalog", source_id: c.canonical_id })}
            />
          ))}
        </LibrarySection>
      )}
    </div>
  );
}
```

Note on the `kcal: 0, protein_g: 0...` defaults: the `recent` and `frequent` sources POST the FoodItem shape; the server scales macros from per_100g via `macrosForQty`. The client doesn't need to send pre-computed macros — the server overrides them based on qty_g. The zeros are placeholders that the server immediately overwrites.

- [ ] **Step 8.4: Write the debounce hook**

Create `lib/ui/use-debounced-value.ts`:

```ts
// lib/ui/use-debounced-value.ts
import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
```

- [ ] **Step 8.5: Wire Library tab into MealLoggerSheet**

In `components/log/MealLoggerSheet.tsx`, find the tab array `["type", "scan", "photo", "voice"]` and add `"library"` between `scan` and `photo`. Update the `Tab` type union. Add the tab content case for `"library"`:

```tsx
import { MealLoggerLibraryTab } from "./MealLoggerLibraryTab";

// ...inside the component, hook up the userId prop. Add to component signature:
export function MealLoggerSheet({
  open,
  onClose,
  initialMealSlot,
  initialEatenAt,
  userId,  // ADD THIS
}: {
  open: boolean;
  onClose: () => void;
  initialMealSlot?: MealSlot;
  initialEatenAt?: string;
  userId: string;  // ADD THIS
}) {
  // ... existing state ...
  const [historyPickerOpen, setHistoryPickerOpen] = useState(false);  // ADD — for Task 9 wiring

  // Update tab union type:
  type Tab = "type" | "scan" | "library" | "photo" | "voice";

  // Update tab array in render:
  {(["type", "scan", "library", "photo", "voice"] as const).map((t) => (...))}

  // Add tab content:
  {tab === "library" && (
    <MealLoggerLibraryTab
      userId={userId}
      mealSlot={mealSlot}
      eatenAt={eatenAt}
      onCommitted={onCommitted}
      onOpenHistoryPicker={() => setHistoryPickerOpen(true)}
    />
  )}
}
```

Existing callers of MealLoggerSheet (search `<MealLoggerSheet`) must now pass `userId`. The two known call sites:
- `app/meal/MealJournalClient.tsx`
- `app/metrics/MetricsShell.tsx`

Both already have `userId` (or can derive it via `useUser()`). Add `userId={userId}` to each call.

The `historyPickerOpen` state and the `<HistoryPickerSheet>` mount are wired in Task 9.

- [ ] **Step 8.6: Typecheck and exercise**

```bash
npm run typecheck
```

Then `npm run dev`, open the meal logger, switch to Library tab. Verify: search bar renders, sections render (most will be empty for a fresh user), tap on a recent item commits a draft.

- [ ] **Step 8.7: Commit**

```bash
git add components/log/LibraryRow.tsx components/log/LibrarySection.tsx components/log/MealLoggerLibraryTab.tsx components/log/MealLoggerSheet.tsx lib/ui/use-debounced-value.ts app/meal/MealJournalClient.tsx app/metrics/MetricsShell.tsx
git commit -m "feat(food-log): Library tab in MealLoggerSheet with search + 4 sections"
```

---

## Task 9: HistoryPickerSheet

**Files:**
- Create: `components/log/HistoryPickerSheet.tsx`
- Create: `components/log/HistoryPickerDateBar.tsx`
- Create: `components/log/HistoryPickerBucket.tsx`
- Create: `components/log/HistoryPickerSlotCard.tsx`
- Modify: `components/log/MealLoggerSheet.tsx` (mount HistoryPickerSheet)

- [ ] **Step 9.1: Write HistoryPickerDateBar**

Create `components/log/HistoryPickerDateBar.tsx`:

```tsx
"use client";

export function HistoryPickerDateBar({
  date,
  onChange,
  minDate,
  maxDate,
}: {
  date: string;
  onChange: (date: string) => void;
  minDate: string;
  maxDate: string;
}) {
  const dt = new Date(`${date}T00:00:00Z`);
  const prev = new Date(dt);
  prev.setUTCDate(prev.getUTCDate() - 1);
  const next = new Date(dt);
  next.setUTCDate(next.getUTCDate() + 1);
  const prevIso = prev.toISOString().slice(0, 10);
  const nextIso = next.toISOString().slice(0, 10);

  const canGoBack = prevIso >= minDate;
  const canGoForward = nextIso <= maxDate;

  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
      <button
        type="button"
        onClick={() => canGoBack && onChange(prevIso)}
        disabled={!canGoBack}
        className="px-3 py-1 text-sm text-zinc-100 disabled:opacity-30"
      >
        ◀
      </button>
      <input
        type="date"
        value={date}
        min={minDate}
        max={maxDate}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1 text-sm text-zinc-100"
      />
      <button
        type="button"
        onClick={() => canGoForward && onChange(nextIso)}
        disabled={!canGoForward}
        className="px-3 py-1 text-sm text-zinc-100 disabled:opacity-30"
      >
        ▶
      </button>
    </div>
  );
}
```

- [ ] **Step 9.2: Write HistoryPickerBucket**

Create `components/log/HistoryPickerBucket.tsx`:

```tsx
"use client";

import { MEAL_SLOTS, mealSlotLabel } from "@/lib/food/meal-slot";
import { fmtNum } from "@/lib/ui/score";
import type { FoodItem, MealSlot } from "@/lib/food/types";

export type SelectedItem = {
  item: FoodItem;
  source_entry_id: string;
  source_date: string;
};

export function HistoryPickerBucket({
  selected,
  destinationSlot,
  onChangeDestination,
  onRemove,
  onClearAll,
}: {
  selected: SelectedItem[];
  destinationSlot: MealSlot;
  onChangeDestination: (slot: MealSlot) => void;
  onRemove: (idx: number) => void;
  onClearAll: () => void;
}) {
  if (selected.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-zinc-500 border-b border-zinc-800">
        Tap items below to add them. Selected items will appear here.
      </div>
    );
  }
  return (
    <div className="border-b border-zinc-800 px-3 py-2">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wider text-zinc-400">
          Selected ({selected.length}) — Add to:
        </div>
        <select
          value={destinationSlot}
          onChange={(e) => onChangeDestination(e.target.value as MealSlot)}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100"
        >
          {MEAL_SLOTS.map((s) => (
            <option key={s} value={s}>{mealSlotLabel(s)}</option>
          ))}
        </select>
      </div>
      <ul className="mt-2 space-y-1">
        {selected.map((s, idx) => (
          <li key={`${s.source_entry_id}-${idx}`} className="flex items-center justify-between text-xs text-zinc-300">
            <span>
              {s.item.name} {fmtNum(s.item.qty_g)}g
              <span className="ml-2 text-zinc-500">· {s.source_date}</span>
            </span>
            <button type="button" onClick={() => onRemove(idx)} aria-label="Remove" className="px-2">×</button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={onClearAll} className="mt-1 text-xs text-zinc-500 underline">Clear all</button>
    </div>
  );
}
```

- [ ] **Step 9.3: Write HistoryPickerSlotCard**

Create `components/log/HistoryPickerSlotCard.tsx`:

```tsx
"use client";

import { mealSlotLabel } from "@/lib/food/meal-slot";
import { fmtNum } from "@/lib/ui/score";
import type { FoodItem, FoodLogEntry, MealSlot } from "@/lib/food/types";

type ItemKey = string; // `${entry.id}::${itemIdx}`

export function HistoryPickerSlotCard({
  date,
  slot,
  entries,
  selectedKeys,
  onToggleItem,
  onSelectAllInSlot,
}: {
  date: string;
  slot: MealSlot;
  entries: FoodLogEntry[];
  selectedKeys: Set<ItemKey>;
  onToggleItem: (entry: FoodLogEntry, itemIdx: number) => void;
  onSelectAllInSlot: (entries: FoodLogEntry[]) => void;
}) {
  if (entries.length === 0) return null;
  const totalItems = entries.reduce((a, e) => a + e.items.length, 0);

  return (
    <section className="rounded-lg border border-zinc-800">
      <header className="flex items-center justify-between border-b border-zinc-900 px-3 py-2">
        <div className="text-xs uppercase tracking-wider text-zinc-400">
          {date} — {mealSlotLabel(slot)} ({totalItems} {totalItems === 1 ? "item" : "items"})
        </div>
        <button
          type="button"
          onClick={() => onSelectAllInSlot(entries)}
          className="text-xs text-zinc-100 underline"
        >
          Select all
        </button>
      </header>
      <ul>
        {entries.flatMap((e) =>
          e.items.map((it: FoodItem, idx: number) => {
            const key: ItemKey = `${e.id}::${idx}`;
            const checked = selectedKeys.has(key);
            return (
              <li key={key} className="flex items-center gap-2 border-b border-zinc-900 px-3 py-2 last:border-b-0">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleItem(e, idx)}
                  className="h-4 w-4"
                />
                <div className="flex-1 text-xs text-zinc-300">
                  <div className="font-medium text-zinc-100">{it.name}</div>
                  <div className="text-zinc-500">
                    {fmtNum(it.qty_g)}g · {fmtNum(it.kcal)} kcal · {fmtNum(it.protein_g)}P · {fmtNum(it.carbs_g)}C · {fmtNum(it.fat_g)}F
                  </div>
                </div>
              </li>
            );
          }),
        )}
      </ul>
    </section>
  );
}
```

- [ ] **Step 9.4: Write HistoryPickerSheet (orchestrator)**

Create `components/log/HistoryPickerSheet.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { MEAL_SLOTS } from "@/lib/food/meal-slot";
import { HistoryPickerDateBar } from "./HistoryPickerDateBar";
import { HistoryPickerBucket, type SelectedItem } from "./HistoryPickerBucket";
import { HistoryPickerSlotCard } from "./HistoryPickerSlotCard";
import { useFoodHistory } from "@/lib/query/hooks/useFoodHistory";
import { todayInUserTz } from "@/lib/time";
import type { FoodLogEntry, MealSlot } from "@/lib/food/types";

function offsetDate(iso: string, deltaDays: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

export function HistoryPickerSheet({
  open,
  onClose,
  userId,
  initialDestinationSlot,
  initialEatenAt,
  onCommitted,
}: {
  open: boolean;
  onClose: () => void;
  userId: string;
  initialDestinationSlot: MealSlot;
  initialEatenAt: string;
  onCommitted: () => void;
}) {
  const today = todayInUserTz();
  const minDate = offsetDate(today, -60);

  const [date, setDate] = useState(offsetDate(today, -1)); // yesterday by default
  const [selected, setSelected] = useState<SelectedItem[]>([]);
  const [destinationSlot, setDestinationSlot] = useState<MealSlot>(initialDestinationSlot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch a single day's worth of entries.
  const { data: days = [], isLoading } = useFoodHistory(userId, date, date);
  const dayData = days[0];

  // Build the checked-checkbox set by (entry.id, itemIdx). An item is checked
  // if ANY bucket entry matches its (entry_id, name, qty_g). Adding the same
  // item twice keeps the checkbox checked once; unchecking removes from the
  // bucket entirely. This matches the user mental model: "I picked this item."
  const checkedSet = new Set<string>();
  for (const day of days) {
    for (const slot of MEAL_SLOTS) {
      day.slots[slot].forEach((entry) => {
        entry.items.forEach((item, idx) => {
          const inBucket = selected.some(
            (s) =>
              s.source_entry_id === entry.id &&
              s.item.name === item.name &&
              s.item.qty_g === item.qty_g,
          );
          if (inBucket) checkedSet.add(`${entry.id}::${idx}`);
        });
      });
    }
  }

  const toggleItem = (entry: FoodLogEntry, itemIdx: number) => {
    const item = entry.items[itemIdx];
    const matches = (s: SelectedItem) =>
      s.source_entry_id === entry.id && s.item.name === item.name && s.item.qty_g === item.qty_g;
    const isInBucket = selected.some(matches);
    if (isInBucket) {
      // Remove ALL matching bucket entries so the checkbox always reflects state.
      setSelected((prev) => prev.filter((s) => !matches(s)));
    } else {
      setSelected((prev) => [
        ...prev,
        { item, source_entry_id: entry.id, source_date: date },
      ]);
    }
  };

  const selectAllInSlot = (entries: FoodLogEntry[]) => {
    setSelected((prev) => {
      const next = [...prev];
      for (const entry of entries) {
        for (const item of entry.items) {
          const exists = next.some(
            (s) => s.source_entry_id === entry.id && s.item.name === item.name && s.item.qty_g === item.qty_g,
          );
          if (!exists) {
            next.push({ item, source_entry_id: entry.id, source_date: date });
          }
        }
      }
      return next;
    });
  };

  const removeFromBucket = (idx: number) => {
    setSelected((prev) => prev.filter((_, i) => i !== idx));
  };

  const clearAll = () => setSelected([]);

  const qc = useQueryClient();

  const commit = async () => {
    if (selected.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const draftRes = await fetch("/api/food/library/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source_kind: "history_picker",
          items: selected.map((s) => s.item),
          source_entry_ids: [...new Set(selected.map((s) => s.source_entry_id))],
          meal_slot: destinationSlot,
          eaten_at: initialEatenAt,
        }),
      });
      if (!draftRes.ok) {
        const json = await draftRes.json().catch(() => ({ error: "draft_failed" }));
        throw new Error(json.error || "draft_failed");
      }
      const { entry } = await draftRes.json();
      const commitRes = await fetch("/api/food/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entry_id: entry.id }),
      });
      if (!commitRes.ok) {
        const json = await commitRes.json().catch(() => ({ error: "commit_failed" }));
        throw new Error(json.error || "commit_failed");
      }
      clearAll();
      onCommitted();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet open={open} onClose={onClose} title="Pick items from history">
      <HistoryPickerDateBar
        date={date}
        onChange={setDate}
        minDate={minDate}
        maxDate={today}
      />
      <HistoryPickerBucket
        selected={selected}
        destinationSlot={destinationSlot}
        onChangeDestination={setDestinationSlot}
        onRemove={removeFromBucket}
        onClearAll={clearAll}
      />
      <div className="space-y-3 p-3">
        {isLoading && <p className="text-xs text-zinc-500">Loading…</p>}
        {!isLoading && !dayData && (
          <p className="text-xs text-zinc-500">No entries logged on {date}.</p>
        )}
        {dayData && MEAL_SLOTS.map((slot) => (
          <HistoryPickerSlotCard
            key={slot}
            date={dayData.date}
            slot={slot}
            entries={dayData.slots[slot]}
            selectedKeys={checkedSet}
            onToggleItem={toggleItem}
            onSelectAllInSlot={selectAllInSlot}
          />
        ))}
      </div>
      {error && <p className="px-3 pb-2 text-xs text-red-400">{error}</p>}
      <div className="sticky bottom-0 border-t border-zinc-800 bg-zinc-950 p-3">
        <button
          type="button"
          onClick={commit}
          disabled={busy || selected.length === 0}
          className="w-full rounded-md bg-zinc-100 py-2 text-sm text-zinc-900 disabled:opacity-50"
        >
          {busy ? "…" : `Add ${selected.length} item${selected.length === 1 ? "" : "s"} to ${destinationSlot}`}
        </button>
      </div>
    </BottomSheet>
  );
}
```

Note: the `checkedSet` build above is the single source of truth for which checkboxes are checked. The helper functions `toggleItem`, `selectAllInSlot`, `removeFromBucket`, `clearAll` mutate the `selected` bucket which the next render re-derives `checkedSet` from. Bucket can contain duplicates of the same (entry, item) — toggling the checkbox removes ALL bucket entries that match.

- [ ] **Step 9.5: Mount HistoryPickerSheet in MealLoggerSheet**

In `components/log/MealLoggerSheet.tsx`, add the import and the mount:

```tsx
import { HistoryPickerSheet } from "./HistoryPickerSheet";

// Inside the component, after the BottomSheet closes, add:
<HistoryPickerSheet
  open={historyPickerOpen}
  onClose={() => setHistoryPickerOpen(false)}
  userId={userId}
  initialDestinationSlot={mealSlot}
  initialEatenAt={eatenAt}
  onCommitted={onCommitted}
/>
```

Place this sibling to (not inside) the existing `<BottomSheet>` — both sheets can mount simultaneously.

- [ ] **Step 9.6: Typecheck and exercise**

```bash
npm run typecheck
npm run dev
```

Open the meal logger → Library tab → "Pick from history" button → date scrubber → check items → "Add N items" → verify the entry shows up in /meal and /metrics?sub=log.

- [ ] **Step 9.7: Commit**

```bash
git add components/log/HistoryPickerSheet.tsx components/log/HistoryPickerDateBar.tsx components/log/HistoryPickerBucket.tsx components/log/HistoryPickerSlotCard.tsx components/log/MealLoggerSheet.tsx
git commit -m "feat(food-log): HistoryPickerSheet for multi-source meal assembly"
```

---

## Task 10: MealSlotEmptyCard pills + standalone HistoryPickerSheet entry point

**Files:**
- Modify: `components/meal/MealSlotEmptyCard.tsx`

- [ ] **Step 10.1: Read existing component**

Read `components/meal/MealSlotEmptyCard.tsx` to see the current structure (the "+ Log breakfast" button etc.). The pills go above that button.

- [ ] **Step 10.2: Add Copy yesterday + Pick from history pills**

Modify `components/meal/MealSlotEmptyCard.tsx` to accept new props and render two pills:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { mealSlotLabel } from "@/lib/food/meal-slot";
import type { MealSlot } from "@/lib/food/types";

export function MealSlotEmptyCard({
  slot,
  date,
  onLog,
  onPickFromHistory,
}: {
  slot: MealSlot;
  date: string;             // today's date in user TZ
  onLog: () => void;
  onPickFromHistory: () => void;
}) {
  const [yesterdayIds, setYesterdayIds] = useState<string[] | null>(null);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  // Probe yesterday-slot endpoint on mount.
  useEffect(() => {
    fetch(`/api/food/yesterday-slot?date=${date}&slot=${slot}`)
      .then((r) => r.ok ? r.json() : null)
      .then((json) => {
        if (json?.has_entries) setYesterdayIds(json.entry_ids);
      })
      .catch(() => { /* silent */ });
  }, [date, slot]);

  const copyYesterday = async () => {
    if (!yesterdayIds || yesterdayIds.length === 0) return;
    setBusy(true);
    try {
      // Copy each yesterday entry → commit. Parallel.
      await Promise.all(
        yesterdayIds.map(async (id) => {
          const draftRes = await fetch(`/api/food/entries/${id}/copy`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ meal_slot: slot }),
          });
          if (!draftRes.ok) throw new Error("copy_failed");
          const { entry } = await draftRes.json();
          const commitRes = await fetch("/api/food/commit", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ entry_id: entry.id }),
          });
          if (!commitRes.ok) throw new Error("commit_failed");
        }),
      );
      await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "food-entries" });
      await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "daily-logs" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-dashed border-zinc-800 p-3">
      <header className="text-sm font-semibold text-zinc-300">{mealSlotLabel(slot)}</header>
      <p className="text-xs text-zinc-500">No entries logged.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {yesterdayIds && yesterdayIds.length > 0 && (
          <button
            type="button"
            onClick={copyYesterday}
            disabled={busy}
            className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-100 disabled:opacity-50"
          >
            📋 Copy yesterday's {mealSlotLabel(slot).toLowerCase()} ({yesterdayIds.length} {yesterdayIds.length === 1 ? "item" : "items"})
          </button>
        )}
        <button
          type="button"
          onClick={onPickFromHistory}
          className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-100"
        >
          📚 Pick from history
        </button>
      </div>
      <button
        type="button"
        onClick={onLog}
        className="mt-3 w-full rounded-md bg-zinc-100 py-2 text-sm text-zinc-900"
      >
        + Log {mealSlotLabel(slot).toLowerCase()}
      </button>
    </section>
  );
}
```

The existing call site (likely `app/meal/MealJournalClient.tsx`) needs to pass the new `date` and `onPickFromHistory` props. The MealJournalClient should also mount its own `<HistoryPickerSheet>` (separate from MealLoggerSheet's mount) so the "Pick from history" pill opens a sheet without first opening the meal logger.

In `app/meal/MealJournalClient.tsx`, add:

```tsx
const [historyPickerOpen, setHistoryPickerOpen] = useState<MealSlot | null>(null);

// Wire it through to MealSlotEmptyCard:
<MealSlotEmptyCard
  slot={s}
  date={date}
  onLog={() => setLoggerOpen(s)}
  onPickFromHistory={() => setHistoryPickerOpen(s)}
/>

// Mount the sheet:
{historyPickerOpen && (
  <HistoryPickerSheet
    open={true}
    onClose={() => setHistoryPickerOpen(null)}
    userId={userId}
    initialDestinationSlot={historyPickerOpen}
    initialEatenAt={initialEatenAtForLogger()}
    onCommitted={() => setHistoryPickerOpen(null)}
  />
)}
```

- [ ] **Step 10.3: Typecheck, exercise, commit**

```bash
npm run typecheck
```

Exercise: open `/meal`, scroll to an empty slot (e.g., today's lunch), verify two pills render (one only if yesterday had entries). Tap "Copy yesterday" → verify entry appears. Tap "Pick from history" → verify sheet opens.

```bash
git add components/meal/MealSlotEmptyCard.tsx app/meal/MealJournalClient.tsx
git commit -m "feat(food-log): two pills on MealSlotEmptyCard — Copy yesterday + Pick from history"
```

---

## Task 11: Entry-row affordances (☆ + 📋) on TodaysMeals + MealSlotCard

**Files:**
- Modify: `components/log/TodaysMeals.tsx`
- Modify: `components/meal/MealSlotCard.tsx`

- [ ] **Step 11.1: Add star + copy buttons to TodaysMeals row**

Read `components/log/TodaysMeals.tsx`. Each entry row currently has edit/delete affordances. Add ☆ and 📋:

```tsx
// At the top, add imports:
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

// In the row rendering, alongside existing edit/delete buttons:
<button
  type="button"
  aria-label={entry.is_favorite ? "Unfavorite" : "Favorite"}
  onClick={async (e) => {
    e.stopPropagation();
    const next = !entry.is_favorite;
    // Optimistic update via TanStack mutation pattern; for simplicity here, invalidate after.
    const res = await fetch(`/api/food/entries/${entry.id}/favorite`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: next }),
    });
    if (res.ok) {
      await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "food-entries" });
      await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "food-library" });
    }
  }}
  className="text-lg"
>
  {entry.is_favorite ? "★" : "☆"}
</button>
<button
  type="button"
  aria-label="Copy to today"
  onClick={async (e) => {
    e.stopPropagation();
    const draftRes = await fetch(`/api/food/entries/${entry.id}/copy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!draftRes.ok) return;
    const { entry: draft } = await draftRes.json();
    const commitRes = await fetch("/api/food/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entry_id: draft.id }),
    });
    if (commitRes.ok) {
      await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "food-entries" });
      await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "daily-logs" });
    }
  }}
  className="text-base"
>
  📋
</button>
```

Adapt the exact placement to match the existing row layout — the goal is to render `☆ 📋 ✎ 🗑` in a horizontal row at the right side of each entry row.

The `qc` variable comes from `const qc = useQueryClient();` declared at the top of the component.

- [ ] **Step 11.2: Add star + copy buttons to MealSlotCard entry rows**

Apply the same pattern to `components/meal/MealSlotCard.tsx`. The `entries` prop already exists; each entry row inside the slot card gets the same two buttons.

- [ ] **Step 11.3: Typecheck, exercise, commit**

```bash
npm run typecheck
```

Exercise: on `/meal`, tap ☆ on a meal — refresh, verify it has star filled. Then verify the same meal shows up in the Library tab's Favorites section. Tap 📋 — verify a fresh copy is created with today's date and same slot.

```bash
git add components/log/TodaysMeals.tsx components/meal/MealSlotCard.tsx
git commit -m "feat(food-log): ☆ favorite + 📋 copy-to-today affordances on entry rows"
```

---

## Task 12: Per-item ☆ in preview/edit sheets

**Files:**
- Modify: `components/log/FoodEntryEditSheet.tsx`
- Modify: `components/log/MealLoggerTypeTab.tsx`

- [ ] **Step 12.1: Add per-item star in FoodEntryEditSheet**

In `components/log/FoodEntryEditSheet.tsx`, locate the per-item rendering (the `items.map((it, idx) => ...)` block). Add a small star button next to the item name that toggles a favorite via the `/api/food/item-favorites` endpoint:

```tsx
import { useFoodItemFavorites } from "@/lib/query/hooks/useFoodItemFavorites";

// At top of component:
const { data: itemFavorites = [] } = useFoodItemFavorites(userId);
const isItemFavorite = (name: string) =>
  itemFavorites.some((f) => f.name.toLowerCase() === name.toLowerCase());

// Inside the item row rendering:
<button
  type="button"
  aria-label={isItemFavorite(it.name) ? "Unfavorite item" : "Favorite item"}
  onClick={async () => {
    const starred = isItemFavorite(it.name);
    if (starred) {
      const fav = itemFavorites.find((f) => f.name.toLowerCase() === it.name.toLowerCase());
      if (!fav) return;
      await fetch(`/api/food/item-favorites/${fav.id}`, { method: "DELETE" });
    } else {
      await fetch("/api/food/item-favorites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: it.name,
          qty_g: it.qty_g,
          per_100g: it.per_100g,
          source: it.source,
          db_ref: it.db_ref ?? null,
          default_meal_slot: entry.meal_slot,
        }),
      });
    }
    await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "food-item-favorites" });
    await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "food-library" });
  }}
  className="text-lg"
>
  {isItemFavorite(it.name) ? "★" : "☆"}
</button>
```

The component signature must accept `userId: string` if it doesn't already — thread through from callers.

- [ ] **Step 12.2: Add per-item star in MealLoggerTypeTab draft preview**

Apply the same pattern to `components/log/MealLoggerTypeTab.tsx` — in the draft-preview block (the `draft.items.map((it, idx) => ...)` rendering, around line 74). Same star toggle, same hook.

The MealLoggerTypeTab signature must accept `userId`. Update the call site in MealLoggerSheet to pass `userId` through.

- [ ] **Step 12.3: Typecheck, exercise, commit**

```bash
npm run typecheck
```

Exercise: parse a meal, in the preview tap ☆ on one item — verify the item appears in the Library tab's Favorites section. Commit the meal, open from /meal, tap ☆ on a different item in the edit sheet — verify it appears in Favorites too.

```bash
git add components/log/FoodEntryEditSheet.tsx components/log/MealLoggerTypeTab.tsx components/log/MealLoggerSheet.tsx
git commit -m "feat(food-log): per-item ☆ in entry preview and edit sheets"
```

---

## Task 13: Audit script + CLAUDE.md + final typecheck

**Files:**
- Create: `scripts/audit-food-library.mjs`
- Modify: `CLAUDE.md`

- [ ] **Step 13.1: Write audit script**

Create `scripts/audit-food-library.mjs`:

```js
#!/usr/bin/env node
// scripts/audit-food-library.mjs
//
// Read-only audit for v1.1: verifies food_recent_items and food_frequent_items
// outputs are internally consistent (no nulls in required fields, dedupe works,
// counts make sense). Also probes food_cache_search end-to-end.
//
// Run via:
//   AUDIT_USER_ID=<your-uuid> \
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//        --env-file=.env.local scripts/audit-food-library.mjs

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const env = readFileSync(".env.local", "utf-8")
  .split("\n")
  .reduce((acc, line) => {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) acc[m[1]] = m[2].replace(/^"|"$/g, "");
    return acc;
  }, {});

const userId = process.env.AUDIT_USER_ID;
if (!userId) { console.error("Set AUDIT_USER_ID env var"); process.exit(1); }

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

console.log("→ food_recent_items(30, 20)");
const { data: recent, error: recentErr } = await supabase.rpc("food_recent_items", { p_user_id: userId, p_days: 30, p_limit: 20 });
if (recentErr) throw recentErr;
console.log(`  ${recent.length} rows`);
for (const r of recent) {
  assert.ok(r.name, "recent.name required");
  assert.ok(typeof r.qty_g === "number" || typeof r.qty_g === "string", "recent.qty_g required");
  assert.ok(r.per_100g, "recent.per_100g required");
  assert.ok(["db", "llm"].includes(r.source), "recent.source must be db/llm");
}
const recentNames = recent.map((r) => r.name.toLowerCase());
assert.equal(recentNames.length, new Set(recentNames).size, "recent must be deduped by name");

console.log("→ food_frequent_items(30, 20)");
const { data: frequent, error: freqErr } = await supabase.rpc("food_frequent_items", { p_user_id: userId, p_days: 30, p_limit: 20 });
if (freqErr) throw freqErr;
console.log(`  ${frequent.length} rows`);
for (const f of frequent) {
  assert.ok(typeof f.occurrence_count === "number" && f.occurrence_count >= 1, "frequent.occurrence_count must be >= 1");
}
const freqNames = frequent.map((f) => f.name.toLowerCase());
assert.equal(freqNames.length, new Set(freqNames).size, "frequent must be deduped by name");

console.log("→ food_cache_search('chicken', 10)");
const { data: catalog, error: catErr } = await supabase.rpc("food_cache_search", { q: "chicken", p_limit: 10 });
if (catErr) throw catErr;
console.log(`  ${catalog.length} matches`);

console.log("\n✓ audit-food-library passed");
```

Make executable: `chmod +x scripts/audit-food-library.mjs`.

- [ ] **Step 13.2: Run audit**

```bash
AUDIT_USER_ID=<your-uuid> \
node --import ./scripts/alias-loader.mjs --experimental-strip-types \
     --env-file=.env.local scripts/audit-food-library.mjs
```

Expected: prints rows for each section + `✓ audit-food-library passed`. If any assertion fails, the SQL function output is malformed — investigate before declaring done.

- [ ] **Step 13.3: Update CLAUDE.md**

In `CLAUDE.md`, add migration 0022 to the Database migrations chain (after the existing 0021 entry — adjust the numbering to match the existing pattern):

```markdown
18. [supabase/migrations/0022_food_log_favorites_and_library.sql](supabase/migrations/0022_food_log_favorites_and_library.sql) — v1.1 of in-app food logging: adds `food_log_entries.is_favorite` for meal-level favorites, `food_item_favorites` table for item-level favorites, three SQL helpers (`food_recent_items`, `food_frequent_items`, `food_cache_search`), and extends `food_log_entries.kind` allowlist with `'copy'` and `'library'`.
```

In the same file, find the "In-app food logging" sub-section under "Data sources & precedence" and append:

```markdown
- **v1.1 additions (sub-project #1 follow-on)**: Copy-from-past-entry via `/api/food/entries/[id]/copy`; meal-level favorites via `is_favorite` flag + `/api/food/entries/[id]/favorite`; item-level favorites in `food_item_favorites` via `/api/food/item-favorites` CRUD; Library tab in `MealLoggerSheet` aggregating Favorites/Recent/Frequent/Catalog via `/api/food/library`; multi-source meal assembly via `HistoryPickerSheet` + `/api/food/history` + extended `/api/food/library/draft` (history_picker source_kind). Per-slot "Copy yesterday's <slot>" pill on `MealSlotEmptyCard` (single-tap fast path).
```

Optionally add to the Scripts section:

```markdown
- [scripts/audit-food-library.mjs](scripts/audit-food-library.mjs) — verifies `food_recent_items` / `food_frequent_items` / `food_cache_search` SQL helper outputs are internally consistent. Set `AUDIT_USER_ID` env var. Same alias-loader pattern as other audit scripts.
```

- [ ] **Step 13.4: Final typecheck**

```bash
npm run typecheck
```

Expected: exits 0.

- [ ] **Step 13.5: Commit**

```bash
git add scripts/audit-food-library.mjs CLAUDE.md
git commit -m "feat(food-log): audit script + CLAUDE.md update for v1.1"
```

---

## Self-Review Notes (informational)

**Spec coverage check** — every numbered goal:
- Goal 1 (copy any committed entry, slot-defaulted) → Task 3 + Task 11 (UI)
- Goal 2 (two-level favorites) → Task 1 (schema) + Task 3 (entry favorite) + Task 4 (item favorites CRUD) + Task 11 (entry-row ☆) + Task 12 (per-item ☆)
- Goal 3 (Library tab with 4 sections) → Task 5 (endpoint) + Task 8 (UI)
- Goal 4 (Recent / Frequent derived) → Task 1 (SQL functions) + Task 5 (endpoint composes them) + Task 8 (UI surfaces them)
- Goal 5 (Catalog section) → Task 1 (`food_cache_search`) + Task 5 + Task 8 (UI conditional render)
- Goal 6 (meal_slot integrity) → Task 3 (copy carries slot) + Task 5 + Task 9 (HistoryPickerSheet destination slot)
- Goal 7 (per-slot "Copy from yesterday") → Task 6 (yesterday-slot endpoint) + Task 10 (UI pill)
- Goal 8 (HistoryPickerSheet) → Task 6 (history endpoint) + Task 9 (full UI)

**Non-goal compliance** — multi-select inside Library tab stays single-tap (Task 8); browsing older than 60 days clamped server + client side (Task 6 + Task 9 date bar).

**Type consistency** — `FoodItem`, `FoodMacros`, `MealSlot`, `FoodLogEntry`, `FoodItemFavorite`, `FoodLibrarySections`, `HistoryDay`, `SelectedItem` used consistently across tasks 2 → 9.

**Open items deferred** — qty-adjust preview after library-tap (currently goes straight to commit; could add a preview step in v1.2), 60-day cap configurability, optimistic UI fine-tuning.
