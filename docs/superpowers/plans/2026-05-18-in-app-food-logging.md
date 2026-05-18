# In-app Food Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Spec A foundation of the in-app food logging feature — text + barcode modalities, USDA + OpenFoodFacts food DB integration with Haiku 4.5 fallback, item-level `food_log_entries` table with aggregation into `daily_logs`, MealLoggerSheet UI from the existing Fab, and additive coach-data hooks (chat tool, morning brief context, weekly review composer). Yazio CSV ingest deprecated to legacy-fallback. Photo (Spec B) and voice (Spec C) UI tabs ship greyed-out for forward compat.

**Architecture:** Four-modality pipeline collapsing to one shape: parse → resolve macros → preview → commit → aggregate. The parse step is modality-specific (Haiku 4.5 text extraction / OpenFoodFacts UPC lookup). All paths converge on `lib/food/lookup.ts:resolveItemMacros` which tries cache → USDA → LLM fallback. Commit calls a Postgres `sum_food_entries` function and upserts `daily_logs` nutrition columns so existing surfaces (morning brief, weekly review, dashboard) consume the new data unchanged.

**Tech Stack:** Next.js 15 App Router, Supabase (Postgres + RLS + `pg_trgm` extension), TanStack Query (hybrid SSR-hydrate pattern), Anthropic SDK (Haiku 4.5 via `callClaude` + `parseClaudeJson`), Tailwind v4. New external integrations: USDA FoodData Central API (free, signup) + OpenFoodFacts API (no key). No test framework exists in this project — verification uses `npm run typecheck` + manual exercise via `npm run dev` + a smoke harness script per pure module under `scripts/`.

**Spec:** [docs/superpowers/specs/2026-05-18-in-app-food-logging-design.md](../specs/2026-05-18-in-app-food-logging-design.md).

---

## Pre-flight

- [ ] **Pre-flight 1: Create worktree (recommended)**

  ```bash
  git worktree add -b feat/food-logging ../health-app-food-logging main
  cd ../health-app-food-logging
  npm install
  cp ../Health\ app/.env.local .env.local
  ```

  Continue work in the worktree. Cleanup via `git worktree remove` once merged.

- [ ] **Pre-flight 2: Verify clean baseline**

  ```bash
  npm run typecheck
  ```

  Expected: exits 0. If it doesn't, stop and fix unrelated breakage before continuing.

- [ ] **Pre-flight 3: Sign up for USDA FoodData Central API key**

  Visit https://fdc.nal.usda.gov/api-key-signup.html, fill the form, receive key by email (instant). Add to `.env.local`:

  ```bash
  USDA_FDC_API_KEY=your_key_here
  ```

  Also add the same key to Vercel env (Production + Preview) before merging. Free tier allows 1000 req/hour, plenty for single-user.

---

## File Structure

**New files (23):**

```
supabase/migrations/0018_food_logging.sql

lib/food/lookup.ts            — resolveItemMacros (cache → USDA → LLM fallback)
lib/food/parse.ts             — Haiku 4.5 text extraction
lib/food/barcode.ts           — OpenFoodFacts fetcher
lib/food/aggregate.ts         — sum_food_entries wrapper + daily_logs upsert
lib/food/types.ts             — FoodLogEntry, FoodItem, FoodDbCacheRow, etc.

app/api/food/parse/route.ts
app/api/food/barcode/route.ts
app/api/food/commit/route.ts
app/api/food/entries/route.ts          — GET list for date range
app/api/food/entries/[id]/route.ts     — PATCH (qty edits) + DELETE

lib/query/fetchers/foodEntries.ts
lib/query/hooks/useFoodEntries.ts

components/log/MealLoggerSheet.tsx     — bottom sheet with 4 tabs
components/log/MealLoggerTypeTab.tsx
components/log/MealLoggerScanTab.tsx
components/log/MealLoggerComingSoonTab.tsx
components/log/TodaysMeals.tsx         — list block on /log
components/log/FoodEntryEditSheet.tsx  — qty-edit / delete sheet

scripts/smoke-food-lookup.mjs          — pure-function smoke harness
scripts/smoke-food-parse.mjs           — Haiku extraction smoke (live API)
scripts/audit-food-aggregation.mjs     — read-only audit
```

**Modified files (10):**

```
lib/query/keys.ts                                   — add foodEntries key family
lib/coach/tools.ts                                  — register query_food_log
lib/coach/system-prompts.ts                         — extend SCHEMA_EXPLAINER
lib/morning/brief/advice-prompt.ts                  — accept topItems context
lib/morning/brief/assembler.ts                      — pass topItems through
lib/morning/brief/index.ts                          — fetch + compute topItems
lib/coach/weekly-review/compose-trends.ts           — optional top_items field
lib/coach/weekly-review/narrative-prompt.ts         — conditional top_items line
app/api/ingest/health/route.ts                      — Yazio precedence check
components/profile/IngestPanel.tsx                  — Yazio opt-out toggle
app/log/page.tsx (and components/log/LogClient.tsx) — render TodaysMeals
components/layout/BottomNav.tsx (or Fab host)       — wire "Log meal" entry
CLAUDE.md                                           — new sub-section + migration entry
```

---

## Task 1: Migration 0018 — tables, function, RLS, profiles flag

**Files:**
- Create: `supabase/migrations/0018_food_logging.sql`

- [ ] **Step 1.1: Write the migration**

  Create `supabase/migrations/0018_food_logging.sql`:

  ```sql
  -- 0018_food_logging.sql
  --
  -- In-app food logging foundation (Spec A).
  --
  -- Adds:
  --   - food_log_entries: per-event item-level log (text, barcode, photo, voice)
  --   - food_db_cache: shared cache of external food-DB lookups
  --   - sum_food_entries(user_id, date): aggregation helper called from commit route
  --   - profiles.disable_yazio_ingest: per-user opt-out for the legacy Yazio path
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
  -- Day-bucketing uses UTC; see plan task 6 for the eaten_at → date conversion
  -- the route handler does (passes p_date computed in the user's local TZ).
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
  ```

- [ ] **Step 1.2: Apply via Supabase CLI**

  ```bash
  supabase db push
  ```

  Expected: prints `Applying migration 20260518_food_logging.sql` (timestamp prefix added by CLI) and exits 0.

  If `supabase db push` reports an existing-history mismatch, run:

  ```bash
  supabase migration repair --status applied <previous_migration_id>
  ```

  Then retry push.

- [ ] **Step 1.3: Verify schema in Dashboard**

  Open Supabase Dashboard → Table Editor. Confirm `food_log_entries` and `food_db_cache` are listed. Open SQL Editor and run:

  ```sql
  select sum_food_entries(auth.uid(), current_date);
  ```

  Expected: returns `{}` (no entries yet) without error.

- [ ] **Step 1.4: Commit**

  ```bash
  git add supabase/migrations/0018_food_logging.sql
  git commit -m "feat(food-log): migration 0018 — food_log_entries + food_db_cache + sum function"
  ```

---

## Task 2: TypeScript types for food log

**Files:**
- Create: `lib/food/types.ts`
- Modify: `lib/data/types.ts:end-of-file` (add re-export comment, not actual export — types live in lib/food/)

- [ ] **Step 2.1: Write the types module**

  Create `lib/food/types.ts`:

  ```ts
  // lib/food/types.ts
  //
  // Type shapes for the food logging feature. Mirrors the jsonb columns on
  // food_log_entries + food_db_cache. Kept here (not in lib/data/types.ts)
  // because they're narrowly used by lib/food/* and the food UI; the broader
  // DailyLog types stay in lib/data/types.ts.

  export type FoodMacros = {
    kcal: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    fiber_g: number;
  };

  export type FoodItem = {
    name: string;
    qty_g: number;
    /** Macros at qty_g (computed: per_100g × qty_g / 100). */
    kcal: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    fiber_g: number;
    /** Per-100g values — kept on the item so client-side qty rescale doesn't need a round-trip. */
    per_100g: FoodMacros;
    source: "db" | "llm";
    db_ref: {
      source: "usda" | "openfoodfacts" | "manual";
      canonical_id: string;
    } | null;
    confidence: "high" | "medium" | "low" | null;
  };

  export type FoodLogEntryKind = "text" | "barcode" | "photo" | "voice";
  export type FoodLogEntryStatus = "draft" | "committed" | "rejected";

  export type FoodLogEntryRawInput =
    | { kind: "text"; text: string }
    | { kind: "barcode"; upc: string; qty_g: number }
    | { kind: "photo"; photo_path: string }
    | { kind: "voice"; audio_path: string; transcript: string };

  export type FoodLogEntry = {
    id: string;
    user_id: string;
    eaten_at: string;
    kind: FoodLogEntryKind;
    raw_input: FoodLogEntryRawInput;
    items: FoodItem[];
    totals: FoodMacros;
    is_estimated: boolean;
    status: FoodLogEntryStatus;
    created_at: string;
    updated_at: string;
  };

  export type FoodDbCacheRow = {
    canonical_id: string;
    source: "usda" | "openfoodfacts" | "manual";
    upc: string | null;
    name: string;
    per_100g: FoodMacros;
    serving_size_g: number | null;
    raw_payload: unknown;
    last_fetched_at: string;
  };

  /** Default macros object — used as zero for sums/initializations. */
  export const ZERO_MACROS: FoodMacros = {
    kcal: 0,
    protein_g: 0,
    carbs_g: 0,
    fat_g: 0,
    fiber_g: 0,
  };

  export function sumMacros(items: Array<{ kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number }>): FoodMacros {
    return items.reduce<FoodMacros>(
      (acc, it) => ({
        kcal:      acc.kcal      + it.kcal,
        protein_g: acc.protein_g + it.protein_g,
        carbs_g:   acc.carbs_g   + it.carbs_g,
        fat_g:     acc.fat_g     + it.fat_g,
        fiber_g:   acc.fiber_g   + it.fiber_g,
      }),
      { ...ZERO_MACROS },
    );
  }

  /** Scale per-100g macros to a given qty in grams. */
  export function macrosForQty(per_100g: FoodMacros, qty_g: number): FoodMacros {
    const k = qty_g / 100;
    return {
      kcal:      per_100g.kcal      * k,
      protein_g: per_100g.protein_g * k,
      carbs_g:   per_100g.carbs_g   * k,
      fat_g:     per_100g.fat_g     * k,
      fiber_g:   per_100g.fiber_g   * k,
    };
  }
  ```

- [ ] **Step 2.2: Typecheck**

  ```bash
  npm run typecheck
  ```

  Expected: exits 0.

- [ ] **Step 2.3: Commit**

  ```bash
  git add lib/food/types.ts
  git commit -m "feat(food-log): type shapes for FoodItem, FoodLogEntry, FoodDbCacheRow"
  ```

---

## Task 3: `lib/food/lookup.ts` — resolveItemMacros (cache → USDA → LLM fallback)

**Files:**
- Create: `lib/food/lookup.ts`
- Create: `scripts/smoke-food-lookup.mjs`

- [ ] **Step 3.1: Write the lookup module**

  Create `lib/food/lookup.ts`:

  ```ts
  // lib/food/lookup.ts
  //
  // resolveItemMacros: name + qty_g → FoodItem
  //
  // Lookup chain:
  //   1. food_db_cache trigram match on name (similarity ≥ TRGM_THRESHOLD)
  //   2. USDA FoodData Central /foods/search (writes back to cache on success)
  //   3. Haiku 4.5 estimates per_100g macros (NOT cached — only verified DB
  //      sources go to cache)
  //
  // Returns a fully-populated FoodItem with macros scaled to qty_g.

  import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
  import { callClaude, parseClaudeJson } from "@/lib/anthropic/client";
  import { SHORT_FORM_MODEL } from "@/lib/anthropic/models";
  import { macrosForQty, type FoodItem, type FoodMacros, type FoodDbCacheRow } from "@/lib/food/types";

  /** Minimum trigram similarity for a cache match to count. Tune during use. */
  const TRGM_THRESHOLD = 0.6;

  /** USDA FDC search endpoint. Returns Foundation + SR Legacy + Survey foods
   *  by default — the canonical "raw ingredients" datasets. */
  const USDA_SEARCH_URL = "https://api.nal.usda.gov/fdc/v1/foods/search";

  type UsdaFood = {
    fdcId: number;
    description: string;
    foodNutrients?: Array<{
      nutrientId?: number;
      nutrientName?: string;
      nutrientNumber?: string;
      value?: number;
      unitName?: string;
    }>;
    servingSize?: number;
    servingSizeUnit?: string;
  };

  /** USDA nutrient numbers we care about. */
  const NUTRIENT_NUM = {
    energy_kcal: "208",
    protein_g:   "203",
    carbs_g:     "205",
    fat_g:       "204",
    fiber_g:     "291",
  } as const;

  function extractUsdaMacros(food: UsdaFood): FoodMacros {
    const get = (num: string): number => {
      const n = food.foodNutrients?.find((x) => x.nutrientNumber === num);
      return typeof n?.value === "number" ? n.value : 0;
    };
    return {
      kcal:      get(NUTRIENT_NUM.energy_kcal),
      protein_g: get(NUTRIENT_NUM.protein_g),
      carbs_g:   get(NUTRIENT_NUM.carbs_g),
      fat_g:     get(NUTRIENT_NUM.fat_g),
      fiber_g:   get(NUTRIENT_NUM.fiber_g),
    };
  }

  async function lookupCacheByName(name: string): Promise<FoodDbCacheRow | null> {
    const supabase = createSupabaseServiceRoleClient();
    // Use pg_trgm similarity. Order by similarity desc, limit 1.
    const { data, error } = await supabase
      .rpc("food_cache_similar", { q: name, threshold: TRGM_THRESHOLD })
      .maybeSingle();
    if (error) {
      // If the RPC doesn't exist (didn't ship in 0018), fall back to ilike.
      const fallback = await supabase
        .from("food_db_cache")
        .select("*")
        .ilike("name", `%${name}%`)
        .limit(1)
        .maybeSingle();
      if (fallback.error) return null;
      return (fallback.data as FoodDbCacheRow | null) ?? null;
    }
    return (data as FoodDbCacheRow | null) ?? null;
  }

  async function lookupUsda(name: string): Promise<FoodDbCacheRow | null> {
    const apiKey = process.env.USDA_FDC_API_KEY;
    if (!apiKey) {
      console.warn("[food-lookup] USDA_FDC_API_KEY not set — skipping USDA");
      return null;
    }
    const url = `${USDA_SEARCH_URL}?api_key=${encodeURIComponent(apiKey)}&query=${encodeURIComponent(name)}&pageSize=1&dataType=Foundation,SR%20Legacy`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[food-lookup] USDA ${res.status} for query "${name}"`);
      return null;
    }
    const data = (await res.json()) as { foods?: UsdaFood[] };
    const top = data.foods?.[0];
    if (!top) return null;

    const per_100g = extractUsdaMacros(top);
    // USDA Foundation/SR Legacy values are per 100g for energy/macros.

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
    return inserted as FoodDbCacheRow;
  }

  async function llmEstimate(name: string): Promise<FoodMacros> {
    const prompt = `You are a nutrition reference. Return per-100g macros for the food described below as STRICT JSON, no commentary.

Schema: {"kcal": number, "protein_g": number, "carbs_g": number, "fat_g": number, "fiber_g": number}

Food: "${name}"

If the food is ambiguous, pick the most common prepared form.`;
    const raw = await callClaude([{ role: "user", content: prompt }], {
      model: SHORT_FORM_MODEL,
      maxTokens: 200,
      temperature: 0,
    });
    return parseClaudeJson<FoodMacros>(raw);
  }

  export async function resolveItemMacros(name: string, qty_g: number): Promise<FoodItem> {
    // 1. cache
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
      };
    }
    // 2. USDA
    const usda = await lookupUsda(name);
    if (usda) {
      const macros = macrosForQty(usda.per_100g, qty_g);
      return {
        name: usda.name,
        qty_g,
        ...macros,
        per_100g: usda.per_100g,
        source: "db",
        db_ref: { source: "usda", canonical_id: usda.canonical_id },
        confidence: "high",
      };
    }
    // 3. LLM fallback
    const per_100g = await llmEstimate(name);
    const macros = macrosForQty(per_100g, qty_g);
    return {
      name,
      qty_g,
      ...macros,
      per_100g,
      source: "llm",
      db_ref: null,
      confidence: "low",
    };
  }
  ```

- [ ] **Step 3.2: Verify `food_cache_similar` RPC exists**

  The RPC was added in Task 1's migration. Confirm it's callable: in Supabase Dashboard SQL Editor, run:

  ```sql
  select food_cache_similar('chicken breast', 0.3);
  ```

  Expected: 0 rows (cache empty), no error. If the function doesn't exist, re-check Task 1 migration content and re-apply.

- [ ] **Step 3.3: Write smoke harness**

  Create `scripts/smoke-food-lookup.mjs`:

  ```js
  #!/usr/bin/env node
  // scripts/smoke-food-lookup.mjs
  //
  // Smoke test for lib/food/lookup.ts. Hits the real USDA API + Anthropic API.
  // Run via:
  //   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
  //        --env-file=.env.local scripts/smoke-food-lookup.mjs
  //
  // Asserts: chicken breast resolves via USDA, returns kcal in 150-180/100g
  // range; an obviously made-up food falls back to LLM with source='llm'.

  import assert from "node:assert/strict";
  import { resolveItemMacros } from "../lib/food/lookup.ts";

  console.log("→ resolveItemMacros('chicken breast grilled', 200)");
  const chicken = await resolveItemMacros("chicken breast grilled", 200);
  console.log("  result:", chicken);
  assert.equal(chicken.source, "db", "chicken should hit DB (USDA or cache)");
  assert.ok(chicken.kcal > 200 && chicken.kcal < 500, "chicken 200g kcal should be 200-500");
  assert.ok(chicken.protein_g > 30, "chicken 200g protein should be >30g");

  console.log("\n→ resolveItemMacros('obscure homemade galaxy stew', 250)");
  const obscure = await resolveItemMacros("obscure homemade galaxy stew", 250);
  console.log("  result:", obscure);
  assert.equal(obscure.source, "llm", "obscure food should fall back to LLM");
  assert.equal(obscure.confidence, "low", "LLM fallback should be low confidence");
  assert.ok(obscure.kcal > 0, "LLM should return non-zero kcal");

  console.log("\n✓ smoke-food-lookup passed");
  ```

  Make executable: `chmod +x scripts/smoke-food-lookup.mjs`

- [ ] **Step 3.4: Run smoke harness**

  ```bash
  node --import ./scripts/alias-loader.mjs --experimental-strip-types \
       --env-file=.env.local scripts/smoke-food-lookup.mjs
  ```

  Expected: prints results for both calls and `✓ smoke-food-lookup passed`. If chicken returns LLM source, check USDA key is set and the API responded; if obscure returns DB source, check the trigram threshold isn't too lenient.

- [ ] **Step 3.5: Typecheck and commit**

  ```bash
  npm run typecheck
  git add lib/food/lookup.ts scripts/smoke-food-lookup.mjs
  git commit -m "feat(food-log): resolveItemMacros with USDA + cache + LLM fallback"
  ```

---

## Task 4: `lib/food/parse.ts` — Haiku 4.5 text extraction

**Files:**
- Create: `lib/food/parse.ts`
- Create: `scripts/smoke-food-parse.mjs`

- [ ] **Step 4.1: Write the parse module**

  Create `lib/food/parse.ts`:

  ```ts
  // lib/food/parse.ts
  //
  // Haiku 4.5 text → [{ name, qty_g }] extraction.
  //
  // Returns ONLY the extracted item list. Macro resolution happens downstream
  // via lib/food/lookup.ts:resolveItemMacros, which the route handler
  // dispatches per item. This split keeps the Haiku call narrow: it does NOT
  // estimate macros — that's either DB-sourced (preferred) or done by a
  // separate cheap LLM call only when the DB has no match.

  import { z } from "zod";
  import { callClaude, parseClaudeJson } from "@/lib/anthropic/client";
  import { SHORT_FORM_MODEL } from "@/lib/anthropic/models";

  export const ExtractedItemSchema = z.object({
    name: z.string().min(1),
    qty_g: z.number().positive().finite(),
  });

  export const ExtractResponseSchema = z.object({
    items: z.array(ExtractedItemSchema).min(1).max(15),
  });

  export type ExtractedItem = z.infer<typeof ExtractedItemSchema>;

  const SYSTEM = `You convert free-text food descriptions into a structured list of items with quantities in grams.

Rules:
- Output STRICT JSON matching {"items": [{"name": string, "qty_g": number}]}. No commentary.
- Convert household units to grams using common references:
    1 cup cooked rice ≈ 158g
    1 cup raw oats ≈ 80g
    1 slice bread ≈ 30g
    1 tbsp olive oil ≈ 14g
    1 medium apple ≈ 180g
    1 large egg ≈ 50g
    1 chicken breast (medium) ≈ 170g
- If the user gave a quantity directly in grams or oz, use it (oz → g × 28.35).
- If quantity is ambiguous, pick a reasonable single-serving default and proceed (don't ask, don't refuse).
- name should be canonical-ish: "chicken breast grilled" not "I ate chicken".
- Max 15 items per call.`;

  /** Extract a list of items from free-text food input. */
  export async function extractItems(text: string): Promise<ExtractedItem[]> {
    const raw = await callClaude(
      [{ role: "user", content: text }],
      {
        model: SHORT_FORM_MODEL,
        system: SYSTEM,
        maxTokens: 600,
        temperature: 0,
      },
    );
    const parsed = parseClaudeJson<unknown>(raw);
    const validated = ExtractResponseSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(`Haiku returned invalid extraction: ${validated.error.message}`);
    }
    return validated.data.items;
  }
  ```

- [ ] **Step 4.2: Write smoke harness**

  Create `scripts/smoke-food-parse.mjs`:

  ```js
  #!/usr/bin/env node
  // scripts/smoke-food-parse.mjs
  //
  // Hits the real Anthropic API. Asserts extraction shape + reasonable gram
  // conversions for household units.
  //
  // Run via:
  //   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
  //        --env-file=.env.local scripts/smoke-food-parse.mjs

  import assert from "node:assert/strict";
  import { extractItems } from "../lib/food/parse.ts";

  const cases = [
    {
      input: "200g grilled chicken breast and 1 cup cooked white rice",
      expectCount: 2,
      checks: (items) => {
        const chicken = items.find((i) => /chicken/i.test(i.name));
        const rice = items.find((i) => /rice/i.test(i.name));
        assert.ok(chicken, "should extract chicken");
        assert.ok(rice, "should extract rice");
        assert.equal(chicken.qty_g, 200, "chicken should be 200g exactly");
        assert.ok(rice.qty_g >= 140 && rice.qty_g <= 180, `rice 1 cup should be ~158g, got ${rice.qty_g}`);
      },
    },
    {
      input: "oats with banana and peanut butter",
      expectCount: 3,
      checks: (items) => {
        // Just check 3 items came back, no quantity assertions.
        assert.equal(items.length, 3, `should extract 3 items, got ${items.length}`);
      },
    },
  ];

  for (const c of cases) {
    console.log(`→ extractItems(${JSON.stringify(c.input)})`);
    const items = await extractItems(c.input);
    console.log("  items:", items);
    if (typeof c.expectCount === "number") {
      assert.ok(items.length >= 1, `should return at least 1 item`);
    }
    c.checks(items);
  }

  console.log("\n✓ smoke-food-parse passed");
  ```

- [ ] **Step 4.3: Run smoke harness**

  ```bash
  node --import ./scripts/alias-loader.mjs --experimental-strip-types \
       --env-file=.env.local scripts/smoke-food-parse.mjs
  ```

  Expected: both cases pass. If item count is off, tune the SYSTEM prompt's bullet list of household conversions and re-run.

- [ ] **Step 4.4: Typecheck and commit**

  ```bash
  npm run typecheck
  git add lib/food/parse.ts scripts/smoke-food-parse.mjs
  git commit -m "feat(food-log): Haiku 4.5 text extraction with zod validation"
  ```

---

## Task 5: `lib/food/barcode.ts` — OpenFoodFacts fetcher

**Files:**
- Create: `lib/food/barcode.ts`

- [ ] **Step 5.1: Write the barcode module**

  Create `lib/food/barcode.ts`:

  ```ts
  // lib/food/barcode.ts
  //
  // UPC → product macros via OpenFoodFacts (free, no key required).
  //
  // Cache-first: if food_db_cache has a row for (source='openfoodfacts', upc),
  // return it. Otherwise fetch from OFF, normalize, write back, return.

  import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
  import type { FoodDbCacheRow, FoodMacros } from "@/lib/food/types";

  const OFF_BASE = "https://world.openfoodfacts.org/api/v2/product";

  type OffNutriments = {
    "energy-kcal_100g"?: number;
    energy_100g?: number;          // kJ fallback when -kcal missing
    proteins_100g?: number;
    carbohydrates_100g?: number;
    fat_100g?: number;
    fiber_100g?: number;
  };

  type OffProduct = {
    product_name?: string;
    product_name_en?: string;
    brands?: string;
    image_front_url?: string;
    nutriments?: OffNutriments;
    serving_size?: string;          // e.g. "150 g"
    serving_quantity?: number;      // OFF's parsed numeric quantity
  };

  type OffResponse = {
    status: number;                 // 1 = found, 0 = not found
    product?: OffProduct;
  };

  function parseServingSizeG(prod: OffProduct): number | null {
    if (typeof prod.serving_quantity === "number") return prod.serving_quantity;
    if (!prod.serving_size) return null;
    const m = prod.serving_size.match(/(\d+(?:\.\d+)?)\s*g/i);
    return m ? parseFloat(m[1]) : null;
  }

  function normalizeMacros(n: OffNutriments | undefined): FoodMacros {
    const kcal = typeof n?.["energy-kcal_100g"] === "number"
      ? n["energy-kcal_100g"]
      : typeof n?.energy_100g === "number"
      ? n.energy_100g / 4.184              // kJ → kcal
      : 0;
    return {
      kcal,
      protein_g: n?.proteins_100g ?? 0,
      carbs_g:   n?.carbohydrates_100g ?? 0,
      fat_g:     n?.fat_100g ?? 0,
      fiber_g:   n?.fiber_100g ?? 0,
    };
  }

  /** Look up a UPC. Returns the cache row (always; freshly inserted if needed)
   *  or null when OFF has no record. */
  export async function lookupBarcode(upc: string): Promise<FoodDbCacheRow | null> {
    const supabase = createSupabaseServiceRoleClient();

    // Cache hit?
    const { data: cached } = await supabase
      .from("food_db_cache")
      .select("*")
      .eq("source", "openfoodfacts")
      .eq("upc", upc)
      .maybeSingle();
    if (cached) return cached as FoodDbCacheRow;

    // Fetch from OFF.
    const url = `${OFF_BASE}/${encodeURIComponent(upc)}.json`;
    const res = await fetch(url, {
      headers: { "User-Agent": "ApexHealthOS/1.0 (single-user app)" },
    });
    if (!res.ok) {
      console.warn(`[food-barcode] OFF ${res.status} for upc ${upc}`);
      return null;
    }
    const data = (await res.json()) as OffResponse;
    if (data.status !== 1 || !data.product) return null;

    const name = data.product.product_name_en
      ?? data.product.product_name
      ?? `Unknown product ${upc}`;

    const { data: inserted, error } = await supabase
      .from("food_db_cache")
      .insert({
        source: "openfoodfacts",
        upc,
        name: data.product.brands ? `${name} (${data.product.brands})` : name,
        per_100g: normalizeMacros(data.product.nutriments),
        serving_size_g: parseServingSizeG(data.product),
        raw_payload: data.product,
      })
      .select("*")
      .single();
    if (error) {
      console.error("[food-barcode] cache insert failed", error);
      return null;
    }
    return inserted as FoodDbCacheRow;
  }
  ```

- [ ] **Step 5.2: Manual smoke via curl**

  Pick a UPC from your kitchen (e.g. a Fage Greek yogurt UPC). Test the OFF endpoint directly first:

  ```bash
  curl -s "https://world.openfoodfacts.org/api/v2/product/0073420001767.json" | head -c 500
  ```

  If `status: 1`, the product exists. Note the UPC for the next step.

- [ ] **Step 5.3: Typecheck and commit**

  ```bash
  npm run typecheck
  git add lib/food/barcode.ts
  git commit -m "feat(food-log): OpenFoodFacts barcode lookup with cache write-through"
  ```

---

## Task 6: `lib/food/aggregate.ts` — sum + upsert daily_logs

**Files:**
- Create: `lib/food/aggregate.ts`

- [ ] **Step 6.1: Write the aggregate module**

  Create `lib/food/aggregate.ts`:

  ```ts
  // lib/food/aggregate.ts
  //
  // After a food_log_entries commit, this module:
  //   1. Calls sum_food_entries(user_id, date) RPC to total committed items
  //   2. Upserts daily_logs nutrition columns for that date
  //
  // Day-bucketing: the caller passes p_date as the user's local-date string
  // (YYYY-MM-DD). The Postgres function compares against (eaten_at at UTC)::date,
  // which for single-user-in-CET is usually identical to local date EXCEPT for
  // 00:00-01:00 (winter) or 00:00-02:00 (summer) local edge cases. For now we
  // accept the UTC bucketing as good-enough; revisit if late-night logging
  // shows up wrong (see spec §"Open items").

  import type { SupabaseClient } from "@supabase/supabase-js";
  import type { FoodMacros } from "@/lib/food/types";
  import { ZERO_MACROS } from "@/lib/food/types";

  /** Calls sum_food_entries RPC. Returns zeros if no committed entries exist. */
  export async function sumFoodEntriesForDate(
    supabase: SupabaseClient,
    userId: string,
    date: string,
  ): Promise<FoodMacros> {
    const { data, error } = await supabase.rpc("sum_food_entries", {
      p_user_id: userId,
      p_date: date,
    });
    if (error) throw error;
    const row = (data ?? {}) as Partial<FoodMacros>;
    return {
      kcal:      row.kcal      ?? 0,
      protein_g: row.protein_g ?? 0,
      carbs_g:   row.carbs_g   ?? 0,
      fat_g:     row.fat_g     ?? 0,
      fiber_g:   row.fiber_g   ?? 0,
    };
  }

  /** Upsert daily_logs nutrition columns for (user_id, date) with the given totals.
   *  Other columns on daily_logs are not touched. */
  export async function upsertDailyLogsNutrition(
    supabase: SupabaseClient,
    userId: string,
    date: string,
    macros: FoodMacros,
  ): Promise<void> {
    const { error } = await supabase
      .from("daily_logs")
      .upsert(
        {
          user_id: userId,
          date,
          calories_eaten: macros.kcal,
          protein_g:      macros.protein_g,
          carbs_g:        macros.carbs_g,
          fat_g:          macros.fat_g,
          fiber_g:        macros.fiber_g,
          source: "food_log",
        },
        { onConflict: "user_id,date" },
      );
    if (error) throw error;
  }

  /** End-to-end: sum committed entries for the date, upsert daily_logs.
   *  When totals are all zero (last entry deleted), still upserts to clear the
   *  nutrition columns to zero rather than leaving stale aggregates. */
  export async function reaggregateDay(
    supabase: SupabaseClient,
    userId: string,
    date: string,
  ): Promise<FoodMacros> {
    const macros = await sumFoodEntriesForDate(supabase, userId, date);
    await upsertDailyLogsNutrition(supabase, userId, date, macros);
    return macros;
  }

  /** Re-export for callers that want to short-circuit on no-op. */
  export { ZERO_MACROS };
  ```

- [ ] **Step 6.2: Add `fiber_g` to TypeScript types**

  The column was added in Task 1's migration. Mirror it in TypeScript:

  In `lib/data/types.ts`, find the `DailyLog` type and add `fiber_g: number | null;` alongside `protein_g`, `carbs_g`, `fat_g`.

  In `lib/query/fetchers/dailyLogs.ts`, add `fiber_g` to the `COLS` constant string between `fat_g` and `respiratory_rate`. (The narrower `TREND_COLS` does NOT need fiber — `/trends` doesn't chart it.)

  Run `npm run typecheck`. Expected: exits 0. If other call sites destructure `DailyLog` and pass to typed args, the new optional column won't break them.

- [ ] **Step 6.3: Typecheck and commit**

  ```bash
  npm run typecheck
  git add lib/food/aggregate.ts lib/data/types.ts lib/query/fetchers/dailyLogs.ts
  git commit -m "feat(food-log): aggregate.ts (sum + upsert daily_logs) + fiber_g type"
  ```

---

## Task 7: API routes — parse, barcode, commit, entries, entries/[id]

**Files:**
- Create: `app/api/food/parse/route.ts`
- Create: `app/api/food/barcode/route.ts`
- Create: `app/api/food/commit/route.ts`
- Create: `app/api/food/entries/route.ts`
- Create: `app/api/food/entries/[id]/route.ts`

- [ ] **Step 7.1: Write `/api/food/parse`**

  Create `app/api/food/parse/route.ts`:

  ```ts
  // app/api/food/parse/route.ts
  //
  // POST { text, eaten_at? } → draft food_log_entries row + computed totals.
  //
  // Pipeline: extractItems(text) → resolveItemMacros(item) per item → insert
  // draft row → return entry shape to client for preview.

  import { NextResponse } from "next/server";
  import { z } from "zod";
  import { createSupabaseServerClient } from "@/lib/supabase/server";
  import { extractItems } from "@/lib/food/parse";
  import { resolveItemMacros } from "@/lib/food/lookup";
  import { sumMacros, type FoodItem } from "@/lib/food/types";

  const BodySchema = z.object({
    text: z.string().min(1).max(2000),
    eaten_at: z.string().datetime().optional(),
  });

  export async function POST(req: Request) {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const json = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(json);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

    const { text, eaten_at } = parsed.data;

    // 1. Extract items via Haiku
    let extracted;
    try {
      extracted = await extractItems(text);
    } catch (e) {
      return NextResponse.json(
        { error: "extraction_failed", detail: (e as Error).message },
        { status: 502 },
      );
    }

    // 2. Resolve macros per item (cache → USDA → LLM fallback)
    const items: FoodItem[] = await Promise.all(
      extracted.map((it) => resolveItemMacros(it.name, it.qty_g)),
    );

    const totals = sumMacros(items);
    const is_estimated = items.some((it) => it.source === "llm");

    // 3. Insert draft entry
    const { data: inserted, error } = await supabase
      .from("food_log_entries")
      .insert({
        user_id: user.id,
        eaten_at: eaten_at ?? new Date().toISOString(),
        kind: "text",
        raw_input: { kind: "text", text },
        items,
        totals,
        is_estimated,
        status: "draft",
      })
      .select("id, eaten_at, kind, items, totals, is_estimated, status")
      .single();
    if (error) {
      console.error("[/api/food/parse] insert failed", error);
      return NextResponse.json({ error: "insert_failed" }, { status: 500 });
    }

    return NextResponse.json({ entry: inserted });
  }
  ```

- [ ] **Step 7.2: Write `/api/food/barcode`**

  Create `app/api/food/barcode/route.ts`:

  ```ts
  // app/api/food/barcode/route.ts
  //
  // POST { upc, qty_g?, eaten_at? } → draft entry, or 404 if OFF has no match.

  import { NextResponse } from "next/server";
  import { z } from "zod";
  import { createSupabaseServerClient } from "@/lib/supabase/server";
  import { lookupBarcode } from "@/lib/food/barcode";
  import { macrosForQty, type FoodItem } from "@/lib/food/types";

  const BodySchema = z.object({
    upc: z.string().regex(/^\d{8,14}$/),
    qty_g: z.number().positive().finite().optional(),
    eaten_at: z.string().datetime().optional(),
  });

  export async function POST(req: Request) {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const json = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(json);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

    const { upc, eaten_at } = parsed.data;

    const product = await lookupBarcode(upc);
    if (!product) {
      return NextResponse.json({ error: "product_not_found", upc }, { status: 404 });
    }

    const qty_g = parsed.data.qty_g ?? product.serving_size_g ?? 100;
    const macros = macrosForQty(product.per_100g, qty_g);

    const item: FoodItem = {
      name: product.name,
      qty_g,
      ...macros,
      per_100g: product.per_100g,
      source: "db",
      db_ref: { source: "openfoodfacts", canonical_id: product.canonical_id },
      confidence: "high",
    };

    const { data: inserted, error } = await supabase
      .from("food_log_entries")
      .insert({
        user_id: user.id,
        eaten_at: eaten_at ?? new Date().toISOString(),
        kind: "barcode",
        raw_input: { kind: "barcode", upc, qty_g },
        items: [item],
        totals: macros,
        is_estimated: false,
        status: "draft",
      })
      .select("id, eaten_at, kind, items, totals, is_estimated, status")
      .single();
    if (error) {
      console.error("[/api/food/barcode] insert failed", error);
      return NextResponse.json({ error: "insert_failed" }, { status: 500 });
    }

    return NextResponse.json({
      entry: inserted,
      product_image: (product.raw_payload as { image_front_url?: string }).image_front_url ?? null,
    });
  }
  ```

- [ ] **Step 7.3: Write `/api/food/commit`**

  Create `app/api/food/commit/route.ts`:

  ```ts
  // app/api/food/commit/route.ts
  //
  // POST { entry_id } → flip status to 'committed', reaggregate daily_logs
  // for the entry's date, invalidate /log via revalidatePath.

  import { NextResponse } from "next/server";
  import { z } from "zod";
  import { revalidatePath } from "next/cache";
  import { createSupabaseServerClient } from "@/lib/supabase/server";
  import { reaggregateDay } from "@/lib/food/aggregate";

  const BodySchema = z.object({
    entry_id: z.string().uuid(),
  });

  function utcDate(iso: string): string {
    return iso.slice(0, 10);
  }

  export async function POST(req: Request) {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const json = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(json);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

    const { entry_id } = parsed.data;

    // Update status. RLS scopes to the user.
    const { data: updated, error } = await supabase
      .from("food_log_entries")
      .update({ status: "committed", updated_at: new Date().toISOString() })
      .eq("id", entry_id)
      .eq("user_id", user.id)
      .select("id, eaten_at, totals")
      .single();
    if (error || !updated) {
      console.error("[/api/food/commit] update failed", error);
      return NextResponse.json({ error: "commit_failed" }, { status: 500 });
    }

    const date = utcDate(updated.eaten_at);
    const macros = await reaggregateDay(supabase, user.id, date);

    revalidatePath("/log");
    revalidatePath("/");

    return NextResponse.json({ ok: true, date, totals: macros });
  }
  ```

- [ ] **Step 7.4: Write `/api/food/entries` (GET list)**

  Create `app/api/food/entries/route.ts`:

  ```ts
  // app/api/food/entries/route.ts
  //
  // GET ?from=YYYY-MM-DD&to=YYYY-MM-DD → array of committed FoodLogEntry rows.
  // Used by useFoodEntries hook AND by the coach's query_food_log tool handler.

  import { NextResponse } from "next/server";
  import { z } from "zod";
  import { createSupabaseServerClient } from "@/lib/supabase/server";

  const QuerySchema = z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  });

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

    const { data, error } = await supabase
      .from("food_log_entries")
      .select("id, user_id, eaten_at, kind, raw_input, items, totals, is_estimated, status, created_at, updated_at")
      .eq("user_id", user.id)
      .eq("status", "committed")
      .gte("eaten_at", `${parsed.data.from}T00:00:00Z`)
      .lte("eaten_at", `${parsed.data.to}T23:59:59Z`)
      .order("eaten_at", { ascending: false });
    if (error) {
      console.error("[/api/food/entries] query failed", error);
      return NextResponse.json({ error: "query_failed" }, { status: 500 });
    }
    return NextResponse.json({ entries: data ?? [] });
  }
  ```

- [ ] **Step 7.5: Write `/api/food/entries/[id]` (PATCH + DELETE)**

  Create `app/api/food/entries/[id]/route.ts`:

  ```ts
  // app/api/food/entries/[id]/route.ts
  //
  // PATCH { items } → replace items, recompute totals + is_estimated, reaggregate.
  //   (Today-only constraint: rejects edits to entries with eaten_at not today.)
  // DELETE → set status='rejected', reaggregate (drops the entry from totals).

  import { NextResponse } from "next/server";
  import { z } from "zod";
  import { revalidatePath } from "next/cache";
  import { createSupabaseServerClient } from "@/lib/supabase/server";
  import { reaggregateDay } from "@/lib/food/aggregate";
  import { sumMacros, type FoodItem } from "@/lib/food/types";

  const ItemSchema = z.object({
    name: z.string(),
    qty_g: z.number().positive().finite(),
    kcal: z.number(),
    protein_g: z.number(),
    carbs_g: z.number(),
    fat_g: z.number(),
    fiber_g: z.number(),
    per_100g: z.object({
      kcal: z.number(),
      protein_g: z.number(),
      carbs_g: z.number(),
      fat_g: z.number(),
      fiber_g: z.number(),
    }),
    source: z.enum(["db", "llm"]),
    db_ref: z
      .object({
        source: z.enum(["usda", "openfoodfacts", "manual"]),
        canonical_id: z.string().uuid(),
      })
      .nullable(),
    confidence: z.enum(["high", "medium", "low"]).nullable(),
  });

  const PatchSchema = z.object({
    items: z.array(ItemSchema).min(1),
  });

  function utcDate(iso: string): string {
    return iso.slice(0, 10);
  }

  function isToday(iso: string): boolean {
    return utcDate(iso) === utcDate(new Date().toISOString());
  }

  export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const json = await req.json().catch(() => null);
    const parsed = PatchSchema.safeParse(json);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

    // Fetch the entry first (today-only check).
    const { data: existing } = await supabase
      .from("food_log_entries")
      .select("eaten_at")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();
    if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (!isToday(existing.eaten_at)) {
      return NextResponse.json({ error: "edit_past_day_disallowed" }, { status: 403 });
    }

    const items = parsed.data.items as FoodItem[];
    const totals = sumMacros(items);
    const is_estimated = items.some((it) => it.source === "llm");

    const { error } = await supabase
      .from("food_log_entries")
      .update({ items, totals, is_estimated, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", user.id);
    if (error) return NextResponse.json({ error: "update_failed" }, { status: 500 });

    const date = utcDate(existing.eaten_at);
    await reaggregateDay(supabase, user.id, date);
    revalidatePath("/log");
    return NextResponse.json({ ok: true });
  }

  export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const { data: existing } = await supabase
      .from("food_log_entries")
      .select("eaten_at")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();
    if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const { error } = await supabase
      .from("food_log_entries")
      .update({ status: "rejected", updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", user.id);
    if (error) return NextResponse.json({ error: "delete_failed" }, { status: 500 });

    const date = utcDate(existing.eaten_at);
    await reaggregateDay(supabase, user.id, date);
    revalidatePath("/log");
    return NextResponse.json({ ok: true });
  }
  ```

- [ ] **Step 7.6: Typecheck and commit**

  ```bash
  npm run typecheck
  git add app/api/food
  git commit -m "feat(food-log): api routes — parse, barcode, commit, entries (list/PATCH/DELETE)"
  ```

- [ ] **Step 7.7: Exercise the API end-to-end via curl**

  ```bash
  npm run dev &
  sleep 5
  # Sign in via the browser to get a session cookie first.
  # Then in the browser DevTools console:
  #   fetch('/api/food/parse', {method:'POST', headers:{'content-type':'application/json'},
  #         body: JSON.stringify({text: '200g grilled chicken breast and 1 cup white rice'})})
  #     .then(r => r.json()).then(console.log)
  ```

  Expected: response includes `entry` with `items` (2), totals, `is_estimated`, `status: 'draft'`. Capture the `entry.id` and commit it:

  ```js
  fetch('/api/food/commit', {method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({entry_id: '<ID>'})})
    .then(r => r.json()).then(console.log)
  ```

  Expected: `{ ok: true, date: '2026-05-18', totals: {...} }`. Then visit `/` and check the today's macros card reflects the new totals.

---

## Task 8: Yazio precedence + opt-out toggle

**Files:**
- Modify: `app/api/ingest/health/route.ts`
- Modify: `components/profile/IngestPanel.tsx`
- Modify: `lib/data/types.ts:Profile` (add `disable_yazio_ingest`)

- [ ] **Step 8.1: Add `disable_yazio_ingest` to Profile type**

  In `lib/data/types.ts`, find the `Profile` type and add:

  ```ts
  disable_yazio_ingest: boolean;
  ```

  Run `npm run typecheck`.

- [ ] **Step 8.2: Modify Yazio ingest to check precedence + opt-out**

  Open `app/api/ingest/health/route.ts`. Locate the Yazio branch (search for `'yazio'` or `source=yazio`). Wrap the nutrition-column write block with:

  ```ts
  // ── In-app food log precedence ────────────────────────────────────────────
  // Skip Yazio nutrition writes when either:
  //  1. profiles.disable_yazio_ingest is true (user opted out), OR
  //  2. any committed food_log_entries row exists for this date.
  // See CLAUDE.md "Data sources & precedence" — in-app logging is now the
  // owner of calories_eaten / protein_g / carbs_g / fat_g / fiber_g.

  const { data: profile } = await supabase
    .from("profiles")
    .select("disable_yazio_ingest")
    .eq("user_id", user.id)
    .maybeSingle();

  if (profile?.disable_yazio_ingest) {
    return NextResponse.json({ ok: true, skipped: true, reason: "yazio_ingest_disabled" });
  }

  const { count: foodLogCount } = await supabase
    .from("food_log_entries")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("status", "committed")
    .gte("eaten_at", `${log_date}T00:00:00Z`)
    .lte("eaten_at", `${log_date}T23:59:59Z`);

  if ((foodLogCount ?? 0) > 0) {
    console.info(`[ingest/yazio] skipping ${log_date} — in-app food log present`);
    // Continue processing other fields (if any), just skip nutrition columns.
    // Replace the nutrition portion of the upsert with explicit omission below.
  } else {
    // Existing Yazio nutrition upsert path goes here.
  }
  ```

  Adapt to the exact existing structure of the file. The goal is: when either opt-out or in-app logging is present for the date, the Yazio path does NOT write `calories_eaten / protein_g / carbs_g / fat_g / fiber_g`.

- [ ] **Step 8.3: Add opt-out toggle to IngestPanel**

  In `components/profile/IngestPanel.tsx`, locate the Yazio section (around line 85 per earlier grep). Add a toggle row:

  ```tsx
  // (Inside the Yazio section block.)
  // Note: read disable_yazio_ingest from useProfile hook (must already expose
  // the full Profile row). If it doesn't, extend the profile fetcher's select.

  <label className="flex items-center justify-between gap-3 py-2">
    <span className="text-sm text-zinc-300">
      Stop importing Yazio — I'm logging in-app now
    </span>
    <input
      type="checkbox"
      checked={profile?.disable_yazio_ingest ?? false}
      onChange={async (e) => {
        const next = e.target.checked;
        const res = await fetch("/api/profile", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ disable_yazio_ingest: next }),
        });
        if (res.ok) await queryClient.invalidateQueries({ queryKey: queryKeys.profile.one(userId) });
      }}
      className="h-4 w-4"
    />
  </label>
  ```

  If `/api/profile` PATCH doesn't exist, you'll need to add the `disable_yazio_ingest` field to whatever existing profile-save server action already supports the system_prompt field. Reuse that pattern.

- [ ] **Step 8.4: Typecheck and commit**

  ```bash
  npm run typecheck
  git add app/api/ingest/health/route.ts components/profile/IngestPanel.tsx lib/data/types.ts
  git commit -m "feat(food-log): Yazio precedence (in-app supersedes) + opt-out toggle"
  ```

---

## Task 9: Client query layer — fetchers, hooks, keys

**Files:**
- Create: `lib/query/fetchers/foodEntries.ts`
- Create: `lib/query/hooks/useFoodEntries.ts`
- Modify: `lib/query/keys.ts`

- [ ] **Step 9.1: Extend query keys**

  In `lib/query/keys.ts`, add to the `queryKeys` object (between `workouts` and `tokens`):

  ```ts
  foodEntries: {
    all: (userId: string) => ["food-entries", userId] as const,
    range: (userId: string, from: string, to: string) =>
      ["food-entries", userId, "range", from, to] as const,
  },
  ```

- [ ] **Step 9.2: Write the fetchers (server + browser pair)**

  Create `lib/query/fetchers/foodEntries.ts`:

  ```ts
  // lib/query/fetchers/foodEntries.ts
  import type { SupabaseClient } from "@supabase/supabase-js";
  import { createSupabaseBrowserClient } from "@/lib/supabase/client";
  import type { FoodLogEntry } from "@/lib/food/types";

  const COLS =
    "id, user_id, eaten_at, kind, raw_input, items, totals, is_estimated, status, created_at, updated_at";

  /** Returns committed food_log_entries for [from, to] (inclusive date range). */
  export async function fetchFoodEntriesServer(
    supabase: SupabaseClient,
    userId: string,
    from: string,
    to: string,
  ): Promise<FoodLogEntry[]> {
    const { data, error } = await supabase
      .from("food_log_entries")
      .select(COLS)
      .eq("user_id", userId)
      .eq("status", "committed")
      .gte("eaten_at", `${from}T00:00:00Z`)
      .lte("eaten_at", `${to}T23:59:59Z`)
      .order("eaten_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as FoodLogEntry[];
  }

  export async function fetchFoodEntriesBrowser(
    userId: string,
    from: string,
    to: string,
  ): Promise<FoodLogEntry[]> {
    const supabase = createSupabaseBrowserClient();
    const { data, error } = await supabase
      .from("food_log_entries")
      .select(COLS)
      .eq("user_id", userId)
      .eq("status", "committed")
      .gte("eaten_at", `${from}T00:00:00Z`)
      .lte("eaten_at", `${to}T23:59:59Z`)
      .order("eaten_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as FoodLogEntry[];
  }
  ```

- [ ] **Step 9.3: Write the hook**

  Create `lib/query/hooks/useFoodEntries.ts`:

  ```ts
  // lib/query/hooks/useFoodEntries.ts
  import { useQuery } from "@tanstack/react-query";
  import { queryKeys } from "@/lib/query/keys";
  import { fetchFoodEntriesBrowser } from "@/lib/query/fetchers/foodEntries";

  export function useFoodEntries(userId: string, from: string, to: string) {
    return useQuery({
      queryKey: queryKeys.foodEntries.range(userId, from, to),
      queryFn: () => fetchFoodEntriesBrowser(userId, from, to),
      enabled: !!userId,
    });
  }
  ```

- [ ] **Step 9.4: Typecheck and commit**

  ```bash
  npm run typecheck
  git add lib/query/fetchers/foodEntries.ts lib/query/hooks/useFoodEntries.ts lib/query/keys.ts
  git commit -m "feat(food-log): client cache — foodEntries fetchers + hook"
  ```

---

## Task 10: MealLoggerSheet UI + Fab integration

**Files:**
- Create: `components/log/MealLoggerSheet.tsx`
- Create: `components/log/MealLoggerTypeTab.tsx`
- Create: `components/log/MealLoggerScanTab.tsx`
- Create: `components/log/MealLoggerComingSoonTab.tsx`
- Modify: `components/layout/BottomNav.tsx` (or wherever the Fab is rendered)

- [ ] **Step 10.1: Write `MealLoggerSheet.tsx` (orchestrator + tab strip)**

  Create `components/log/MealLoggerSheet.tsx`:

  ```tsx
  "use client";
  import { useState } from "react";
  import { BottomSheet } from "@/components/ui/BottomSheet";
  import { MealLoggerTypeTab } from "./MealLoggerTypeTab";
  import { MealLoggerScanTab } from "./MealLoggerScanTab";
  import { MealLoggerComingSoonTab } from "./MealLoggerComingSoonTab";
  import { useQueryClient } from "@tanstack/react-query";
  import { queryKeys } from "@/lib/query/keys";

  type Tab = "type" | "scan" | "photo" | "voice";

  export function MealLoggerSheet({
    open,
    onClose,
    userId,
  }: {
    open: boolean;
    onClose: () => void;
    userId: string;
  }) {
    const [tab, setTab] = useState<Tab>("type");
    const queryClient = useQueryClient();

    const onCommitted = async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.foodEntries.all(userId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.dailyLogs.all(userId) });
      onClose();
    };

    return (
      <BottomSheet open={open} onClose={onClose} title="Log meal">
        <div className="flex gap-1 border-b border-zinc-800 px-3 pt-2">
          {(["type", "scan", "photo", "voice"] as const).map((t) => (
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
          {tab === "type" && <MealLoggerTypeTab onCommitted={onCommitted} />}
          {tab === "scan" && <MealLoggerScanTab onCommitted={onCommitted} />}
          {tab === "photo" && <MealLoggerComingSoonTab modality="photo" />}
          {tab === "voice" && <MealLoggerComingSoonTab modality="voice" />}
        </div>
      </BottomSheet>
    );
  }
  ```

- [ ] **Step 10.2: Write `MealLoggerTypeTab.tsx`**

  Create `components/log/MealLoggerTypeTab.tsx`:

  ```tsx
  "use client";
  import { useState } from "react";
  import type { FoodLogEntry } from "@/lib/food/types";
  import { fmtNum } from "@/lib/ui/score";

  export function MealLoggerTypeTab({ onCommitted }: { onCommitted: () => void }) {
    const [text, setText] = useState("");
    const [draft, setDraft] = useState<Pick<FoodLogEntry, "id" | "items" | "totals" | "is_estimated"> | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const parse = async () => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/food/parse", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "parse_failed");
        setDraft(json.entry);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    };

    const commit = async () => {
      if (!draft) return;
      setBusy(true);
      try {
        const res = await fetch("/api/food/commit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ entry_id: draft.id }),
        });
        if (!res.ok) throw new Error("commit_failed");
        setText("");
        setDraft(null);
        onCommitted();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    };

    const discard = async () => {
      if (!draft) return;
      // Best-effort: DELETE the draft. Failure is silent — drafts are
      // garbage-collectable on their own (status='draft' rows aren't queried
      // anywhere except for the active editor).
      await fetch(`/api/food/entries/${draft.id}`, { method: "DELETE" }).catch(() => {});
      setDraft(null);
      setText("");
    };

    if (draft) {
      return (
        <div className="space-y-3">
          <ul className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
            {draft.items.map((it, idx) => (
              <li key={idx} className="p-3 text-sm">
                <div className="flex items-baseline justify-between">
                  <span className="font-medium">{it.name}</span>
                  {it.source === "llm" && (
                    <span className="text-xs text-amber-400">estimated</span>
                  )}
                </div>
                <div className="text-xs text-zinc-400">
                  {fmtNum(it.qty_g)} g · {fmtNum(it.kcal)} kcal · {fmtNum(it.protein_g)} P · {fmtNum(it.carbs_g)} C · {fmtNum(it.fat_g)} F
                </div>
              </li>
            ))}
          </ul>
          <div className="text-sm">
            Total: <strong>{fmtNum(draft.totals.kcal)} kcal</strong> · {fmtNum(draft.totals.protein_g)} P · {fmtNum(draft.totals.carbs_g)} C · {fmtNum(draft.totals.fat_g)} F
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={discard} disabled={busy} className="flex-1 rounded-md border border-zinc-700 py-2 text-sm">
              Discard
            </button>
            <button type="button" onClick={commit} disabled={busy} className="flex-1 rounded-md bg-zinc-100 py-2 text-sm text-zinc-900">
              {busy ? "..." : "Commit"}
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-3">
        <label className="text-xs uppercase tracking-wider text-zinc-400">What did you eat?</label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder="e.g. 200g grilled chicken breast and 1 cup white rice"
          className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-3 text-sm"
        />
        {error && <p className="text-xs text-red-400">{error}</p>}
        <button
          type="button"
          onClick={parse}
          disabled={busy || text.trim().length < 3}
          className="w-full rounded-md bg-zinc-100 py-2 text-sm text-zinc-900 disabled:opacity-50"
        >
          {busy ? "Parsing..." : "Parse"}
        </button>
      </div>
    );
  }
  ```

- [ ] **Step 10.3: Write `MealLoggerScanTab.tsx`**

  Create `components/log/MealLoggerScanTab.tsx`:

  ```tsx
  "use client";
  import { useEffect, useRef, useState } from "react";
  import { fmtNum } from "@/lib/ui/score";

  type Product = {
    entry: { id: string; items: { name: string; qty_g: number; kcal: number; protein_g: number; carbs_g: number; fat_g: number }[]; totals: { kcal: number; protein_g: number; carbs_g: number; fat_g: number } };
    product_image: string | null;
  };

  export function MealLoggerScanTab({ onCommitted }: { onCommitted: () => void }) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [supported, setSupported] = useState<boolean | null>(null);
    const [scanned, setScanned] = useState<Product | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
      // Feature-detect BarcodeDetector.
      const has = typeof (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector !== "undefined";
      setSupported(has);
      if (!has) return;
      let stream: MediaStream | null = null;
      let stopped = false;
      (async () => {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "environment" },
          });
          if (stopped) return;
          if (videoRef.current) videoRef.current.srcObject = stream;
        } catch (e) {
          setError("Camera permission required");
        }
      })();
      const detector = new (window as unknown as { BarcodeDetector: new (opts: { formats: string[] }) => { detect: (s: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }).BarcodeDetector({
        formats: ["ean_13", "upc_a", "upc_e", "ean_8"],
      });
      const tick = async () => {
        if (stopped || !videoRef.current || scanned) return;
        try {
          const codes = await detector.detect(videoRef.current);
          if (codes[0]?.rawValue) {
            await onDetected(codes[0].rawValue);
            return;
          }
        } catch {
          /* ignore — keep scanning */
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return () => {
        stopped = true;
        stream?.getTracks().forEach((t) => t.stop());
      };
    }, [scanned]);

    const onDetected = async (upc: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/food/barcode", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ upc }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "scan_failed");
        setScanned(json);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    };

    const commit = async () => {
      if (!scanned) return;
      setBusy(true);
      try {
        const res = await fetch("/api/food/commit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ entry_id: scanned.entry.id }),
        });
        if (!res.ok) throw new Error("commit_failed");
        setScanned(null);
        onCommitted();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    };

    if (supported === false) {
      return (
        <div className="text-sm text-zinc-400">
          Barcode scanning isn't supported in this browser. Use the Type tab instead.
        </div>
      );
    }

    if (scanned) {
      const item = scanned.entry.items[0];
      return (
        <div className="space-y-3">
          {scanned.product_image && (
            <img src={scanned.product_image} alt="" className="mx-auto h-32 w-32 rounded-md object-cover" />
          )}
          <div className="text-center">
            <div className="font-medium">{item.name}</div>
            <div className="text-xs text-zinc-400">
              {fmtNum(item.qty_g)} g · {fmtNum(item.kcal)} kcal · {fmtNum(item.protein_g)} P · {fmtNum(item.carbs_g)} C · {fmtNum(item.fat_g)} F
            </div>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={() => setScanned(null)} disabled={busy} className="flex-1 rounded-md border border-zinc-700 py-2 text-sm">
              Scan another
            </button>
            <button type="button" onClick={commit} disabled={busy} className="flex-1 rounded-md bg-zinc-100 py-2 text-sm text-zinc-900">
              {busy ? "..." : "Commit"}
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-2">
        <video ref={videoRef} autoPlay playsInline className="w-full rounded-md bg-zinc-950" />
        <p className="text-center text-xs text-zinc-500">Point at a barcode</p>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    );
  }
  ```

- [ ] **Step 10.4: Write `MealLoggerComingSoonTab.tsx`**

  Create `components/log/MealLoggerComingSoonTab.tsx`:

  ```tsx
  export function MealLoggerComingSoonTab({ modality }: { modality: "photo" | "voice" }) {
    return (
      <div className="py-8 text-center text-sm text-zinc-500">
        {modality === "photo"
          ? "Photo logging is coming soon — Spec B."
          : "Voice logging is coming soon — Spec C."}
      </div>
    );
  }
  ```

- [ ] **Step 10.5: Wire Fab → MealLoggerSheet**

  Open `components/layout/BottomNav.tsx`. Locate the Fab button (the existing "+" or "log" entry that opens `LogEntrySheet`). Add a separate state for the meal logger, and offer the user a choice OR replace the existing Fab's primary action with a small "Log meal" submenu. Pattern:

  ```tsx
  // Add at top:
  import { MealLoggerSheet } from "@/components/log/MealLoggerSheet";

  // Inside the component:
  const [mealOpen, setMealOpen] = useState(false);

  // Either:
  //   (a) Replace Fab's onClick to setMealOpen(true), OR
  //   (b) Add a sub-action chip "Log meal" that opens MealLoggerSheet.
  // Recommended: option (b) so the existing daily-metrics flow stays accessible.

  // Render:
  <MealLoggerSheet open={mealOpen} onClose={() => setMealOpen(false)} userId={userId} />
  ```

  If `BottomNav.tsx` doesn't already receive `userId`, plumb it through from `app/layout.tsx`. The auth gate already runs at the layout level — pass `userId` to `BottomNav` as a prop.

- [ ] **Step 10.6: Typecheck and exercise**

  ```bash
  npm run typecheck
  npm run dev
  ```

  In the browser: open the Fab → Log meal → Type tab → enter text → Parse → review draft → Commit. Verify the toast/close, then check `/log` shows the totals updated.

  Then test Scan tab: scan a real barcode (e.g. a Fage tub) → commit.

- [ ] **Step 10.7: Commit**

  ```bash
  git add components/log/MealLoggerSheet.tsx components/log/MealLoggerTypeTab.tsx components/log/MealLoggerScanTab.tsx components/log/MealLoggerComingSoonTab.tsx components/layout/BottomNav.tsx
  git commit -m "feat(food-log): MealLoggerSheet with Type/Scan tabs + Fab wiring"
  ```

---

## Task 11: TodaysMeals on /log + FoodEntryEditSheet

**Files:**
- Create: `components/log/TodaysMeals.tsx`
- Create: `components/log/FoodEntryEditSheet.tsx`
- Modify: `app/log/page.tsx`
- Modify: `components/log/LogClient.tsx`

- [ ] **Step 11.1: Write `TodaysMeals.tsx`**

  Create `components/log/TodaysMeals.tsx`:

  ```tsx
  "use client";
  import { useState } from "react";
  import { useFoodEntries } from "@/lib/query/hooks/useFoodEntries";
  import { FoodEntryEditSheet } from "./FoodEntryEditSheet";
  import { fmtNum } from "@/lib/ui/score";
  import type { FoodLogEntry } from "@/lib/food/types";

  export function TodaysMeals({ userId }: { userId: string }) {
    const today = new Date().toISOString().slice(0, 10);
    const { data: entries = [], isLoading } = useFoodEntries(userId, today, today);
    const [editing, setEditing] = useState<FoodLogEntry | null>(null);

    if (isLoading) return <div className="text-xs text-zinc-500">Loading meals…</div>;
    if (entries.length === 0) {
      return (
        <div className="rounded-md border border-zinc-800 p-4 text-sm text-zinc-500">
          No meals logged today. Use the Log button below.
        </div>
      );
    }

    const total = entries.reduce(
      (acc, e) => ({
        kcal: acc.kcal + e.totals.kcal,
        protein_g: acc.protein_g + e.totals.protein_g,
        carbs_g: acc.carbs_g + e.totals.carbs_g,
        fat_g: acc.fat_g + e.totals.fat_g,
      }),
      { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
    );

    return (
      <section className="space-y-3">
        <header className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-400">Today's meals</h2>
          <div className="text-xs text-zinc-400">
            {fmtNum(total.kcal)} kcal · {fmtNum(total.protein_g)} P · {fmtNum(total.carbs_g)} C · {fmtNum(total.fat_g)} F
          </div>
        </header>
        <ul className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
          {entries.map((e) => (
            <li key={e.id} className="p-3">
              <button type="button" onClick={() => setEditing(e)} className="block w-full text-left">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-zinc-500">
                    {new Date(e.eaten_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {e.kind}
                    {e.is_estimated && <span className="ml-1 text-amber-400">estimated</span>}
                  </span>
                  <span className="text-xs text-zinc-400">{fmtNum(e.totals.kcal)} kcal</span>
                </div>
                <div className="mt-1 text-sm">{e.items.map((it) => it.name).join(", ")}</div>
              </button>
            </li>
          ))}
        </ul>
        {editing && (
          <FoodEntryEditSheet entry={editing} onClose={() => setEditing(null)} userId={userId} />
        )}
      </section>
    );
  }
  ```

- [ ] **Step 11.2: Write `FoodEntryEditSheet.tsx`**

  Create `components/log/FoodEntryEditSheet.tsx`:

  ```tsx
  "use client";
  import { useState } from "react";
  import { useQueryClient } from "@tanstack/react-query";
  import { BottomSheet } from "@/components/ui/BottomSheet";
  import { queryKeys } from "@/lib/query/keys";
  import { macrosForQty, type FoodItem, type FoodLogEntry } from "@/lib/food/types";
  import { fmtNum } from "@/lib/ui/score";

  export function FoodEntryEditSheet({
    entry,
    onClose,
    userId,
  }: {
    entry: FoodLogEntry;
    onClose: () => void;
    userId: string;
  }) {
    const [items, setItems] = useState<FoodItem[]>(entry.items);
    const [busy, setBusy] = useState(false);
    const qc = useQueryClient();

    const setQty = (idx: number, qty_g: number) => {
      setItems((prev) =>
        prev.map((it, i) => {
          if (i !== idx) return it;
          const macros = macrosForQty(it.per_100g, qty_g);
          return { ...it, qty_g, ...macros };
        }),
      );
    };

    const save = async () => {
      setBusy(true);
      try {
        const res = await fetch(`/api/food/entries/${entry.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items }),
        });
        if (!res.ok) throw new Error("update_failed");
        await qc.invalidateQueries({ queryKey: queryKeys.foodEntries.all(userId) });
        await qc.invalidateQueries({ queryKey: queryKeys.dailyLogs.all(userId) });
        onClose();
      } finally {
        setBusy(false);
      }
    };

    const del = async () => {
      if (!confirm("Delete this entry?")) return;
      setBusy(true);
      try {
        const res = await fetch(`/api/food/entries/${entry.id}`, { method: "DELETE" });
        if (!res.ok) throw new Error("delete_failed");
        await qc.invalidateQueries({ queryKey: queryKeys.foodEntries.all(userId) });
        await qc.invalidateQueries({ queryKey: queryKeys.dailyLogs.all(userId) });
        onClose();
      } finally {
        setBusy(false);
      }
    };

    return (
      <BottomSheet open onClose={onClose} title="Edit meal">
        <div className="space-y-3 p-4">
          {items.map((it, idx) => (
            <div key={idx} className="rounded-md border border-zinc-800 p-3">
              <div className="text-sm font-medium">{it.name}</div>
              <label className="mt-2 block text-xs text-zinc-400">
                Quantity (g)
                <input
                  type="number"
                  value={it.qty_g}
                  onChange={(e) => setQty(idx, parseFloat(e.target.value) || 0)}
                  className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 p-2 text-sm"
                />
              </label>
              <div className="mt-2 text-xs text-zinc-500">
                {fmtNum(it.kcal)} kcal · {fmtNum(it.protein_g)} P · {fmtNum(it.carbs_g)} C · {fmtNum(it.fat_g)} F
              </div>
            </div>
          ))}
          <div className="flex gap-2">
            <button type="button" onClick={del} disabled={busy} className="flex-1 rounded-md border border-red-700 py-2 text-sm text-red-400">
              Delete
            </button>
            <button type="button" onClick={save} disabled={busy} className="flex-1 rounded-md bg-zinc-100 py-2 text-sm text-zinc-900">
              {busy ? "..." : "Save"}
            </button>
          </div>
        </div>
      </BottomSheet>
    );
  }
  ```

- [ ] **Step 11.3: Render `TodaysMeals` in `/log`**

  Open `components/log/LogClient.tsx`. At the top of the rendered tree (above the existing form), add:

  ```tsx
  import { TodaysMeals } from "./TodaysMeals";
  // …
  // Inside the component (userId already in scope via props):
  <TodaysMeals userId={userId} />
  ```

  In `app/log/page.tsx`, prefetch today's entries to hydrate the SSR pass:

  ```tsx
  import { fetchFoodEntriesServer } from "@/lib/query/fetchers/foodEntries";
  import { queryKeys } from "@/lib/query/keys";
  // …
  // After the makeServerQueryClient() call, before children render:
  const today = new Date().toISOString().slice(0, 10);
  await queryClient.prefetchQuery({
    queryKey: queryKeys.foodEntries.range(user.id, today, today),
    queryFn: () => fetchFoodEntriesServer(supabase, user.id, today, today),
  });
  ```

  Match the exact existing prefetch pattern in the file.

- [ ] **Step 11.4: Typecheck + exercise**

  ```bash
  npm run typecheck
  npm run dev
  ```

  Visit `/log`. With today's entries committed earlier, verify TodaysMeals renders. Tap an entry → edit qty → Save → list updates + dashboard macros card reflects new totals.

- [ ] **Step 11.5: Commit**

  ```bash
  git add components/log/TodaysMeals.tsx components/log/FoodEntryEditSheet.tsx components/log/LogClient.tsx app/log/page.tsx
  git commit -m "feat(food-log): TodaysMeals list + FoodEntryEditSheet on /log"
  ```

---

## Task 12: Coach data integration — query_food_log + brief topItems + weekly review

**Files:**
- Modify: `lib/coach/tools.ts`
- Modify: `lib/coach/system-prompts.ts`
- Modify: `lib/morning/brief/index.ts`
- Modify: `lib/morning/brief/advice-prompt.ts`
- Modify: `lib/morning/brief/assembler.ts`
- Modify: `lib/coach/weekly-review/compose-trends.ts`
- Modify: `lib/coach/weekly-review/narrative-prompt.ts`

- [ ] **Step 12.1: Register `query_food_log` tool**

  In `lib/coach/tools.ts`, add a new tool schema next to `DAILY_LOGS_TOOL` and `WORKOUTS_TOOL`:

  ```ts
  export const FOOD_LOG_TOOL = {
    name: "query_food_log",
    description:
      "Query the in-app food log for a date range. Returns committed entries with per-item macros. Use when the user asks about specific foods, meal composition, or food choices — distinct from query_daily_logs which returns daily totals only. Range capped at 90 days.",
    input_schema: {
      type: "object" as const,
      required: ["start_date", "end_date"],
      properties: {
        start_date: { type: "string", format: "date" },
        end_date: { type: "string", format: "date" },
        item_filter: { type: "string", description: "Optional case-insensitive substring match on item name." },
      },
    },
  };
  ```

  Add to the exported tool list (search for the array literal that bundles `DAILY_LOGS_TOOL`, `WORKOUTS_TOOL`, and the rest — append `FOOD_LOG_TOOL`).

  Then add the executor. Match the structure of existing executors (look at the `query_daily_logs` executor for the pattern: validate input, enforce range cap, .eq("user_id", userId), return data):

  ```ts
  export async function executeQueryFoodLog(
    supabase: SupabaseClient,
    userId: string,
    input: { start_date: string; end_date: string; item_filter?: string },
  ): Promise<unknown> {
    // Range cap — 90 days, same as raw daily_logs.
    const start = new Date(input.start_date);
    const end = new Date(input.end_date);
    const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
    if (days > 90) {
      return { error: "range_too_large", message: "Max 90 days for query_food_log." };
    }
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    const { data, error } = await supabase
      .from("food_log_entries")
      .select("eaten_at, kind, items, totals")
      .eq("user_id", userId)
      .eq("status", "committed")
      .gte("eaten_at", `${fmt(start)}T00:00:00Z`)
      .lte("eaten_at", `${fmt(end)}T23:59:59Z`)
      .order("eaten_at", { ascending: false });
    if (error) return { error: "query_failed", message: error.message };

    let rows = (data ?? []) as Array<{
      eaten_at: string;
      kind: string;
      items: Array<{ name: string; qty_g: number; kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number; source: string }>;
      totals: { kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number };
    }>;

    if (input.item_filter) {
      const f = input.item_filter.toLowerCase();
      rows = rows
        .map((r) => ({ ...r, items: r.items.filter((it) => it.name.toLowerCase().includes(f)) }))
        .filter((r) => r.items.length > 0);
    }

    return { rows };
  }
  ```

  Wire it into the tool-dispatch switch (search for `case "query_daily_logs":`). Add:

  ```ts
  case "query_food_log":
    return await executeQueryFoodLog(supabase, userId, input as { start_date: string; end_date: string; item_filter?: string });
  ```

- [ ] **Step 12.2: Document the new tool in `SCHEMA_EXPLAINER`**

  In `lib/coach/system-prompts.ts`, under `## Tools` in `SCHEMA_EXPLAINER`, add a bullet:

  ```
  - query_food_log(start_date, end_date, item_filter?) — fetch the in-app food log for a date range. Returns committed entries with per-item macros (name, qty_g, kcal, protein/carbs/fat/fiber). Use for food-choice and meal-composition questions; use query_daily_logs for day-level macro totals. Range capped at 90 days.
  ```

- [ ] **Step 12.3: Add `topItemsYesterday` to the morning brief**

  Open `lib/morning/brief/index.ts`. Locate where the brief assembler is composed (the function that returns the structured payload). Add a step that fetches yesterday's committed food entries:

  ```ts
  // After the existing yesterday's daily_logs fetch:
  const yesterdayIso = /* yesterday's YYYY-MM-DD computed elsewhere */;
  const { data: foodEntries } = await supabase
    .from("food_log_entries")
    .select("items, totals")
    .eq("user_id", userId)
    .eq("status", "committed")
    .gte("eaten_at", `${yesterdayIso}T00:00:00Z`)
    .lte("eaten_at", `${yesterdayIso}T23:59:59Z`);

  // Flatten items, sort by kcal descending, take top 3.
  const flatItems = (foodEntries ?? []).flatMap((e) => e.items as Array<{ name: string; kcal: number }>);
  const dayKcal = flatItems.reduce((s, it) => s + it.kcal, 0);
  const topItemsYesterday: { source: "food_log" | "yazio" | "none"; items: Array<{ name: string; kcal: number; share_of_day_pct: number }> } =
    dayKcal > 0
      ? {
          source: "food_log",
          items: [...flatItems]
            .sort((a, b) => b.kcal - a.kcal)
            .slice(0, 3)
            .map((it) => ({ name: it.name, kcal: it.kcal, share_of_day_pct: Math.round((it.kcal / dayKcal) * 100) })),
        }
      : { source: "none", items: [] };

  // Pass topItemsYesterday into the advice-prompt builder (next step).
  ```

- [ ] **Step 12.4: Thread `topItemsYesterday` into the advice prompt**

  In `lib/morning/brief/advice-prompt.ts`, add `topItemsYesterday` to the context type used by the prompt builders. Inside the prompt body (in the section that lists "Athlete context" / nutrition data), add a conditional line:

  ```ts
  // Existing prompt template:
  // …
  ${topItemsYesterday?.source === "food_log" && topItemsYesterday.items.length > 0
    ? `\n## Yesterday's top items by calories\n${topItemsYesterday.items.map((it) => `- ${it.name} (${Math.round(it.kcal)} kcal, ${it.share_of_day_pct}% of day)`).join("\n")}\nUse this when relevant to today's recommendation.`
    : ""}
  // …
  ```

  Also extend `lib/morning/brief/assembler.ts` to pass `topItemsYesterday` through to `advice-prompt.ts`. No card UI change needed — only the prompt text gains a section.

- [ ] **Step 12.5: Add `top_items` to weekly review nutrition trends**

  In `lib/coach/weekly-review/compose-trends.ts`, locate where `trends.nutrition` is built. Add an optional `top_items` field:

  ```ts
  // After computing existing nutrition aggregates:
  const { data: weekEntries } = await supabase
    .from("food_log_entries")
    .select("items, eaten_at")
    .eq("user_id", userId)
    .eq("status", "committed")
    .gte("eaten_at", `${weekStart}T00:00:00Z`)
    .lte("eaten_at", `${weekEnd}T23:59:59Z`);

  const dayCount = new Set((weekEntries ?? []).map((e) => e.eaten_at.slice(0, 10))).size;
  let top_items: Array<{ name: string; frequency: number; total_kcal: number }> | undefined;
  if (dayCount >= 3 && weekEntries) {
    const tally = new Map<string, { frequency: number; total_kcal: number }>();
    for (const e of weekEntries) {
      for (const it of e.items as Array<{ name: string; kcal: number }>) {
        const key = it.name.toLowerCase();
        const cur = tally.get(key) ?? { frequency: 0, total_kcal: 0 };
        tally.set(key, { frequency: cur.frequency + 1, total_kcal: cur.total_kcal + it.kcal });
      }
    }
    top_items = [...tally.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.frequency * b.total_kcal - a.frequency * a.total_kcal)
      .slice(0, 5);
  }

  // Attach to nutrition trends:
  trends.nutrition = { ...trends.nutrition, top_items };
  ```

  Add `top_items?: Array<{ name: string; frequency: number; total_kcal: number }>` to the relevant TypeScript type for `WeeklyReviewPayload.trends.nutrition` (search `lib/data/types.ts` and `lib/coach/weekly-review/*` for the declaration).

- [ ] **Step 12.6: Surface `top_items` in the weekly review narrative prompt**

  In `lib/coach/weekly-review/narrative-prompt.ts`, locate the section of the prompt that handles `trends.nutrition`. Add a conditional template line:

  ```ts
  // Inside the nutrition portion of the prompt:
  ${trends.nutrition.top_items && trends.nutrition.top_items.length > 0
    ? `\nTop items by usage this week: ${trends.nutrition.top_items.map((t) => `${t.name} (×${t.frequency}, ${Math.round(t.total_kcal)} kcal total)`).join("; ")}`
    : ""}
  ```

- [ ] **Step 12.7: Typecheck and exercise the brief**

  ```bash
  npm run typecheck
  ```

  Then manually trigger a morning brief regenerate (use the `regenerate_morning_brief` tool via chat, or the retry-brief endpoint if `intake_state='brief_failed'` is easy to put yourself into). Verify the brief still renders and the AI's advice section references food items when relevant.

- [ ] **Step 12.8: Commit**

  ```bash
  git add lib/coach/tools.ts lib/coach/system-prompts.ts lib/morning/brief lib/coach/weekly-review
  git commit -m "feat(food-log): coach data hooks — query_food_log + brief topItems + weekly review top_items"
  ```

---

## Task 13: Audit script + CLAUDE.md update + final check

**Files:**
- Create: `scripts/audit-food-aggregation.mjs`
- Modify: `CLAUDE.md`

- [ ] **Step 13.1: Write the audit script**

  Create `scripts/audit-food-aggregation.mjs`:

  ```js
  #!/usr/bin/env node
  // scripts/audit-food-aggregation.mjs
  //
  // Read-only audit: for any date with committed food_log_entries, verify
  // daily_logs nutrition columns equal sum_food_entries(user_id, date).
  // Flags drift (e.g. a Yazio write that snuck through after in-app commit).
  //
  // Run via:
  //   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
  //        --env-file=.env.local scripts/audit-food-aggregation.mjs

  import { createSupabaseServiceRoleClient } from "../lib/supabase/server.ts";

  const supabase = createSupabaseServiceRoleClient();

  // Find every distinct (user_id, date) with committed food entries.
  const { data: pairs, error } = await supabase
    .rpc("food_log_distinct_dates")
    .returns();

  if (error || !pairs) {
    // RPC may not exist; fallback to a raw query via the SQL editor flow.
    // For single-user app, just hardcode the known user_id from env.
    const userId = process.env.AUDIT_USER_ID;
    if (!userId) throw new Error("Set AUDIT_USER_ID env var to your user id");
    const { data: entries } = await supabase
      .from("food_log_entries")
      .select("eaten_at")
      .eq("user_id", userId)
      .eq("status", "committed");
    const dates = new Set((entries ?? []).map((e) => e.eaten_at.slice(0, 10)));
    let drift = 0;
    for (const date of dates) {
      const { data: agg } = await supabase.rpc("sum_food_entries", { p_user_id: userId, p_date: date });
      const { data: log } = await supabase
        .from("daily_logs")
        .select("calories_eaten, protein_g, carbs_g, fat_g, fiber_g")
        .eq("user_id", userId)
        .eq("date", date)
        .single();
      const expected = agg ?? {};
      const actual = log ?? {};
      const fields = ["kcal", "protein_g", "carbs_g", "fat_g", "fiber_g"];
      const map = { kcal: "calories_eaten" };
      const driftFields = fields.filter((f) => {
        const col = map[f] ?? f;
        return Math.abs((actual[col] ?? 0) - (expected[f] ?? 0)) > 0.5;
      });
      if (driftFields.length > 0) {
        drift++;
        console.warn(`[DRIFT] ${date} fields: ${driftFields.join(",")}`);
        console.warn(`  expected:`, expected);
        console.warn(`  actual:`, actual);
      }
    }
    if (drift === 0) console.log(`✓ ${dates.size} dates audited, no drift`);
    else console.log(`✗ ${drift}/${dates.size} dates drifted`);
    process.exit(drift === 0 ? 0 : 1);
  }
  ```

- [ ] **Step 13.2: Run the audit**

  Set your user id and run:

  ```bash
  AUDIT_USER_ID=<your-uuid> \
  node --import ./scripts/alias-loader.mjs --experimental-strip-types \
       --env-file=.env.local scripts/audit-food-aggregation.mjs
  ```

  Expected: `✓ N dates audited, no drift` for whatever dates you've committed entries on.

- [ ] **Step 13.3: Update CLAUDE.md**

  Add migration 0018 to the Database migrations chain:

  ```markdown
  16. [supabase/migrations/0018_food_logging.sql](supabase/migrations/0018_food_logging.sql) — adds `food_log_entries` (item-level meal log: text/barcode/photo/voice) + `food_db_cache` (shared cache of USDA + OpenFoodFacts lookups with pg_trgm index) + `sum_food_entries(user_id, date)` aggregation function + `profiles.disable_yazio_ingest` opt-out flag.
  ```

  Add a new sub-section under "Data sources & precedence":

  ```markdown
  - **In-app food logging** ([lib/food/](lib/food/), table `food_log_entries`) — owns `calories_eaten`, `protein_g`, `carbs_g`, `fat_g`, `fiber_g` on `daily_logs` for any date with at least one committed `food_log_entries` row. Item extraction via Haiku 4.5 (text) or OpenFoodFacts (barcode) → macro resolution via `lib/food/lookup.ts:resolveItemMacros` (cache → USDA FDC → Haiku 4.5 fallback marked `is_estimated`) → commit via `/api/food/commit` calls `sum_food_entries` and upserts `daily_logs`. Yazio CSV ingest at [/api/ingest/health?source=yazio](app/api/ingest/health/route.ts) checks for committed in-app entries on the same date and skips its nutrition write when present; also short-circuits entirely when `profiles.disable_yazio_ingest = true`. Photo (Spec B) and voice (Spec C) modalities reuse the same data model; their UI tabs ship greyed-out in Spec A.
  ```

  Also note the new chat tool in the coach AI section:

  ```markdown
  - `query_food_log(start_date, end_date, item_filter?)` — added with in-app food logging (sub-project #1 of coach-team arc). Returns per-item macros for committed entries. Distinct from `query_daily_logs` which returns daily totals.
  ```

- [ ] **Step 13.4: Final typecheck**

  ```bash
  npm run typecheck
  ```

  Expected: exits 0.

- [ ] **Step 13.5: Commit and offer to merge**

  ```bash
  git add scripts/audit-food-aggregation.mjs CLAUDE.md
  git commit -m "feat(food-log): audit script + CLAUDE.md update for in-app food logging"
  ```

  Branch is ready. If using a worktree, the typical next step is to push and open a PR:

  ```bash
  git push -u origin feat/food-logging
  gh pr create --title "feat: in-app food logging (Spec A)" --body "$(cat <<'EOF'
  ## Summary
  - Ships Spec A of sub-project #1 (coach-team arc): in-app food logging foundation.
  - Text + barcode modalities. Photo + voice tabs greyed for forward compat (Spec B + C).
  - Hybrid macro resolution: USDA + OpenFoodFacts cache, Haiku 4.5 fallback flagged `is_estimated`.
  - Yazio CSV ingest deprecated to legacy fallback (in-app commits take precedence per date).
  - Additive coach hooks: `query_food_log` chat tool, morning-brief top items, weekly-review `top_items`.

  ## Test plan
  - [ ] Migration 0018 applied via `supabase db push`
  - [ ] `npm run typecheck` green
  - [ ] Text logging: parse → preview → commit → totals appear on /log and dashboard
  - [ ] Barcode logging: scan a real UPC → preview → commit
  - [ ] Edit committed entry qty → daily_logs reflects new totals
  - [ ] Delete committed entry → daily_logs reflects removal
  - [ ] Yazio CSV upload on a date with in-app entries logs the skip and does NOT overwrite nutrition columns
  - [ ] Profile toggle "Stop importing Yazio" → subsequent Yazio uploads return `skipped: true`
  - [ ] `scripts/audit-food-aggregation.mjs` reports no drift
  - [ ] Morning brief regenerate references food items in advice section when present
  - [ ] Coach chat: ask "what did I eat today?" — `query_food_log` fires and returns items

  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  EOF
  )"
  ```

  Do not push or create the PR without explicit user instruction — this step is the recipe, the user runs it when they're ready.

---

## Self-Review Notes (informational, not steps)

**Spec coverage check** — every numbered goal in the spec maps to at least one task:
- Goal 1 (4 modalities) → Tasks 4, 5, 10 (text + barcode shipped; photo + voice greyed-out shells)
- Goal 2 (DB + LLM fallback) → Task 3
- Goal 3 (item-level + day aggregation) → Tasks 1, 6, 7 (commit route)
- Goal 4 (Yazio coexistence with precedence) → Task 8
- Goal 5 (three additive coach hooks) → Task 12
- Goal 6 (Fab + MealLoggerSheet) → Task 10

**Non-goal compliance** — Nutrition coach persona, photo/voice ingest, recipe save, restaurant DB, micronutrient tracking, per-meal AI reactions all explicitly out of scope and left out of tasks.

**Spec §"Open items"** — three of the four open items remain open by design (Haiku prompt tuning, trigram threshold tuning, `food_db_cache.raw_payload` retention). The fourth (day-bucketing timezone) is acknowledged in Task 6 comments with the simple-UTC-for-now stance.
