# In-app Food Logging with AI Macro Analysis — Design

**Date:** 2026-05-18
**Status:** Approved (awaiting implementation plan)
**Owner:** single-user app, Abdelouahed
**Relation to other work:** Sub-project #1 of the "coach team" arc. Lays the nutrition-data foundation that the upcoming Multi-coach team architecture (sub-project #2) will build its Nutrition specialist on top of. Two follow-on specs ride on the same foundation: Spec B (photo capture) and Spec C (voice memo).

## Problem

Nutrition is the weakest data source in the app today. WHOOP gives item-level sleep and recovery, Strong gives item-level lifts, Withings gives daily body comp. Nutrition gives **only daily macro totals** via Yazio CSV — protein/carbs/fat/calories summed across the day, with no per-meal granularity, no per-item context, and no way to ask "what did I eat for breakfast on Tuesday?"

This caps how deep coach analysis can go. The morning brief's macros block can say "you hit 142g protein"; it cannot say "your weekday lunches are the protein gap — three of last week's lunches were rice + vegetables with no protein source." The weekly review's nutrition trends section can show 7-day calorie and macro averages; it cannot say "your top-3 fiber sources are oats, broccoli, and apples — adding a fourth would close your fiber gap." The chat coach has no tool to query food log; the only nutrition tool is `query_daily_logs` returning aggregate columns.

This spec pulls food logging in-app. New ingest path: AI extracts food items + quantities from text (today) and barcode scans (today), then photo (Spec B) and voice (Spec C). Items resolve to macros via a verified food database (USDA + OpenFoodFacts) with LLM fallback for items the DB doesn't have. Item-level entries land in a new `food_log_entries` table; aggregated totals continue to populate `daily_logs` nutrition columns so existing surfaces (morning brief, weekly review, trends, dashboard cards) keep working unchanged.

Yazio CSV ingest stays operational as a legacy fallback during transition. The Nutrition coach persona — the dedicated voice that interprets the new item-level data with food-choice and quantity advice — is a separate sub-project (#2 of the coach-team arc) and explicitly out of scope here. This spec ships the data foundation only; existing coach surfaces benefit incidentally from richer prompt context.

## Goals

1. **Four modalities for food entry, shipped across three specs.** Text and barcode in this spec (highest accuracy + lowest cost). Photo in Spec B (Claude Sonnet 4.6 vision). Voice in Spec C (Whisper-class STT). All four converge on the same `food_log_entries` schema and the same parse → DB-lookup → preview → commit pipeline.
2. **Macros come from a verified food DB with LLM fallback.** USDA FoodData Central for raw ingredients, OpenFoodFacts for packaged products (barcode). When neither matches, Haiku 4.5 estimates macros and the entry is flagged `is_estimated=true`. The flag is real signal — coach prompts can downweight uncertain entries.
3. **Item-level entries with day-level aggregation.** Every committed entry stores per-item macros in `food_log_entries.items` jsonb. A Postgres function rolls today's committed entries into `daily_logs.calories_eaten / protein_g / carbs_g / fat_g / fiber_g` on every commit. Existing surfaces that read `daily_logs` (morning brief, weekly review, trends, dashboard) work unchanged.
4. **In-app logging supersedes Yazio without breaking historical data.** When any committed `food_log_entries` row exists for a given date, Yazio CSV ingest writes are discarded for that date. Historical Yazio-only rows in `daily_logs` stay; no backfill or migration of past data into `food_log_entries`.
5. **Three small additive hooks for existing coach surfaces.** Morning brief gets top-3-items-by-calories in its prompt context. New chat tool `query_food_log` returns item-level entries. Weekly review nutrition composer gains optional `top_items` for narrative use. No new coach personas, no per-meal reactions — the dedicated Nutrition coach is sub-project #2.
6. **Mobile-first logging UX in the existing Fab.** The floating action button gains a "Log meal" entry that opens a bottom sheet with tabs per modality. Photo and voice tabs ship greyed-out in Spec A with "Coming soon" copy so the UI shell is forward-compatible without waiting on the vision/STT integrations.

## Non-Goals

- **The Nutrition coach persona.** Sub-project #2 of the coach-team arc. This spec only lands the data that persona will consume. No new coach prompt, no Nutrition-specific chat surface, no per-meal AI reactions in Spec A.
- **Micronutrient tracking.** Vit D, iron, B12, magnesium, sodium, etc. USDA returns the data; we just don't expose it in `items` or `totals` yet. Easy follow-on if the user asks.
- **Recipe save / "my usual breakfast" quick-add.** Wait until logging usage shows what gets re-typed often. Premature feature.
- **Restaurant menu DB integration.** OpenFoodFacts has some restaurant chains; USDA has cooked staples; LLM fallback covers homemade/exotic dishes. A dedicated restaurant DB (e.g., Nutritionix's restaurant database — paid) is deferred.
- **Backfilling historical Yazio data into `food_log_entries`.** Item-level history is gone (Yazio CSV is totals-only). Yazio rows in `daily_logs` stay; we don't fake item-level history from them.
- **Per-meal coach reactions ("good breakfast!").** Noise, not value. The coach surfaces analysis on demand and in scheduled briefs/reviews, not after every commit.
- **Cross-device sync of in-progress drafts.** Drafts live in the database as `status='draft'` rows; if a draft from another session is open elsewhere, you'll see it on next load — but no live websocket sync.
- **Camera permissions UX flow for barcode beyond the browser default.** Browser handles the camera prompt; if the user denies, the Scan tab shows a "Camera permission required" message. No retry-permission flow in Spec A.
- **Offline logging.** Requires network for parse + DB lookup. A future PWA-offline pass could queue drafts; not in Spec A.
- **Editing committed entries from days other than today.** Initial UI only lets you edit/delete today's entries. Past-day edits via direct DB tooling for now; UI edit-past lands if it becomes a real friction.
- **Smart "you ate this yesterday too" suggestions.** Recipe DB territory; deferred.

## Phasing within this sub-project

| Spec | Scope | Status |
|---|---|---|
| **Spec A (this doc)** | Text + barcode + DB layer + UI shell + data model + Yazio deprecation + coach data hooks | 📝 Designing |
| Spec B — Photo capture | Claude Sonnet 4.6 vision call into the same pipeline + Storage bucket + photo upload UI | Deferred |
| Spec C — Voice memo | Whisper-class STT → reuses text pipeline + push-to-record UI affordance | Deferred |

Specs B and C each land as a thin addition on the Spec A foundation. No data-model changes, no aggregation changes, no new tables. Each is ~1 week of work.

## Architecture overview

```
                            Floating action button (Fab)
                                       │
                                       ▼
                         MealLoggerSheet (bottom sheet)
                                       │
              ┌────────────────────────┼────────────────────────┐
              │                        │                         │
              ▼                        ▼                         ▼
        [Type tab]              [Scan tab]              [Photo / Voice tabs]
        textarea + Parse      camera + UPC scan         "Coming soon" (Spec B/C)
              │                        │
              ▼                        ▼
   POST /api/food/parse      POST /api/food/barcode
   ┌──────────────────┐       ┌──────────────────┐
   │ Haiku 4.5 extract│       │  upc → cache     │
   │ items + qty_g    │       │  → OpenFoodFacts │
   └────────┬─────────┘       └────────┬─────────┘
            │                          │
            └──────────┬───────────────┘
                       ▼
              ┌──────────────────────┐
              │ resolveItemMacros()  │  lib/food/lookup.ts
              │  1. food_db_cache    │
              │  2. USDA FDC fetch   │
              │  3. LLM fallback     │
              │     (mark estimated) │
              └────────┬─────────────┘
                       │
                       ▼
              ┌──────────────────────┐
              │ draft food_log_entry │  status='draft'
              │ returned to client   │
              └────────┬─────────────┘
                       │
                       ▼
              [Preview UI — edit qty, swap items, see totals]
                       │
                       ▼
              POST /api/food/commit { entry_id }
                       │
                       ▼
              ┌──────────────────────┐
              │ status='committed'   │
              │ sum_food_entries()   │ Postgres function
              │ upsert daily_logs    │  nutrition columns
              │ revalidatePath('/log')│
              └──────────────────────┘
                       │
                       ▼
            Existing coach surfaces benefit
            (morning brief, weekly review,
             trends, dashboard cards) —
            no changes to those reads.
```

Three additive coach-data hooks land alongside the foundation:

- `lib/morning/brief/index.ts` — prompt context gains `topItemsYesterday` (up to 3 items by calories) when `food_log_entries` exists for D-1.
- `lib/coach/tools.ts` — new `query_food_log(start_date, end_date, item_filter?)` tool returning expanded items per entry.
- `lib/coach/weekly-review/compose-trends.ts` — `WeeklyReviewPayload.trends.nutrition` gains optional `top_items` field when ≥3 days of in-app entries exist in the week.

## Data model

Migration `supabase/migrations/0018_food_logging.sql` adds two tables.

### `food_log_entries`

Item-level food log, one row per logging event (one meal, one snack, one barcode scan).

```sql
create table food_log_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  eaten_at timestamptz not null,
  kind text not null check (kind in ('text', 'barcode', 'photo', 'voice')),
  raw_input jsonb not null,
  -- raw_input shapes per kind:
  --   text:    { text: string }
  --   barcode: { upc: string, qty_g: number }
  --   photo:   { photo_path: string }              -- Spec B
  --   voice:   { audio_path: string, transcript: string }  -- Spec C
  items jsonb not null,
  -- items: array of:
  --   { name: string, qty_g: number,
  --     kcal: number, protein_g: number, carbs_g: number, fat_g: number, fiber_g: number,
  --     per_100g: { kcal, protein_g, carbs_g, fat_g, fiber_g },  -- enables client-side qty rescale
  --     source: 'db' | 'llm',
  --     db_ref: { source: 'usda' | 'openfoodfacts' | 'manual', canonical_id: uuid } | null,
  --     confidence: 'high' | 'medium' | 'low' | null }
  totals jsonb not null,
  -- totals: { kcal, protein_g, carbs_g, fat_g, fiber_g }
  is_estimated boolean not null default false,
  status text not null default 'draft' check (status in ('draft', 'committed', 'rejected')),
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
```

No `unique` constraint on `(user_id, eaten_at, kind)` — the user might log two snacks at the same timestamp; de-dup is the user's job via the preview UI.

`is_estimated` is `true` iff any item has `source='llm'`. Computed in route handler on insert; not a generated column to keep updates simple.

### `food_db_cache`

Shared cache of external food-DB lookups. Not per-user (food macros aren't user-scoped).

```sql
create table food_db_cache (
  canonical_id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('usda', 'openfoodfacts', 'manual')),
  upc text,
  name text not null,
  per_100g jsonb not null,
  -- per_100g: { kcal, protein_g, carbs_g, fat_g, fiber_g }
  serving_size_g numeric,         -- nullable; OFF often provides
  raw_payload jsonb not null,     -- full external response for audit
  last_fetched_at timestamptz not null default now()
);

create unique index on food_db_cache (source, upc) where upc is not null;
create extension if not exists pg_trgm;
create index on food_db_cache using gin (name gin_trgm_ops);

alter table food_db_cache enable row level security;
create policy "anyone authenticated reads food_db_cache" on food_db_cache
  for select using (auth.role() = 'authenticated');
-- writes go through service role only (the parse/barcode routes use it)
```

`pg_trgm` enables fuzzy name lookup ("chicken breast grilled" ~ "Chicken, breast, broiled"). Threshold tuning lives in `lib/food/lookup.ts`.

### `sum_food_entries` function

Pure aggregation function, called from the commit route handler.

```sql
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
  return result;
end;
$$;
```

Route handler then upserts `daily_logs` for `(user_id, log_date=p_date)` with the returned totals. Yazio's source-of-truth check happens in the Yazio ingest route, not here — see §"Yazio deprecation."

## Source-of-truth rule (extends CLAUDE.md)

CLAUDE.md "Data sources & precedence" gains a new bullet:

> **In-app food logging** (`lib/food/`, table `food_log_entries`) — owns `calories_eaten`, `protein_g`, `carbs_g`, `fat_g`, `fiber_g` on `daily_logs` for any date with at least one committed `food_log_entries` row. The `sum_food_entries(user_id, date)` Postgres function is called from `/api/food/commit` and upserts the totals. Yazio CSV ingest (`/api/ingest/health?source=yazio`) MUST check for existing committed in-app entries on the same date and skip the write when present. Historical Yazio-only rows on `daily_logs` are not migrated.

## Pipelines

### Text input

Endpoint: `POST /api/food/parse`

```ts
// request
{ text: string, eaten_at?: string }   // eaten_at defaults to now()

// response
{ entry_id: uuid, items: Item[], totals: Totals, is_estimated: boolean }
```

Steps:

1. **Extract items.** Haiku 4.5 call with a single tool `extract_food_items`. Input: user's text. Output: `[{ name: string, qty_g: number }]`. Prompt instructs the model to convert household units ("1 cup white rice cooked") to grams using common references. Tool is single-purpose — no chat, no free-form output.
2. **Resolve each item to macros.** `lib/food/lookup.ts` exports `resolveItemMacros(name: string, qty_g: number): Promise<ResolvedItem>`. For each extracted item:
   - Query `food_db_cache` by trigram similarity on `name`, ordered by similarity descending. If top hit has similarity ≥ 0.6, use it.
   - Cache miss → query USDA FDC `/foods/search?query={name}` (free API, signup for key). Take top result, normalize macros to per-100g, write to `food_db_cache` with `source='usda'`. Use it.
   - USDA returns no result OR returns a result with low text match → Haiku 4.5 estimates `per_100g` macros for the named item; build a synthetic `Item` with `source='llm'`, `confidence='low'`. Do NOT write LLM-sourced macros to `food_db_cache` (cache is for verified DB sources only).
3. **Insert draft entry.** Service-role insert into `food_log_entries` with `status='draft'`, computed `totals`, computed `is_estimated`. Return `entry_id` + items + totals to client.
4. **Client previews** in the meal logger sheet. User can edit `qty_g` per item (which proportionally rescales that item's macros), remove items, or discard the whole draft.

Edit-on-preview semantics: rescaling `qty_g` recomputes macros client-side (`per_100g × new_qty_g / 100`), since `per_100g` is implicit in the draft's stored items. To make this cleanly client-computable, drafts store `per_100g` on each item too — not just the resolved `kcal/protein_g/...` at the original quantity. (Minor schema clarification: `items[].per_100g` is an additional optional field.)

### Barcode

Endpoint: `POST /api/food/barcode`

```ts
// request
{ upc: string, qty_g?: number, eaten_at?: string }

// response
{ entry_id: uuid, product: { name, image_url, per_100g, serving_size_g }, qty_g, totals, is_estimated: false }
```

Steps:

1. **Cache lookup.** `food_db_cache` where `source='openfoodfacts' and upc=$upc`. Hit → use.
2. **Cache miss.** GET `https://world.openfoodfacts.org/api/v2/product/{upc}.json`. If `status===1`, normalize `nutriments` to `per_100g`, write cache row, use.
3. **No OFF match.** Return `{ error: 'product_not_found', upc }` — client shows "Product not in database — log via Type tab" with the UPC pre-filled in the textarea. (Edge case for niche local products.)
4. **Build draft entry** with `kind='barcode'`, single item with `source='db'`, `db_ref.source='openfoodfacts'`. `qty_g` defaults to OFF's `serving_size_g` if present, else 100g. User can edit qty in preview.

Camera scanning: client uses the [BarcodeDetector Web API](https://developer.mozilla.org/en-US/docs/Web/API/BarcodeDetector) where available (modern iOS Safari, Chrome, Edge). Fallback: a `@zxing/library` shim for older browsers. Detection runs on the live video stream; a successful scan calls the endpoint and pauses the camera. No image is uploaded — only the decoded UPC string.

### Photo (Spec B) — sketch only

`POST /api/food/photo` (multipart). Server uploads to `food-photos/{user_id}/{eaten_at}.jpg` in a new private Storage bucket. Claude Sonnet 4.6 vision call extracts `[{name, qty_g, confidence}]`. From step 3 onward the pipeline is identical to text input. UI: photo preview shown above the items list so the user can sanity-check what the AI saw.

### Voice (Spec C) — sketch only

`POST /api/food/voice` (audio blob, opus or webm). Server uploads to `food-audio/{user_id}/{eaten_at}.{ext}` in a new private Storage bucket. STT via Whisper API (OpenAI's `whisper-1` or Anthropic's eventual STT if available by then). Transcript flows into the text pipeline from step 1.

## API routes

| Route | Method | Purpose |
|---|---|---|
| `/api/food/parse` | POST | Text input → draft entry |
| `/api/food/barcode` | POST | UPC scan → draft entry |
| `/api/food/commit` | POST | Promote draft to committed; aggregate to daily_logs |
| `/api/food/entries` | GET | List entries for a date range (used by Today's meals + chat tool) |
| `/api/food/entries/:id` | PATCH | Edit committed entry (today only in Spec A) |
| `/api/food/entries/:id` | DELETE | Delete entry (status → 'rejected'); re-aggregate |

All routes are user-scoped via `createSupabaseServerClient()` (RLS-respecting). The `food_db_cache` writes use service role inside the parse/barcode handlers.

## Client cache integration

Follows the established TanStack Query SSR-hydrate pattern (see CLAUDE.md "Client cache").

- `lib/query/fetchers/foodEntries.ts` — `fetchFoodEntriesServer` + `fetchFoodEntriesBrowser`, same select string.
- `lib/query/hooks/useFoodEntries.ts` — `useFoodEntries(userId, from, to)`.
- `lib/query/keys.ts` — `queryKeys.foodEntries.all(userId)`, `.range(userId, from, to)`.
- Commit + edit + delete mutations invalidate `queryKeys.foodEntries.all(userId)` AND `queryKeys.dailyLogs.all(userId)` (since aggregation rewrites the daily_logs row).
- `/log` page prefetches today's food entries in its server component and hydrates the client `TodaysMeals` component.

## UI surfaces

### MealLoggerSheet

`components/log/MealLoggerSheet.tsx` — bottom sheet, opened from the Fab.

```
┌──────────────────────────────────────┐
│  Log meal                       [✕]  │
├──────────────────────────────────────┤
│  [ Type ] [ Scan ] [ Photo ] [ Voice]│  ← tabs (last two greyed)
├──────────────────────────────────────┤
│                                      │
│  (Type tab content)                  │
│  ┌────────────────────────────────┐  │
│  │ What did you eat?              │  │
│  │ ─────────────────────────────  │  │
│  │ 200g grilled chicken breast    │  │
│  │ 1 cup white rice cooked        │  │
│  │ half avocado                   │  │
│  │                                │  │
│  └────────────────────────────────┘  │
│           [ Parse ]                  │
│                                      │
└──────────────────────────────────────┘
```

After "Parse" press, the textarea collapses into a summary line and the preview renders below:

```
┌──────────────────────────────────────┐
│  Items                               │
│  ┌────────────────────────────────┐  │
│  │ Chicken breast, grilled        │  │
│  │ 200 g · 330 kcal · 62 P · 0 C · 7 F│
│  │ [edit qty] [×]                 │  │
│  ├────────────────────────────────┤  │
│  │ Rice, white, cooked            │  │
│  │ 158 g · 205 kcal · 4 P · 45 C · 0 F│
│  │ [edit qty] [×]                 │  │
│  ├────────────────────────────────┤  │
│  │ Avocado · estimated  ⚠         │  │
│  │ 100 g · 160 kcal · 2 P · 9 C · 15 F│
│  │ [edit qty] [×]                 │  │
│  └────────────────────────────────┘  │
│  Total: 695 kcal · 68 P · 54 C · 22 F│
│                                      │
│  [ Discard ]    [ Commit ]           │
└──────────────────────────────────────┘
```

Scan tab uses the device camera viewfinder via `<video>` + `BarcodeDetector`. On detection, the view replaces with the product card (image + name + per-100g macros) + a qty input (default = serving_size_g if known, else 100g), then a Commit button.

Photo and Voice tabs render a centered "Coming soon" panel referencing the relevant follow-on spec — gives the UI shell forward-compat without dead code paths.

### TodaysMeals section on /log

`components/log/TodaysMeals.tsx` — list block above the existing daily-metrics form on `/log`.

```
┌──────────────────────────────────────┐
│  Today's meals                       │
│  ─────────────────────────────────   │
│  Total: 1,820 kcal · 142 P · 165 C · 60 F│
│                                      │
│  08:14 · Type                        │
│    Oats, banana, peanut butter       │
│    480 kcal · 22 P · 60 C · 18 F  →  │
│                                      │
│  12:45 · Scan                        │
│    Greek yogurt 2%, Fage 5.3 oz      │
│    140 kcal · 17 P · 7 C · 5 F    →  │
│                                      │
│  13:10 · Type (estimated ⚠)          │
│    Chana masala homemade             │
│    520 kcal · 22 P · 55 C · 18 F  →  │
│                                      │
└──────────────────────────────────────┘
```

Each row tappable → opens the entry in the MealLoggerSheet in "edit committed" mode (qty edits only, no re-parse). Trash icon → DELETE.

The existing daily-metrics form on `/log` keeps its nutrition fields visible but greyed and read-only when any in-app entries exist for the day, with a small "Pulling from your meal log" note. The user logs via the Fab, not the form, when in-app logging is the source.

## Coach data integration (additive only)

Three small hooks land alongside the foundation. Each is a few-line change to an existing composer / tool list.

### Morning brief

`lib/morning/brief/index.ts` already builds a structured prompt context for the Haiku call that authors the Advice block. The context object gains:

```ts
yesterdayTopItems: {
  source: 'food_log' | 'yazio' | 'none',
  items: Array<{ name: string, kcal: number, share_of_day_pct: number }>  // top 3 by kcal
}
```

When `source='food_log'`, the advice prompt template gains a line: "Yesterday's top items by calories: {items list}. Use this when relevant to today's recommendation." When `source='yazio'` or `'none'`, the field is omitted from the prompt entirely (no change from today). No card UI change.

### Chat tool: `query_food_log`

Added to `lib/coach/tools.ts`:

```ts
{
  name: 'query_food_log',
  description: 'Query the in-app food log for a date range. Returns committed entries with per-item macros. Use when the user asks about specific foods, meal composition, or food choices — distinct from query_daily_logs which returns daily totals only.',
  input_schema: {
    type: 'object',
    properties: {
      start_date: { type: 'string', format: 'date' },
      end_date:   { type: 'string', format: 'date' },
      item_filter: { type: 'string', description: 'optional case-insensitive substring match on item name' }
    },
    required: ['start_date', 'end_date']
  }
}
```

Handler enforces the same 90-day cap as `query_daily_logs` in raw mode. Returns:

```ts
Array<{
  eaten_at: string,
  kind: 'text'|'barcode'|'photo'|'voice',
  items: Array<{ name, qty_g, kcal, protein_g, carbs_g, fat_g, fiber_g, is_estimated: boolean }>,
  totals: { kcal, protein_g, carbs_g, fat_g, fiber_g }
}>
```

`SCHEMA_EXPLAINER` in [lib/coach/system-prompts.ts](lib/coach/system-prompts.ts) gains a `query_food_log` entry under `## Tools` describing the contract.

### Weekly review nutrition composer

`lib/coach/weekly-review/compose-trends.ts` already populates `WeeklyReviewPayload.trends.nutrition` from `daily_logs` macros. Gains optional `top_items`:

```ts
trends.nutrition.top_items?: Array<{ name: string, frequency: number, total_kcal: number }>
```

Computed when ≥3 days of in-app entries exist in the review week. Top-5 by `frequency × total_kcal` rank. Consumed by `narrative-prompt.ts` — if `top_items` is present, the prompt template gains a line "Top items by usage this week: {list}" for the §4 narrative section. If absent, no template change.

## Yazio deprecation

Two coexistence rules + one opt-out:

1. **Per-date precedence in Yazio ingest.** `app/api/ingest/health/route.ts` (the `?source=yazio` branch) — before writing nutrition columns for a given `log_date`, query `food_log_entries` for any committed row on that date. If present, skip the nutrition columns write (other Yazio-owned columns, if any, still write). Log a one-line `info` to console for audit.
2. **Per-user opt-out flag.** Migration adds `profiles.disable_yazio_ingest boolean not null default false`. When true, Yazio ingest accepts the upload but returns `{ ok: true, skipped: true, reason: 'yazio_ingest_disabled' }` without writing anything. Surfaced in `/profile` as a toggle in the Yazio section: "Stop importing — I'm logging in-app now."
3. **No historical migration.** Yazio rows already in `daily_logs` stay as-is. Day-level totals are preserved; item-level history is unrecoverable (Yazio CSV is totals-only). The trends and weekly review surfaces continue to show those historical numbers; only forward-looking days get item-level depth.

CLAUDE.md "Data sources & precedence" Yazio bullet updates to reflect the in-app-supersedes rule. The bullet's existing language about Apple Health column ownership is unchanged (this spec doesn't touch step/calorie/distance columns).

## Environment

- `USDA_FDC_API_KEY` — free, signup at fdc.nal.usda.gov/api-guide.html. Required for the USDA fetch path.
- OpenFoodFacts requires no key.
- No new `COACH_TOOL_SECRET`-style HMAC needed; commit/edit/delete are RLS-protected user actions.

## Deliverables

- `supabase/migrations/0018_food_logging.sql` — tables, indexes, `sum_food_entries` function, RLS policies, `profiles.disable_yazio_ingest` column.
- `lib/food/parse.ts` — Haiku 4.5 extraction call + tool definition.
- `lib/food/barcode.ts` — OpenFoodFacts fetcher + cache writer.
- `lib/food/lookup.ts` — `resolveItemMacros` with USDA fetch + LLM fallback.
- `lib/food/aggregate.ts` — thin wrapper calling `sum_food_entries` and upserting `daily_logs`.
- `app/api/food/parse/route.ts`, `app/api/food/barcode/route.ts`, `app/api/food/commit/route.ts`, `app/api/food/entries/route.ts`, `app/api/food/entries/[id]/route.ts`.
- `components/log/MealLoggerSheet.tsx` — the bottom sheet with 4 tabs.
- `components/log/TodaysMeals.tsx` — today's entries list on /log.
- `components/log/FoodEntryEditSheet.tsx` — qty-edit + delete for committed entries.
- `lib/query/fetchers/foodEntries.ts` + `lib/query/hooks/useFoodEntries.ts` + key additions to `lib/query/keys.ts`.
- `lib/coach/tools.ts` — add `query_food_log`.
- `lib/coach/system-prompts.ts` — extend `SCHEMA_EXPLAINER` with the new tool.
- `lib/morning/brief/index.ts` — `yesterdayTopItems` prompt context addition.
- `lib/coach/weekly-review/compose-trends.ts` — optional `top_items` field on nutrition trends.
- `lib/coach/weekly-review/narrative-prompt.ts` — conditional template line for `top_items`.
- `app/api/ingest/health/route.ts` — Yazio precedence check.
- `components/profile/YazioCard.tsx` (or wherever Yazio settings live) — opt-out toggle.
- `scripts/audit-food-aggregation.mjs` — read-only audit: for any date with committed `food_log_entries`, verifies `daily_logs` matches `sum_food_entries`. Same script harness as `audit-coach-trends.mjs` and `audit-proactive-cron.mjs`.
- CLAUDE.md update — new "In-app food logging" sub-section under "Data sources & precedence" + migration `0018_food_logging.sql` listed in the migrations chain.

## Open items deferred to implementation plan

- Exact Haiku 4.5 prompt + tool schema for `extract_food_items` — to be drafted during implementation; validation against a 20-item test corpus before merging.
- Trigram similarity threshold for `food_db_cache` name match — start at 0.6, tune during the first week of use.
- Whether `BarcodeDetector` requires the `@zxing/library` fallback on the user's specific iOS version (Safari support is patchy across iOS 16/17) — check during implementation; if needed, ship the fallback in the same PR.
- Whether `food_db_cache.raw_payload` retention needs a cleanup policy — defer; the cache is small (~10KB/product) and won't pressure storage for the foreseeable future.
- **Day-bucketing timezone for `sum_food_entries`.** Function currently casts `(eaten_at at time zone 'UTC')::date`. For single-user app, this is fine if all logging happens during waking hours that fall on the same UTC day as the user's local day — but late-evening meals (e.g., 23:00 local in CET) will bucket to the wrong day. Implementation should either (a) parameterize the function with a `p_tz text` arg defaulting to `'UTC'` and pass the user's TZ from the commit route, or (b) have the commit route compute the local-date and pass it explicitly as `p_date`. Pick during implementation based on what feels least error-prone.

## Future specs that build on this

- **Spec B — Photo capture.** Vision call + Storage bucket + photo upload UI. ~1 week.
- **Spec C — Voice memo.** STT + push-to-record UI. ~1 week.
- **Sub-project #2 — Nutrition coach persona** (separate arc). Builds on the rich item-level data this spec lands. Adds a Nutrition-specific system prompt, possibly a Nutrition-tab surface, and per-meal / weekly food-choice advice. Out of scope here.
- **Micronutrient tracking.** USDA returns the data; surface it in `items` + `totals` once a use case exists.
- **Recipe save / quick-add.** Reactive feature — wait for actual re-typing patterns from the food log.
