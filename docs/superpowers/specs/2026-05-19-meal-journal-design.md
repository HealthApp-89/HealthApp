# Meal Journal — Design

**Date:** 2026-05-19
**Status:** Draft
**Author:** Abdelouahed (with Claude)
**Builds on:** [2026-05-18-in-app-food-logging-design.md](2026-05-18-in-app-food-logging-design.md)

## Why

In-app food logging (sub-project #1 of the coach-team arc) shipped a flat list of meals on `/metrics?sub=log`. That list answers "what did I eat today" but not "what did I eat for breakfast today" — the coach can't reason about meal timing, the user can't see per-meal pacing against a target, and there's no surface for the kind of journal/diary structure MyFitnessPal and Yazio established as table-stakes for diet tracking.

This design adds:

1. **Meal-slot grouping** (Breakfast / Lunch / Dinner / Snacks) as a durable attribution dimension on every `food_log_entries` row.
2. A **dedicated `/meal` top-level tab** with a meal-first journal view — per-meal cards each with their own "+" entry point, Yazio-style.
3. A **user-editable nutrition-target override layer** on `profiles`, so the user can set their own daily kcal + macro split + per-meal split, overriding the AI-built plan when they want to.
4. **Coach integration** — `query_food_log` gains a `meal_slot` filter; new `propose_nutrition_targets` / `commit_nutrition_targets` tools let the coach derive a target via BMR + activity + goal and write it to the override layer on user approval.

## What's already in place (don't rebuild)

- `food_log_entries` table with `eaten_at timestamptz`, per-item macros, `status` state machine, `FoodEntryEditSheet`.
- `sum_food_entries(user_id, date)` aggregation function feeding `daily_logs`.
- `MealLoggerSheet` (Type / Scan / coming-soon Photo / Voice tabs) and the parse → resolve → commit pipeline.
- `getTodayTargets(date)` abstraction at [lib/morning/brief/get-today-targets.ts](../../../lib/morning/brief/get-today-targets.ts) — Phase 2 `plan_payload.nutrition` → Phase 1 `intake_payload` → null fallback chain.
- `query_food_log` coach tool already exposes per-item macros + `eaten_at` (90-day range cap, item-name substring filter).

## Out of scope

- Burned-calorie offset in the daily summary math (V2; avoids the MFP-style double-count footgun).
- "Quick add" macros without item resolution.
- Copy-meal / favorite-meal / recipe features.
- Meal-time nudges in the morning brief or proactive layer ("you skipped breakfast 3 days this week").
- Photo and voice log modalities — they stay grey-shown ("coming soon") per the original food-logging spec.

---

## § 1 — Data model

### Migration 0020 — `meal_slot` on `food_log_entries`

```sql
-- 0020_food_log_meal_slot.sql
alter table food_log_entries
  add column meal_slot text
    check (meal_slot in ('breakfast','lunch','dinner','snack')) not null
    default 'snack';

-- Backfill existing rows by time-of-day. UTC-bucketed (matches existing
-- sum_food_entries day-keying).
update food_log_entries
set meal_slot = case
  when extract(hour from eaten_at) between 4 and 10 then 'breakfast'
  when extract(hour from eaten_at) between 11 and 14 then 'lunch'
  when extract(hour from eaten_at) between 15 and 16 then 'snack'
  when extract(hour from eaten_at) between 17 and 21 then 'dinner'
  else 'snack'
end;

-- Drop the default — new rows must specify a slot (meal-first UX contract).
alter table food_log_entries alter column meal_slot drop default;

create index on food_log_entries (user_id, eaten_at, meal_slot);
```

### Migration 0021 — `nutrition_overrides` on `profiles`

```sql
-- 0021_profile_nutrition_overrides.sql
alter table profiles
  add column nutrition_overrides jsonb;

-- Shape (validated app-side, not via SQL check — jsonb fields stay flexible):
-- {
--   kcal?: number,                    // 800–6000 range enforced in API
--   macro_ratios?: { protein_pct, carbs_pct, fat_pct },  // sums to 1.0 ± 0.01
--   meal_ratios?:  { breakfast, lunch, dinner, snacks }  // sums to 1.0 ± 0.01
-- } | null
```

No default — `NULL` means "no overrides, use plan/intake".

### Type additions in [lib/food/types.ts](../../../lib/food/types.ts)

```ts
export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export type FoodLogEntry = {
  // …existing fields…
  meal_slot: MealSlot;
};
```

### New module: `lib/food/meal-slot.ts`

Pure functions:

```ts
export function deriveMealSlot(d: Date): MealSlot;     // matches the SQL CASE above
export const MEAL_SLOTS: readonly MealSlot[];          // ['breakfast','lunch','dinner','snack']
export function mealSlotLabel(s: MealSlot): string;    // 'Breakfast' | 'Lunch' | …
```

The SQL CASE and the TS `deriveMealSlot` MUST stay in lockstep. The migration is a one-shot backfill; the TS function is the runtime source going forward.

### New module: `lib/food/meal-targets.ts`

```ts
export type MealRatios = { breakfast: number; lunch: number; dinner: number; snacks: number };
export const DEFAULT_MEAL_RATIOS: MealRatios = { breakfast: 0.30, lunch: 0.35, dinner: 0.30, snacks: 0.05 };

export function targetForSlot(slot: MealSlot, dayKcal: number, ratios: MealRatios = DEFAULT_MEAL_RATIOS): number;
export function targetsForAllSlots(dayKcal: number, ratios?: MealRatios): Record<MealSlot, number>;
```

Pure compute, no DB. Consumed by `MealSlotCard` and the day summary.

### `getTodayTargets` extension

Return shape gains `meal_ratios: MealRatios | null` and `source_per_field?: Record<'kcal' | 'macros' | 'meal_ratios', 'override' | 'plan' | 'intake' | null>`. Resolution becomes field-by-field:

```
kcal:        overrides.kcal        ?? plan.nutrition.kcal        ?? intake.kcal        ?? null
macro_ratios: overrides.macro_ratios ?? plan.nutrition.macros_ratios ?? intake.macros ?? null
meal_ratios:  overrides.meal_ratios  ?? plan.nutrition.meal_ratios   ?? null  // intake doesn't carry meal_ratios
```

(`plan_payload.nutrition` does not currently carry `meal_ratios` — the composer will be extended in a separate Phase 2 follow-up if needed. For now, plan_payload.nutrition.meal_ratios is treated as optional and `null` falls through to `DEFAULT_MEAL_RATIOS` at the consumer.)

Every existing consumer of `getTodayTargets` is read-only on the fields it already used — the return shape is a superset.

---

## § 2 — Navigation + routing

### New top-level tab

[components/layout/BottomNav.tsx](../../../components/layout/BottomNav.tsx) — insert one entry between `/metrics` and `/coach`:

```ts
{ href: '/meal', label: 'Meal', Icon: UtensilsCrossed, match: (p) => p.startsWith('/meal') },
```

Final tab order: **Today · Metrics · Meal · Coach · Profile**.

### New route

```
app/meal/
  page.tsx               # SSR shell — auth gate, prefetch entries + today targets
  MealJournalClient.tsx  # client — TanStack hydrate, day scrubber, renders cards

components/meal/
  MealJournalDay.tsx     # day summary card (kcal numbers + 4 macro bars)
  MealSlotCard.tsx       # one of {Breakfast,Lunch,Dinner,Snacks}
  MealSlotEmptyCard.tsx  # dashed-border empty state
```

URL: `/meal?date=YYYY-MM-DD` (defaults to today in user TZ). Date scrubber arrows update the param via `router.push`, matching existing `/metrics?sub=log&date=...` pattern.

### Hydration pattern

`app/meal/page.tsx` mirrors `/coach/trends` and `/metrics`:

1. `redirect('/login')` if no session.
2. Mint `makeServerQueryClient()`.
3. Prefetch via Server fetchers: `fetchFoodEntriesServer(userId, date, date)`, `fetchTodayTargetsServer(userId, date)`.
4. `<HydrationBoundary state={dehydrate(qc)}><MealJournalClient userId={userId} date={date} /></HydrationBoundary>`.

### Retire `/metrics?sub=log`

Delete:

- `app/metrics/_sub/LogSubPill.tsx`
- `components/log/LogClient.tsx`
- `components/log/TodaysMeals.tsx`

Keep (still used by `/meal` and by the convenience `/metrics` FAB):

- `components/log/MealLoggerSheet.tsx` + the three tab components
- `components/log/FoodEntryEditSheet.tsx`

Edit `app/metrics/MetricsShell.tsx`:

- Remove "Log" from the pill list.
- The sticky "+ Log entry" button + `LogEntrySheet` keep working — "Log meal" still opens `MealLoggerSheet` (auto-derives slot from `now`). Convenience entry point, no data path change.

---

## § 3 — Profile target overrides + coach-driven recommendation

### Profile UI

New section [components/profile/NutritionTargetsSection.tsx](../../../components/profile/NutritionTargetsSection.tsx) on `/profile`:

```
┌─ Nutrition targets ────────────────────────────────┐
│ Daily calories    [ 1900 ] kcal     Source: manual │
│ Macro split       P [35]  C [35]  F [30]  (= 100%) │
│ Meal split        B [30] L [35] D [30] S [5] (=100)│
│                                                     │
│ [ Reset to plan ]   [ Ask coach to recommend → ]   │
└─────────────────────────────────────────────────────┘
```

Behavior:

- "Source" line shows `plan` / `intake` / `manual` per field — independent per row.
- Split sliders auto-balance unedited siblings so sums stay 100%.
- "Reset to plan" clears `nutrition_overrides` to `NULL`.
- "Ask coach to recommend" deep-links to `/coach?mode=default&starter=nutrition_targets`, priming an initial user message.

### Write endpoint

`POST /api/profile/nutrition-overrides` — RLS-respecting Supabase client. Zod-validates:

- `kcal ∈ [800, 6000]` if present.
- `macro_ratios` sums to 1.0 ± 0.01, each field ≥ 0.
- `meal_ratios` sums to 1.0 ± 0.01, each field ≥ 0.

Writes to `profiles.nutrition_overrides`. Invalidates `today-targets`, `daily-logs`, `food-entries` query keys client-side.

### Coach tools

New in [lib/coach/tools.ts](../../../lib/coach/tools.ts):

**`propose_nutrition_targets`** — pure compute.

- Inputs (Anthropic input_schema): `kcal: number`, `protein_pct: number`, `carbs_pct: number`, `fat_pct: number`, optional `breakfast_pct/lunch_pct/dinner_pct/snacks_pct` (defaults to `30/35/30/5` if any missing), required `rationale: string` (the coach's plain-language reasoning for the recommendation).
- Executor validates ranges + sums, returns `{kcal, macro_ratios, meal_ratios, rationale}` + HMAC token signed with `COACH_TOOL_SECRET` (matches `propose_plan` / `propose_block`).
- The coach reads BMR inputs (age, sex, weight_kg, height_cm) from the existing athlete-profile snapshot prefix. Mifflin-St Jeor + activity multiplier (sourced from `athlete_profile_documents.intake_payload.training` schedule) + goal-phase adjustment is the coach's job, not the tool's — the tool is a sink, not a calculator.

**`commit_nutrition_targets`** — verifies HMAC, writes to `profiles.nutrition_overrides`, invalidates `today-targets` query key. UI: same proposal-chip pattern as the existing weekly-planning tools, rendered by an extension to `ChatThread`'s tool-call dispatch.

Both registered in `default` mode only.

---

## § 4 — UI components

### `MealJournalDay`

Props: `{ userId: string; date: string }`.

Reads `useFoodEntries(userId, date, date)` and `useTodayTargets(userId, date)`. Renders:

- Header: weekday + date string, small caption "Daily journal", date scrubber arrows.
- `kcal eaten / kcal target` (large), `remaining = target − eaten` (small, suppressed when target is null).
- Four macro bars (P / C / F / Fiber) with `<eaten> / <target>` and fill bar.
- "Meals logged: N / 4" where N is `count(distinct meal_slot in entries)`.

All numbers via `fmtNum()` per the project's number-display rule.

### `MealSlotCard`

Props: `{ slot: MealSlot; entries: FoodLogEntry[]; targetKcal: number | null; date: string }`.

Filled state (entries.length > 0):

- Header row: slot label, small grey caption `<earliest eaten_at HH:mm> · <slot kcal sum> / <targetKcal> target`, white circular "+" button.
- Item rows: per-entry `eaten_at HH:mm`, comma-joined item names, per-entry `kcal · P`, chevron. Tap → opens `FoodEntryEditSheet`.

Empty state (entries.length === 0) — `MealSlotEmptyCard`:

- Dashed border (`border-dashed border-zinc-700`).
- Header only: slot label, caption `0 / <targetKcal> target` (or no caption if target is null), "+" button.

Rendered in fixed order: Breakfast, Lunch, Dinner, Snacks.

"+" tap opens `MealLoggerSheet` with `initialMealSlot={slot}`, `initialEatenAt = now` if scrubbed date is today else `12:00 of scrubbed date`.

### `MealLoggerSheet` changes

New props:

- `initialMealSlot?: MealSlot`
- `initialEatenAt?: string` (ISO)

Internal state seeds `meal_slot` from `initialMealSlot ?? deriveMealSlot(initialEatenAt ?? now)`. Sheet title becomes `Log <Slot>` when `initialMealSlot` provided.

The slot is **not** exposed as an editable control inside the sheet — re-bucketing happens in the edit sheet later. Single-purpose sheets.

Commit payload to `POST /api/food/commit` adds `meal_slot`. Route extended to accept it (Zod), persists with `status='committed'`. The existing `revalidatePath("/log")` call in the commit route is replaced with `revalidatePath("/meal")` (the path that hosts the new journal).

### `FoodEntryEditSheet` additions

New fields at top of body, above the item list:

- **Time field** — `<input type="datetime-local">` bound to `eaten_at`. Constrained to today-only (matches existing API constraint).
- **Meal slot dropdown** — `<select>` with the 4 slots.

Both included in PATCH body when changed. `app/api/food/entries/[id]/route.ts` PATCH gains optional `meal_slot` + `eaten_at` (Zod):

- `meal_slot` validated against enum.
- `eaten_at` validated to parse as a date within the same UTC day as the existing row's `eaten_at` (preserves the today-only invariant and avoids re-aggregating a second day).

### New hook: `useTodayTargets`

[lib/query/hooks/useTodayTargets.ts](../../../lib/query/hooks/useTodayTargets.ts) — wraps a thin server route `GET /api/profile/today-targets?date=...` so the resolution chain (overrides → plan → intake) stays server-side and reads `profiles.nutrition_overrides` with the user's RLS session.

Query key: `['today-targets', userId, date]`.

Invalidated by:

- The profile-overrides PATCH (kcal/macro/meal_ratios change).
- `MealLoggerSheet` commit (target may shift if user just changed splits — predicate invalidation is fine).

---

## § 5 — End-to-end flow + coach integration

### Log flow (per-card "+")

1. User taps "+" on `MealSlotCard` (slot = e.g. `lunch`, date = scrubbed date).
2. `MealLoggerSheet` opens with `initialMealSlot='lunch'`, `initialEatenAt = now` (or `12:00` of past date).
3. User picks tab (Type / Scan / coming-soon). Existing parse → resolve pipeline runs unchanged.
4. Commit: `POST /api/food/commit` accepts `meal_slot`. Persists with `status='committed'`, calls `sum_food_entries`, upserts `daily_logs`.
5. TanStack invalidates `food-entries`, `daily-logs`, `today-targets` (predicate-based).

### Edit flow

1. Tap an entry row → `FoodEntryEditSheet` opens.
2. PATCH `/api/food/entries/[id]` accepts the expanded body. Today-only constraint preserved.
3. Card re-renders post-invalidate.
4. Delete unchanged.

### Coach: `query_food_log` extension

[lib/coach/tools.ts](../../../lib/coach/tools.ts) — single executor change:

- Input schema gains optional `meal_slot: { type: 'string', enum: ['breakfast','lunch','dinner','snack'] }`.
- Description: *"Optional meal_slot filter narrows results to a single slot — useful for questions like 'how much protein at breakfast last week?'."*
- Executor: `.eq('meal_slot', i.meal_slot)` when present; `meal_slot` added to `.select(...)` columns.

Available in `default` / `plan_week` / `setup_block` modes (same as today). Not `intake`.

### Backwards compatibility

- **Yazio CSV ingest** — `/api/ingest/health?source=yazio` retains its "skip if committed in-app entries exist" gate. Slot column doesn't affect ingest behavior. New Yazio-imported rows are out of scope (gated out when in-app entries exist for the date).
- **Audit script** — [scripts/audit-food-aggregation.mjs](../../../scripts/audit-food-aggregation.mjs) aggregates by `(user_id, eaten_at::date)`. Slot-agnostic, no change needed.
- **Morning brief** — consumes `getTodayTargets`; overrides flow through transparently. No code change in [lib/morning/brief/](../../../lib/morning/brief/).

### CLAUDE.md update

`## Architecture › Data sources & precedence` — add a paragraph:

> **`meal_slot` is an attribution dimension**, not an ownership change. `food_log_entries.meal_slot` (`breakfast|lunch|dinner|snack`) groups entries for the journal UI and lets `query_food_log` filter by slot. Day-level aggregation in `sum_food_entries` and the resulting `daily_logs` writes are slot-agnostic.
>
> **`profiles.nutrition_overrides`** sits at the top of the target-resolution chain consumed by `getTodayTargets`: per-field override → `plan_payload.nutrition` → `intake_payload`. The override layer is the user's say; the plan_payload is the coach-built plan; both can coexist independently.

---

## Implementation order (rough)

1. Migration 0020 + types + `lib/food/meal-slot.ts` (DB-first foundation; no UI change visible yet).
2. Commit route + PATCH route extensions.
3. Migration 0021 + `nutrition_overrides` API + `getTodayTargets` resolution-chain extension.
4. New `/meal` route, hydration plumbing, `useTodayTargets` hook.
5. `MealJournalDay` + `MealSlotCard` + `MealSlotEmptyCard` + delete `LogSubPill` / `LogClient` / `TodaysMeals`.
6. `MealLoggerSheet` props + `FoodEntryEditSheet` field additions.
7. Profile `NutritionTargetsSection` + sliders.
8. `query_food_log` meal_slot extension.
9. `propose_nutrition_targets` / `commit_nutrition_targets` tools + chip UI.
10. CLAUDE.md update.

Each step independently typechecks and ships green; the new tab stays empty until step 5.

## Open items

- **Recipe / favorites** — not in scope. Worth a future spec; high payoff for repeat eaters.
- **Burned-calorie offset** in day summary math — deferred to V2. Decision: keep math as `remaining = target − eaten` only.
- **`plan_payload.nutrition.meal_ratios` composer field** — Phase 2 composer extension can add it later; for now the resolution chain falls through to `DEFAULT_MEAL_RATIOS` (30/35/30/5) when neither override nor plan carry it.
- **Past-date logging** for dates ≠ today — the per-card "+" enables the sheet on past dates with `eaten_at = 12:00` of the scrubbed day, but the existing today-only PATCH on `/api/food/entries/[id]` blocks edits to past entries. Whether `POST /api/food/commit` accepts a draft with a past `eaten_at` is an existing implementation detail of the parse/barcode draft-creation routes — out of scope to change here. If the team wants strict "today-only" UX, the date scrubber can be locked to today in V1; if past-date logging is desired, both the PATCH constraint and any draft-creation guards need a coordinated update in a follow-up.
