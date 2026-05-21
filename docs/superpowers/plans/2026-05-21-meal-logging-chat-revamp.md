# Meal Logging Chat Revamp — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `/meal`'s one-shot TEXT-tab input with a Nora-led chat thread inside `MealLoggerSheet`, add a `user_food_items` personal library that beats USDA in resolution, and fix the omelette-class catalog failures (drop OFF from text-resolve, USDA British→US spelling fallback, flip search source-rank, purge low-precision OFF cache rows).

**Architecture:** Two layers. A **deterministic resolution layer** (server) turns text into items+macros via `library → cache → USDA-with-spelling → LLM-estimate` — OFF is removed from this chain. A **conversation layer** (Nora in a new `meal_log` chat mode) wraps the resolver and asks clarifying questions only when at least one item came back at `medium`/`low` confidence. All else flows straight to a structured preview card the user confirms.

**Tech stack:** Next.js 15 App Router · Supabase (Postgres + RLS) · TanStack Query v5 · Anthropic SDK (Haiku 4.5 for extraction, Sonnet for clarification via existing `runChatStream`) · Tailwind v4. No automated test framework in this repo — verification is `npm run typecheck` + manual exercise in `npm run dev` per the project's CLAUDE.md (see [CLAUDE.md "Commands" section](../../CLAUDE.md)).

**Source spec:** [docs/superpowers/specs/2026-05-21-meal-logging-chat-revamp-design.md](../specs/2026-05-21-meal-logging-chat-revamp-design.md).

---

## File structure

The plan creates 13 files, modifies 16, and deletes 3. Each task lists its exact paths.

**New files:**
- `supabase/migrations/0027_meal_logging_chat_revamp.sql` — schema additions.
- `lib/food/spelling.ts` — British → US token normaliser used by USDA fallback.
- `lib/food/library.ts` — service-role CRUD helpers for `user_food_items`.
- `app/api/food/library/route.ts` — POST (create) + GET (list/search).
- `app/api/food/library/[id]/route.ts` — PATCH (update) + DELETE.
- `app/api/food/entries/[id]/items/route.ts` — PATCH draft items array.
- `lib/query/fetchers/foodLibrary.ts` — TanStack Query server + browser fetchers.
- `lib/query/hooks/useFoodLibrary.ts` — client hook.
- `components/log/MealLoggerChatTab.tsx` — Nora thread + composer (text + mic + barcode + send).
- `components/log/MealLoggerPreviewCard.tsx` — structured preview bubble with Confirm/Edit/Cancel.
- `components/log/MealLoggerEditor.tsx` — inline qty editor swapped in when Edit is tapped.
- `app/profile/library/page.tsx` + `components/profile/LibraryClient.tsx` — Manage Library surface.
- `scripts/audit-meal-logging-resolve.mjs` — regression audit covering omelette-class traps.
- `scripts/purge-low-precision-off-cache.mjs` — one-shot cleanup of poisoned OFF rows.

**Modified files:**
- `lib/data/types.ts` — `ChatMode` adds `'meal_log'`, `ChatMessageRow.kind` adds `'meal_log'`, `ToolCallLog.name` adds three tool names, new `UserFoodItem` shape, `FoodItem.db_ref.source` adds `'user_library'`.
- `lib/food/types.ts` — extend `db_ref.source` union to include `'user_library'`.
- `lib/food/lookup.ts` — new chain order (library → cache → USDA-with-spelling → LLM); OFF removed; USDA fallback wired.
- `lib/food/search.ts` — flip `SOURCE_RANK`, add `user_food_items` fan-out leg.
- `lib/food/parse.ts` — one-line system-prompt addition for recipe-name passthrough.
- `app/api/food/parse/route.ts` — add `needs_clarification` to response.
- `app/api/food/commit/route.ts` — pass through `recipe_id` if present on draft.
- `lib/coach/tools.ts` — add `PICK_LIBRARY_ITEM_TOOL`, `SAVE_TO_LIBRARY_TOOL`, `SEARCH_LIBRARY_TOOL` schemas + executors.
- `lib/coach/chat-stream.ts` — register meal_log tools in the dispatch switch and the mode-gate.
- `lib/coach/system-prompts.ts` — new `NORA_MEAL_LOG_PROMPT` composed onto `NORA_BASE`.
- `components/log/MealLoggerSheet.tsx` — restructure tab list; CHAT default; SCAN/VOICE folded into composer.
- `components/log/MealLoggerSearchTab.tsx` — picks append to current draft, not commit standalone.
- `components/log/MealLoggerLibraryTab.tsx` — show user_food_items rows in a "Saved" section.
- `components/meal/MealSlotCard.tsx` — collapse rendering when entry has `recipe_id`.
- `lib/query/keys.ts` — add `foodLibrary` key family.
- `CLAUDE.md` — extend the food-logging architecture paragraph with the new chain order and `user_food_items` notes.

**Deleted files:**
- `components/log/MealLoggerTypeTab.tsx` — replaced by CHAT tab.
- `components/log/MealLoggerScanTab.tsx` — barcode folded into composer.
- `components/log/MealLoggerComingSoonTab.tsx` — voice folded into composer.

---

## Task 1: Migration 0027 — schema additions

Adds the `user_food_items` table, the `food_log_entries.recipe_id` column, extends the `chat_messages.kind` allowlist with `'meal_log'`, and replaces `chat_messages_visible_idx` so the default `/coach` history excludes `meal_log` rows.

**Files:**
- Create: `supabase/migrations/0027_meal_logging_chat_revamp.sql`

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/0027_meal_logging_chat_revamp.sql`:

```sql
-- ============================================================================
-- 0027_meal_logging_chat_revamp.sql
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

-- updated_at trigger (matches existing convention from 0010, 0018, etc.)
create or replace function public.user_food_items_set_updated_at()
returns trigger language plpgsql as $$
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
```

- [ ] **Step 2: Apply the migration**

Run:

```bash
supabase db push
```

Expected output ends with: `Finished supabase db push.` If `supabase` says the migration is already applied (e.g. from a parallel branch), run `supabase migration repair --status applied 0027` first, then re-push.

- [ ] **Step 3: Verify in the SQL editor**

Run in Supabase Dashboard → SQL Editor (or `psql`):

```sql
select column_name, data_type, is_nullable
  from information_schema.columns
  where table_name = 'user_food_items' order by ordinal_position;

select column_name from information_schema.columns
  where table_name = 'food_log_entries' and column_name = 'recipe_id';

select indexname from pg_indexes
  where tablename = 'chat_messages' and indexname = 'chat_messages_visible_idx';
```

Expected: `user_food_items` shows 10 columns; `food_log_entries.recipe_id` exists; `chat_messages_visible_idx` exists.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0027_meal_logging_chat_revamp.sql
git commit -m "feat(db): migration 0027 — user_food_items + meal_log chat kind"
```

---

## Task 2: TypeScript types

Add the row-level type for `user_food_items`, extend the `db_ref.source` union, extend `ChatMode` and `ChatMessageRow.kind` and `ToolCallLog.name`.

**Files:**
- Modify: `lib/food/types.ts`
- Modify: `lib/data/types.ts`

- [ ] **Step 1: Add `UserFoodItem` and library types in `lib/food/types.ts`**

Append to the bottom of `lib/food/types.ts` (after `HistoryDay`):

```ts
// ── user_food_items (personal library) ────────────────────────────────────────

export type UserFoodItemSource = "user_manual" | "user_label" | "user_recipe";

/** Composite ingredient slot — what `composite_of[i]` looks like.
 *  Same shape as the resolver input: a name + qty in grams. At log-expand
 *  time each composite ingredient gets resolved through the standard chain. */
export type UserFoodComposite = {
  name: string;
  qty_g: number;
};

export type UserFoodItem = {
  id: string;
  user_id: string;
  name: string;
  /** Per-100g macros for single items. NULL for recipes. */
  per_100g: FoodMacros | null;
  /** Ingredient list for recipes. NULL for single items. */
  composite_of: UserFoodComposite[] | null;
  /** Recipe-only: typical "1 serving" gram weight; UI defaults the qty input
   *  to this when the user picks the recipe. NULL for single items. */
  default_serving_g: number | null;
  source: UserFoodItemSource;
  notes: string | null;
  created_at: string;
  updated_at: string;
};
```

Then extend the existing `db_ref.source` union in the same file. Find `FoodItem.db_ref` (around line 30) and change:

```ts
  db_ref: {
    source: "usda" | "openfoodfacts" | "manual";
    canonical_id: string;
  } | null;
```

to:

```ts
  db_ref: {
    source: "usda" | "openfoodfacts" | "manual" | "user_library";
    canonical_id: string;
  } | null;
```

Apply the **same** change to `FoodItemFavorite.db_ref` (around line 130) and `FoodDbCacheRow.source` (around line 80) — only add `"user_library"` to the FoodItem-style db_ref unions, NOT to `FoodDbCacheRow.source` (cache rows never come from user library).

Also extend `SearchCandidate.source` to include `"user_library"`:

```ts
export type SearchCandidate = {
  name: string;
  per_100g: FoodMacros;
  source: "db" | "off" | "usda" | "user_library";
  canonical_id: string | null;
  image_url: string | null;
};
```

- [ ] **Step 2: Extend `ChatMode`, `ChatMessageRow.kind`, `ToolCallLog.name` in `lib/data/types.ts`**

Edit line 308:

```ts
export type ChatMode = "default" | "plan_week" | "setup_block" | "intake" | "meal_log";
```

Edit line 112 (`ChatMessageRow.kind` union):

```ts
  kind: "coach" | "morning_intake" | "morning_brief" | "weekly_review" | "proactive_nudge" | "system_routing" | "meal_log";
```

Extend `ToolCallLog.name` union (lines 124-153). After the existing `"regenerate_morning_brief"` line, add three new entries:

```ts
    | "regenerate_morning_brief"
    | "pick_library_item"
    | "save_to_library"
    | "search_library";
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS. New types are referenced but not yet consumed; nothing should fail.

- [ ] **Step 4: Commit**

```bash
git add lib/food/types.ts lib/data/types.ts
git commit -m "feat(types): UserFoodItem shape + meal_log ChatMode + tool names"
```

---

## Task 3: British→US spelling fallback

A small static map used by the USDA lookup to retry queries when the first call returns zero hits.

**Files:**
- Create: `lib/food/spelling.ts`

- [ ] **Step 1: Write the spelling module**

Create `lib/food/spelling.ts`:

```ts
// lib/food/spelling.ts
//
// British→American spelling normaliser for catalog queries.
//
// USDA's database uses American spellings ("omelet", "yogurt", "zucchini").
// Users naturally type British spellings ("omelette", "yoghurt", "courgette").
// resolveItemMacros calls USDA once with the literal query; if it returns
// zero foods, lookupUsda retries once with the normalised variant via this
// helper. No extra round-trip on the common case (query already in US English).
//
// Pure data + one function. Extend the map only when a real miss is observed
// — don't speculate.

const BRIT_TO_US: Record<string, string> = {
  omelette: "omelet",
  yoghurt: "yogurt",
  courgette: "zucchini",
  aubergine: "eggplant",
  prawn: "shrimp",
  prawns: "shrimps",
  rocket: "arugula",
  coriander: "cilantro",
  // Extension policy: only add when an audit/manual test confirms USDA has the
  // US-spelled food but the British-spelled query returns 0 foods.
};

/** Return a US-spelled variant of the query if any token maps, else null.
 *  Case-insensitive — the returned string is lowercase. */
export function maybeNormalize(query: string): string | null {
  const toks = query.toLowerCase().split(/\s+/);
  let changed = false;
  const out = toks.map((t) => {
    const v = BRIT_TO_US[t];
    if (v) { changed = true; return v; }
    return t;
  });
  return changed ? out.join(" ") : null;
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Manual smoke test in node**

```bash
node --input-type=module -e "
import('./lib/food/spelling.ts').then(m => {
  console.log(m.maybeNormalize('omelette'));            // → 'omelet'
  console.log(m.maybeNormalize('low fat yoghurt'));     // → 'low fat yogurt'
  console.log(m.maybeNormalize('chicken breast'));      // → null (unchanged)
});
" 2>/dev/null || echo "(if tsx complains, skip — the import is verified by typecheck)"
```

Expected: prints `omelet`, `low fat yogurt`, `null`.

- [ ] **Step 4: Commit**

```bash
git add lib/food/spelling.ts
git commit -m "feat(food): British→US spelling normaliser for USDA fallback"
```

---

## Task 4: `user_food_items` server helpers (`lib/food/library.ts`)

Service-role CRUD helpers used by the API routes and (server-side) by `resolveItemMacros`. RLS gating happens via the per-request auth client at the route layer; this module is for service-role paths and per-user trigram lookup.

**Files:**
- Create: `lib/food/library.ts`

- [ ] **Step 1: Write the library helpers**

Create `lib/food/library.ts`:

```ts
// lib/food/library.ts
//
// CRUD helpers for user_food_items (the personal library). The API routes
// in app/api/food/library/* are thin shells around these.
//
// Two access patterns:
//   - Per-user (RLS-respecting): create/list/update/delete from a request-
//     bound supabase client; auth.uid() enforces ownership.
//   - Service-role (lookup chain): lookupLibraryByName runs with the service
//     role and an explicit user_id parameter — used by resolveItemMacros and
//     by chat-stream tool executors that already have the userId from
//     supabase.auth.getUser() in the calling route.
//
// The trigram threshold mirrors lib/food/lookup.ts (0.6). Library hits
// always carry confidence='high' — the user vetted these themselves.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import type {
  UserFoodItem,
  UserFoodItemSource,
  UserFoodComposite,
  FoodMacros,
} from "@/lib/food/types";

const TRGM_THRESHOLD = 0.6;

export type CreateLibraryItemInput =
  | {
      kind: "item";
      name: string;
      per_100g: FoodMacros;
      source: Extract<UserFoodItemSource, "user_manual" | "user_label">;
      notes?: string | null;
    }
  | {
      kind: "recipe";
      name: string;
      composite_of: UserFoodComposite[];
      default_serving_g: number;
      source: Extract<UserFoodItemSource, "user_recipe">;
      notes?: string | null;
    };

/** Create a library row. Validates the one-shape constraint up-front so the
 *  Postgres CHECK only fires on programmer error. */
export async function createLibraryItem(
  supabase: SupabaseClient,
  input: CreateLibraryItemInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (input.kind === "item") {
    if (!input.per_100g) return { ok: false, error: "per_100g required for kind=item" };
  } else {
    if (!input.composite_of?.length) return { ok: false, error: "composite_of required for kind=recipe" };
    if (!Number.isFinite(input.default_serving_g) || input.default_serving_g <= 0) {
      return { ok: false, error: "default_serving_g must be a positive number" };
    }
  }
  const row =
    input.kind === "item"
      ? {
          name: input.name,
          per_100g: input.per_100g,
          composite_of: null,
          default_serving_g: null,
          source: input.source,
          notes: input.notes ?? null,
        }
      : {
          name: input.name,
          per_100g: null,
          composite_of: input.composite_of,
          default_serving_g: input.default_serving_g,
          source: input.source,
          notes: input.notes ?? null,
        };
  const { data, error } = await supabase
    .from("user_food_items")
    .insert(row)
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: (data as { id: string }).id };
}

export async function listLibraryItems(
  supabase: SupabaseClient,
  q?: string,
  limit = 50,
): Promise<UserFoodItem[]> {
  let query = supabase
    .from("user_food_items")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (q && q.trim().length >= 2) {
    query = query.ilike("name", `%${q.trim()}%`);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as UserFoodItem[];
}

export async function updateLibraryItem(
  supabase: SupabaseClient,
  id: string,
  patch: Partial<{
    name: string;
    per_100g: FoodMacros | null;
    composite_of: UserFoodComposite[] | null;
    default_serving_g: number | null;
    notes: string | null;
  }>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.from("user_food_items").update(patch).eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function deleteLibraryItem(
  supabase: SupabaseClient,
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.from("user_food_items").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Trigram fuzzy lookup over the user's library. Used by resolveItemMacros
 *  as the first leg of the chain. Uses ilike as the trigram operator fallback
 *  since pg_trgm's `%` is index-friendly but server-side `similarity()`
 *  RPC isn't defined here; the gin_trgm_ops index speeds up ilike too. */
export async function lookupLibraryByName(
  userId: string,
  name: string,
): Promise<UserFoodItem | null> {
  const supabase = createSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from("user_food_items")
    .select("*")
    .eq("user_id", userId)
    .ilike("name", `%${name}%`)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn("[food-library] lookupLibraryByName failed", error);
    return null;
  }
  return (data as UserFoodItem | null) ?? null;
}

void TRGM_THRESHOLD; // reserved for the trigram RPC path; ilike covers v1.
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/food/library.ts
git commit -m "feat(food): user_food_items CRUD + lookup helpers"
```

---

## Task 5: Resolution chain rewrite in `lib/food/lookup.ts`

Re-order to `library → cache → USDA-with-spelling → LLM`. Remove OFF from the chain entirely (it stays in `app/api/food/barcode/route.ts` and `lib/food/search.ts` only). Wire `maybeNormalize` into `lookupUsda`.

**Files:**
- Modify: `lib/food/lookup.ts`

- [ ] **Step 1: Add spelling fallback inside `lookupUsda`**

In `lib/food/lookup.ts`, find `async function lookupUsda` (around line 90). Replace its body so that when the first response has 0 foods AND `maybeNormalize(name)` returns a variant, a second call runs with the normalised query before giving up.

Add the import at the top:

```ts
import { maybeNormalize } from "@/lib/food/spelling";
```

Replace the body of `lookupUsda` so the first `if (foods.length === 0) return null;` becomes a retry branch:

```ts
async function lookupUsda(name: string): Promise<{ row: FoodDbCacheRow; score: number } | null> {
  const apiKey = process.env.USDA_FDC_API_KEY;
  if (!apiKey) {
    console.warn("[food-lookup] USDA_FDC_API_KEY not set — skipping USDA");
    return null;
  }
  const doSearch = async (q: string): Promise<UsdaFood[] | null> => {
    const url = `${USDA_SEARCH_URL}?api_key=${encodeURIComponent(apiKey)}&query=${encodeURIComponent(q)}&pageSize=5&dataType=Foundation,SR%20Legacy`;
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    } catch (err) {
      console.warn(`[food-lookup] USDA fetch failed for query "${q}"`, err);
      return null;
    }
    if (!res.ok) {
      console.warn(`[food-lookup] USDA ${res.status} for query "${q}"`);
      return null;
    }
    const data = (await res.json()) as { foods?: UsdaFood[] };
    return data.foods ?? [];
  };

  // First try: literal query.
  let foods = await doSearch(name);
  let usedQuery = name;
  if (foods && foods.length === 0) {
    // Retry with a US-spelled variant if any British token maps.
    const variant = maybeNormalize(name);
    if (variant && variant !== name.toLowerCase()) {
      console.info(`[food-lookup] USDA 0 hits for "${name}" — retrying as "${variant}"`);
      const retried = await doSearch(variant);
      if (retried) {
        foods = retried;
        usedQuery = variant;
      }
    }
  }
  if (!foods || foods.length === 0) return null;

  const best = pickBestCandidate(
    usedQuery,
    foods.map((f) => ({ name: f.description, food: f })),
    0.5,
  );
  if (!best) {
    console.info(`[food-lookup] USDA top-${foods.length} all below threshold for "${name}"`);
    return null;
  }
  const top = best.candidate.food;
  const per_100g = extractUsdaMacros(top);

  const supabase = createSupabaseServiceRoleClient();
  const { data: inserted, error } = await supabase
    .from("food_db_cache")
    .insert({
      source: "usda",
      upc: null,
      name: top.description,
      per_100g,
      serving_size_g: top.servingSizeUnit === "g" ? top.servingSize : null,
      raw_payload: top,
    })
    .select("*")
    .single();
  if (error) {
    console.error("[food-lookup] cache insert failed", error);
    return null;
  }
  return { row: inserted as FoodDbCacheRow, score: best.score };
}
```

- [ ] **Step 2: Insert library leg + drop OFF from `resolveItemMacros`**

Add the import at the top of the file:

```ts
import { lookupLibraryByName } from "@/lib/food/library";
import type { UserFoodItem } from "@/lib/food/types";
```

Replace the `resolveItemMacros` function body. The new chain is `library → cache → USDA → LLM`. OFF is removed; the `lookupOpenFoodFacts` function itself stays defined and exported because [app/api/food/barcode/route.ts](../../app/api/food/barcode/route.ts) and `lib/food/search.ts` still use it.

Add a `userId` parameter (callers in `app/api/food/parse/route.ts` and `app/api/food/commit/route.ts` already have access to `user.id`).

```ts
export async function resolveItemMacros(
  name: string,
  qty_g: number,
  userId: string,
): Promise<FoodItem> {
  // 1. user_food_items (library — single items only at this layer; recipes
  //    are expanded by the caller via expandRecipe below, not here).
  const lib = await lookupLibraryByName(userId, name);
  if (lib && lib.per_100g) {
    const macros = macrosForQty(lib.per_100g, qty_g);
    return {
      name: lib.name,
      qty_g,
      ...macros,
      per_100g: lib.per_100g,
      source: "db",
      db_ref: { source: "user_library", canonical_id: lib.id },
      confidence: "high",
      match_score: 1.0,
    };
  }

  // 2. food_db_cache
  const cached = await lookupCacheByName(name);
  if (cached) {
    const macros = macrosForQty(cached.per_100g, qty_g);
    return {
      name: cached.name,
      qty_g,
      ...macros,
      per_100g: cached.per_100g,
      source: "db",
      db_ref: { source: cached.source, canonical_id: cached.canonical_id },
      confidence: "high",
      match_score: 1.0,
    };
  }

  // 3. USDA (with spelling fallback inside lookupUsda)
  const usda = await lookupUsda(name);
  if (usda) {
    const macros = macrosForQty(usda.row.per_100g, qty_g);
    return {
      name: usda.row.name,
      qty_g,
      ...macros,
      per_100g: usda.row.per_100g,
      source: "db",
      db_ref: { source: "usda", canonical_id: usda.row.canonical_id },
      confidence: usda.score >= 0.7 ? "high" : "medium",
      match_score: usda.score,
    };
  }

  // 4. LLM fallback (unchanged) — confidence='low', is_estimated=true.
  let per_100g: FoodMacros;
  try {
    per_100g = await llmEstimate(name);
  } catch (err) {
    console.warn("[food-lookup] LLM estimate failed", err);
    throw new Error(`resolveItemMacros: all lookup paths failed for "${name}"`);
  }
  const macros = macrosForQty(per_100g, qty_g);
  return {
    name,
    qty_g,
    ...macros,
    per_100g,
    source: "llm",
    db_ref: null,
    confidence: "low",
    match_score: null,
  };
}
```

Note: the spec defines a recipe-aware library leg (composite expansion). For v1, **recipes are expanded by the caller** at the `/api/food/parse` route (Task 9), not inside `resolveItemMacros`. The `if (lib && lib.per_100g)` guard means a recipe row in the library is skipped here and the caller handles expansion. This keeps `resolveItemMacros` doing exactly one thing.

Add a sibling helper `expandLibraryRecipe` to the same file:

```ts
/** Expand a recipe library row into its component items, resolving each via
 *  the standard chain. Returns the resolved FoodItem[] sized to `qty_g`
 *  relative to the recipe's default_serving_g (or 1× if no default). */
export async function expandLibraryRecipe(
  recipe: UserFoodItem,
  qty_g: number,
  userId: string,
): Promise<FoodItem[]> {
  if (!recipe.composite_of || !recipe.default_serving_g) {
    throw new Error(`expandLibraryRecipe: ${recipe.id} is not a recipe`);
  }
  const scale = qty_g / recipe.default_serving_g;
  return Promise.all(
    recipe.composite_of.map((ing) =>
      resolveItemMacros(ing.name, ing.qty_g * scale, userId),
    ),
  );
}
```

- [ ] **Step 3: Update existing callers to pass `userId`**

Search for `resolveItemMacros(` callers — they need the new param. Likely call sites:
- `app/api/food/parse/route.ts` — has `user.id` already; pass `user.id` as the third arg.
- `app/api/food/draft/route.ts` — pass `user.id`.
- Any other call sites — grep first.

Run:

```bash
grep -rn "resolveItemMacros(" --include="*.ts" --include="*.tsx" app lib | grep -v "lib/food/lookup.ts"
```

For each match, add `user.id` as the third argument. Example for `app/api/food/parse/route.ts:50`:

```ts
// before
return await resolveItemMacros(it.name, it.qty_g);
// after
return await resolveItemMacros(it.name, it.qty_g, user.id);
```

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS. Any "Expected 3 arguments, but got 2" errors mean a caller still uses the old signature — fix them.

- [ ] **Step 5: Commit**

```bash
git add lib/food/lookup.ts app/api/food/parse/route.ts app/api/food/draft/route.ts
# add any other modified call-site files reported by grep in step 3
git commit -m "feat(food): library leg + USDA spelling fallback; drop OFF from text-resolve"
```

---

## Task 6: Search fan-out — add library leg, flip SOURCE_RANK

`lib/food/search.ts` powers the SEARCH tab. Library hits should win; USDA should beat OFF (today it's the inverse).

**Files:**
- Modify: `lib/food/search.ts`

- [ ] **Step 1: Flip the source rank and add library**

Edit line 28 of `lib/food/search.ts`:

```ts
// before
const SOURCE_RANK = { db: 0, off: 1, usda: 2 } as const;

// after
const SOURCE_RANK = { user_library: 0, db: 1, usda: 2, off: 3 } as const;
```

The `SearchCandidate.source` union was extended in Task 2 to include `"user_library"`.

- [ ] **Step 2: Add the library fan-out branch**

At the top of the file, add:

```ts
import { listLibraryItems } from "@/lib/food/library";
```

The existing `searchFoods` function takes a `query` only. To search the per-user library we need the user id — extend the signature. Change the function declaration and the API route that calls it.

```ts
// before
export async function searchFoods(query: string, limit = 20): Promise<SearchCandidate[]> {
// after
export async function searchFoods(
  query: string,
  userId: string,
  limit = 20,
): Promise<SearchCandidate[]> {
```

Add a new private helper above `searchFoods`:

```ts
async function searchUserLibrary(query: string, userId: string): Promise<SearchCandidate[]> {
  // Use the service-role client through listLibraryItems? No — listLibraryItems
  // expects a per-request supabase client. Inline a service-role read here so
  // searchFoods stays self-contained.
  const supabase = createSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from("user_food_items")
    .select("id, name, per_100g, composite_of, default_serving_g")
    .eq("user_id", userId)
    .ilike("name", `%${query}%`)
    .order("updated_at", { ascending: false })
    .limit(20);
  if (error || !data) return [];
  return (data as Array<{ id: string; name: string; per_100g: FoodMacros | null; composite_of: unknown[] | null; default_serving_g: number | null }>)
    .map((r) => {
      // Recipes need a flattened per_100g; for now just expose them with a
      // synthetic kcal-per-serving estimated from the default_serving_g flag.
      // The picker (MealLoggerSearchTab) will append them as-is and Task 13's
      // sheet logic resolves recipe vs item at append time.
      const per_100g: FoodMacros = r.per_100g ?? { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 };
      return {
        name: r.name,
        per_100g,
        source: "user_library" as const,
        canonical_id: r.id,
        image_url: null,
      };
    });
}
```

Add the necessary import next to existing supabase import:

```ts
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
```

(It may already exist — only add if missing.) Also add the `FoodMacros` type import if not already present.

In `searchFoods`, extend the parallel fan-out:

```ts
  const [libHits, cacheHits, offHits, usdaHits] = await Promise.all([
    searchUserLibrary(query, userId),
    searchCacheTrigram(query),
    searchOpenFoodFacts(query),
    searchUsda(query),
  ]);
  const all = [...libHits, ...cacheHits, ...offHits, ...usdaHits];
```

Sort uses the rank map already; the new key `user_library: 0` makes library win.

- [ ] **Step 3: Update the route that calls `searchFoods`**

[app/api/food/search/route.ts:28](../../app/api/food/search/route.ts) currently calls `await searchFoods(parsed.data.q, parsed.data.limit)`. Change to:

```ts
  const candidates = await searchFoods(parsed.data.q, user.id, parsed.data.limit);
```

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/food/search.ts app/api/food/search/route.ts
git commit -m "feat(food): library leg in search fan-out; rank user_library > db > usda > off"
```

---

## Task 7: Library API routes

CRUD over `user_food_items`. Routes are per-request RLS-bound (not service-role), so `auth.uid()` enforces ownership.

**Files:**
- Create: `app/api/food/library/route.ts`
- Create: `app/api/food/library/[id]/route.ts`

- [ ] **Step 1: Write `app/api/food/library/route.ts` (POST + GET)**

```ts
// app/api/food/library/route.ts
//
// POST → create a user_food_items row (single item or recipe).
// GET  → list/search user_food_items (used by Manage Library page + Nora's
//        search_library tool when called from the chat surface).

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  createLibraryItem,
  listLibraryItems,
  type CreateLibraryItemInput,
} from "@/lib/food/library";

const Per100gSchema = z.object({
  kcal: z.number().finite().nonnegative(),
  protein_g: z.number().finite().nonnegative(),
  carbs_g: z.number().finite().nonnegative(),
  fat_g: z.number().finite().nonnegative(),
  fiber_g: z.number().finite().nonnegative(),
});

const CompositeSchema = z.object({
  name: z.string().min(1),
  qty_g: z.number().positive().finite(),
});

const CreateBodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("item"),
    name: z.string().min(1).max(120),
    per_100g: Per100gSchema,
    source: z.enum(["user_manual", "user_label"]),
    notes: z.string().max(2000).nullish(),
  }),
  z.object({
    kind: z.literal("recipe"),
    name: z.string().min(1).max(120),
    composite_of: z.array(CompositeSchema).min(1).max(20),
    default_serving_g: z.number().positive().finite(),
    source: z.literal("user_recipe"),
    notes: z.string().max(2000).nullish(),
  }),
]);

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = CreateBodySchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const result = await createLibraryItem(supabase, parsed.data as CreateLibraryItemInput);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ id: result.id });
}

const QuerySchema = z.object({
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    q: url.searchParams.get("q") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const items = await listLibraryItems(supabase, parsed.data.q, parsed.data.limit);
  return NextResponse.json({ items });
}
```

- [ ] **Step 2: Write `app/api/food/library/[id]/route.ts` (PATCH + DELETE)**

```ts
// app/api/food/library/[id]/route.ts
//
// PATCH  → update name / macros / composite / notes.
// DELETE → remove a library row. Past food_log_entries with this recipe_id
//          have ON DELETE SET NULL so the row stays, just loses its
//          recipe-collapse affordance.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { updateLibraryItem, deleteLibraryItem } from "@/lib/food/library";

const Per100gSchema = z.object({
  kcal: z.number().finite().nonnegative(),
  protein_g: z.number().finite().nonnegative(),
  carbs_g: z.number().finite().nonnegative(),
  fat_g: z.number().finite().nonnegative(),
  fiber_g: z.number().finite().nonnegative(),
});

const CompositeSchema = z.object({
  name: z.string().min(1),
  qty_g: z.number().positive().finite(),
});

const PatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  per_100g: Per100gSchema.nullable().optional(),
  composite_of: z.array(CompositeSchema).max(20).nullable().optional(),
  default_serving_g: z.number().positive().finite().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const json = await req.json().catch(() => null);
  const parsed = PatchSchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const result = await updateLibraryItem(supabase, id, parsed.data);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const result = await deleteLibraryItem(supabase, id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Manual smoke test (dev server)**

```bash
npm run dev &
sleep 4
# In a logged-in browser session, copy the access_token from sb-* cookie or
# use the existing curl-with-cookie pattern from prior PRs. Then:
#
#   curl -X POST http://localhost:3000/api/food/library \
#     -H 'Content-Type: application/json' \
#     --cookie "$(cat /tmp/cookie)" \
#     -d '{"kind":"item","name":"Test Halloumi","per_100g":{"kcal":316,"protein_g":21,"carbs_g":2,"fat_g":25,"fiber_g":0},"source":"user_label"}'
#
#   curl http://localhost:3000/api/food/library?q=halloumi --cookie "$(cat /tmp/cookie)"
#
# Expected: POST returns {"id": "<uuid>"}, GET returns {"items":[...]}.
# If you don't have a cookie file handy, skip and exercise via the UI in Task 15.
```

- [ ] **Step 5: Commit**

```bash
git add app/api/food/library/route.ts app/api/food/library/\[id\]/route.ts
git commit -m "feat(api): /api/food/library CRUD routes"
```

---

## Task 8: Draft items PATCH route

`PATCH /api/food/entries/[id]/items` — update the `items[]` array on a draft entry. Used by Nora's `pick_library_item` tool (Task 10) and by `MealLoggerEditor` (Task 11). Refuses on committed entries.

**Files:**
- Create: `app/api/food/entries/[id]/items/route.ts`

- [ ] **Step 1: Write the route**

```ts
// app/api/food/entries/[id]/items/route.ts
//
// PATCH the items[] array on a draft food_log_entries row. Refuses if the
// row is committed — items on a committed entry are frozen.
//
// Body shape mirrors the items[] column: an array of FoodItem-like objects.
// Server recomputes totals + is_estimated rather than trusting the client.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { sumMacros, type FoodItem } from "@/lib/food/types";

const MacrosSchema = z.object({
  kcal: z.number().finite().nonnegative(),
  protein_g: z.number().finite().nonnegative(),
  carbs_g: z.number().finite().nonnegative(),
  fat_g: z.number().finite().nonnegative(),
  fiber_g: z.number().finite().nonnegative(),
});

const ItemSchema = z.object({
  name: z.string().min(1),
  qty_g: z.number().positive().finite(),
  kcal: z.number().finite().nonnegative(),
  protein_g: z.number().finite().nonnegative(),
  carbs_g: z.number().finite().nonnegative(),
  fat_g: z.number().finite().nonnegative(),
  fiber_g: z.number().finite().nonnegative(),
  per_100g: MacrosSchema,
  source: z.enum(["db", "llm"]),
  db_ref: z.object({
    source: z.enum(["usda", "openfoodfacts", "manual", "user_library"]),
    canonical_id: z.string(),
  }).nullable(),
  confidence: z.enum(["high", "medium", "low"]).nullable(),
  match_score: z.number().min(0).max(1).nullable(),
});

const BodySchema = z.object({
  items: z.array(ItemSchema).min(1).max(30),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const json = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  // Refuse on committed; RLS scopes to the user.
  const { data: existing, error: readErr } = await supabase
    .from("food_log_entries")
    .select("id, status")
    .eq("id", id)
    .single();
  if (readErr || !existing) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if ((existing as { status: string }).status === "committed") {
    return NextResponse.json({ error: "committed_entries_are_frozen" }, { status: 409 });
  }

  const items = parsed.data.items as FoodItem[];
  const totals = sumMacros(items);
  const is_estimated = items.some((it) => it.source === "llm");

  const { data: updated, error: updErr } = await supabase
    .from("food_log_entries")
    .update({ items, totals, is_estimated })
    .eq("id", id)
    .select("id, eaten_at, meal_slot, kind, items, totals, is_estimated, is_favorite, status")
    .single();
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
  return NextResponse.json({ entry: updated });
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/api/food/entries/\[id\]/items/route.ts
git commit -m "feat(api): PATCH /api/food/entries/[id]/items — draft items update"
```

---

## Task 9: `/api/food/parse` adds `needs_clarification` + recipe-name prompt nudge

Two small touches: the route returns a boolean flag so the client can decide whether to render the preview directly or open a chat clarification; and the Haiku extractor learns to emit a single item with the user's literal recipe-name (e.g. "my omelette") so the library can match.

**Files:**
- Modify: `lib/food/parse.ts`
- Modify: `app/api/food/parse/route.ts`

- [ ] **Step 1: Add the recipe-name rule to the Haiku system prompt**

In `lib/food/parse.ts`, find the `SYSTEM` constant. Insert this bullet right after the `PRESERVE MODIFIERS` rule:

```
- RECIPE NAMES PASS THROUGH. If the user references a meal name they likely have a recipe for (e.g. "my omelette", "my morning shake", "Abdel's omelette"), emit a SINGLE item with the user's exact name and qty_g: 100. The downstream resolver will match it against the user's library by name; if no library entry exists it will fall through to LLM estimate naturally.
```

Also extend one of the examples to demonstrate:

```
- Input: "my morning omelette"
  Output: {"items": [{"name": "my morning omelette", "qty_g": 100}]}
```

- [ ] **Step 2: Compute `needs_clarification` in the parse route**

In `app/api/food/parse/route.ts`, after the per-item resolution loop where `items` is assembled, compute the flag and include it in the response:

```ts
  const totals = sumMacros(items);
  const is_estimated = items.some((it) => it.source === "llm");
  const needs_clarification = items.some(
    (it) => it.confidence === "medium" || it.confidence === "low",
  );

  // 3. Insert draft entry (existing — unchanged)
  // ...

  return NextResponse.json({ entry: inserted, needs_clarification });
```

Make sure the `inserted` select includes everything the client needs (the existing select string covers it).

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/food/parse.ts app/api/food/parse/route.ts
git commit -m "feat(api): /api/food/parse returns needs_clarification + recipe-name passthrough"
```

---

## Task 10: Nora `meal_log` mode — system prompt, 3 tools, chat-stream wiring

Add the prompt fragment for Nora-in-meal-log, three new tool schemas + executors, and the dispatch + mode-gate wiring in `lib/coach/chat-stream.ts`.

**Files:**
- Modify: `lib/coach/system-prompts.ts`
- Modify: `lib/coach/tools.ts`
- Modify: `lib/coach/chat-stream.ts`

- [ ] **Step 1: Add the Nora meal-log system prompt**

In `lib/coach/system-prompts.ts`, append:

```ts
export const NORA_MEAL_LOG_PROMPT = `You are in meal-logging mode.

Your job: help the user record what they ate, accurately and quickly. You
are NOT giving nutrition advice or coaching in this mode — that's reserved
for the /coach surface.

You will receive a draft meal entry whose items have already been resolved
to per-100g macros by the deterministic resolver (USDA/library/LLM). Each
item carries a confidence level: high, medium, or low.

When at least one item is non-high-confidence, ask ONE short clarifying
question focused on the lowest-confidence item. Offer 2-3 chip suggestions:
- a saved library item if search_library finds one matching the item name
- "Enter label values" to capture exact macros for a brand-specific food
- "Use generic" to accept the current resolved macros as-is

Tool use:
- search_library to look up saved items matching an item name
- pick_library_item to swap a resolved item for a specific library row
- save_to_library to add a new single-item or recipe entry

When everything is settled or all items are already high-confidence, end
your turn — do NOT call any commit tool. The user taps Confirm in the UI.

Keep responses terse. One sentence per turn. No nutrition advice.`;
```

Find where `speakerSystemPrompt(speaker)` is defined (likely near the bottom of the file) and add a branch for the `meal_log` mode case. The function may currently take `(speaker)`; we may need to add `(speaker, mode?)`. If easier, expose a separate helper:

```ts
export function speakerSystemPromptForMode(
  speaker: Speaker,
  mode: ChatMode,
): string {
  if (speaker === "nora" && mode === "meal_log") {
    return `${NORA_BASE}\n\n${NORA_MEAL_LOG_PROMPT}`;
  }
  return speakerSystemPrompt(speaker);
}
```

Add the import for `ChatMode` if not present.

- [ ] **Step 2: Add three tool schemas in `lib/coach/tools.ts`**

After the existing `MARK_GLP1_DISCONTINUED_TOOL` (or wherever Nora's tools cluster), add three exports:

```ts
export const SEARCH_LIBRARY_TOOL: ToolSchema = {
  name: "search_library",
  description:
    "Fuzzy-search the user's personal food library (user_food_items). Returns up to 5 names + ids. Use to find candidates before calling pick_library_item.",
  input_schema: {
    type: "object" as const,
    required: ["query"],
    properties: {
      query: { type: "string", description: "Food name to look up." },
      limit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
    },
  },
};

export const PICK_LIBRARY_ITEM_TOOL: ToolSchema = {
  name: "pick_library_item",
  description:
    "Replace one resolved item in a draft food_log_entries row with a specific user_food_items entry. Server scales macros to the existing qty_g.",
  input_schema: {
    type: "object" as const,
    required: ["entry_id", "item_index", "library_item_id"],
    properties: {
      entry_id: { type: "string", description: "food_log_entries.id (must be status='draft')." },
      item_index: { type: "integer", minimum: 0, description: "Index into entry.items[] to replace." },
      library_item_id: { type: "string", description: "user_food_items.id to use." },
    },
  },
};

export const SAVE_TO_LIBRARY_TOOL: ToolSchema = {
  name: "save_to_library",
  description:
    "Persist a food into the user's personal library. Two kinds: 'item' (single food, per_100g macros) or 'recipe' (composite of items + default serving). Item source is 'user_label' when macros come from a product label, 'user_manual' otherwise.",
  input_schema: {
    type: "object" as const,
    required: ["kind", "name", "source"],
    properties: {
      kind: { type: "string", enum: ["item", "recipe"] },
      name: { type: "string" },
      source: { type: "string", enum: ["user_manual", "user_label", "user_recipe"] },
      per_100g: {
        type: "object",
        properties: {
          kcal: { type: "number" },
          protein_g: { type: "number" },
          carbs_g: { type: "number" },
          fat_g: { type: "number" },
          fiber_g: { type: "number" },
        },
      },
      composite_of: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "qty_g"],
          properties: {
            name: { type: "string" },
            qty_g: { type: "number" },
          },
        },
      },
      default_serving_g: { type: "number" },
      notes: { type: "string" },
    },
  },
};
```

Add the executors. Find where `executeQueryFoodLog` is (around line 1500-2000 — search `executeQueryFoodLog`) and add three new functions in the same style:

```ts
export async function executeSearchLibrary(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ items: Array<{ id: string; name: string }> }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const query = typeof i.query === "string" ? i.query.trim() : "";
  const limit = typeof i.limit === "number" ? Math.min(10, Math.max(1, i.limit)) : 5;
  if (query.length < 2) {
    return {
      ok: false,
      error: { error: "query must be at least 2 chars" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  const { data, error } = await opts.supabase
    .from("user_food_items")
    .select("id, name")
    .eq("user_id", opts.userId)
    .ilike("name", `%${query}%`)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) {
    return {
      ok: false,
      error: { error: error.message },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  const items = (data ?? []) as Array<{ id: string; name: string }>;
  return {
    ok: true,
    data: { items },
    meta: { ms: Date.now() - t0, result_rows: items.length, range_days: 0, truncated: false },
  };
}

export async function executePickLibraryItem(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ entry_id: string; updated_items_count: number }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const entry_id = typeof i.entry_id === "string" ? i.entry_id : "";
  const item_index = typeof i.item_index === "number" ? i.item_index : -1;
  const library_item_id = typeof i.library_item_id === "string" ? i.library_item_id : "";

  if (!entry_id || item_index < 0 || !library_item_id) {
    return {
      ok: false,
      error: { error: "entry_id, item_index, library_item_id all required" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  // Load library item.
  const { data: lib, error: libErr } = await opts.supabase
    .from("user_food_items")
    .select("id, name, per_100g")
    .eq("id", library_item_id)
    .eq("user_id", opts.userId)
    .single();
  if (libErr || !lib) {
    return {
      ok: false,
      error: { error: "library_item_not_found" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  const libRow = lib as { id: string; name: string; per_100g: Record<string, number> | null };
  if (!libRow.per_100g) {
    return {
      ok: false,
      error: { error: "library_item_is_recipe_not_item" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  // Load draft entry.
  const { data: entry, error: entryErr } = await opts.supabase
    .from("food_log_entries")
    .select("id, status, items")
    .eq("id", entry_id)
    .eq("user_id", opts.userId)
    .single();
  if (entryErr || !entry) {
    return {
      ok: false,
      error: { error: "entry_not_found" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  const entryRow = entry as { id: string; status: string; items: Array<Record<string, unknown>> };
  if (entryRow.status !== "draft") {
    return {
      ok: false,
      error: { error: "entry_not_draft" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  if (item_index >= entryRow.items.length) {
    return {
      ok: false,
      error: { error: "item_index_out_of_range" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  // Patch the item in place. Reuse existing qty_g; rescale macros.
  const oldItem = entryRow.items[item_index] as { qty_g: number };
  const qty_g = oldItem.qty_g;
  const k = qty_g / 100;
  const scaled = {
    kcal: libRow.per_100g.kcal * k,
    protein_g: libRow.per_100g.protein_g * k,
    carbs_g: libRow.per_100g.carbs_g * k,
    fat_g: libRow.per_100g.fat_g * k,
    fiber_g: libRow.per_100g.fiber_g * k,
  };
  const newItem = {
    name: libRow.name,
    qty_g,
    ...scaled,
    per_100g: libRow.per_100g,
    source: "db" as const,
    db_ref: { source: "user_library" as const, canonical_id: libRow.id },
    confidence: "high" as const,
    match_score: 1.0,
  };
  const newItems = [...entryRow.items];
  newItems[item_index] = newItem;

  // Recompute totals + is_estimated.
  const totals = newItems.reduce(
    (acc, it) => {
      const x = it as Record<string, number>;
      acc.kcal      += x.kcal      ?? 0;
      acc.protein_g += x.protein_g ?? 0;
      acc.carbs_g   += x.carbs_g   ?? 0;
      acc.fat_g     += x.fat_g     ?? 0;
      acc.fiber_g   += x.fiber_g   ?? 0;
      return acc;
    },
    { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
  );
  const is_estimated = newItems.some((it) => (it as { source?: string }).source === "llm");

  const { error: updErr } = await opts.supabase
    .from("food_log_entries")
    .update({ items: newItems, totals, is_estimated })
    .eq("id", entry_id)
    .eq("user_id", opts.userId);
  if (updErr) {
    return {
      ok: false,
      error: { error: updErr.message },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  return {
    ok: true,
    data: { entry_id, updated_items_count: 1 },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
  };
}

export async function executeSaveToLibrary(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: unknown;
}): Promise<ToolResult<{ id: string }>> {
  const t0 = Date.now();
  const i = (opts.input ?? {}) as Record<string, unknown>;
  const kind = i.kind === "item" || i.kind === "recipe" ? i.kind : null;
  const name = typeof i.name === "string" ? i.name.trim() : "";
  const source = typeof i.source === "string" ? i.source : "";
  if (!kind || !name || !source) {
    return {
      ok: false,
      error: { error: "kind, name, source required" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }

  if (kind === "item") {
    const per_100g = i.per_100g as Record<string, unknown> | undefined;
    if (!per_100g) {
      return {
        ok: false,
        error: { error: "per_100g required for kind=item" },
        meta: { ms: Date.now() - t0, range_days: 0 },
      };
    }
    const row = {
      user_id: opts.userId,
      name,
      per_100g,
      composite_of: null,
      default_serving_g: null,
      source,
      notes: typeof i.notes === "string" ? i.notes : null,
    };
    const { data, error } = await opts.supabase
      .from("user_food_items")
      .insert(row)
      .select("id")
      .single();
    if (error) {
      return {
        ok: false,
        error: { error: error.message },
        meta: { ms: Date.now() - t0, range_days: 0 },
      };
    }
    return {
      ok: true,
      data: { id: (data as { id: string }).id },
      meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
    };
  }

  // recipe
  const composite_of = i.composite_of as unknown[] | undefined;
  const default_serving_g = i.default_serving_g as number | undefined;
  if (!Array.isArray(composite_of) || composite_of.length === 0) {
    return {
      ok: false,
      error: { error: "composite_of array required for kind=recipe" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  if (!default_serving_g || default_serving_g <= 0) {
    return {
      ok: false,
      error: { error: "default_serving_g > 0 required for kind=recipe" },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  const row = {
    user_id: opts.userId,
    name,
    per_100g: null,
    composite_of,
    default_serving_g,
    source,
    notes: typeof i.notes === "string" ? i.notes : null,
  };
  const { data, error } = await opts.supabase
    .from("user_food_items")
    .insert(row)
    .select("id")
    .single();
  if (error) {
    return {
      ok: false,
      error: { error: error.message },
      meta: { ms: Date.now() - t0, range_days: 0 },
    };
  }
  return {
    ok: true,
    data: { id: (data as { id: string }).id },
    meta: { ms: Date.now() - t0, result_rows: 1, range_days: 0, truncated: false },
  };
}
```

Update `NORA_TOOLS` (around line 3379) to add the three new tools at the end:

```ts
export const NORA_TOOLS: readonly ToolSchema[] = [
  FOOD_LOG_TOOL,
  DAILY_LOGS_TOOL,
  PROPOSE_NUTRITION_TARGETS_TOOL,
  COMMIT_NUTRITION_TARGETS_TOOL,
  APPLY_MACROS_CORRECTION_TOOL,
  APPLY_PROTEIN_CORRECTION_TOOL,
  SET_GLP1_STATUS_TOOL,
  SET_GLP1_TAPER_STARTED_TOOL,
  MARK_GLP1_DISCONTINUED_TOOL,
  SEARCH_LIBRARY_TOOL,
  PICK_LIBRARY_ITEM_TOOL,
  SAVE_TO_LIBRARY_TOOL,
];
```

- [ ] **Step 3: Wire dispatch + mode gate in `lib/coach/chat-stream.ts`**

At the top of `lib/coach/chat-stream.ts`, extend the existing executor imports:

```ts
import {
  // ...existing imports
  executeSearchLibrary,
  executePickLibraryItem,
  executeSaveToLibrary,
  // ...
} from "@/lib/coach/tools";
```

Find the `modeAllowsTool` function (line 217 area). Add a `meal_log` branch:

```ts
const modeAllowsTool = (name: string): boolean => {
  if (opts.mode === "meal_log") {
    return name === "search_library" || name === "pick_library_item" || name === "save_to_library";
  }
  if (opts.mode === "plan_week" || opts.mode === "setup_block") {
    // ...existing
  }
  // ...rest unchanged
};
```

In the dispatch switch (the `if (block.name === "query_daily_logs")` / `else if` chain starting around line 357), add three branches before the final `else` that returns `unknown_tool`:

```ts
} else if (block.name === "search_library") {
  result = await executeSearchLibrary({
    supabase: opts.sr,
    userId: opts.userId,
    input: block.input,
  });
} else if (block.name === "pick_library_item") {
  result = await executePickLibraryItem({
    supabase: opts.sr,
    userId: opts.userId,
    input: block.input,
  });
} else if (block.name === "save_to_library") {
  result = await executeSaveToLibrary({
    supabase: opts.sr,
    userId: opts.userId,
    input: block.input,
  });
} else {
```

Also: where `chat-stream.ts` resolves the system prompt for non-Peter speakers (line ~189 uses `speakerSystemPrompt(speaker)`), wrap it to honour the meal-log mode:

```ts
const baseSystemText = speaker === "peter"
  ? opts.systemPrompt
  : speakerSystemPromptForMode(speaker, opts.mode ?? "default");
```

Add the import:

```ts
import { speakerSystemPromptForMode } from "@/lib/coach/system-prompts";
```

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/tools.ts lib/coach/chat-stream.ts lib/coach/system-prompts.ts
git commit -m "feat(coach): Nora meal_log mode + 3 library tools"
```

---

## Task 11: Preview card + inline editor components

Both render inside the chat thread but encapsulate clear concerns: the preview card is read-only display + 3 buttons; the editor is the per-item qty input form.

**Files:**
- Create: `components/log/MealLoggerPreviewCard.tsx`
- Create: `components/log/MealLoggerEditor.tsx`

- [ ] **Step 1: Write `MealLoggerPreviewCard`**

```tsx
"use client";
// components/log/MealLoggerPreviewCard.tsx
//
// Read-only preview of a draft food_log_entries row, rendered inside the
// meal-log chat thread (one bubble per draft). Three actions: Confirm
// (calls /api/food/commit), Edit (swaps to MealLoggerEditor in place),
// Cancel (deletes the draft row).

import { useState } from "react";
import type { FoodLogEntry } from "@/lib/food/types";
import { fmtNum } from "@/lib/ui/score";

type Props = {
  entry: FoodLogEntry;
  onCommitted: () => void;
  onCancelled: () => void;
  onEdit: () => void;
};

export function MealLoggerPreviewCard({ entry, onCommitted, onCancelled, onEdit }: Props) {
  const [busy, setBusy] = useState<"confirm" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy("confirm");
    setError(null);
    const res = await fetch("/api/food/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry_id: entry.id }),
    });
    if (!res.ok) {
      setError("Couldn't commit — try again.");
      setBusy(null);
      return;
    }
    onCommitted();
  };

  const cancel = async () => {
    setBusy("cancel");
    setError(null);
    const res = await fetch(`/api/food/entries/${entry.id}`, { method: "DELETE" });
    if (!res.ok) {
      setError("Couldn't cancel — try again.");
      setBusy(null);
      return;
    }
    onCancelled();
  };

  return (
    <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-3 text-sm">
      <div className="space-y-1.5">
        {entry.items.map((it, idx) => (
          <div key={idx} className="flex items-baseline justify-between gap-3">
            <span className="text-zinc-200">
              {it.name}
              <span className="text-zinc-500"> · {fmtNum(it.qty_g)}g</span>
              {it.confidence === "low" && <span className="ml-1 text-amber-500 text-xs">est.</span>}
              {it.confidence === "medium" && <span className="ml-1 text-amber-400 text-xs">~</span>}
            </span>
            <span className="text-zinc-400 tabular-nums text-xs">
              {fmtNum(it.kcal)}kcal · {fmtNum(it.protein_g)}P
            </span>
          </div>
        ))}
      </div>
      <div className="mt-3 pt-3 border-t border-zinc-800 flex items-baseline justify-between text-xs">
        <span className="text-zinc-500">Total</span>
        <span className="text-zinc-200 tabular-nums">
          {fmtNum(entry.totals.kcal)}kcal · {fmtNum(entry.totals.protein_g)}P · {fmtNum(entry.totals.carbs_g)}C · {fmtNum(entry.totals.fat_g)}F
        </span>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={confirm}
          className="flex-1 rounded-lg bg-zinc-100 text-zinc-900 px-3 py-1.5 text-xs font-medium disabled:opacity-50"
        >
          {busy === "confirm" ? "Saving…" : "Confirm"}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={onEdit}
          className="rounded-lg bg-zinc-800 text-zinc-200 px-3 py-1.5 text-xs"
        >
          Edit
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={cancel}
          className="rounded-lg bg-zinc-800 text-zinc-400 px-3 py-1.5 text-xs"
        >
          {busy === "cancel" ? "…" : "Cancel"}
        </button>
      </div>
      {error && <div className="mt-2 text-xs text-amber-400">{error}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Write `MealLoggerEditor`**

```tsx
"use client";
// components/log/MealLoggerEditor.tsx
//
// Inline per-item qty editor for a draft food_log_entries row. Replaces the
// preview card in place when the user taps Edit. Save → PATCH /api/food/
// entries/[id]/items, then swap back to preview view.

import { useState } from "react";
import type { FoodLogEntry, FoodItem } from "@/lib/food/types";
import { macrosForQty } from "@/lib/food/types";
import { fmtNum } from "@/lib/ui/score";

type Props = {
  entry: FoodLogEntry;
  onSaved: (updated: FoodLogEntry) => void;
  onCancel: () => void;
};

export function MealLoggerEditor({ entry, onSaved, onCancel }: Props) {
  const [items, setItems] = useState<FoodItem[]>(entry.items);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setQty = (idx: number, qty_g: number) => {
    setItems((prev) =>
      prev.map((it, i) =>
        i === idx
          ? { ...it, qty_g, ...macrosForQty(it.per_100g, qty_g) }
          : it,
      ),
    );
  };

  const removeItem = (idx: number) => {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  };

  const save = async () => {
    if (items.length === 0) {
      setError("Add at least one item.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/food/entries/${entry.id}/items`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    if (!res.ok) {
      setError("Save failed — try again.");
      setBusy(false);
      return;
    }
    const json = (await res.json()) as { entry: FoodLogEntry };
    setBusy(false);
    onSaved(json.entry);
  };

  return (
    <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-3 text-sm">
      <div className="space-y-2">
        {items.map((it, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <span className="flex-1 text-zinc-200 truncate">{it.name}</span>
            <input
              type="number"
              min={1}
              step={1}
              value={Math.round(it.qty_g)}
              onChange={(e) => setQty(idx, Math.max(1, parseInt(e.target.value || "0", 10)))}
              className="w-16 rounded bg-zinc-800 text-right text-zinc-100 px-2 py-1 text-xs tabular-nums"
            />
            <span className="text-zinc-500 text-xs">g</span>
            <span className="w-14 text-right text-zinc-400 tabular-nums text-xs">
              {fmtNum(it.kcal)}kcal
            </span>
            <button
              type="button"
              onClick={() => removeItem(idx)}
              className="text-zinc-500 hover:text-zinc-300 text-xs px-1"
              title="Remove"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={save}
          className="flex-1 rounded-lg bg-zinc-100 text-zinc-900 px-3 py-1.5 text-xs font-medium disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="rounded-lg bg-zinc-800 text-zinc-400 px-3 py-1.5 text-xs"
        >
          Back
        </button>
      </div>
      {error && <div className="mt-2 text-xs text-amber-400">{error}</div>}
    </div>
  );
}
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS. If `fmtNum` import path is wrong, check `lib/ui/score.ts`'s actual exports and adjust.

- [ ] **Step 4: Commit**

```bash
git add components/log/MealLoggerPreviewCard.tsx components/log/MealLoggerEditor.tsx
git commit -m "feat(meal-log): preview card + inline qty editor components"
```

---

## Task 12: `MealLoggerChatTab` — Nora thread + composer

The thread renders today's `chat_messages` rows with `kind='meal_log'`. The composer has three input affordances (text, mic, barcode) and a send button.

**Files:**
- Create: `components/log/MealLoggerChatTab.tsx`

- [ ] **Step 1: Write the chat tab**

```tsx
"use client";
// components/log/MealLoggerChatTab.tsx
//
// The "CHAT" tab inside MealLoggerSheet. One Nora thread, scoped to today.
// Persistent across sheet open/close (rows live in chat_messages with
// kind='meal_log'). Composer holds text input + mic + barcode + send.
//
// Submit path:
//   1. POST /api/food/parse → returns { entry, needs_clarification }
//   2. Write a Nora chat_messages row with ui={mode:'preview', entry_id}
//   3a. needs_clarification=false → preview card renders; user taps Confirm
//   3b. needs_clarification=true  → also POST /api/chat with mode='meal_log'
//      passing the draft entry_id; Nora streams a clarifying question; the
//      response writes its own chat_messages rows.
//
// The component does NOT manage draft state in React. The chat_messages
// thread IS the state; we refetch on each interaction.

import { useEffect, useRef, useState } from "react";
import type { MealSlot, FoodLogEntry } from "@/lib/food/types";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { MealLoggerPreviewCard } from "./MealLoggerPreviewCard";
import { MealLoggerEditor } from "./MealLoggerEditor";

type ThreadMessage = {
  id: string;
  speaker: "user" | "nora";
  content: string;
  ui: { mode: "preview" | "committed" | "cancelled"; entry_id?: string } | null;
  created_at: string;
};

type Props = {
  userId: string;
  mealSlot: MealSlot;
  eatenAt: string;
  onCommitted: () => Promise<void>;
};

export function MealLoggerChatTab({ userId, mealSlot, eatenAt, onCommitted }: Props) {
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [drafts, setDrafts] = useState<Record<string, FoodLogEntry>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const supabase = createSupabaseBrowserClient();

  // Initial fetch: today's meal_log rows.
  useEffect(() => {
    const fetchThread = async () => {
      const todayUtcStart = new Date();
      todayUtcStart.setHours(0, 0, 0, 0);
      const { data, error } = await supabase
        .from("chat_messages")
        .select("id, speaker, content, ui, created_at")
        .eq("user_id", userId)
        .eq("kind", "meal_log")
        .gte("created_at", todayUtcStart.toISOString())
        .order("created_at", { ascending: true });
      if (error) {
        console.error("[chat-tab] thread fetch failed", error);
        return;
      }
      setMessages((data ?? []) as ThreadMessage[]);

      // Hydrate draft entries referenced by any preview-mode message.
      const entryIds = (data ?? [])
        .map((m) => (m as ThreadMessage).ui?.entry_id)
        .filter((x): x is string => typeof x === "string");
      if (entryIds.length > 0) {
        const { data: entries } = await supabase
          .from("food_log_entries")
          .select("id, eaten_at, meal_slot, kind, items, totals, is_estimated, is_favorite, status, recipe_id")
          .in("id", entryIds);
        const dict: Record<string, FoodLogEntry> = {};
        for (const e of (entries ?? []) as FoodLogEntry[]) dict[e.id] = e;
        setDrafts(dict);
      }
    };
    fetchThread();
  }, [userId, supabase]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);

    // 1. POST /api/food/parse
    const parseRes = await fetch("/api/food/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, meal_slot: mealSlot, eaten_at: eatenAt }),
    });
    if (!parseRes.ok) {
      setBusy(false);
      // Inline error bubble — keep it simple.
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          speaker: "nora",
          content: "I couldn't read that. Try rephrasing.",
          ui: null,
          created_at: new Date().toISOString(),
        },
      ]);
      return;
    }
    const parseJson = (await parseRes.json()) as {
      entry: FoodLogEntry;
      needs_clarification: boolean;
    };

    // 2. Write a user row + a Nora preview row to chat_messages.
    //    Real persistence happens server-side via the chat infra, but since
    //    we're bypassing /api/chat on the happy path we insert directly here.
    const { data: userRow } = await supabase
      .from("chat_messages")
      .insert({
        user_id: userId,
        role: "user",
        content: text,
        status: "done",
        speaker: "user",
        kind: "meal_log",
        mode: "meal_log",
        ui: null,
      })
      .select("id, speaker, content, ui, created_at")
      .single();
    const { data: noraRow } = await supabase
      .from("chat_messages")
      .insert({
        user_id: userId,
        role: "assistant",
        content: "",
        status: "done",
        speaker: "nora",
        kind: "meal_log",
        mode: "meal_log",
        ui: { mode: "preview", entry_id: parseJson.entry.id },
      })
      .select("id, speaker, content, ui, created_at")
      .single();

    setMessages((prev) => [
      ...prev,
      ...(userRow ? [userRow as ThreadMessage] : []),
      ...(noraRow ? [noraRow as ThreadMessage] : []),
    ]);
    setDrafts((prev) => ({ ...prev, [parseJson.entry.id]: parseJson.entry }));
    setInput("");

    // 3. If clarification needed, ping /api/chat in mode=meal_log.
    if (parseJson.needs_clarification) {
      // Fire-and-forget: a follow-up Nora row gets written by the chat route
      // once Sonnet's response lands. Polling/SSE would be nicer; for v1
      // refetch the thread after 1s.
      fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "meal_log",
          speaker: "nora",
          message: `[meal_log] Draft entry ${parseJson.entry.id} has low-confidence items: ${
            parseJson.entry.items
              .map((it, i) => `[${i}] ${it.name} (${it.confidence ?? "n/a"})`)
              .join(", ")
          }`,
        }),
      }).catch(() => undefined);

      setTimeout(async () => {
        const { data } = await supabase
          .from("chat_messages")
          .select("id, speaker, content, ui, created_at")
          .eq("user_id", userId)
          .eq("kind", "meal_log")
          .gte("created_at", new Date(Date.now() - 30_000).toISOString())
          .order("created_at", { ascending: true });
        setMessages((data ?? []) as ThreadMessage[]);
      }, 1500);
    }

    setBusy(false);
  };

  const handleVoice = async () => {
    type SpeechRecognitionInstance = {
      lang: string;
      interimResults: boolean;
      continuous: boolean;
      onresult: ((ev: { results: ArrayLike<{ 0: { transcript: string } }> }) => void) | null;
      onend: (() => void) | null;
      start: () => void;
      stop: () => void;
    };
    type SpeechWindow = Window & {
      SpeechRecognition?: new () => SpeechRecognitionInstance;
      webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
    };
    const w = window as SpeechWindow;
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!SR) {
      alert("Voice not supported on this browser.");
      return;
    }
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.continuous = false;
    rec.onresult = (ev) => {
      const transcript = ev.results[0][0].transcript;
      setInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
    };
    rec.onend = () => setRecording(false);
    rec.start();
    setRecording(true);
  };

  const handleBarcode = () => {
    // v1: no in-browser camera flow — open the existing SCAN endpoint via
    // /api/food/barcode by manual UPC entry as a fallback. Replace with a
    // camera component in a follow-up.
    const upc = prompt("Enter barcode (UPC):");
    if (!upc || !/^\d{6,14}$/.test(upc)) return;
    fetch("/api/food/barcode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ upc, qty_g: 100, meal_slot: mealSlot, eaten_at: eatenAt }),
    })
      .then((r) => r.json())
      .then((j: { entry?: FoodLogEntry }) => {
        if (j.entry) {
          setDrafts((prev) => ({ ...prev, [j.entry!.id]: j.entry! }));
          // For brevity, just refetch the thread after a 500ms delay (the
          // barcode route doesn't post a chat_messages row; insert one here).
          supabase
            .from("chat_messages")
            .insert({
              user_id: userId,
              role: "assistant",
              content: "",
              status: "done",
              speaker: "nora",
              kind: "meal_log",
              mode: "meal_log",
              ui: { mode: "preview", entry_id: j.entry.id },
            })
            .select("id, speaker, content, ui, created_at")
            .single()
            .then(({ data }) => {
              if (data) setMessages((prev) => [...prev, data as ThreadMessage]);
            });
        }
      });
  };

  return (
    <div className="flex flex-col h-[60vh] -m-4">
      <div className="flex-1 overflow-y-auto px-4 py-2 space-y-3">
        {messages.length === 0 && (
          <div className="text-zinc-500 text-sm py-8 text-center">
            Tell Nora what you ate. She'll figure out the macros.
          </div>
        )}
        {messages.map((m) => {
          if (m.speaker === "user") {
            return (
              <div key={m.id} className="flex justify-end">
                <div className="rounded-2xl bg-blue-600 text-white px-3 py-2 text-sm max-w-[80%]">
                  {m.content}
                </div>
              </div>
            );
          }
          // nora
          if (m.ui?.mode === "preview" && m.ui.entry_id && drafts[m.ui.entry_id]) {
            const draft = drafts[m.ui.entry_id];
            if (editingId === draft.id) {
              return (
                <MealLoggerEditor
                  key={m.id}
                  entry={draft}
                  onSaved={(u) => {
                    setDrafts((p) => ({ ...p, [u.id]: u }));
                    setEditingId(null);
                  }}
                  onCancel={() => setEditingId(null)}
                />
              );
            }
            return (
              <MealLoggerPreviewCard
                key={m.id}
                entry={draft}
                onCommitted={async () => {
                  // Stamp a "committed" bubble.
                  await supabase
                    .from("chat_messages")
                    .insert({
                      user_id: userId,
                      role: "assistant",
                      content: "",
                      status: "done",
                      speaker: "nora",
                      kind: "meal_log",
                      mode: "meal_log",
                      ui: { mode: "committed", entry_id: draft.id },
                    });
                  setMessages((prev) =>
                    prev.map((x) =>
                      x.id === m.id
                        ? { ...x, ui: { mode: "committed", entry_id: draft.id } }
                        : x,
                    ),
                  );
                  await onCommitted();
                }}
                onCancelled={() => {
                  setMessages((prev) => prev.filter((x) => x.id !== m.id));
                  setDrafts((prev) => {
                    const next = { ...prev };
                    delete next[draft.id];
                    return next;
                  });
                }}
                onEdit={() => setEditingId(draft.id)}
              />
            );
          }
          if (m.ui?.mode === "committed") {
            return (
              <div key={m.id} className="flex">
                <div className="rounded-full bg-emerald-900/60 text-emerald-200 px-3 py-1 text-xs">
                  ✓ logged · {mealSlot}
                </div>
              </div>
            );
          }
          // Plain Nora text (clarifying question from /api/chat).
          return (
            <div key={m.id} className="flex">
              <div className="rounded-2xl bg-zinc-800 text-zinc-200 px-3 py-2 text-sm max-w-[85%]">
                {m.content}
              </div>
            </div>
          );
        })}
      </div>
      <div className="border-t border-zinc-800 px-3 py-2 flex items-center gap-2">
        <button
          type="button"
          onClick={handleVoice}
          className={`px-2 py-1.5 rounded ${recording ? "text-red-400" : "text-zinc-400"}`}
          title="Voice"
        >
          🎤
        </button>
        <button
          type="button"
          onClick={handleBarcode}
          className="px-2 py-1.5 rounded text-zinc-400"
          title="Barcode"
        >
          ⌗
        </button>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Tell Nora what you ate…"
          className="flex-1 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-100 placeholder-zinc-500 text-sm px-3 py-2 focus:outline-none focus:border-zinc-600"
        />
        <button
          type="button"
          disabled={!input.trim() || busy}
          onClick={send}
          className="rounded-lg bg-zinc-100 text-zinc-900 px-3 py-2 text-xs font-medium disabled:opacity-50"
        >
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS. If `chat_messages` insert types reject any field, mirror the existing chat-route inserts in `app/api/chat/route.ts` to match the row shape.

- [ ] **Step 3: Commit**

```bash
git add components/log/MealLoggerChatTab.tsx
git commit -m "feat(meal-log): MealLoggerChatTab — Nora thread + composer (text/voice/barcode)"
```

---

## Task 13: `MealLoggerSheet` restructure + delete dead tabs

Remove TEXT/SCAN/VOICE/ComingSoon tabs. Add CHAT as default. SEARCH and LIBRARY remain.

**Files:**
- Modify: `components/log/MealLoggerSheet.tsx`
- Delete: `components/log/MealLoggerTypeTab.tsx`
- Delete: `components/log/MealLoggerScanTab.tsx`
- Delete: `components/log/MealLoggerComingSoonTab.tsx`

- [ ] **Step 1: Replace the sheet's tab list and tab content switch**

Replace `components/log/MealLoggerSheet.tsx` in full:

```tsx
"use client";
import { useState } from "react";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { MealLoggerChatTab } from "./MealLoggerChatTab";
import { MealLoggerSearchTab } from "./MealLoggerSearchTab";
import { MealLoggerLibraryTab } from "./MealLoggerLibraryTab";
import { HistoryPickerSheet } from "./HistoryPickerSheet";
import { useQueryClient } from "@tanstack/react-query";
import type { MealSlot } from "@/lib/food/types";
import { deriveMealSlot, mealSlotLabel } from "@/lib/food/meal-slot";

type Tab = "chat" | "search" | "library";

export function MealLoggerSheet({
  open,
  onClose,
  userId,
  initialMealSlot,
  initialEatenAt,
}: {
  open: boolean;
  onClose: () => void;
  userId: string;
  initialMealSlot?: MealSlot;
  initialEatenAt?: string;
}) {
  const [tab, setTab] = useState<Tab>("chat");
  const [historyPickerOpen, setHistoryPickerOpen] = useState(false);
  const queryClient = useQueryClient();

  const mealSlot: MealSlot =
    initialMealSlot ?? deriveMealSlot(
      initialEatenAt ? new Date(initialEatenAt) : new Date(),
    );
  const eatenAt = initialEatenAt ?? new Date().toISOString();

  const onCommitted = async () => {
    await queryClient.invalidateQueries({
      predicate: (q) => q.queryKey[0] === "food-entries",
    });
    await queryClient.invalidateQueries({
      predicate: (q) => q.queryKey[0] === "daily-logs",
    });
    await queryClient.invalidateQueries({
      predicate: (q) => q.queryKey[0] === "today-targets",
    });
    // We do NOT auto-close on commit any more — user might want to log
    // another meal in the same thread. Closing is explicit via the sheet's
    // close button.
  };

  const title = initialMealSlot ? `Log ${mealSlotLabel(initialMealSlot)}` : "Log meal";

  return (
    <>
      <BottomSheet open={open} onClose={onClose} title={title}>
        <div className="flex gap-1 border-b border-zinc-800 px-3 pt-2">
          {(["chat", "search", "library"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-3 py-2 text-xs uppercase tracking-wider ${
                tab === t ? "text-zinc-100 border-b-2 border-zinc-100" : "text-zinc-500"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="p-4">
          {tab === "chat" && (
            <MealLoggerChatTab
              userId={userId}
              mealSlot={mealSlot}
              eatenAt={eatenAt}
              onCommitted={onCommitted}
            />
          )}
          {tab === "search" && (
            <MealLoggerSearchTab
              userId={userId}
              mealSlot={mealSlot}
              eatenAt={eatenAt}
              onCommitted={onCommitted}
            />
          )}
          {tab === "library" && (
            <MealLoggerLibraryTab
              userId={userId}
              mealSlot={mealSlot}
              eatenAt={eatenAt}
              onCommitted={onCommitted}
              onPickFromHistory={() => setHistoryPickerOpen(true)}
            />
          )}
        </div>
      </BottomSheet>
      <HistoryPickerSheet
        open={historyPickerOpen}
        onClose={() => setHistoryPickerOpen(false)}
        userId={userId}
        mealSlot={mealSlot}
        eatenAt={eatenAt}
        onCommitted={onCommitted}
      />
    </>
  );
}
```

**Note:** If `MealLoggerLibraryTab` doesn't currently accept `onPickFromHistory`, leave the prop off — keep the existing signature. The intent here is to keep SEARCH and LIBRARY tabs functionally what they were before this refactor.

- [ ] **Step 2: Delete the dead tab files**

```bash
git rm components/log/MealLoggerTypeTab.tsx components/log/MealLoggerScanTab.tsx components/log/MealLoggerComingSoonTab.tsx
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS. If anything imports the deleted tabs, that error surfaces here — search the project for `MealLoggerTypeTab`, `MealLoggerScanTab`, `MealLoggerComingSoonTab` and remove any stale imports.

```bash
grep -rn "MealLoggerTypeTab\|MealLoggerScanTab\|MealLoggerComingSoonTab" --include="*.ts" --include="*.tsx" app components lib
```

Expected after deletion: no matches.

- [ ] **Step 4: Commit**

```bash
git add components/log/MealLoggerSheet.tsx
git commit -m "feat(meal-log): MealLoggerSheet → CHAT default; drop TEXT/SCAN/VOICE tabs"
```

---

## Task 14: `MealSlotCard` recipe collapse rendering

When an entry carries `recipe_id`, show the recipe's name as the collapsed header instead of the list of items. Tap to expand.

**Files:**
- Modify: `components/meal/MealSlotCard.tsx`

- [ ] **Step 1: Inspect the current MealSlotCard**

```bash
grep -n "function MealSlotCard\|items\.map\|items\[" components/meal/MealSlotCard.tsx | head -10
```

Read enough to understand the current rendering shape: the card receives an entry (or entries) and renders item lines.

- [ ] **Step 2: Add recipe-collapse handling**

Inside the render, where the existing code iterates `entry.items`, add a check at the top: if `entry.recipe_id` is non-null, fetch the recipe name once via `/api/food/library?q=` (or a dedicated `/api/food/library/[id]`-style GET that returns one row — Task 7's `[id]` route only has PATCH/DELETE, so add a GET if the existing one isn't enough; or join in the page server-prefetch).

Simpler: extend the existing food-entries fetcher to join `user_food_items.name` for the recipe.

**Pragmatic v1 path:** the `recipe_id` column is now present and the journal *displays* it (no name lookup) — just show a small "📋 recipe" pill on entries with `recipe_id` set, and keep the expanded items list as the body. Full recipe-name lookup ships in a follow-up.

```tsx
{entry.recipe_id && (
  <span className="ml-2 rounded bg-zinc-800 text-zinc-400 px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
    recipe
  </span>
)}
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add components/meal/MealSlotCard.tsx
git commit -m "feat(meal-journal): recipe pill on entries with recipe_id"
```

---

## Task 15: Manage Library page

A small page at `/profile/library` listing the user's `user_food_items`, with inline edit/delete. SSR-hydrate pattern per the project's TanStack Query conventions.

**Files:**
- Create: `lib/query/keys.ts` (modify — add `foodLibrary` key family)
- Create: `lib/query/fetchers/foodLibrary.ts`
- Create: `lib/query/hooks/useFoodLibrary.ts`
- Create: `app/profile/library/page.tsx`
- Create: `components/profile/LibraryClient.tsx`

- [ ] **Step 1: Add the key family**

In `lib/query/keys.ts`, add to the existing `queryKeys` object:

```ts
  foodLibrary: {
    all: (userId: string) => ["food-library", userId] as const,
    search: (userId: string, q: string) => ["food-library", userId, q] as const,
  },
```

- [ ] **Step 2: Write the fetchers**

Create `lib/query/fetchers/foodLibrary.ts`:

```ts
// lib/query/fetchers/foodLibrary.ts
//
// Server + browser fetchers for user_food_items. Same select shape on both
// variants; both throw on Supabase error so TanStack Query lights up isError.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { UserFoodItem } from "@/lib/food/types";

const SELECT = "id, user_id, name, per_100g, composite_of, default_serving_g, source, notes, created_at, updated_at";

export async function fetchFoodLibraryServer(
  supabase: SupabaseClient,
  userId: string,
): Promise<UserFoodItem[]> {
  const { data, error } = await supabase
    .from("user_food_items")
    .select(SELECT)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as UserFoodItem[];
}

export async function fetchFoodLibraryBrowser(
  supabase: SupabaseClient,
  userId: string,
): Promise<UserFoodItem[]> {
  const { data, error } = await supabase
    .from("user_food_items")
    .select(SELECT)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as UserFoodItem[];
}
```

- [ ] **Step 3: Write the hook**

Create `lib/query/hooks/useFoodLibrary.ts`:

```ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { fetchFoodLibraryBrowser } from "@/lib/query/fetchers/foodLibrary";
import { queryKeys } from "@/lib/query/keys";

export function useFoodLibrary(userId: string) {
  const supabase = createSupabaseBrowserClient();
  return useQuery({
    queryKey: queryKeys.foodLibrary.all(userId),
    queryFn: () => fetchFoodLibraryBrowser(supabase, userId),
  });
}
```

- [ ] **Step 4: Write the page (server component)**

Create `app/profile/library/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { fetchFoodLibraryServer } from "@/lib/query/fetchers/foodLibrary";
import { queryKeys } from "@/lib/query/keys";
import { LibraryClient } from "@/components/profile/LibraryClient";

export const dynamic = "force-dynamic";

export default async function LibraryPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const queryClient = makeServerQueryClient();
  await queryClient.prefetchQuery({
    queryKey: queryKeys.foodLibrary.all(user.id),
    queryFn: () => fetchFoodLibraryServer(supabase, user.id),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <LibraryClient userId={user.id} />
    </HydrationBoundary>
  );
}
```

- [ ] **Step 5: Write the client component**

Create `components/profile/LibraryClient.tsx`:

```tsx
"use client";
import { useState } from "react";
import { useFoodLibrary } from "@/lib/query/hooks/useFoodLibrary";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fmtNum } from "@/lib/ui/score";
import type { UserFoodItem } from "@/lib/food/types";

export function LibraryClient({ userId }: { userId: string }) {
  const { data: items, isLoading, isError } = useFoodLibrary(userId);
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this library item? Past logs are kept.")) return;
    setBusyId(id);
    const res = await fetch(`/api/food/library/${id}`, { method: "DELETE" });
    if (res.ok) {
      await queryClient.invalidateQueries({ queryKey: queryKeys.foodLibrary.all(userId) });
    }
    setBusyId(null);
  };

  if (isLoading) return <div className="p-4 text-zinc-500">Loading…</div>;
  if (isError) return <div className="p-4 text-amber-400">Couldn't load library.</div>;
  const rows = items ?? [];

  return (
    <main className="px-4 py-6 max-w-2xl mx-auto">
      <h1 className="text-xl font-semibold text-zinc-100 mb-1">My Library</h1>
      <p className="text-zinc-500 text-sm mb-6">
        Saved foods and recipes. These resolve first when you log meals.
      </p>
      {rows.length === 0 && (
        <div className="text-zinc-600 text-sm py-12 text-center">
          Nothing saved yet. Use "Save to library" in the meal log to add items.
        </div>
      )}
      <ul className="space-y-2">
        {rows.map((it: UserFoodItem) => {
          const isRecipe = it.composite_of !== null;
          return (
            <li
              key={it.id}
              className="rounded-2xl bg-zinc-900 border border-zinc-800 p-3 text-sm"
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-zinc-100 truncate">{it.name}</div>
                  <div className="text-xs text-zinc-500 mt-0.5">
                    {isRecipe
                      ? `Recipe · ${it.composite_of?.length ?? 0} ingredients · default ${fmtNum(it.default_serving_g ?? 0)}g`
                      : `${fmtNum(it.per_100g?.kcal ?? 0)} kcal · ${fmtNum(it.per_100g?.protein_g ?? 0)}P / 100g`}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busyId === it.id}
                  onClick={() => handleDelete(it.id)}
                  className="text-zinc-500 hover:text-amber-400 text-xs"
                >
                  {busyId === it.id ? "…" : "Delete"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
```

- [ ] **Step 6: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS. If `makeServerQueryClient` is named differently in `lib/query/queryClient.ts`, adjust the import.

- [ ] **Step 7: Commit**

```bash
git add lib/query/keys.ts lib/query/fetchers/foodLibrary.ts lib/query/hooks/useFoodLibrary.ts app/profile/library/page.tsx components/profile/LibraryClient.tsx
git commit -m "feat(profile): /profile/library — Manage Library page"
```

---

## Task 16: Cache purge + audit scripts

Two operational scripts. The purge is one-shot to clean OFF-poisoned rows; the audit verifies the resolver's quality on a fixed vocabulary.

**Files:**
- Create: `scripts/purge-low-precision-off-cache.mjs`
- Create: `scripts/audit-meal-logging-resolve.mjs`

- [ ] **Step 1: Write the purge script**

Create `scripts/purge-low-precision-off-cache.mjs`:

```js
// scripts/purge-low-precision-off-cache.mjs
//
// One-shot cleanup. Iterates food_db_cache rows where source='openfoodfacts'
// and computes token-overlap precision of name against the FIRST TOKEN of
// the name (synthetic short query). Rows whose precision is below 0.5 are
// noisy hits — packaged products that overlap weakly with the canonical
// food name. Deletes them (--apply) or just reports (--dry, default).
//
// Run via:
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//        --env-file=.env.local scripts/purge-low-precision-off-cache.mjs [--apply]

import { createClient } from "@supabase/supabase-js";

const STOPWORDS = new Set(["of", "the", "and", "a", "or", "with", "in"]);
const tokenize = (s) =>
  s.toLowerCase()
    .split(/[\s,.\-/()]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));

const apply = process.argv.includes("--apply");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const sr = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !sr) {
  console.error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const sb = createClient(url, sr);

const { data, error } = await sb
  .from("food_db_cache")
  .select("canonical_id, source, name")
  .eq("source", "openfoodfacts")
  .limit(1000);
if (error) {
  console.error("Read failed", error);
  process.exit(1);
}

const offenders = [];
for (const row of data) {
  const tokens = tokenize(row.name);
  if (tokens.length === 0) continue;
  const firstToken = tokens[0];
  // Synthetic query = first token. precision = |{firstToken} ∩ tokens| / |tokens|.
  const precision = tokens.includes(firstToken) ? 1 / tokens.length : 0;
  if (precision < 0.5) {
    offenders.push({ canonical_id: row.canonical_id, name: row.name, tokens: tokens.length, precision });
  }
}

console.log(`Found ${offenders.length} low-precision OFF rows (precision < 0.5).`);
for (const o of offenders.slice(0, 25)) {
  console.log(`  ${o.precision.toFixed(2)} | ${o.tokens} toks | ${o.name}`);
}
if (offenders.length > 25) console.log(`  ...and ${offenders.length - 25} more.`);

if (!apply) {
  console.log("\nDry run — pass --apply to delete.");
  process.exit(0);
}

const ids = offenders.map((o) => o.canonical_id);
const { error: delErr } = await sb.from("food_db_cache").delete().in("canonical_id", ids);
if (delErr) {
  console.error("Delete failed", delErr);
  process.exit(1);
}
console.log(`Deleted ${ids.length} rows.`);
```

- [ ] **Step 2: Write the audit script**

Create `scripts/audit-meal-logging-resolve.mjs`:

```js
// scripts/audit-meal-logging-resolve.mjs
//
// Regression audit for resolveItemMacros. Runs a fixed vocabulary covering
// known traps and prints per-item: source, name returned, per-100g macros,
// confidence. Set AUDIT_USER_ID env var (a real user id).
//
// Run via:
//   AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs \
//     --experimental-strip-types --env-file=.env.local \
//     scripts/audit-meal-logging-resolve.mjs

import { resolveItemMacros } from "@/lib/food/lookup";

const userId = process.env.AUDIT_USER_ID;
if (!userId) {
  console.error("Set AUDIT_USER_ID env var (a real user uuid).");
  process.exit(1);
}

const VOCAB = [
  // British spellings — should hit USDA via spelling fallback
  "omelette", "yoghurt", "courgette", "aubergine", "prawn",
  // Single-token foods — should hit USDA cleanly
  "chicken", "rice", "banana", "egg", "broccoli",
  // Brand-vs-generic — should ideally hit user library if saved
  "halloumi", "greek yogurt", "peanut butter",
  // Foods we expect LLM fallback for
  "m'semen", "tagine chicken", "harira",
];

for (const q of VOCAB) {
  try {
    const r = await resolveItemMacros(q, 100, userId);
    console.log(
      [
        q.padEnd(20),
        (r.db_ref?.source ?? "llm").padEnd(14),
        r.confidence?.padEnd(7) ?? "n/a    ",
        r.name.padEnd(45).slice(0, 45),
        `${Math.round(r.kcal)}kcal`,
        `${r.protein_g.toFixed(1)}P`,
        `${r.carbs_g.toFixed(1)}C`,
        `${r.fat_g.toFixed(1)}F`,
      ].join("  "),
    );
  } catch (e) {
    console.error(`${q}: FAIL — ${(e).message}`);
  }
}
```

- [ ] **Step 3: Run the purge (dry-run first)**

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/purge-low-precision-off-cache.mjs
```

Expected: prints a list of OFF rows with low precision. Eyeball the list — entries like "spanish spinach omelette (unearthed)" should appear if they exist. If the list looks right, re-run with `--apply`:

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/purge-low-precision-off-cache.mjs --apply
```

Expected: prints `Deleted N rows.`

- [ ] **Step 4: Run the audit**

```bash
AUDIT_USER_ID=<your-uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-meal-logging-resolve.mjs
```

Expected: for `omelette`, shows `usda  high   Egg, whole, cooked, omelet ... 154kcal 10.6P 0.6C 11.7F`. For `chicken`, hits USDA. For `m'semen`, falls through to `llm low`. Capture this output — it's the regression baseline.

- [ ] **Step 5: Commit**

```bash
git add scripts/purge-low-precision-off-cache.mjs scripts/audit-meal-logging-resolve.mjs
git commit -m "chore(food): cache purge + meal-logging resolve audit scripts"
```

---

## Task 17: CLAUDE.md update + manual UI verification

Document the new chain order and `user_food_items` in the project README so future sessions don't relitigate. Then exercise the UI end-to-end.

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md**

Find the "In-app food logging" paragraph (search for `**In-app food logging**` near the database-migrations list). Append a new sub-paragraph after the existing v1.1 additions block:

```md
  - **v1.2 — Nora-led chat thread + personal library (this arc)**: Replaces the one-shot TEXT tab in MealLoggerSheet with a daily-continuous Nora chat thread (`chat_messages.kind='meal_log'`, mode='meal_log'). The resolution chain is now `user_food_items → food_db_cache → USDA (with British→US spelling fallback) → LLM`; OFF is removed from text-resolve (kept for `/api/food/barcode` only). `user_food_items` is a per-user table storing single items (per_100g macros) or recipes (composite_of jsonb), unified by a `(per_100g IS NOT NULL) <> (composite_of IS NOT NULL)` constraint. Library hits beat USDA in both `resolveItemMacros` and `searchFoods` (SOURCE_RANK = user_library:0 → db:1 → usda:2 → off:3). `food_log_entries.recipe_id` back-references the library row when a meal was logged via a saved recipe. Nora's meal-log mode has three tools: `search_library`, `pick_library_item`, `save_to_library`. Confirm-gate is strict in v1: every preview requires explicit Confirm. Audit: `AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-meal-logging-resolve.mjs`. Spec: [docs/superpowers/specs/2026-05-21-meal-logging-chat-revamp-design.md](docs/superpowers/specs/2026-05-21-meal-logging-chat-revamp-design.md).
```

Also add migration 0027 to the migrations list at the top of CLAUDE.md (after 0026):

```md
27. [supabase/migrations/0027_meal_logging_chat_revamp.sql](supabase/migrations/0027_meal_logging_chat_revamp.sql) — adds `user_food_items` (per-user library: single items via `per_100g` OR recipes via `composite_of`, exclusive via CHECK); `food_log_entries.recipe_id` back-reference; extends `chat_messages_kind_check` with `'meal_log'`; replaces `chat_messages_visible_idx` to filter out `meal_log` from default /coach history (now excludes both `system_routing` and `meal_log`).
```

- [ ] **Step 2: Manual UI verification**

Start dev:

```bash
npm run dev
```

Open http://localhost:3000/meal. Run through this checklist:

  - [ ] Tap "+ Log entry" on the Lunch slot. Sheet opens with CHAT tab focused.
  - [ ] Type `200g chicken breast and a cup rice`. Send. Preview card appears with two items, both showing no "est." marker. Tap Confirm. "✓ logged · lunch" bubble appears, journal underneath updates.
  - [ ] Re-open sheet. Type `omelette`. Preview shows the USDA "Egg, whole, cooked, omelet" line at ~154 kcal/100g (with the spelling fallback firing). Confirm.
  - [ ] Re-open sheet. Type `halloumi` (low-fat). The first item may come back as `medium` confidence. Nora's clarifying bubble (or just a low-confidence "est." marker) should appear. Tap Edit → adjust qty → Save → Confirm.
  - [ ] Tap "+" on a different slot (Dinner). Confirm the same thread shows, but the next entry's meal_slot is Dinner. Close sheet, journal shows the Dinner card updated.
  - [ ] Navigate to /profile/library. List shows entries you saved (if any). Delete one. Reload — gone.
  - [ ] On a meal that you logged via a (manually-inserted, for now) recipe, the journal card shows the small "recipe" pill.
  - [ ] In /coach, the meal_log messages do not appear in the default history view.

If any step fails, fix the underlying issue and re-verify before continuing.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md notes for meal-logging chat revamp + migration 0027"
```

- [ ] **Step 4: Final summary**

Run:

```bash
git log --oneline 0027.. 2>/dev/null || git log --oneline -20
```

You should see ~17 commits covering: migration, types, spelling, library helpers, lookup chain, search, library API, draft items API, parse route, Nora mode, preview/editor, chat tab, sheet restructure, slot card, library page, scripts, docs.

---

## Notes for executor

- **No tests:** This project has no automated test runner. Every task ends with `npm run typecheck` instead of a test command. The final verification step (Task 17 Step 2) is the manual UI exercise — treat it as the integration test.
- **Schema drift:** If `supabase db push` reports the migration already applied, run `supabase migration repair --status applied 0027` first.
- **`chat_messages` insert shape:** The bare-bones inserts in `MealLoggerChatTab.tsx` assume the existing `chat_messages` columns. If TypeScript flags missing fields (`coach`, `thread`, etc.), mirror what the existing `/api/chat` route inserts.
- **Voice / barcode in the composer:** The v1 voice uses `webkitSpeechRecognition` directly (works in Safari + Chrome). Barcode falls back to a `prompt()` for UPC entry — replacing it with a camera component is a follow-up out of scope.
- **`/api/chat` `mode='meal_log'` payload:** The chat tab's "fire-and-forget" POST to `/api/chat` assumes the existing chat route accepts `{ mode, speaker, message }` and propagates `mode` to `runChatStream` (the existing `plan_week` / `setup_block` / `intake` modes already exercise this path). If the actual route requires a thread id or assistant message stub, adapt to match.
- **OFF removal scope:** Don't delete `lookupOpenFoodFacts` itself — it's still called from `lib/food/search.ts` (the SEARCH tab fan-out) and `app/api/food/barcode/route.ts`. Only its participation in `resolveItemMacros` is removed.

### Deferred to follow-up (in spec but not in this plan)

These items are in the spec but intentionally postponed to keep this arc shippable. Open follow-up tasks for each before declaring the spec fully closed.

- **2+-similar-meals smart-offer trigger.** The spec describes "after the second commit of a similar combo in a week, Nora's next post-commit bubble appends 'Save as a recipe?'". The data plumbing for this (recipe storage, save_to_library tool) is in place; what's missing is the deterministic `find_similar_recent_entries(items, days=7)` helper + the post-commit bubble emission. v1 still supports the manual save path (the save_to_library tool + the Manage Library page); the *automatic offer* is what's deferred.
- **Recipe-name display in the journal.** Task 14 ships a `recipe` pill on rows with `recipe_id` set; the spec describes the row collapsing under the recipe's name with ingredient expansion on tap. Needs a join (or a name lookup) wired into `fetchFoodEntries`. Strictly cosmetic.
- **24h orphan-draft cleanup cron.** The spec mentions an existing draft-expiry job (or a new 24h cleanup cron). v1 leaves drafts in place — the Cancel button is the manual cleanup path, and the absence of stale drafts from `sum_food_entries` (which only counts `status='committed'`) means there's no accounting bug, just clutter.
