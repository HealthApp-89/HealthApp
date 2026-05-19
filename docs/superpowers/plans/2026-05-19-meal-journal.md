# Meal Journal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add meal-slot grouping (breakfast/lunch/dinner/snack) to the in-app food log, a dedicated `/meal` top-level tab with a meal-first journal UI, a user-editable nutrition-target override layer on `profiles`, and matching coach tools.

**Architecture:** Two migrations add `food_log_entries.meal_slot` (`text NOT NULL` with `'snack'` default, backfilled by time-of-day) and `profiles.nutrition_overrides jsonb`. The `/meal` route is SSR-hydrated like other pages — server prefetches food entries + today targets, client renders `MealJournalDay` + four `MealSlotCard`s. `getTodayTargets` gains a per-field override layer at the top of its resolution chain. Two new coach tools (`propose_nutrition_targets` / `commit_nutrition_targets`) reuse the existing HMAC propose/commit pattern signed with `COACH_TOOL_SECRET`. `/metrics?sub=log` is retired (work moves to `/meal`); `MealLoggerSheet` and `FoodEntryEditSheet` stay and gain new props.

**Tech Stack:** Next.js 15 (App Router), Supabase (Postgres + RLS), TanStack Query v5, Tailwind v4, Anthropic SDK, Zod, lucide-react icons.

**Spec:** [docs/superpowers/specs/2026-05-19-meal-journal-design.md](../specs/2026-05-19-meal-journal-design.md)

**No test suite note:** This project has no unit-test harness ([CLAUDE.md](../../../CLAUDE.md) explicitly: "There is no test suite and no working linter"). Verification per task is `npm run typecheck` + manual UX exercise in a local dev server, plus targeted node scripts for DB-shape changes. Commits run after each green typecheck.

**Spec deviation noted up front:** The spec's §1 says the `meal_slot` `default` is dropped after backfill. This plan keeps `default 'snack'` permanently — the "must specify a slot" invariant is enforced by Zod in the parse/barcode/commit/PATCH routes (every legitimate insert path requires it), and the DB default stays as defense-in-depth in case a future path forgets. Smaller blast radius if a non-UI code path inserts a row.

---

## File structure

**New files:**
- `supabase/migrations/0020_food_log_meal_slot.sql`
- `supabase/migrations/0021_profile_nutrition_overrides.sql`
- `lib/food/meal-slot.ts` — `MealSlot` enum, `deriveMealSlot`, `MEAL_SLOTS`, `mealSlotLabel`
- `lib/food/meal-targets.ts` — `MealRatios`, `DEFAULT_MEAL_RATIOS`, `targetForSlot`, `targetsForAllSlots`
- `app/meal/page.tsx` — SSR shell
- `app/meal/MealJournalClient.tsx` — client component, hydration consumer
- `components/meal/MealJournalDay.tsx`
- `components/meal/MealSlotCard.tsx`
- `components/meal/MealSlotEmptyCard.tsx`
- `app/api/profile/today-targets/route.ts` — GET endpoint backing `useTodayTargets`
- `app/api/profile/nutrition-overrides/route.ts` — POST endpoint
- `lib/query/fetchers/todayTargets.ts` — server + browser fetchers
- `lib/query/hooks/useTodayTargets.ts`
- `components/profile/NutritionTargetsSection.tsx`
- `components/chat/NutritionTargetsProposalCard.tsx` — proposal-chip UI for coach tool

**Modified files:**
- `lib/food/types.ts` — add `MealSlot` re-export + `FoodLogEntry.meal_slot`
- `lib/query/fetchers/foodEntries.ts` — add `meal_slot` to COLS
- `lib/query/keys.ts` — add `todayTargets` key
- `lib/morning/brief/get-today-targets.ts` — apply `nutrition_overrides` + return `meal_ratios`
- `app/api/food/parse/route.ts` — accept `meal_slot` in Zod, set on insert
- `app/api/food/barcode/route.ts` — accept `meal_slot` in Zod, set on insert
- `app/api/food/commit/route.ts` — `revalidatePath("/meal")` instead of `"/log"`
- `app/api/food/entries/[id]/route.ts` — PATCH accepts optional `meal_slot` + `eaten_at`
- `components/log/MealLoggerSheet.tsx` — new props `initialMealSlot`, `initialEatenAt`
- `components/log/MealLoggerTypeTab.tsx` — accept slot from parent, send in parse body
- `components/log/MealLoggerScanTab.tsx` — accept slot from parent, send in barcode body
- `components/log/FoodEntryEditSheet.tsx` — add `eaten_at` + `meal_slot` controls
- `components/layout/BottomNav.tsx` — insert `/meal` entry
- `app/metrics/MetricsShell.tsx` — remove "Log" pill from list
- `lib/coach/tools.ts` — extend `query_food_log`, add `propose_nutrition_targets` + `commit_nutrition_targets`
- `components/chat/ChatThread.tsx` — dispatch new proposal-chip card
- `CLAUDE.md` — append paragraph to `## Architecture › Data sources & precedence`

**Deleted files:**
- `app/metrics/_sub/LogSubPill.tsx`
- `components/log/LogClient.tsx`
- `components/log/TodaysMeals.tsx`

---

## Task 1: Migration 0020 — `meal_slot` column + backfill

**Files:**
- Create: `supabase/migrations/0020_food_log_meal_slot.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0020_food_log_meal_slot.sql
--
-- Adds meal_slot to food_log_entries (breakfast/lunch/dinner/snack) as a
-- durable attribution dimension for the meal-first journal UI on /meal and
-- the meal_slot filter on the query_food_log coach tool.
--
-- meal_slot is an ATTRIBUTION dimension, not an ownership change — the
-- daily_logs nutrition aggregation in sum_food_entries stays slot-agnostic.
-- See CLAUDE.md "Data sources & precedence".

alter table food_log_entries
  add column meal_slot text
    check (meal_slot in ('breakfast','lunch','dinner','snack')) not null
    default 'snack';

-- Backfill existing rows by time-of-day. UTC-bucketed to match
-- sum_food_entries day-keying.
update food_log_entries
set meal_slot = case
  when extract(hour from eaten_at) between 4 and 10 then 'breakfast'
  when extract(hour from eaten_at) between 11 and 14 then 'lunch'
  when extract(hour from eaten_at) between 15 and 16 then 'snack'
  when extract(hour from eaten_at) between 17 and 21 then 'dinner'
  else 'snack'
end;

create index on food_log_entries (user_id, eaten_at, meal_slot);
```

- [ ] **Step 2: Apply the migration**

Run: `supabase db push`
Expected: "Applying migration 0020_food_log_meal_slot.sql ... Done."

- [ ] **Step 3: Verify backfill in dashboard**

Open the Supabase SQL editor and run:

```sql
select meal_slot, count(*) from food_log_entries group by meal_slot order by 1;
```

Expected: rows summing to total count, with at least `snack` populated (every row has a slot).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0020_food_log_meal_slot.sql
git commit -m "feat(meal): migration 0020 — meal_slot column on food_log_entries"
```

---

## Task 2: TypeScript types + meal-slot module + fetcher columns

**Files:**
- Modify: `lib/food/types.ts`
- Create: `lib/food/meal-slot.ts`
- Modify: `lib/query/fetchers/foodEntries.ts`

- [ ] **Step 1: Add `MealSlot` type to `lib/food/types.ts`**

Add to the top of the file (after the imports/comments):

```ts
export type MealSlot = "breakfast" | "lunch" | "dinner" | "snack";
```

In `FoodLogEntry`, add `meal_slot` after `kind`:

```ts
export type FoodLogEntry = {
  id: string;
  user_id: string;
  eaten_at: string;
  kind: FoodLogEntryKind;
  meal_slot: MealSlot;
  // … rest unchanged …
};
```

- [ ] **Step 2: Create `lib/food/meal-slot.ts`**

```ts
// lib/food/meal-slot.ts
//
// Pure helpers for meal_slot. The deriveMealSlot mapping MUST stay in
// lockstep with the SQL CASE in supabase/migrations/0020_food_log_meal_slot.sql
// (used for the one-shot backfill). Going forward, this TS function is the
// runtime source of truth — the migration mapping is frozen historical code.

import type { MealSlot } from "./types";

export const MEAL_SLOTS = ["breakfast", "lunch", "dinner", "snack"] as const;

export function deriveMealSlot(d: Date): MealSlot {
  const h = d.getHours();
  if (h >= 4 && h <= 10) return "breakfast";
  if (h >= 11 && h <= 14) return "lunch";
  if (h >= 15 && h <= 16) return "snack";
  if (h >= 17 && h <= 21) return "dinner";
  return "snack";
}

export function mealSlotLabel(s: MealSlot): string {
  switch (s) {
    case "breakfast": return "Breakfast";
    case "lunch":     return "Lunch";
    case "dinner":    return "Dinner";
    case "snack":     return "Snacks";
  }
}
```

- [ ] **Step 3: Add `meal_slot` to fetcher COLS**

In `lib/query/fetchers/foodEntries.ts`, change the `COLS` constant:

```ts
const COLS =
  "id, user_id, eaten_at, meal_slot, kind, raw_input, items, totals, is_estimated, status, created_at, updated_at";
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/food/types.ts lib/food/meal-slot.ts lib/query/fetchers/foodEntries.ts
git commit -m "feat(meal): MealSlot type, deriveMealSlot helper, fetcher columns"
```

---

## Task 3: `lib/food/meal-targets.ts`

**Files:**
- Create: `lib/food/meal-targets.ts`

- [ ] **Step 1: Write the module**

```ts
// lib/food/meal-targets.ts
//
// Pure derivation of per-meal kcal targets from a day-level kcal target +
// optional user ratios. Consumed by MealSlotCard and the day-summary card.

import type { MealSlot } from "./types";

export type MealRatios = {
  breakfast: number;
  lunch: number;
  dinner: number;
  snacks: number;
};

export const DEFAULT_MEAL_RATIOS: MealRatios = {
  breakfast: 0.30,
  lunch:     0.35,
  dinner:    0.30,
  snacks:    0.05,
};

export function targetForSlot(
  slot: MealSlot,
  dayKcal: number,
  ratios: MealRatios = DEFAULT_MEAL_RATIOS,
): number {
  const k =
    slot === "breakfast" ? ratios.breakfast :
    slot === "lunch"     ? ratios.lunch     :
    slot === "dinner"    ? ratios.dinner    :
    ratios.snacks;
  return Math.round(dayKcal * k);
}

export function targetsForAllSlots(
  dayKcal: number,
  ratios: MealRatios = DEFAULT_MEAL_RATIOS,
): Record<MealSlot, number> {
  return {
    breakfast: targetForSlot("breakfast", dayKcal, ratios),
    lunch:     targetForSlot("lunch",     dayKcal, ratios),
    dinner:    targetForSlot("dinner",    dayKcal, ratios),
    snack:     targetForSlot("snack",     dayKcal, ratios),
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/food/meal-targets.ts
git commit -m "feat(meal): meal-targets module — default ratios + slot target compute"
```

---

## Task 4: Parse/barcode/commit routes + MealLoggerSheet plumbing

**Files:**
- Modify: `app/api/food/parse/route.ts`
- Modify: `app/api/food/barcode/route.ts`
- Modify: `app/api/food/commit/route.ts`
- Modify: `components/log/MealLoggerSheet.tsx`
- Modify: `components/log/MealLoggerTypeTab.tsx`
- Modify: `components/log/MealLoggerScanTab.tsx`

- [ ] **Step 1: Parse route accepts `meal_slot`**

In `app/api/food/parse/route.ts`, update the Zod schema and insert payload. Find the schema definition (Zod object near top of file) and add:

```ts
const Body = z.object({
  text: z.string().min(1).max(500),
  eaten_at: z.string().datetime().optional(),
  meal_slot: z.enum(["breakfast", "lunch", "dinner", "snack"]),
});
```

In the `.insert({ … })` call, add `meal_slot: parsed.data.meal_slot,` (alongside the existing `kind`, `raw_input`, etc).

- [ ] **Step 2: Barcode route accepts `meal_slot`**

In `app/api/food/barcode/route.ts`, do the same: extend the Zod body to require `meal_slot`, and include it in the `.insert({ … })`.

- [ ] **Step 3: Commit route: fix revalidatePath**

In `app/api/food/commit/route.ts`, line ~49:

```ts
revalidatePath("/meal");   // was: "/log"
revalidatePath("/");
```

`/log` no longer exists after Task 13; switch now so commits during the rollout still invalidate the new page once it's created.

- [ ] **Step 4: `MealLoggerSheet` accepts new props**

In `components/log/MealLoggerSheet.tsx`, change the prop type and pass props down:

```ts
import type { MealSlot } from "@/lib/food/types";
import { deriveMealSlot, mealSlotLabel } from "@/lib/food/meal-slot";

type Tab = "type" | "scan" | "photo" | "voice";

export function MealLoggerSheet({
  open,
  onClose,
  initialMealSlot,
  initialEatenAt,
}: {
  open: boolean;
  onClose: () => void;
  initialMealSlot?: MealSlot;
  initialEatenAt?: string;
}) {
  const [tab, setTab] = useState<Tab>("type");
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
    onClose();
  };

  const title = initialMealSlot ? `Log ${mealSlotLabel(initialMealSlot)}` : "Log meal";

  return (
    <BottomSheet open={open} onClose={onClose} title={title}>
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
        {tab === "type" && (
          <MealLoggerTypeTab
            mealSlot={mealSlot}
            eatenAt={eatenAt}
            onCommitted={onCommitted}
          />
        )}
        {tab === "scan" && (
          <MealLoggerScanTab
            mealSlot={mealSlot}
            eatenAt={eatenAt}
            onCommitted={onCommitted}
          />
        )}
        {tab === "photo" && <MealLoggerComingSoonTab modality="photo" />}
        {tab === "voice" && <MealLoggerComingSoonTab modality="voice" />}
      </div>
    </BottomSheet>
  );
}
```

- [ ] **Step 5: Type tab sends `meal_slot` in parse request**

Open `components/log/MealLoggerTypeTab.tsx`. Find the prop type and the `fetch("/api/food/parse", …)` call. Modify:

```ts
import type { MealSlot } from "@/lib/food/types";

export function MealLoggerTypeTab({
  mealSlot,
  eatenAt,
  onCommitted,
}: {
  mealSlot: MealSlot;
  eatenAt: string;
  onCommitted: () => void;
}) {
  // … existing state …
```

In the parse-call body, add `meal_slot` and `eaten_at`:

```ts
const res = await fetch("/api/food/parse", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text, meal_slot: mealSlot, eaten_at: eatenAt }),
});
```

- [ ] **Step 6: Scan tab sends `meal_slot` in barcode request**

Open `components/log/MealLoggerScanTab.tsx`. Mirror the change from Step 5: add `mealSlot`/`eatenAt` props, include `meal_slot` and `eaten_at` in the `/api/food/barcode` fetch body.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Manual smoke test**

Start `npm run dev`. From `/metrics`, tap the "+ Log entry" sticky button → "Log meal" → MealLoggerSheet opens. Type a quick meal ("two eggs and toast"), commit. Open the Supabase dashboard, run:

```sql
select id, eaten_at, meal_slot, status from food_log_entries
order by created_at desc limit 1;
```

Expected: `meal_slot` is non-null (matches `deriveMealSlot(now)`), `status='committed'`.

- [ ] **Step 9: Commit**

```bash
git add app/api/food/parse/route.ts app/api/food/barcode/route.ts app/api/food/commit/route.ts components/log/MealLoggerSheet.tsx components/log/MealLoggerTypeTab.tsx components/log/MealLoggerScanTab.tsx
git commit -m "feat(meal): parse/barcode/commit routes + MealLoggerSheet plumb meal_slot"
```

---

## Task 5: Migration 0021 — `nutrition_overrides` on `profiles`

**Files:**
- Create: `supabase/migrations/0021_profile_nutrition_overrides.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0021_profile_nutrition_overrides.sql
--
-- Adds nutrition_overrides jsonb to profiles. Shape (validated app-side
-- by /api/profile/nutrition-overrides — jsonb fields stay flexible):
--   {
--     kcal?: number,
--     macro_ratios?: { protein_pct, carbs_pct, fat_pct },  // sums to 1.0 ± 0.01
--     meal_ratios?:  { breakfast, lunch, dinner, snacks }  // sums to 1.0 ± 0.01
--   } | null
-- NULL means "no overrides, fall through to plan_payload / intake_payload".
-- Consumed by getTodayTargets at lib/morning/brief/get-today-targets.ts.

alter table profiles
  add column nutrition_overrides jsonb;
```

- [ ] **Step 2: Apply the migration**

Run: `supabase db push`
Expected: "Applying migration 0021_profile_nutrition_overrides.sql ... Done."

- [ ] **Step 3: Verify the column exists**

In Supabase SQL editor:

```sql
select column_name, data_type from information_schema.columns
where table_name='profiles' and column_name='nutrition_overrides';
```

Expected: one row `(nutrition_overrides, jsonb)`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0021_profile_nutrition_overrides.sql
git commit -m "feat(meal): migration 0021 — profiles.nutrition_overrides jsonb"
```

---

## Task 6: Extend `getTodayTargets` with overrides + meal_ratios

**Files:**
- Modify: `lib/morning/brief/get-today-targets.ts`

- [ ] **Step 1: Extend `TodayTargets` return shape**

Add to the `TodayTargets` type:

```ts
export type TodayTargetsSourceMap = {
  kcal: "override" | "plan" | "intake";
  macros: "override" | "plan" | "intake";
  meal_ratios: "override" | "plan" | "default";
};

// NOTE: MealRatios lives in lib/food/meal-targets.ts — this module re-exports
// it so callers can import from either location.
import type { MealRatios } from "@/lib/food/meal-targets";
export type { MealRatios };

export type TodayTargets = {
  // … all existing fields stay …
  meal_ratios: MealRatios;
  source_per_field: TodayTargetsSourceMap;
};
```

Import `MealRatios` from `lib/food/meal-targets.ts` and re-export it from this module — there is exactly one definition (in `meal-targets.ts`) and any consumer can import from either location. No duplicate definitions.

- [ ] **Step 2: Add an overrides reader**

Add near the other helpers in the file:

```ts
type NutritionOverrides = {
  kcal?: number;
  macro_ratios?: { protein_pct: number; carbs_pct: number; fat_pct: number };
  meal_ratios?: MealRatios;
} | null;

async function getOverrides(
  supabase: SupabaseClient,
  userId: string,
): Promise<NutritionOverrides> {
  const { data, error } = await supabase
    .from("profiles")
    .select("nutrition_overrides")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data?.nutrition_overrides ?? null) as NutritionOverrides;
}

const DEFAULT_MEAL_RATIOS: MealRatios = {
  breakfast: 0.30, lunch: 0.35, dinner: 0.30, snacks: 0.05,
};

function applyOverrides(
  base: Omit<TodayTargets, "meal_ratios" | "source_per_field">,
  overrides: NutritionOverrides,
): TodayTargets {
  // Per-field override semantics:
  //  - override.kcal alone changes only kcal; protein_g/carb_g/fat_g stay
  //    at the base values (acceptable UX: meal-split display surfaces the
  //    discrepancy; the user opted into manual control).
  //  - override.macro_ratios recomputes grams against the effective kcal.
  //  - override.meal_ratios is orthogonal to kcal/macros.
  const finalKcal = overrides?.kcal ?? base.kcal;

  let protein_g = base.protein_g;
  let carb_g = base.carb_g;
  let fat_g = base.fat_g;
  if (overrides?.macro_ratios) {
    protein_g = Math.round((finalKcal * overrides.macro_ratios.protein_pct) / 4);
    carb_g    = Math.round((finalKcal * overrides.macro_ratios.carbs_pct)   / 4);
    fat_g     = Math.round((finalKcal * overrides.macro_ratios.fat_pct)     / 9);
  }

  const meal_ratios = overrides?.meal_ratios ?? DEFAULT_MEAL_RATIOS;

  const source_per_field: TodayTargetsSourceMap = {
    kcal:        overrides?.kcal !== undefined         ? "override" : (base.source as "plan" | "intake"),
    macros:      overrides?.macro_ratios !== undefined ? "override" : (base.source as "plan" | "intake"),
    meal_ratios: overrides?.meal_ratios !== undefined  ? "override" : "default",
  };

  return {
    ...base,
    kcal: finalKcal,
    protein_g,
    carb_g,
    fat_g,
    meal_ratios,
    source_per_field,
  };
}
```

- [ ] **Step 3: Wire `applyOverrides` into every return path**

`getTodayTargets` has multiple return statements (GLP-1 active, GLP-1 tapering, classical, steady-state plan, intake fallback). For each, wrap the existing return object with `applyOverrides`. Example (steady-state plan):

```ts
// before:
return {
  kcal: plan.nutrition.kcal_target,
  protein_g: plan.nutrition.protein_g,
  // …
};

// after:
const base = {
  kcal: plan.nutrition.kcal_target,
  protein_g: plan.nutrition.protein_g,
  // … all existing fields up to and including today_phase_mode …
};
return applyOverrides(base, overrides);
```

At the top of the function (after the first `data` fetch), add:

```ts
const overrides = await getOverrides(supabase, userId);
```

Run the override-wrap on all five branches:
1. GLP-1 active
2. GLP-1 tapering
3. Classical
4. Steady-state plan
5. Phase 1 intake fallback

Each branch's `base` object is `Omit<TodayTargets, "meal_ratios" | "source_per_field">`.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/morning/brief/get-today-targets.ts
git commit -m "feat(meal): per-field nutrition overrides layer + meal_ratios on TodayTargets"
```

---

## Task 7: `useTodayTargets` hook + GET endpoint

**Files:**
- Create: `app/api/profile/today-targets/route.ts`
- Create: `lib/query/fetchers/todayTargets.ts`
- Create: `lib/query/hooks/useTodayTargets.ts`
- Modify: `lib/query/keys.ts`

- [ ] **Step 1: Server route**

```ts
// app/api/profile/today-targets/route.ts
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getTodayTargets } from "@/lib/morning/brief/get-today-targets";

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const targets = await getTodayTargets(supabase, user.id);
  return NextResponse.json({ targets });
}
```

Note: `getTodayTargets` already pulls `todayInUserTz()` internally — no `?date` param needed for v1. Keeps the endpoint simple. The hook still takes a `date` arg so the query key namespaces correctly per-day cache (next-day rollover invalidates naturally on date change).

- [ ] **Step 2: Add query key**

In `lib/query/keys.ts`, add after `foodEntries`:

```ts
todayTargets: {
  all: (userId: string) => ["today-targets", userId] as const,
  byDate: (userId: string, date: string) =>
    ["today-targets", userId, date] as const,
},
```

- [ ] **Step 3: Fetchers**

```ts
// lib/query/fetchers/todayTargets.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { getTodayTargets, type TodayTargets } from "@/lib/morning/brief/get-today-targets";

export async function fetchTodayTargetsServer(
  supabase: SupabaseClient,
  userId: string,
): Promise<TodayTargets | null> {
  return getTodayTargets(supabase, userId);
}

export async function fetchTodayTargetsBrowser(): Promise<TodayTargets | null> {
  const res = await fetch("/api/profile/today-targets", { credentials: "include" });
  if (!res.ok) throw new Error(`today-targets fetch failed: ${res.status}`);
  const json = await res.json();
  return json.targets as TodayTargets | null;
}
```

The browser variant goes via the route (not direct Supabase) because `getTodayTargets` reads from `athlete_profile_documents` + `profiles` + `training_weeks` + `daily_logs` — too much for client-side, and we want one server compute pass.

- [ ] **Step 4: Hook**

```ts
// lib/query/hooks/useTodayTargets.ts
"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchTodayTargetsBrowser } from "@/lib/query/fetchers/todayTargets";

export function useTodayTargets(userId: string, date: string) {
  return useQuery({
    queryKey: queryKeys.todayTargets.byDate(userId, date),
    queryFn: fetchTodayTargetsBrowser,
    enabled: !!userId,
  });
}
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/api/profile/today-targets/route.ts lib/query/fetchers/todayTargets.ts lib/query/hooks/useTodayTargets.ts lib/query/keys.ts
git commit -m "feat(meal): /api/profile/today-targets endpoint + useTodayTargets hook"
```

---

## Task 8: `/meal` route skeleton

**Files:**
- Create: `app/meal/page.tsx`
- Create: `app/meal/MealJournalClient.tsx`

- [ ] **Step 1: Server page**

```tsx
// app/meal/page.tsx
import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { queryKeys } from "@/lib/query/keys";
import { fetchFoodEntriesServer } from "@/lib/query/fetchers/foodEntries";
import { fetchTodayTargetsServer } from "@/lib/query/fetchers/todayTargets";
import { todayInUserTz } from "@/lib/time";
import { MealJournalClient } from "./MealJournalClient";

export const dynamic = "force-dynamic";

export default async function MealPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const sp = await searchParams;
  const date = sp.date ?? todayInUserTz();

  const qc = makeServerQueryClient();
  await Promise.all([
    qc.prefetchQuery({
      queryKey: queryKeys.foodEntries.range(user.id, date, date),
      queryFn: () => fetchFoodEntriesServer(supabase, user.id, date, date),
    }),
    qc.prefetchQuery({
      queryKey: queryKeys.todayTargets.byDate(user.id, date),
      queryFn: () => fetchTodayTargetsServer(supabase, user.id),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <MealJournalClient userId={user.id} date={date} />
    </HydrationBoundary>
  );
}
```

- [ ] **Step 2: Client component skeleton**

```tsx
// app/meal/MealJournalClient.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useFoodEntries } from "@/lib/query/hooks/useFoodEntries";
import { useTodayTargets } from "@/lib/query/hooks/useTodayTargets";
import { MealLoggerSheet } from "@/components/log/MealLoggerSheet";
import { FoodEntryEditSheet } from "@/components/log/FoodEntryEditSheet";
import type { FoodLogEntry, MealSlot } from "@/lib/food/types";

export function MealJournalClient({
  userId,
  date,
}: {
  userId: string;
  date: string;
}) {
  const router = useRouter();
  const { data: entries = [] } = useFoodEntries(userId, date, date);
  const { data: targets } = useTodayTargets(userId, date);
  const [loggerOpen, setLoggerOpen] = useState<MealSlot | null>(null);
  const [editing, setEditing] = useState<FoodLogEntry | null>(null);

  // Date scrubber helpers — bump date by ±1 day via URL.
  const shift = (deltaDays: number) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + deltaDays);
    router.push(`/meal?date=${d.toISOString().slice(0, 10)}`);
  };

  // The actual rendering (day summary + 4 slot cards) lands in Task 11.
  // For now, prove the data path works.
  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-32">
      <h1 className="text-xl font-semibold">Meal · {date}</h1>
      <p className="mt-2 text-xs text-zinc-500">
        Entries: {entries.length} · Target kcal: {targets?.kcal ?? "—"}
      </p>
      <div className="mt-3 flex gap-2 text-xs">
        <button onClick={() => shift(-1)} className="rounded border border-zinc-700 px-2 py-1">‹ prev</button>
        <button onClick={() => shift(1)} className="rounded border border-zinc-700 px-2 py-1">next ›</button>
      </div>

      {loggerOpen && (
        <MealLoggerSheet
          open
          onClose={() => setLoggerOpen(null)}
          initialMealSlot={loggerOpen}
          initialEatenAt={
            date === new Date().toISOString().slice(0, 10)
              ? new Date().toISOString()
              : `${date}T12:00:00.000Z`
          }
        />
      )}
      {editing && (
        <FoodEntryEditSheet entry={editing} onClose={() => setEditing(null)} />
      )}
    </main>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Manual smoke test**

Start `npm run dev`. Navigate to `http://localhost:3000/meal`. Expect: heading "Meal · YYYY-MM-DD" with today's date, entry count, and target kcal. Test `?date=2026-05-18` URL param to confirm scrubbing.

- [ ] **Step 5: Commit**

```bash
git add app/meal/page.tsx app/meal/MealJournalClient.tsx
git commit -m "feat(meal): /meal route skeleton with SSR hydrate"
```

---

## Task 9: `MealJournalDay` (day summary card)

**Files:**
- Create: `components/meal/MealJournalDay.tsx`

- [ ] **Step 1: Implement the component**

```tsx
// components/meal/MealJournalDay.tsx
"use client";

import { fmtNum } from "@/lib/ui/score";
import type { FoodLogEntry } from "@/lib/food/types";
import type { TodayTargets } from "@/lib/morning/brief/get-today-targets";

export function MealJournalDay({
  entries,
  targets,
  date,
  onShiftDate,
}: {
  entries: FoodLogEntry[];
  targets: TodayTargets | null;
  date: string;
  onShiftDate: (delta: number) => void;
}) {
  const totals = entries.reduce(
    (a, e) => ({
      kcal: a.kcal + e.totals.kcal,
      p:    a.p    + e.totals.protein_g,
      c:    a.c    + e.totals.carbs_g,
      f:    a.f    + e.totals.fat_g,
      fb:   a.fb   + e.totals.fiber_g,
    }),
    { kcal: 0, p: 0, c: 0, f: 0, fb: 0 },
  );

  const targetKcal = targets?.kcal ?? null;
  const remaining = targetKcal !== null ? targetKcal - totals.kcal : null;

  const mealsLogged = new Set(entries.map((e) => e.meal_slot)).size;

  // Display date as weekday + month/day from the ISO string.
  const d = new Date(`${date}T00:00:00`);
  const weekday = d.toLocaleDateString(undefined, { weekday: "short" });
  const month = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <section className="rounded-lg border border-zinc-800 p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <div>
          <div className="text-lg font-semibold">{weekday} · {month}</div>
          <div className="text-xs uppercase tracking-wider text-zinc-500">Daily journal</div>
        </div>
        <div className="flex gap-1 text-zinc-400">
          <button type="button" onClick={() => onShiftDate(-1)} aria-label="Previous day" className="px-2 py-1">‹</button>
          <button type="button" onClick={() => onShiftDate(1)}  aria-label="Next day"     className="px-2 py-1">›</button>
        </div>
      </header>

      <div className="mb-2 flex items-baseline justify-between text-xs uppercase tracking-wider text-zinc-500">
        <span>Eaten · Target · Remaining</span>
        <span>{mealsLogged} / 4 meals</span>
      </div>
      <div className="mb-3 flex items-baseline justify-between">
        <div>
          <span className="text-2xl font-semibold">{fmtNum(totals.kcal)}</span>
          <span className="ml-1 text-sm text-zinc-500">
            / {targetKcal !== null ? `${fmtNum(targetKcal)} kcal` : "—"}
          </span>
        </div>
        <div className="text-sm text-zinc-400">
          {remaining !== null ? `${fmtNum(remaining)} left` : ""}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 text-xs text-zinc-400">
        <MacroBar label="P"  eaten={totals.p}  target={targets?.protein_g} color="bg-green-500" />
        <MacroBar label="C"  eaten={totals.c}  target={targets?.carb_g}    color="bg-sky-500" />
        <MacroBar label="F"  eaten={totals.f}  target={targets?.fat_g}     color="bg-amber-500" />
        <MacroBar label="Fb" eaten={totals.fb} target={null}               color="bg-violet-500" />
      </div>
    </section>
  );
}

function MacroBar({
  label,
  eaten,
  target,
  color,
}: {
  label: string;
  eaten: number;
  target: number | null | undefined;
  color: string;
}) {
  const pct = target && target > 0 ? Math.min(100, (eaten / target) * 100) : 0;
  return (
    <div>
      <div className="mb-1">
        {label} {fmtNum(eaten)}{target ? ` / ${fmtNum(target)}` : ""}
      </div>
      <div className="h-1 overflow-hidden rounded bg-zinc-800">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/meal/MealJournalDay.tsx
git commit -m "feat(meal): day summary card with macro bars + date scrubber"
```

---

## Task 10: `MealSlotCard` + `MealSlotEmptyCard`

**Files:**
- Create: `components/meal/MealSlotCard.tsx`
- Create: `components/meal/MealSlotEmptyCard.tsx`

- [ ] **Step 1: `MealSlotCard`**

```tsx
// components/meal/MealSlotCard.tsx
"use client";

import { fmtNum } from "@/lib/ui/score";
import { mealSlotLabel } from "@/lib/food/meal-slot";
import type { FoodLogEntry, MealSlot } from "@/lib/food/types";

export function MealSlotCard({
  slot,
  entries,
  targetKcal,
  onLog,
  onTapEntry,
}: {
  slot: MealSlot;
  entries: FoodLogEntry[];
  targetKcal: number | null;
  onLog: () => void;
  onTapEntry: (e: FoodLogEntry) => void;
}) {
  const slotKcal = entries.reduce((a, e) => a + e.totals.kcal, 0);
  const earliest = entries.length > 0
    ? new Date(entries[entries.length - 1].eaten_at).toLocaleTimeString([], {
        hour: "2-digit", minute: "2-digit",
      })
    : null;

  return (
    <section className="rounded-lg border border-zinc-800">
      <header className="flex items-center justify-between border-b border-zinc-900 p-3">
        <div>
          <div className="text-sm font-semibold">{mealSlotLabel(slot)}</div>
          <div className="text-xs text-zinc-500">
            {earliest && `${earliest} · `}
            {fmtNum(slotKcal)} kcal
            {targetKcal !== null && ` / ${fmtNum(targetKcal)} target`}
          </div>
        </div>
        <button
          type="button"
          onClick={onLog}
          aria-label={`Log ${mealSlotLabel(slot)}`}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-100 text-lg font-semibold text-zinc-900"
        >
          +
        </button>
      </header>

      <ul>
        {entries.map((e) => (
          <li key={e.id} className="border-b border-zinc-900 last:border-b-0">
            <button
              type="button"
              onClick={() => onTapEntry(e)}
              className="flex w-full items-start justify-between p-3 text-left"
            >
              <div>
                <div className="text-sm">{e.items.map((it) => it.name).join(", ")}</div>
                <div className="text-xs text-zinc-500">
                  {new Date(e.eaten_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  {" · "}
                  {fmtNum(e.totals.kcal)} kcal · {fmtNum(e.totals.protein_g)} P
                  {e.is_estimated && <span className="ml-1 text-amber-400">estimated</span>}
                </div>
              </div>
              <span className="text-zinc-600">›</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 2: `MealSlotEmptyCard`**

```tsx
// components/meal/MealSlotEmptyCard.tsx
"use client";

import { fmtNum } from "@/lib/ui/score";
import { mealSlotLabel } from "@/lib/food/meal-slot";
import type { MealSlot } from "@/lib/food/types";

export function MealSlotEmptyCard({
  slot,
  targetKcal,
  onLog,
}: {
  slot: MealSlot;
  targetKcal: number | null;
  onLog: () => void;
}) {
  return (
    <section className="rounded-lg border border-dashed border-zinc-700">
      <header className="flex items-center justify-between p-3">
        <div>
          <div className="text-sm font-semibold text-zinc-300">{mealSlotLabel(slot)}</div>
          {targetKcal !== null && (
            <div className="text-xs text-zinc-500">0 / {fmtNum(targetKcal)} target</div>
          )}
        </div>
        <button
          type="button"
          onClick={onLog}
          aria-label={`Log ${mealSlotLabel(slot)}`}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-100 text-lg font-semibold text-zinc-900"
        >
          +
        </button>
      </header>
    </section>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add components/meal/MealSlotCard.tsx components/meal/MealSlotEmptyCard.tsx
git commit -m "feat(meal): MealSlotCard + MealSlotEmptyCard components"
```

---

## Task 11: Wire `MealJournalClient` to render the full journal

**Files:**
- Modify: `app/meal/MealJournalClient.tsx`

- [ ] **Step 1: Replace the skeleton body with the full journal**

Open `app/meal/MealJournalClient.tsx` and replace the body of the return statement (the `<main>` block) entirely:

```tsx
"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useFoodEntries } from "@/lib/query/hooks/useFoodEntries";
import { useTodayTargets } from "@/lib/query/hooks/useTodayTargets";
import { MealLoggerSheet } from "@/components/log/MealLoggerSheet";
import { FoodEntryEditSheet } from "@/components/log/FoodEntryEditSheet";
import { MealJournalDay } from "@/components/meal/MealJournalDay";
import { MealSlotCard } from "@/components/meal/MealSlotCard";
import { MealSlotEmptyCard } from "@/components/meal/MealSlotEmptyCard";
import { targetsForAllSlots } from "@/lib/food/meal-targets";
import { MEAL_SLOTS } from "@/lib/food/meal-slot";
import type { FoodLogEntry, MealSlot } from "@/lib/food/types";

export function MealJournalClient({
  userId,
  date,
}: {
  userId: string;
  date: string;
}) {
  const router = useRouter();
  const { data: entries = [] } = useFoodEntries(userId, date, date);
  const { data: targets } = useTodayTargets(userId, date);
  const [loggerOpen, setLoggerOpen] = useState<MealSlot | null>(null);
  const [editing, setEditing] = useState<FoodLogEntry | null>(null);

  const shift = (deltaDays: number) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + deltaDays);
    router.push(`/meal?date=${d.toISOString().slice(0, 10)}`);
  };

  const slotTargets = useMemo(() => {
    if (!targets) return null;
    return targetsForAllSlots(targets.kcal, targets.meal_ratios);
  }, [targets]);

  const entriesBySlot = useMemo(() => {
    const grouped: Record<MealSlot, FoodLogEntry[]> = {
      breakfast: [], lunch: [], dinner: [], snack: [],
    };
    for (const e of entries) grouped[e.meal_slot].push(e);
    return grouped;
  }, [entries]);

  const initialEatenAtForLogger = (): string => {
    const today = new Date().toISOString().slice(0, 10);
    if (date === today) return new Date().toISOString();
    return `${date}T12:00:00.000Z`;
  };

  return (
    <main className="mx-auto max-w-md space-y-3 px-4 pt-6 pb-32">
      <MealJournalDay
        entries={entries}
        targets={targets ?? null}
        date={date}
        onShiftDate={shift}
      />

      {MEAL_SLOTS.map((slot) => {
        const slotEntries = entriesBySlot[slot];
        const slotTarget = slotTargets?.[slot] ?? null;
        if (slotEntries.length === 0) {
          return (
            <MealSlotEmptyCard
              key={slot}
              slot={slot}
              targetKcal={slotTarget}
              onLog={() => setLoggerOpen(slot)}
            />
          );
        }
        return (
          <MealSlotCard
            key={slot}
            slot={slot}
            entries={slotEntries}
            targetKcal={slotTarget}
            onLog={() => setLoggerOpen(slot)}
            onTapEntry={setEditing}
          />
        );
      })}

      {loggerOpen && (
        <MealLoggerSheet
          open
          onClose={() => setLoggerOpen(null)}
          initialMealSlot={loggerOpen}
          initialEatenAt={initialEatenAtForLogger()}
        />
      )}
      {editing && (
        <FoodEntryEditSheet entry={editing} onClose={() => setEditing(null)} />
      )}
    </main>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Manual UX test**

Start `npm run dev`. Navigate to `/meal`. Expect:
- Day summary at top with date + macro bars.
- Four meal cards (Breakfast/Lunch/Dinner/Snacks). Cards with no entries today show dashed border; cards with entries show items.
- Tapping "+" on a card opens MealLoggerSheet with the slot pre-selected in the title.
- Logging a meal commits, sheet closes, the card it belongs to updates.

- [ ] **Step 4: Commit**

```bash
git add app/meal/MealJournalClient.tsx
git commit -m "feat(meal): wire MealJournalClient to render day summary + 4 slot cards"
```

---

## Task 12: BottomNav add `/meal` entry

**Files:**
- Modify: `components/layout/BottomNav.tsx`

- [ ] **Step 1: Insert the entry**

Open `components/layout/BottomNav.tsx`. Find the tabs array (around line 17). Add the new entry between `/metrics` and `/coach`:

```ts
import { Home, BarChart3, UtensilsCrossed, MessageCircle, User } from "lucide-react";

// … in the tabs array …
{ href: "/",        label: "Today",   Icon: Home,             match: (p) => p === "/" },
{ href: "/metrics", label: "Metrics", Icon: BarChart3,        match: (p) => p.startsWith("/metrics") },
{ href: "/meal",    label: "Meal",    Icon: UtensilsCrossed,  match: (p) => p.startsWith("/meal") },
{ href: "/coach",   label: "Coach",   Icon: MessageCircle,    match: (p) => p.startsWith("/coach") },
{ href: "/profile", label: "Profile", Icon: User,             match: (p) => p.startsWith("/profile") },
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Manual UX test**

`npm run dev`. The bottom nav now shows five icons; tapping the meal icon navigates to `/meal`. From `npm run dev` memory hazard: if the new icon doesn't appear after edit, kill `.next/` (`rm -rf .next/`) and restart dev — chunk cache for layout sometimes lags.

- [ ] **Step 4: Commit**

```bash
git add components/layout/BottomNav.tsx
git commit -m "feat(meal): add Meal tab to BottomNav between Metrics and Coach"
```

---

## Task 13: Retire `/metrics?sub=log`

**Files:**
- Delete: `app/metrics/_sub/LogSubPill.tsx`
- Delete: `components/log/LogClient.tsx`
- Delete: `components/log/TodaysMeals.tsx`
- Modify: `app/metrics/MetricsShell.tsx`

- [ ] **Step 1: Audit references**

Run: `grep -rn "LogSubPill\|LogClient\|TodaysMeals\|sub=log" --include="*.tsx" --include="*.ts" .`
Expected: matches inside `app/metrics/MetricsShell.tsx` and the three to-be-deleted files. If anything else references these, address before deleting.

- [ ] **Step 2: Update `MetricsShell.tsx`**

Open `app/metrics/MetricsShell.tsx`. Remove the "Log" pill from the pill list and any conditional render of `LogSubPill`/`LogClient`. Keep the "+ Log entry" sticky button and its `LogEntrySheet`/`MealLoggerSheet` mounts — they remain a convenience entry point.

Use grep to find every reference inside `MetricsShell.tsx` and remove them: imports, pill array entries, switch-case branches that mount the sub.

- [ ] **Step 3: Delete the three files**

```bash
git rm app/metrics/_sub/LogSubPill.tsx components/log/LogClient.tsx components/log/TodaysMeals.tsx
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors. If anything still imports a deleted file, address.

- [ ] **Step 5: Manual UX test**

`npm run dev`. Visit `/metrics`. The pill row should no longer contain "Log". The "+ Log entry" floating button still opens the sheet. Visit `/metrics?sub=log` directly — should not render the old log view (some other default sub should show; the existing routing logic decides).

- [ ] **Step 6: Commit**

```bash
git add app/metrics/MetricsShell.tsx
git commit -m "refactor(meal): retire /metrics?sub=log — work moved to /meal"
```

---

## Task 14: `FoodEntryEditSheet` — `meal_slot` + `eaten_at` controls

**Files:**
- Modify: `components/log/FoodEntryEditSheet.tsx`

- [ ] **Step 1: Add state for the new fields**

In `components/log/FoodEntryEditSheet.tsx`, near the existing `useState` calls, add:

```ts
import { MEAL_SLOTS, mealSlotLabel } from "@/lib/food/meal-slot";
import type { MealSlot } from "@/lib/food/types";

// … inside the component, after `const [items, setItems] = useState(...)` …
const [mealSlot, setMealSlot] = useState<MealSlot>(entry.meal_slot);
const [eatenAt, setEatenAt]   = useState<string>(entry.eaten_at);
```

- [ ] **Step 2: Add controls above the item list**

Just inside `<div className="space-y-3 p-4">`, before `{items.map(...)}`, add:

```tsx
<div className="grid grid-cols-2 gap-2">
  <label className="text-xs text-zinc-400">
    Meal
    <select
      value={mealSlot}
      onChange={(e) => setMealSlot(e.target.value as MealSlot)}
      className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 p-2 text-sm"
    >
      {MEAL_SLOTS.map((s) => (
        <option key={s} value={s}>{mealSlotLabel(s)}</option>
      ))}
    </select>
  </label>

  <label className="text-xs text-zinc-400">
    Time
    <input
      type="datetime-local"
      value={toLocalInputValue(eatenAt)}
      onChange={(e) => setEatenAt(fromLocalInputValue(e.target.value))}
      className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 p-2 text-sm"
    />
  </label>
</div>
```

Add these two helpers near the bottom of the file (outside the component):

```ts
// `datetime-local` expects "YYYY-MM-DDTHH:mm" in local time, with no seconds
// or timezone suffix.
function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInputValue(v: string): string {
  // Reverse of the above — return a full ISO string in UTC.
  return new Date(v).toISOString();
}
```

- [ ] **Step 3: Send the new fields in the PATCH body**

Find the `save` function. Change the request body:

```ts
body: JSON.stringify({ items, meal_slot: mealSlot, eaten_at: eatenAt }),
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add components/log/FoodEntryEditSheet.tsx
git commit -m "feat(meal): FoodEntryEditSheet — meal_slot + eaten_at controls"
```

---

## Task 15: PATCH `/api/food/entries/[id]` accepts new fields

**Files:**
- Modify: `app/api/food/entries/[id]/route.ts`

- [ ] **Step 1: Extend Zod schema**

In `app/api/food/entries/[id]/route.ts`, modify the existing schema (around line ~41):

```ts
const PatchBody = z.object({
  items: z.array(ItemSchema).min(1).optional(),
  meal_slot: z.enum(["breakfast", "lunch", "dinner", "snack"]).optional(),
  eaten_at: z.string().datetime().optional(),
});
```

(Items is now optional — PATCH can change just meal/time without re-sending items.)

- [ ] **Step 2: Validate `eaten_at` stays within the same UTC day**

In the PATCH handler, after parsing the body and fetching the existing row:

```ts
const updates: Record<string, unknown> = {
  updated_at: new Date().toISOString(),
};

if (parsed.data.items) {
  const items = parsed.data.items as FoodItem[];
  updates.items = items;
  updates.totals = sumMacros(items);
  updates.is_estimated = items.some((it) => it.source === "llm");
}

if (parsed.data.meal_slot) {
  updates.meal_slot = parsed.data.meal_slot;
}

if (parsed.data.eaten_at) {
  // Preserve the today-only invariant + ensure we don't shift the row to a
  // different UTC day (would require re-aggregating two days).
  const existingDate = utcDate(existing.eaten_at);
  const newDate = utcDate(parsed.data.eaten_at);
  if (existingDate !== newDate) {
    return NextResponse.json(
      { error: "eaten_at must stay within the same UTC day" },
      { status: 400 },
    );
  }
  updates.eaten_at = parsed.data.eaten_at;
}

const { error: updateErr } = await supabase
  .from("food_log_entries")
  .update(updates)
  .eq("id", id)
  .eq("user_id", user.id);
// … existing re-aggregation + revalidatePath path stays unchanged …
```

(The `isToday(existing.eaten_at)` guard at line ~65 keeps blocking edits to past-day entries.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Manual UX test**

`npm run dev`. From `/meal`, tap a logged entry, change its meal slot in the dropdown, save. Verify the card it appears in changes after invalidate.

- [ ] **Step 5: Commit**

```bash
git add app/api/food/entries/[id]/route.ts
git commit -m "feat(meal): PATCH /food/entries accepts meal_slot + eaten_at"
```

---

## Task 16: POST `/api/profile/nutrition-overrides`

**Files:**
- Create: `app/api/profile/nutrition-overrides/route.ts`

- [ ] **Step 1: Write the route**

```ts
// app/api/profile/nutrition-overrides/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const RatiosSchema = (keys: readonly string[]) =>
  z
    .object(
      Object.fromEntries(keys.map((k) => [k, z.number().min(0).max(1)])),
    )
    .refine(
      (o) => Math.abs(Object.values(o as Record<string, number>).reduce((a, b) => a + b, 0) - 1) < 0.01,
      "ratios must sum to 1.0 (±0.01)",
    );

const Body = z.object({
  kcal: z.number().int().min(800).max(6000).nullable().optional(),
  macro_ratios: RatiosSchema(["protein_pct", "carbs_pct", "fat_pct"]).nullable().optional(),
  meal_ratios:  RatiosSchema(["breakfast", "lunch", "dinner", "snacks"]).nullable().optional(),
}).strict();

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Build the override object, omitting null/undefined fields. Send `null`
  // for any field to clear it; omit to keep existing.
  const { data: existing } = await supabase
    .from("profiles")
    .select("nutrition_overrides")
    .eq("user_id", user.id)
    .maybeSingle();
  const current = (existing?.nutrition_overrides ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...current };

  for (const key of ["kcal", "macro_ratios", "meal_ratios"] as const) {
    if (key in parsed.data) {
      const v = parsed.data[key];
      if (v === null) delete next[key];
      else next[key] = v;
    }
  }

  // Empty object → store NULL to mean "no overrides".
  const finalValue = Object.keys(next).length === 0 ? null : next;

  const { error } = await supabase
    .from("profiles")
    .update({ nutrition_overrides: finalValue })
    .eq("user_id", user.id);
  if (error) {
    console.error("[/api/profile/nutrition-overrides] update failed", error);
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, nutrition_overrides: finalValue });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Manual smoke test**

`npm run dev`. From a browser with auth, run in the console:

```js
await fetch("/api/profile/nutrition-overrides", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ kcal: 1900 }),
}).then(r => r.json());
```

Expected: `{ ok: true, nutrition_overrides: { kcal: 1900 } }`. Verify in Supabase that `profiles.nutrition_overrides` for that user shows `{"kcal": 1900}`.

Then send `kcal: null` to clear:

```js
await fetch("/api/profile/nutrition-overrides", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ kcal: null }),
}).then(r => r.json());
```

Expected: `{ ok: true, nutrition_overrides: null }` (since this was the only key).

- [ ] **Step 4: Commit**

```bash
git add app/api/profile/nutrition-overrides/route.ts
git commit -m "feat(meal): POST /api/profile/nutrition-overrides — per-field override writes"
```

---

## Task 17: `NutritionTargetsSection` on `/profile`

**Files:**
- Create: `components/profile/NutritionTargetsSection.tsx`
- Modify: `app/profile/page.tsx` (mount the component)

- [ ] **Step 1: Build the component**

```tsx
// components/profile/NutritionTargetsSection.tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useTodayTargets } from "@/lib/query/hooks/useTodayTargets";
import { fmtNum } from "@/lib/ui/score";

export function NutritionTargetsSection({
  userId,
  date,
}: {
  userId: string;
  date: string;
}) {
  const { data: targets } = useTodayTargets(userId, date);
  const qc = useQueryClient();

  // Local editable state — only POSTed on "Save".
  const [kcal, setKcal] = useState<number>(targets?.kcal ?? 2000);
  const [proteinPct, setProteinPct] = useState<number>(35);
  const [carbsPct,   setCarbsPct]   = useState<number>(35);
  const [fatPct,     setFatPct]     = useState<number>(30);
  const [bfPct,      setBfPct]      = useState<number>(30);
  const [luPct,      setLuPct]      = useState<number>(35);
  const [diPct,      setDiPct]      = useState<number>(30);
  const [snPct,      setSnPct]      = useState<number>(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const src = targets?.source_per_field;

  // The component is intentionally simple — no slider auto-balancing in v1.
  // Validation is enforced server-side; UI just submits + surfaces errors.
  const save = async (
    payload: Record<string, unknown>,
  ) => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/profile/nutrition-overrides", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "save_failed");
      }
      await qc.invalidateQueries({
        predicate: (q) => q.queryKey[0] === "today-targets",
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveKcal = () => save({ kcal });
  const saveMacros = () => save({
    macro_ratios: {
      protein_pct: proteinPct / 100,
      carbs_pct:   carbsPct   / 100,
      fat_pct:     fatPct     / 100,
    },
  });
  const saveMeals = () => save({
    meal_ratios: {
      breakfast: bfPct / 100,
      lunch:     luPct / 100,
      dinner:    diPct / 100,
      snacks:    snPct / 100,
    },
  });
  const resetAll = () => save({ kcal: null, macro_ratios: null, meal_ratios: null });

  return (
    <section className="rounded-lg border border-zinc-800 p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">
        Nutrition targets
      </h2>

      {/* Daily calories */}
      <div className="mb-4">
        <div className="flex items-baseline justify-between">
          <label className="text-sm">Daily calories</label>
          <span className="text-xs text-zinc-500">Source: {src?.kcal ?? "—"}</span>
        </div>
        <div className="mt-1 flex gap-2">
          <input
            type="number"
            value={kcal}
            onChange={(e) => setKcal(parseInt(e.target.value, 10) || 0)}
            min={800} max={6000}
            className="w-32 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
          />
          <button
            type="button"
            onClick={saveKcal}
            disabled={busy}
            className="rounded-md bg-zinc-100 px-3 py-1 text-xs text-zinc-900"
          >
            Save kcal
          </button>
        </div>
      </div>

      {/* Macro split */}
      <div className="mb-4">
        <div className="flex items-baseline justify-between">
          <label className="text-sm">Macro split (%)</label>
          <span className="text-xs text-zinc-500">Source: {src?.macros ?? "—"}</span>
        </div>
        <div className="mt-1 grid grid-cols-3 gap-2 text-xs">
          <PctInput label="P" value={proteinPct} onChange={setProteinPct} />
          <PctInput label="C" value={carbsPct}   onChange={setCarbsPct} />
          <PctInput label="F" value={fatPct}     onChange={setFatPct} />
        </div>
        <div className="mt-1 text-xs text-zinc-500">Sum: {proteinPct + carbsPct + fatPct}%</div>
        <button
          type="button"
          onClick={saveMacros}
          disabled={busy}
          className="mt-2 rounded-md bg-zinc-100 px-3 py-1 text-xs text-zinc-900"
        >
          Save macros
        </button>
      </div>

      {/* Meal split */}
      <div className="mb-4">
        <div className="flex items-baseline justify-between">
          <label className="text-sm">Meal split (%)</label>
          <span className="text-xs text-zinc-500">Source: {src?.meal_ratios ?? "—"}</span>
        </div>
        <div className="mt-1 grid grid-cols-4 gap-2 text-xs">
          <PctInput label="B" value={bfPct} onChange={setBfPct} />
          <PctInput label="L" value={luPct} onChange={setLuPct} />
          <PctInput label="D" value={diPct} onChange={setDiPct} />
          <PctInput label="S" value={snPct} onChange={setSnPct} />
        </div>
        <div className="mt-1 text-xs text-zinc-500">Sum: {bfPct + luPct + diPct + snPct}%</div>
        <button
          type="button"
          onClick={saveMeals}
          disabled={busy}
          className="mt-2 rounded-md bg-zinc-100 px-3 py-1 text-xs text-zinc-900"
        >
          Save meal split
        </button>
      </div>

      {error && <p className="mb-3 text-xs text-red-400">{error}</p>}

      <div className="flex gap-3 text-xs">
        <button
          type="button"
          onClick={resetAll}
          disabled={busy}
          className="text-zinc-400 underline"
        >
          Reset to plan
        </button>
        <Link
          href="/coach?mode=default&starter=nutrition_targets"
          className="text-zinc-100 underline"
        >
          Ask coach to recommend →
        </Link>
      </div>
    </section>
  );
}

function PctInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="text-zinc-400">{label}</span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10) || 0)}
        min={0} max={100}
        className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1"
      />
    </label>
  );
}
```

**v1 design note** baked into the component: no slider auto-balancing. The user enters numbers; the server validates sum-to-1.0. The spec described slider auto-balancing — deferring to v1.1 to keep this task scoped. The "Sum: X%" hint surfaces the constraint clearly.

- [ ] **Step 2: Mount on `/profile`**

Open `app/profile/page.tsx`. Find where other profile sections are rendered (existing components like `LabPromptCard`, etc). Add a new section block:

```tsx
import { NutritionTargetsSection } from "@/components/profile/NutritionTargetsSection";
import { todayInUserTz } from "@/lib/time";

// … inside the JSX, alongside other sections …
<NutritionTargetsSection userId={user.id} date={todayInUserTz()} />
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Manual UX test**

`npm run dev`. Visit `/profile`. The Nutrition Targets card appears, shows current values from plan/intake (or empty if neither exists). Change kcal to 1900, click "Save kcal". Navigate to `/meal` — day summary shows `/ 1900 kcal` target. Click "Reset to plan" on profile — `/meal` reverts.

- [ ] **Step 5: Commit**

```bash
git add components/profile/NutritionTargetsSection.tsx app/profile/page.tsx
git commit -m "feat(meal): /profile nutrition targets section — kcal/macro/meal overrides"
```

---

## Task 18: Extend `query_food_log` with `meal_slot`

**Files:**
- Modify: `lib/coach/tools.ts`

- [ ] **Step 1: Update input schema + description**

In `lib/coach/tools.ts` around line 108-120, modify the tool definition:

```ts
export const QUERY_FOOD_LOG_TOOL = {
  name: "query_food_log",
  description:
    "Query the in-app food log for a date range. Returns committed entries with per-item macros (name, qty_g, kcal, protein/carbs/fat/fiber, source) and meal_slot. Use for food-choice and meal-composition questions — distinct from query_daily_logs which returns day-level macro totals only. Range capped at 90 days. Optional item_filter is a case-insensitive substring match on item name. Optional meal_slot filter narrows results to a single slot — useful for questions like 'how much protein at breakfast last week?'.",
  input_schema: {
    type: "object" as const,
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string", format: "date" },
      end_date:   { type: "string", format: "date" },
      item_filter: { type: "string", description: "Case-insensitive substring match on item name." },
      meal_slot:   { type: "string", enum: ["breakfast","lunch","dinner","snack"] },
    },
  },
};
```

- [ ] **Step 2: Update executor**

Find the executor around line 705. Modify the Supabase query:

```ts
let queryBuilder = opts.supabase
  .from("food_log_entries")
  .select("eaten_at, meal_slot, kind, items, totals")
  .eq("user_id", opts.userId)
  .eq("status", "committed")
  .gte("eaten_at", `${start}T00:00:00Z`)
  .lte("eaten_at", `${end}T23:59:59Z`)
  .order("eaten_at", { ascending: false });

if (i.meal_slot) {
  if (!["breakfast","lunch","dinner","snack"].includes(i.meal_slot)) {
    return {
      ok: false,
      error: { error: `invalid meal_slot: ${i.meal_slot}` },
      meta: { ms: Date.now() - t0, range_days },
    };
  }
  queryBuilder = queryBuilder.eq("meal_slot", i.meal_slot);
}

const { data, error } = await queryBuilder;
```

Also update the local `FoodLogEntryRow` type used in the executor to include `meal_slot: string`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/tools.ts
git commit -m "feat(meal): query_food_log accepts meal_slot filter + returns it in rows"
```

---

## Task 19: `propose_nutrition_targets` + `commit_nutrition_targets` coach tools

**Files:**
- Modify: `lib/coach/tools.ts`

This task adds two tool definitions and two executors mirroring the existing weekly-planning propose/commit pattern. Find a reference like `PROPOSE_PLAN_TOOL` / `COMMIT_PLAN_TOOL` in the file to mirror exact-style.

- [ ] **Step 1: Add tool schemas**

Append near the other planning tools:

```ts
export const PROPOSE_NUTRITION_TARGETS_TOOL = {
  name: "propose_nutrition_targets",
  description:
    "Propose daily nutrition targets (kcal + macro split + meal split) for the user. Compute kcal from BMR (Mifflin-St Jeor) × activity multiplier × goal-phase adjustment using the athlete profile's age/sex/weight/height/training_days_per_week/goal_phase. Macro split typically 30–35% protein, 30–45% carbs, 25–35% fat depending on goal. Meal split defaults to 30/35/30/5 (B/L/D/S). Returns a structured proposal + HMAC token; the user must approve via commit_nutrition_targets to apply.",
  input_schema: {
    type: "object" as const,
    required: ["kcal", "protein_pct", "carbs_pct", "fat_pct", "rationale"],
    properties: {
      kcal:         { type: "number", minimum: 800, maximum: 6000 },
      protein_pct:  { type: "number", minimum: 0, maximum: 1 },
      carbs_pct:    { type: "number", minimum: 0, maximum: 1 },
      fat_pct:      { type: "number", minimum: 0, maximum: 1 },
      breakfast_pct:{ type: "number", minimum: 0, maximum: 1 },
      lunch_pct:    { type: "number", minimum: 0, maximum: 1 },
      dinner_pct:   { type: "number", minimum: 0, maximum: 1 },
      snacks_pct:   { type: "number", minimum: 0, maximum: 1 },
      rationale:    { type: "string", description: "Plain-language reasoning shown to user on the approval chip." },
    },
  },
};

export const COMMIT_NUTRITION_TARGETS_TOOL = {
  name: "commit_nutrition_targets",
  description:
    "Commit a previously proposed set of nutrition targets to the user's profile.nutrition_overrides. Requires the HMAC token from propose_nutrition_targets.",
  input_schema: {
    type: "object" as const,
    required: ["token"],
    properties: {
      token: { type: "string" },
    },
  },
};
```

- [ ] **Step 2: Add executors**

After the existing `commit_plan` executor, add:

```ts
import { createHmac } from "node:crypto";
// (Likely already imported near the top — verify and re-use.)

function signNutritionTargets(payload: {
  kcal: number;
  macro_ratios: { protein_pct: number; carbs_pct: number; fat_pct: number };
  meal_ratios:  { breakfast: number; lunch: number; dinner: number; snacks: number };
  userId: string;
  exp: number;
}): string {
  const secret = process.env.COACH_TOOL_SECRET;
  if (!secret) throw new Error("COACH_TOOL_SECRET not set");
  const body = JSON.stringify(payload);
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  return `${Buffer.from(body).toString("base64")}.${sig}`;
}

function verifyNutritionTargets(token: string): {
  kcal: number;
  macro_ratios: { protein_pct: number; carbs_pct: number; fat_pct: number };
  meal_ratios:  { breakfast: number; lunch: number; dinner: number; snacks: number };
  userId: string;
  exp: number;
} | null {
  const secret = process.env.COACH_TOOL_SECRET;
  if (!secret) throw new Error("COACH_TOOL_SECRET not set");
  const [b64, sig] = token.split(".");
  if (!b64 || !sig) return null;
  const body = Buffer.from(b64, "base64").toString("utf8");
  const expectedSig = createHmac("sha256", secret).update(body).digest("hex");
  if (expectedSig !== sig) return null;
  const payload = JSON.parse(body);
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// Executor for propose_nutrition_targets
export async function exec_propose_nutrition_targets(
  i: Record<string, unknown>,
  opts: { userId: string },
) {
  const t0 = Date.now();
  const kcal = i.kcal as number;
  const protein_pct = i.protein_pct as number;
  const carbs_pct   = i.carbs_pct   as number;
  const fat_pct     = i.fat_pct     as number;
  const breakfast = (i.breakfast_pct as number | undefined) ?? 0.30;
  const lunch     = (i.lunch_pct     as number | undefined) ?? 0.35;
  const dinner    = (i.dinner_pct    as number | undefined) ?? 0.30;
  const snacks    = (i.snacks_pct    as number | undefined) ?? 0.05;

  const macroSum = protein_pct + carbs_pct + fat_pct;
  const mealSum  = breakfast + lunch + dinner + snacks;
  if (Math.abs(macroSum - 1) >= 0.01) {
    return { ok: false, error: { error: `macro ratios must sum to 1.0, got ${macroSum.toFixed(3)}` }, meta: { ms: Date.now() - t0 } };
  }
  if (Math.abs(mealSum - 1) >= 0.01) {
    return { ok: false, error: { error: `meal ratios must sum to 1.0, got ${mealSum.toFixed(3)}` }, meta: { ms: Date.now() - t0 } };
  }

  const macro_ratios = { protein_pct, carbs_pct, fat_pct };
  const meal_ratios  = { breakfast, lunch, dinner, snacks };

  // 10-minute expiry — fresh proposals only.
  const exp = Math.floor(Date.now() / 1000) + 600;
  const token = signNutritionTargets({ kcal, macro_ratios, meal_ratios, userId: opts.userId, exp });

  return {
    ok: true,
    data: {
      kcal,
      macro_ratios,
      meal_ratios,
      rationale: i.rationale as string,
      token,
    },
    meta: { ms: Date.now() - t0 },
  };
}

// Executor for commit_nutrition_targets
export async function exec_commit_nutrition_targets(
  i: Record<string, unknown>,
  opts: { userId: string; supabase: SupabaseClient },
) {
  const t0 = Date.now();
  const payload = verifyNutritionTargets(i.token as string);
  if (!payload) {
    return { ok: false, error: { error: "invalid or expired token" }, meta: { ms: Date.now() - t0 } };
  }
  if (payload.userId !== opts.userId) {
    return { ok: false, error: { error: "token user mismatch" }, meta: { ms: Date.now() - t0 } };
  }

  // Merge into existing overrides (don't blow away meal_ratios if user set just kcal/macros via this).
  const { data: existing } = await opts.supabase
    .from("profiles")
    .select("nutrition_overrides")
    .eq("user_id", opts.userId)
    .maybeSingle();
  const current = (existing?.nutrition_overrides ?? {}) as Record<string, unknown>;
  const next = {
    ...current,
    kcal: payload.kcal,
    macro_ratios: payload.macro_ratios,
    meal_ratios: payload.meal_ratios,
  };

  const { error } = await opts.supabase
    .from("profiles")
    .update({ nutrition_overrides: next })
    .eq("user_id", opts.userId);
  if (error) {
    return { ok: false, error: { error: `db_error: ${error.message}` }, meta: { ms: Date.now() - t0 } };
  }

  return {
    ok: true,
    data: { applied: { kcal: payload.kcal, macro_ratios: payload.macro_ratios, meal_ratios: payload.meal_ratios } },
    meta: { ms: Date.now() - t0 },
  };
}
```

- [ ] **Step 3: Register tools in the dispatcher**

Inside `lib/coach/tools.ts`, find where existing tools like `query_food_log` and `propose_plan` are registered/dispatched. Add the new two with the same gating they use — available in `default` mode only.

This is file-specific — search the file for `"propose_plan"` to find the registration table or switch statement and mirror the pattern.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/tools.ts
git commit -m "feat(meal): propose_nutrition_targets + commit_nutrition_targets coach tools"
```

---

## Task 20: Proposal-chip UI for nutrition targets

**Files:**
- Create: `components/chat/NutritionTargetsProposalCard.tsx`
- Modify: `components/chat/ChatThread.tsx`

- [ ] **Step 1: Build the proposal card**

```tsx
// components/chat/NutritionTargetsProposalCard.tsx
"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { fmtNum } from "@/lib/ui/score";

export type NutritionTargetsProposal = {
  kcal: number;
  macro_ratios: { protein_pct: number; carbs_pct: number; fat_pct: number };
  meal_ratios:  { breakfast: number; lunch: number; dinner: number; snacks: number };
  rationale: string;
  token: string;
};

export function NutritionTargetsProposalCard({
  proposal,
  onApplied,
}: {
  proposal: NutritionTargetsProposal;
  onApplied?: () => void;
}) {
  const qc = useQueryClient();
  const [state, setState] = useState<"pending" | "applying" | "applied" | "error">("pending");
  const [error, setError] = useState<string | null>(null);

  const apply = async () => {
    setState("applying");
    setError(null);
    try {
      const res = await fetch("/api/coach/tools/commit-nutrition-targets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: proposal.token }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "commit_failed");
      }
      await qc.invalidateQueries({
        predicate: (q) => q.queryKey[0] === "today-targets",
      });
      setState("applied");
      onApplied?.();
    } catch (e) {
      setState("error");
      setError((e as Error).message);
    }
  };

  return (
    <article className="rounded-lg border border-zinc-700 bg-zinc-950 p-3 text-sm">
      <header className="mb-2 text-xs uppercase tracking-wider text-zinc-400">
        Proposed nutrition targets
      </header>
      <dl className="mb-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-zinc-500">Daily kcal</dt>
        <dd>{fmtNum(proposal.kcal)}</dd>
        <dt className="text-zinc-500">Macros</dt>
        <dd>
          {Math.round(proposal.macro_ratios.protein_pct * 100)}% P ·{" "}
          {Math.round(proposal.macro_ratios.carbs_pct   * 100)}% C ·{" "}
          {Math.round(proposal.macro_ratios.fat_pct     * 100)}% F
        </dd>
        <dt className="text-zinc-500">Meal split</dt>
        <dd>
          {Math.round(proposal.meal_ratios.breakfast * 100)} /{" "}
          {Math.round(proposal.meal_ratios.lunch     * 100)} /{" "}
          {Math.round(proposal.meal_ratios.dinner    * 100)} /{" "}
          {Math.round(proposal.meal_ratios.snacks    * 100)}
        </dd>
      </dl>
      <p className="mb-3 text-xs text-zinc-400">{proposal.rationale}</p>
      {state === "pending" && (
        <button
          type="button"
          onClick={apply}
          className="rounded-md bg-zinc-100 px-3 py-1 text-xs font-semibold text-zinc-900"
        >
          Apply targets
        </button>
      )}
      {state === "applying" && <p className="text-xs text-zinc-400">Applying…</p>}
      {state === "applied"  && <p className="text-xs text-green-400">Applied.</p>}
      {state === "error"    && <p className="text-xs text-red-400">{error}</p>}
    </article>
  );
}
```

- [ ] **Step 2: Create commit-tools server endpoint**

The proposal card POSTs to `/api/coach/tools/commit-nutrition-targets`. Create:

```ts
// app/api/coach/tools/commit-nutrition-targets/route.ts
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { exec_commit_nutrition_targets } from "@/lib/coach/tools";

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json();
  const result = await exec_commit_nutrition_targets(body, { userId: user.id, supabase });

  if (!result.ok) return NextResponse.json({ error: result.error.error }, { status: 400 });
  return NextResponse.json(result.data);
}
```

- [ ] **Step 3: Dispatch the card from `ChatThread.tsx`**

Open `components/chat/ChatThread.tsx`. Find where other tool-result cards are dispatched (look for the existing weekly-planning `propose_plan` rendering — that's the closest pattern). In the same switch / map, add a case for `propose_nutrition_targets`:

```tsx
import { NutritionTargetsProposalCard, type NutritionTargetsProposal } from "./NutritionTargetsProposalCard";

// … inside the renderer that handles `tool_calls` on assistant messages …
if (toolCall.name === "propose_nutrition_targets" && toolCall.result?.ok) {
  return (
    <NutritionTargetsProposalCard
      key={toolCall.id}
      proposal={toolCall.result.data as NutritionTargetsProposal}
    />
  );
}
```

(Adapt to the actual structure of `tool_calls` in `chat_messages` — search `propose_plan` in this file to match exact field names.)

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Manual UX test**

`npm run dev`. Navigate to `/coach`. Send a message like "Recommend my nutrition targets — I'm 36, male, 80kg, 178cm, training 4x/week, goal is recomp." Expect: coach proposes targets via tool, proposal card renders, tap "Apply targets" → invalidates, navigate to `/meal` → new targets reflected.

- [ ] **Step 6: Commit**

```bash
git add components/chat/NutritionTargetsProposalCard.tsx components/chat/ChatThread.tsx app/api/coach/tools/commit-nutrition-targets/route.ts
git commit -m "feat(meal): proposal-chip UI + commit endpoint for nutrition_targets coach tool"
```

---

## Task 21: CLAUDE.md update

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Append to "Data sources & precedence"**

Open `CLAUDE.md`. Find the `## Architecture › Data sources & precedence` section. Add a new paragraph after the in-app food logging paragraph:

```markdown
- **Meal-slot attribution**: `food_log_entries.meal_slot` (`breakfast|lunch|dinner|snack`) groups entries for the journal UI on `/meal` and lets `query_food_log` filter by slot. It's an attribution dimension, not an ownership change — day-level aggregation in `sum_food_entries` and the resulting `daily_logs` writes are slot-agnostic. Default `'snack'` retained on the column as defense-in-depth; every legitimate insert path (parse/barcode routes) requires `meal_slot` in its Zod schema.
- **Nutrition target overrides**: `profiles.nutrition_overrides jsonb` sits at the top of the `getTodayTargets` resolution chain: per-field override → `plan_payload.nutrition` → `intake_payload`. The override layer is the user's manual say; plan_payload is the coach-built plan; they coexist independently. Shape: `{ kcal?, macro_ratios?, meal_ratios? } | null`. Coach tools `propose_nutrition_targets` / `commit_nutrition_targets` write here via HMAC propose/commit.
```

Also add to the migrations list (numbered list above the precedence section):

```markdown
18. [supabase/migrations/0020_food_log_meal_slot.sql](supabase/migrations/0020_food_log_meal_slot.sql) — adds `food_log_entries.meal_slot` (`breakfast|lunch|dinner|snack`, NOT NULL with `'snack'` default) and backfills existing rows by time-of-day. Powers the meal-first journal UI on `/meal` and the `meal_slot` filter on `query_food_log`.

19. [supabase/migrations/0021_profile_nutrition_overrides.sql](supabase/migrations/0021_profile_nutrition_overrides.sql) — adds `profiles.nutrition_overrides jsonb` storing optional per-field overrides (`kcal`, `macro_ratios`, `meal_ratios`). `NULL` means "no overrides, fall through to plan/intake". Read by `getTodayTargets`; written by `/api/profile/nutrition-overrides` and the `commit_nutrition_targets` coach tool.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(meal): document meal_slot attribution + nutrition_overrides layer"
```

---

## Self-review

After implementing all tasks, verify:

**Spec coverage:**
- [x] §1 data model → Tasks 1, 2, 3, 5
- [x] §2 navigation + routing → Tasks 8, 12, 13
- [x] §3 profile target overrides + coach recommendation → Tasks 5, 6, 7, 16, 17, 19, 20
- [x] §4 UI components → Tasks 9, 10, 11, 14
- [x] §5 end-to-end flow + coach integration → Tasks 4, 15, 18, 19, 20
- [x] CLAUDE.md update → Task 21

**Migration ordering:** 0020 before 0021. Both apply before downstream code expects the columns. Tasks 1 and 5 sit at the front of each respective dependency chain.

**Typecheck cadence:** Every task ends with `npm run typecheck` + commit. No task ships broken types.

**Single-PR vs multi-PR:** This is one cohesive feature; ship as a single PR or split at Task 13 (everything up through the new tab + retire log sub) and Task 14 (overrides + edit + coach tools). User's call at execution time.

**Known deferred items (v1.1):**
- The `/coach?starter=nutrition_targets` URL param in Task 17 is just a deep-link in v1 — the coach page doesn't yet read the `starter` param to inject a primed user message. User can type their own prompt. Wire-up is a small follow-up if the UX feels rough.
- Slider auto-balancing in `NutritionTargetsSection` (Task 17) is deferred. The current UI uses number inputs with a visible "Sum: X%" hint; server validates the sum.
- Past-date logging asymmetry (per spec open item): the per-meal "+" button enables logging on past dates, but PATCH stays today-only. If this proves confusing, lock the date scrubber to today.
- The `propose_nutrition_targets` / `commit_nutrition_targets` dispatch pattern in Task 19 mirrors the existing `propose_plan` / `commit_plan` registration. Confirm the exact registration shape during implementation (likely a `TOOL_DISPATCH` table or switch in `lib/coach/tools.ts`) — the plan documents the executors and HMAC helpers in full but defers exact dispatch wiring to the existing file's convention.
