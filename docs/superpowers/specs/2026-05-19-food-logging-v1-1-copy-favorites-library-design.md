# Food Logging v1.1 — Copy, Favorites, and Library — Design

**Date:** 2026-05-19
**Status:** Approved (awaiting implementation plan)
**Owner:** single-user app, Abdelouahed
**Relation to other work:** v1.1 of sub-project #1 (in-app food logging, shipped 2026-05-18 + meal-journal addendum shipped on `feat/meal-journal`). Adds three frictions-reducing capabilities — copy-from-past-entry, two-level favorites (meal + item), and a Library tab with search across user history and the shared food DB cache. Slots cleanly into the existing meal-slot infrastructure (migration 0020) and the MealLoggerSheet UI.

## Problem

The food logging feature shipped 2026-05-18 lets the user log a meal four ways: type, barcode, photo (greyed), voice (greyed). The meal-journal addendum on `feat/meal-journal` added per-slot attribution (`food_log_entries.meal_slot`) and a slot-first `/meal` route. Both work, but logging the same meal twice — or a meal the user eats most days — still requires re-typing or re-scanning. That's friction the user noticed almost immediately.

Three concrete frictions:

1. **Repeat-meal friction.** Most days the user eats roughly the same breakfast (oats + banana + PB) and the same post-workout snack. Re-typing "200g oats, 1 banana, 1 tbsp PB" every day to get a Haiku parse is wasted effort when the structured data already exists in yesterday's log.
2. **Same-food friction.** Even when meal composition varies, certain foods recur — Greek yogurt 200g, chicken breast 200g, olive oil 14g. The food's macros are already in `food_db_cache`; logging the item should be a one-tap operation, not a re-extract-and-resolve roundtrip.
3. **No way to find a previous food.** Once a food enters the user's history (eaten last week, scanned a month ago) there's no quick way to surface it for re-logging short of remembering its exact name and typing it back into the parse box.

This spec adds three primitives that address all three frictions in one cohesive surface:

- **Copy from a past entry** — re-creates an entry's items as today's draft, slot-defaulted to the source entry's slot.
- **Two-level favorites** — star a whole meal (e.g., "my usual breakfast") OR star a single food (e.g., "Greek yogurt 200g"). Stars are user-curated and persist across days.
- **Library tab** in the MealLoggerSheet with search + sections — Favorites / Recent / Frequent / Catalog. Catalog only renders during active search and lets the user re-find any food from their history (USDA-resolved or OFF-scanned) in `food_db_cache`.

All three reuse the existing parse → preview → commit pipeline. The only new ingredients are starting points into that pipeline — past entries, favorited items, recent items, frequent items, catalog rows. Nothing about the commit-and-aggregate side changes.

## Goals

1. **Copy any committed entry to today (or a chosen date), slot-defaulted to source.** Available as an action on every entry row in `TodaysMeals` and on the `/meal` slot cards. Reuses the existing draft preview so the user can adjust qty before committing.
2. **Two-level favorites: meals and items.** `is_favorite` boolean on `food_log_entries` (meal-level). Separate `food_item_favorites` table for item-level favorites (independent from any meal). Star toggles wired to PATCH endpoints. Favorites persist forever; not auto-pruned.
3. **Library tab in MealLoggerSheet — one unified surface for re-adding.** Search bar at top, four sections below: Favorites, Recent, Frequent, Catalog. Slot-aware: when MealLoggerSheet opens with `initialMealSlot`, the slot biases rank order in Favorites + Recent + Frequent. Search filters all sections inline. Tap on any row creates a single-item draft (or for favorited meals, a multi-item draft) → preview → commit.
4. **Recent / Frequent are derived, not stored.** Two new SQL helper functions (`food_recent_items`, `food_frequent_items`) compute them on demand from `food_log_entries.items` jsonb. No new persistence layer. Both bounded to last 30 days for relevance.
5. **Catalog section searches the shared `food_db_cache`.** Uses the existing `gin_trgm_ops` index from migration 0018. Renders ONLY when search query is non-empty. Each row shows source chip (`[usda]` / `[off]`). Lets the user re-find any food they've ever interacted with — even if never favorited or recently eaten.
6. **No regressions in meal-slot attribution.** Every code path that creates a new `food_log_entries` row carries a slot. Copy carries source's slot by default with optional override. Favorites carry their slot context. Recent / Frequent / Catalog draft creations use the MealLoggerSheet's `initialMealSlot` (which always has a value — defaulted via `deriveMealSlot(now())` when not explicit).
7. **Per-slot "Copy from yesterday" on `/meal`.** When a slot is empty today AND yesterday's same slot has ≥1 entry, render a "Copy from yesterday" pill on the slot card. Tap clones yesterday's slot entries into today's slot. Fast path for the common journal workflow.

8. **`HistoryPickerSheet` for multi-source meal assembly.** A bottom sheet for browsing any past date (within 60 days), multi-selecting items across dates and meals, and committing them as one new draft. Persistent selection bucket survives date-scrub navigation. Powers three use cases in one surface: (a) copy a whole past meal to any current slot, (b) compose a new meal from items across multiple past dates, (c) cherry-pick partial items from a past meal. Replaces the per-entry "Copy to…" date picker.

## Non-Goals

- **Multi-select inside the Library tab** (Favorites / Recent / Frequent / Catalog rows). Library rows remain single-tap → single-item draft (or whole-meal clone for favorite meals). Multi-source assembly across past entries IS in scope via `HistoryPickerSheet` (see §"UI surfaces"); composing across favorites/recent/frequent in one move stays a future v1.2.
- **Browsing history older than 60 days** in `HistoryPickerSheet`. The date scrubber caps at today-60d. Older entries are rare to want to re-add; if you really need one, edit via DB.
- **Drag-to-reorder favorites.** The `display_order` column on `food_item_favorites` exists for forward-compat, but no v1 UI to reorder. Order falls through to `display_order ASC, created_at DESC`.
- **Folder / category grouping of favorites.** No "Breakfast favorites" folder. The slot-aware ranking inside the Library tab is sufficient for v1.
- **Coach-proposed favorites.** ("Peter noticed you eat oats most days, want to favorite it?") Fun future feature; not in v1.
- **Search across other users' favorites.** Single-user app. `food_item_favorites` is user-scoped; `food_db_cache` is shared (food macros aren't user-scoped, so this is fine).
- **Auto-prune of stale favorites.** Favorites stay forever until the user un-stars them. No "you haven't eaten this in 6 months, want to delete the favorite?"
- **Search inside `food_log_entries.items` for the Library — no full-text search.** Catalog uses trigram on `food_db_cache.name`. Recent/Frequent items are derived from food_log entries by name extraction; the search-filter is client-side substring match on the returned-payload names. This keeps the server query simple.
- **Search the food_db_cache when query is empty.** No "browse all foods" mode — the cache has too many rows for an unfiltered list, and there's no use case (Recent + Frequent + Favorites cover empty-search).
- **Server-side search highlighting.** No `<mark>` markup or fancy match scoring. Plain substring filter is enough.
- **Custom qty defaults per favorite item.** When a user favorites an item, we store the qty at favorite-time. Tapping the favorite later uses that stored qty. No "use last-eaten qty" or "use median qty" logic.
- **Favorite-an-entry-while-uncommitted.** Drafts can't be favorited. The star toggle only renders for committed entries.

## Phasing within this sub-project

| Phase | Scope | Status |
|---|---|---|
| **v1.1 (this spec)** | Copy + 2-level favorites + Library tab with search/recent/frequent/catalog + per-slot "Copy from yesterday" | 📝 Designing |
| v1.2 (potential follow-on) | Multi-select build-a-meal; drag-reorder favorites; coach-proposed favorites | Deferred |

## Architecture overview

```
                        MealLoggerSheet (opened from various entry points)
                                          │
              ┌────────┬─────────┬─────────┬──────────────┐
              │        │         │         │              │
              ▼        ▼         ▼         ▼              ▼
           [Type]   [Scan]   [Photo]   [Voice]      [Library] ← NEW
           parse    barcode  coming    coming        ┌───────────────────┐
                              soon     soon          │ Search bar (top)  │
                                                     ├───────────────────┤
                                                     │ ★ Favorites       │  ← food_log_entries WHERE is_favorite
                                                     │   (meals + items) │     + food_item_favorites
                                                     ├───────────────────┤
                                                     │ 🕓 Recent          │  ← food_recent_items(user, 30, 20)
                                                     ├───────────────────┤
                                                     │ 📊 Frequent (30d)  │  ← food_frequent_items(user, 30, 20)
                                                     ├───────────────────┤
                                                     │ 📚 Catalog        │  ← food_cache_search(q, 20)
                                                     │ (only when typing)│     (renders only when q != "")
                                                     └────────┬──────────┘
                                                              │
                                                              ▼
                                                 Tap row → /api/food/library/draft
                                                  - { source_kind: 'favorite_meal' | 'favorite_item' |
                                                       'recent' | 'frequent' | 'catalog',
                                                      source_id?, item?, meal_slot, eaten_at? }
                                                  - server creates draft, returns it
                                                              │
                                                              ▼
                                                       Existing preview UI (MealLoggerTypeTab-style)
                                                              │
                                                              ▼
                                                  /api/food/commit → existing pipeline
```

**Outside MealLoggerSheet**, the entry-row UI on `/metrics?sub=log` (TodaysMeals) and `/meal` (MealSlotCard) gain:
- Star icon next to existing edit/delete → toggles `is_favorite`
- Copy icon next to existing edit/delete → 1-tap "Copy to today" via `/api/food/entries/[id]/copy` (no submenu — for date / partial-items, user uses MealLoggerSheet → "Pick from history")
- On `MealSlotEmptyCard` (when slot has no entries today): two pills:
  - `[📋 Copy yesterday's <slot>]` — 1-tap fast path when yesterday has ≥1 entry for the same slot
  - `[📚 Pick from history]` — opens `HistoryPickerSheet` with destination preset to this slot

**`HistoryPickerSheet`** is a bottom sheet (peer of MealLoggerSheet's tabs) that opens from: (a) the `[📚 Pick from history]` pill on `MealSlotEmptyCard`, (b) a `[📚 Pick from history]` button at the top of MealLoggerSheet's Library tab. Surface details in §"UI surfaces".

## Data model

### Migration 0023 — `food_log_entries.is_favorite` + `food_item_favorites` + RPCs

```sql
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

-- ── Meal-level favorite (boolean flag) ────────────────────────────────────
alter table food_log_entries
  add column is_favorite boolean not null default false;

-- ── Extend kind check constraint to include 'copy' and 'library' ──────────
-- 'copy' is set by /api/food/entries/[id]/copy (raw_input = { kind: 'copy',
--   source_id: <uuid> }).
-- 'library' is set by /api/food/library/draft (raw_input = { kind: 'library',
--   source_kind: 'favorite_meal'|'favorite_item'|'recent'|'frequent'|'catalog',
--   source_id?: <uuid> }).
alter table food_log_entries
  drop constraint if exists food_log_entries_kind_check;
alter table food_log_entries
  add constraint food_log_entries_kind_check
  check (kind in ('text', 'barcode', 'photo', 'voice', 'copy', 'library'));

create index food_log_entries_user_favorites_idx
  on food_log_entries (user_id, is_favorite, meal_slot, eaten_at desc)
  where is_favorite = true;

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
  unique (user_id, lower(name))   -- one favorite per food per user, case-insensitive
);

create index food_item_favorites_user_order_idx
  on food_item_favorites (user_id, display_order, created_at desc);

alter table food_item_favorites enable row level security;

create policy "user reads own item favorites" on food_item_favorites
  for select using (auth.uid() = user_id);
create policy "user writes own item favorites" on food_item_favorites
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── food_recent_items: last N distinct items from user's committed entries ─
-- Returns the latest occurrence's qty + macros (not aggregated). Caller
-- limits to most recent 20 by default; bounded to last 30 days for relevance.
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
-- Looser threshold than food_cache_similar (0.3 vs 0.6) because this is
-- exploratory search, not auto-resolve. Caller renders source chip.
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

### TypeScript types (additions to `lib/food/types.ts`)

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
  catalog?: FoodDbCacheRow[];  // present only when q != ""
};
```

`FoodLogEntry` (existing) gains `is_favorite: boolean`. Type union for `FoodLogEntryStatus` unchanged.

## API routes

### `POST /api/food/entries/[id]/copy`

Body:
```ts
{
  eaten_at?: string;     // ISO datetime; defaults to now()
  meal_slot?: MealSlot;  // defaults to source entry's slot
}
```

Response:
```ts
{
  entry: Pick<FoodLogEntry, "id" | "eaten_at" | "meal_slot" | "kind" | "items" | "totals" | "is_estimated" | "status">
}
```

Server flow:
1. Auth-gate via `supabase.auth.getUser()` (401 on missing).
2. Validate `id` is uuid; fetch the source entry (`.eq("user_id", user.id)`, `.eq("status", "committed")`, single).
3. 404 if not found (or status != 'committed').
4. Insert new `food_log_entries` row with: same `items`, same `totals`, same `is_estimated`, `kind = 'copy'` (new kind value), `raw_input = { kind: 'copy', source_id: <uuid> }`, `eaten_at = body.eaten_at ?? new Date().toISOString()`, `meal_slot = body.meal_slot ?? source.meal_slot`, `status = 'draft'`, `is_favorite = false` (copies start unfavorited).
5. Return the draft.

Schema additions in migration 0023:
- Extend `food_log_entries.kind` check constraint to include `'copy'`.
- Document the `raw_input` shape for `kind='copy'`: `{ kind: 'copy', source_id: uuid }`.

### `PATCH /api/food/entries/[id]/favorite`

Body:
```ts
{ value: boolean }
```

Response:
```ts
{ ok: true, is_favorite: boolean }
```

Server flow:
1. Auth-gate.
2. Validate uuid + boolean.
3. Update `food_log_entries SET is_favorite = $value, updated_at = now() WHERE id = $id AND user_id = $user`.
4. Return `{ ok: true, is_favorite: $value }`.

No reaggregation needed — favoriting doesn't change macros.

### `GET /api/food/item-favorites`

Response:
```ts
{ favorites: FoodItemFavorite[] }
```

Returns all rows for the user, ordered by `display_order ASC, created_at DESC`.

### `POST /api/food/item-favorites`

Body: a `FoodItem` shape plus optional `default_meal_slot`:
```ts
{
  name: string;
  qty_g: number;
  per_100g: FoodMacros;
  source: "db" | "llm";
  db_ref?: FoodItem["db_ref"];
  default_meal_slot?: MealSlot;
}
```

Response:
```ts
{ favorite: FoodItemFavorite }
```

Server flow:
1. Auth-gate + zod-validate.
2. Upsert on `(user_id, lower(name))` unique key — second tap with the same name is a no-op (returns existing).
3. Return the row.

### `DELETE /api/food/item-favorites/[id]`

Removes a favorite. Auth-gate + ownership check + delete.

Response: `{ ok: true }`.

### `GET /api/food/library`

Query params:
- `slot?: MealSlot` — biases ranking (optional)
- `q?: string` — search query (optional; when non-empty, includes `catalog` section)
- `recent_days?: number` (default 30)
- `frequent_days?: number` (default 30)
- `section_limit?: number` (default 20)

Response: `FoodLibrarySections` (see TypeScript section above).

Server flow:
1. Auth-gate.
2. Fire 4 parallel queries (5 if `q != ""`):
   - Favorite meals: `food_log_entries WHERE user_id AND is_favorite ORDER BY (meal_slot = $slot) DESC, eaten_at DESC LIMIT $section_limit`
   - Favorite items: `food_item_favorites WHERE user_id ORDER BY (default_meal_slot = $slot) DESC, display_order ASC, created_at DESC LIMIT $section_limit`
   - Recent: `SELECT * FROM food_recent_items($user, $recent_days, $section_limit)`
   - Frequent: `SELECT * FROM food_frequent_items($user, $frequent_days, $section_limit)`
   - Catalog (only when `q != ""`): `SELECT * FROM food_cache_search($q, $section_limit)`
3. Dedupe across sections by lowercased name when `q != ""`, priority Favorites > Recent > Frequent > Catalog. When `q == ""`, no dedupe (Catalog section is omitted; the other three naturally overlap less and seeing the same food in Recent + Frequent is informative — "you ate this recently AND often").
4. Return as `FoodLibrarySections`.

Performance note: this is 4-5 small queries running in parallel. The trigram index on `food_db_cache.name` makes Catalog cheap. The new `food_recent_items` / `food_frequent_items` functions are O(N) on the user's last-30-days entries (bounded), with lateral jsonb expansion — should be fast for a single user with bounded log size.

### `POST /api/food/library/draft`

Single endpoint that creates a draft entry from any library row OR a multi-item assembly. Replaces ad-hoc draft-creation logic for each section.

Body:
```ts
{
  source_kind: "favorite_meal" | "favorite_item" | "recent" | "frequent" | "catalog" | "history_picker";
  source_id?: string;          // entry id for favorite_meal; favorite id for favorite_item; cache canonical_id for catalog
  item?: {                     // single-item path for recent / frequent
    name: string;
    qty_g: number;
    per_100g: FoodMacros;
    source: "db" | "llm";
    db_ref?: FoodItem["db_ref"];
  };
  items?: FoodItem[];          // multi-item path for history_picker (and future v1.2 Library multi-select)
  source_entry_ids?: string[]; // history_picker only: provenance — which past entries items came from
  meal_slot: MealSlot;
  eaten_at?: string;
  qty_g?: number;              // override default qty (single-item paths only)
}
```

Server flow:
1. Auth-gate + zod-validate. Exactly one of `{source_id, item, items}` populated.
2. Resolve the source:
   - `favorite_meal` → fetch entry, clone its items array
   - `favorite_item` → fetch `food_item_favorites` row, build single-item array
   - `catalog` → fetch `food_db_cache` row, build single-item array using `qty_g` (default 100g or row's `serving_size_g`)
   - `recent` / `frequent` → use `body.item` directly (no persistent source row)
   - `history_picker` → use `body.items` directly. Server validates each item shape (zod array of FoodItem). Optionally records `source_entry_ids` in `raw_input` for provenance.
3. Compute `totals = sumMacros(items)`, `is_estimated = items.some(i => i.source === 'llm')`.
4. Insert draft entry with `kind = 'library'`, `raw_input = { kind: 'library', source_kind, source_id?, source_entry_ids? }`, `meal_slot = body.meal_slot`, `eaten_at = body.eaten_at ?? now()`, `status = 'draft'`.
5. Return the draft (same response shape as parse/barcode).

Schema additions:
- Extend `food_log_entries.kind` check constraint to include `'library'` and `'copy'` (see Migration 0023 below).

### `GET /api/food/history?from=YYYY-MM-DD&to=YYYY-MM-DD`

Powers `HistoryPickerSheet`'s day view. Returns committed entries in the date range, grouped by date and slot.

Query params:
- `from` (required) — YYYY-MM-DD inclusive lower bound. Server clamps to `>= today - 60d`.
- `to` (required) — YYYY-MM-DD inclusive upper bound.

Response:
```ts
{
  days: Array<{
    date: string;                                       // YYYY-MM-DD
    slots: Record<MealSlot, FoodLogEntry[]>;            // breakfast / lunch / dinner / snack
  }>;
}
```

Server flow:
1. Auth-gate.
2. Validate dates; clamp `from` to today-60d if it's older.
3. Single query: `food_log_entries WHERE user_id AND status='committed' AND eaten_at >= from AND eaten_at < (to + 1 day) ORDER BY eaten_at DESC`.
4. Group server-side by `eaten_at::date` then by `meal_slot`. Empty slots stay omitted (or rendered empty, client's choice — server returns the actual present slots).
5. Return grouped payload.

The 60-day clamp is enforced server-side (defensive against client-side date inputs trying older dates). Client UI prevents scrubbing past it.

## Client cache integration

Follows the established TanStack pattern.

### Query keys (`lib/query/keys.ts`)

```ts
foodLibrary: {
  all: (userId: string) => ["food-library", userId] as const,
  sections: (userId: string, slot: MealSlot | null, q: string) =>
    ["food-library", userId, "sections", slot ?? "no-slot", q] as const,
},
foodItemFavorites: {
  all: (userId: string) => ["food-item-favorites", userId] as const,
},
```

### Fetchers + hooks

- `lib/query/fetchers/foodLibrary.ts` — `fetchFoodLibraryServer` + `fetchFoodLibraryBrowser`.
- `lib/query/hooks/useFoodLibrary.ts` — `useFoodLibrary(userId, slot, query)`. Debounce `query` client-side (300ms) before re-fetching.
- `lib/query/fetchers/foodItemFavorites.ts` + `lib/query/hooks/useFoodItemFavorites.ts` — list of all item favorites (used by per-item star toggles in entry previews).
- Mutation invalidations:
  - Favorite toggle on entry → invalidate `foodLibrary.all(userId)` AND `foodEntries.all(userId)` (the entries fetcher returns `is_favorite`)
  - Item favorite create/delete → invalidate `foodLibrary.all(userId)` AND `foodItemFavorites.all(userId)`
  - Copy + library draft creation → invalidate `foodEntries.all(userId)` AND `dailyLogs.all(userId)` on commit (same pattern as existing parse/commit flow)

## UI surfaces

### `TodaysMeals.tsx` (on `/metrics?sub=log`)

Each entry row gains two new icon buttons (alongside existing edit/delete area):

```
┌──────────────────────────────────────────────┐
│  08:14 · text · breakfast          480 kcal │
│  Oats, banana, peanut butter                │
│                              ☆  📋  ✎  🗑   │
└──────────────────────────────────────────────┘
```

- ☆ → `useFavoriteEntryToggle()` mutation → PATCH /favorite. Optimistic update.
- 📋 → 1-tap "Copy to today" → POST `/api/food/entries/[id]/copy` (no submenu — for any other date or for partial items, the user opens MealLoggerSheet and uses "Pick from history"). The newly-created draft opens in the existing preview UI so the user can adjust qty / commit.

### `/meal` route — `MealSlotCard.tsx` + `MealSlotEmptyCard.tsx`

Each entry inside a `MealSlotCard` gets the same ☆ + 📋 affordances as TodaysMeals.

`MealSlotEmptyCard` (when slot has zero entries today) gains two pills side-by-side:

```
┌──────────────────────────────────────────────┐
│  Breakfast — no entries logged              │
│                                             │
│   [📋 Copy yesterday's breakfast (2 items)] │
│   [📚 Pick from history]                    │
│                                             │
│   [+ Log breakfast]                         │  ← existing
└──────────────────────────────────────────────┘
```

- **`[📋 Copy yesterday's …]`** — 1-tap. Only rendered when yesterday's same slot has ≥1 entry. Server check via `GET /api/food/yesterday-slot?date=YYYY-MM-DD&slot=breakfast → { has_entries: boolean, entry_ids?: string[] }`. Tap → POST /copy for each entry id (parallel) → silent success (no preview — fast path) → slot refreshes.
- **`[📚 Pick from history]`** — opens `HistoryPickerSheet` with `destinationSlot = this slot`. Used when "Copy yesterday" doesn't fit (older date, or want partial items, or want to mix from multiple meals).

### `MealLoggerSheet.tsx` Library tab — add "Pick from history" entry point

At the top of the Library tab, above the search bar:

```
┌──────────────────────────────────────────┐
│  [📚 Pick from history]                  │  ← new
├──────────────────────────────────────────┤
│  [ 🔍 Search foods, meals…          ✕ ]  │
├──────────────────────────────────────────┤
│  ★ Favorites                              │
│  …
```

Tap → opens `HistoryPickerSheet` overlaying the MealLoggerSheet. Destination slot = MealLoggerSheet's current `initialMealSlot`.

### `HistoryPickerSheet.tsx` — the new multi-source picker

Bottom sheet, full-height variant (taller than the standard MealLoggerSheet so the date view has room).

```
┌──────────────────────────────────────────┐
│  Pick items from history            [✕]  │
├──────────────────────────────────────────┤
│  ◀  [Tue May 17]  ▶                      │  ← date scrubber: ◀ ▶ + date pill (tappable for calendar)
│         capped at today - 60d            │
├──────────────────────────────────────────┤
│  Selected (3)  Add to: [Dinner ▼]        │  ← persistent bucket header
│  ─ Chicken breast 200g    ×  · May 14   │
│  ─ Avocado 80g            ×  · May 16   │
│  ─ Rice basmati 150g      ×  · May 16   │
│                              [Clear all] │
├──────────────────────────────────────────┤
│  Tue May 17 — Breakfast (3 items)        │
│    [Select all] [Add meal to selected]   │  ← shortcuts
│  ☑ Oats 80g · 380 kcal · 14P · 60C       │
│  ☐ Banana 120g · 105 kcal                │
│  ☐ Peanut butter 16g · 95 kcal           │
├──────────────────────────────────────────┤
│  Tue May 17 — Lunch (2 items)            │
│  ☐ Greek yogurt 200g · 110 kcal          │
│  ☐ Honey 10g · 30 kcal                   │
├──────────────────────────────────────────┤
│           [ Add 3 items to dinner ]      │  ← bottom CTA, sticky
└──────────────────────────────────────────┘
```

**Component breakdown:**
- `components/log/HistoryPickerSheet.tsx` — orchestrator. Owns: current date in scrubber, selection bucket state (`SelectedItem[]`), destination slot.
- `components/log/HistoryPickerDateBar.tsx` — date scrubber (◀ ▶ + tappable date pill that opens a native date picker). Disables ▶ if current date == today (no future dates). Disables ◀ if current date == today-60d.
- `components/log/HistoryPickerBucket.tsx` — collapsible "Selected (N)" tray at top. Shows each item with source date, × to remove, "Clear all", and destination-slot select.
- `components/log/HistoryPickerSlotCard.tsx` — one card per (date, slot) shown for the chosen date. Per-item checkboxes. "Select all" shortcut. "Add meal to selected" shortcut (clones the whole entry's items into the bucket in one tap).
- Sticky bottom CTA: `[Add N items to <slot>]`. Disabled when N == 0.

**Selection bucket data model (client-state only — no DB write until commit):**

```ts
type SelectedItem = {
  item: FoodItem;            // the actual item shape (name, qty_g, macros, etc.)
  source_entry_id: string;   // for provenance + dedupe
  source_date: string;       // YYYY-MM-DD, for UI display only
};
```

**Multi-add behavior:**
- Tapping the same item twice (e.g., from two different days) ADDS both copies. The bucket can contain duplicates because the user might legitimately want "2x chicken breast 200g" across two meals.
- Tap × in bucket → removes that single entry from the bucket (not all duplicates).
- "Clear all" → empties bucket entirely.

**Commit flow:**
- Tap `[Add N items to <slot>]` → POST `/api/food/library/draft` with body `{ source_kind: 'history_picker', items: <SelectedItem.item[]>, source_entry_ids: <SelectedItem.source_entry_id[]>, meal_slot: <destination>, eaten_at: now() }`.
- Server creates a draft → response opens it in the existing preview UI (the user can tweak qty before final commit).
- Preview commit → POST `/api/food/commit` → reaggregate → close all sheets → /meal or /log shows the new entry.

**Pre-loaded date for the per-entry copy shortcut on TodaysMeals:** out of scope. The TodaysMeals `📋` button is 1-tap copy-to-today only; it doesn't open HistoryPickerSheet. If the user wants the rich picker, they open MealLoggerSheet first.

### `MealLoggerSheet.tsx` — new **Library** tab

Tab strip becomes: `Type / Scan / Library / Photo / Voice` (Library replaces the "Favs" placeholder from the original spec sketch; Photo + Voice stay greyed). The Library tab renders:

```
┌──────────────────────────────────────────┐
│  [ 🔍 Search foods, meals…          ✕ ]  │  ← search input, clear button
├──────────────────────────────────────────┤
│  ★ Favorites                              │
│  ─ [meal] Oatmeal + banana + PB    ☆     │
│  ─ Greek yogurt 200g                ☆    │
│  ─ Chicken breast grilled 200g      ☆    │
├──────────────────────────────────────────┤
│  🕓 Recent (last 30 days)                 │
│  ─ Rice basmati cooked 150g              │
│  ─ Avocado 80g                            │
│  ─ Olive oil 14g                          │
├──────────────────────────────────────────┤
│  📊 Frequent (last 30 days)               │
│  ─ Chicken breast (×18)                  │
│  ─ Greek yogurt (×14)                    │
│  ─ Oats (×12)                             │
├──────────────────────────────────────────┤
│  📚 Catalog  [usda]/[off]                 │  ← only when search != ""
│  ─ Chicken, broilers, breast…  [usda]    │
│  ─ Banza chickpea pasta         [off]    │
└──────────────────────────────────────────┘
```

Component split:
- `components/log/MealLoggerLibraryTab.tsx` — orchestrator (owns search state + slot context + section render).
- `components/log/LibrarySection.tsx` — section header + row list (reusable for all sections).
- `components/log/LibraryRow.tsx` — single row with icon, name, qty/macros, optional star toggle.

Search behavior:
- Client-side: search input controlled, debounced (300ms) before invalidating the TanStack query.
- Server-side: `q` is forwarded to `/api/food/library` which feeds the Catalog section (server filters DB cache via trigram). For Favorites / Recent / Frequent, the SERVER returns the unfiltered top 20 of each — the client filters them in memory by substring match. Rationale: those sections are small (≤20 each) so client-side filtering is fine; avoids needing search-aware SQL for those.
- Empty search → Catalog section omitted entirely (not just empty — the header doesn't render).
- Non-empty search → all four sections render with whatever matches; an otherwise-empty section shows its header + "No matches in this section."

Per-row tap:
- Favorite meal → POST /api/food/library/draft with `source_kind: 'favorite_meal', source_id: <entry_id>` → opens the draft in a preview (the existing MealLoggerTypeTab's draft renderer, lifted into a shared component).
- Favorite item / recent / frequent → POST /api/food/library/draft with the appropriate `source_kind` → opens preview.
- Catalog → POST /api/food/library/draft with `source_kind: 'catalog', source_id: <canonical_id>` → opens preview.

Per-row star (only on Favorite items, Recent, Frequent, Catalog sections — Favorite meals already have stars baked into the section):
- Toggle: POST/DELETE on `/api/food/item-favorites`. Optimistic UI update.

### Per-item star in entry previews

`FoodEntryEditSheet.tsx` (the qty-edit + delete sheet on TodaysMeals + /meal) gains a small ☆ next to each item in the items list. Toggle creates/deletes an `item_favorite` row for that item's name + per_100g + qty + slot context. Persist via `useToggleItemFavorite` mutation.

Similar in `MealLoggerTypeTab.tsx`'s draft preview — each item gets a ☆.

### Theme additions (`lib/ui/theme.ts`)

A single new color for the favorite star (filled state): `gold-400`-ish. Plus a chip color for `[usda]` and `[off]` source pills in the Catalog rows (subdued, matching the existing `is_estimated` amber treatment).

## Source-of-truth precedence rule (extends CLAUDE.md)

No change. Favorites + Library + Copy all create entries via the existing food_log_entries → sum_food_entries → daily_logs path. The new `kind` values (`'copy'`, `'library'`) are just provenance tags; the aggregation function is kind-agnostic.

The new `food_recent_items` and `food_frequent_items` SQL helpers are read-only derivations from `food_log_entries.items` — they do NOT write to any table.

## Deliverables

- `supabase/migrations/0023_food_log_favorites_and_library.sql` — `is_favorite` column, `food_item_favorites` table + RLS, `food_recent_items` + `food_frequent_items` + `food_cache_search` functions, `kind` constraint extension to include `'copy'` and `'library'`.
- Types (`lib/food/types.ts`): `FoodItemFavorite`, `FoodRecentItem`, `FoodFrequentItem`, `FoodLibrarySections`. `FoodLogEntry` gains `is_favorite: boolean`.
- API routes:
  - `app/api/food/entries/[id]/copy/route.ts` (POST)
  - `app/api/food/entries/[id]/favorite/route.ts` (PATCH)
  - `app/api/food/item-favorites/route.ts` (GET + POST)
  - `app/api/food/item-favorites/[id]/route.ts` (DELETE)
  - `app/api/food/library/route.ts` (GET)
  - `app/api/food/library/draft/route.ts` (POST — extended body accepts `items[]` + `source_entry_ids[]` for history_picker)
  - `app/api/food/yesterday-slot/route.ts` (GET — small helper for the "Copy yesterday" pill)
  - `app/api/food/history/route.ts` (GET — date-range query powering `HistoryPickerSheet`'s day view)
- Client cache (`lib/query/`): `foodLibrary` + `foodItemFavorites` + `foodHistory` key families + matching fetchers + hooks.
- UI:
  - `components/log/MealLoggerLibraryTab.tsx`
  - `components/log/LibrarySection.tsx`
  - `components/log/LibraryRow.tsx`
  - `components/log/HistoryPickerSheet.tsx`
  - `components/log/HistoryPickerDateBar.tsx`
  - `components/log/HistoryPickerBucket.tsx`
  - `components/log/HistoryPickerSlotCard.tsx`
  - Updates to `TodaysMeals.tsx` (☆ + 📋 affordances; 📋 is 1-tap copy-to-today), `MealSlotCard.tsx`, `MealSlotEmptyCard.tsx` (two pills: Copy yesterday + Pick from history), `FoodEntryEditSheet.tsx` (per-item ☆), `MealLoggerTypeTab.tsx` (per-item ☆ on draft preview), `MealLoggerSheet.tsx` (Library tab registration + Pick-from-history launcher).
- `lib/ui/theme.ts` — star-fill color + source-chip subdued colors.
- `lib/data/types.ts` — re-export of new types if needed (food types stay in `lib/food/types.ts` per existing convention).
- CLAUDE.md update — new sub-section on copy/favorites/library; migration 0023 listed.
- Audit script: `scripts/audit-food-library.mjs` — read-only audit that for a given user verifies `food_recent_items` and `food_frequent_items` outputs are internally consistent (no nulls in required fields, lowercased-name dedup works, counts make sense). Run once after migration applies.

## Environment / config

No new env vars. No new external API integrations. Everything operates on existing Supabase data + the existing food_db_cache populated by sub-project #1.

## Open items deferred to implementation plan

- **Optimistic UI cadence for star toggles.** The plan should specify TanStack mutation `onMutate` shape for instant feedback before server confirms.
- **"Copy from yesterday" multi-entry confirmation UX.** If yesterday's breakfast has 3 entries, does the pill say "Copy 3 items" or open a multi-select? v1 starts with "copy all" via a single tap; if user wants finer control they do it from the Library tab.
- **Migration 0023 backfill behavior.** New columns + tables only — no existing data to migrate. (Existing entries have `is_favorite = false` by the default; no manual backfill needed.)
- **Date scrubber on `/meal` and Library "Recent" — UTC vs local.** Recent's `last_eaten_at` is a timestamp; UI should format in user TZ but the SQL function's day-bucketing is interval-based (`now() - 30 days`) which is timezone-agnostic. No edge case here.
- **Whether to surface `occurrence_count` on Frequent rows** as a visible chip (`×18`) — yes, see the UI mock. Per-row layout treats it as a small subdued chip.

## Future specs that build on this

- **Multi-select inside the Library tab** — tap 3 favorite items + 2 frequent rows + commit as one entry. The `items[]` body on `/api/food/library/draft` already supports this; the addition is a per-section selection bucket UI in the Library tab (mirroring `HistoryPickerBucket`'s pattern). Easy v1.2.
- **Drag-reorder favorites** — `display_order` column already exists; UI hookup later.
- **Coach-proposed favorites** — Peter notices recurring meals; suggests favoriting them via a chat card. Lands cleanly because the `food_item_favorites` table is already user-scoped and the favorites toggle endpoint exists.
- **"Most-eaten this week" widget** on `/meal` summary card — uses `food_frequent_items` with `p_days=7`. Trivial to slot in.
- **Catalog rows showing original source rich info** — when tapping a Catalog row, show the OFF product image (already cached in `food_db_cache.raw_payload`) or the USDA description in the preview. Minor polish.
- **History older than 60 days** — extend the scrubber cap if a real need emerges. The data is there; only the client-side cap and the server clamp need lifting.
