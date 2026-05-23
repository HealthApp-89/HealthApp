# Nutrition + body comp trends view + Nora proactive intelligence

**Status:** Draft
**Date:** 2026-05-23
**Owner:** Abdelouahed

## Summary

Two surfaces share one compute spine:

1. **Trends view (C)** — split the existing `CoachTrendsView` "Composition" pill into dedicated **Body** and **Nutrition** pills at the top of `/metrics`. Add a food-quality block (protein sources, carb sources, cooking method, diet diversity) and per-meal-slot breakouts that the current scalar-only view is missing.
2. **Nora's proactive intelligence (D)** — add four new triggers to the existing `lib/coach/proactive/` cron pipeline so Nora reaches out under her own thread on the same signals the new trends view visualizes. Goes from her current one trigger (`off_pace_weight`) to a substantive coaching surface.

Single shared compute module (`lib/coach/nutrition-intelligence/`) powers both surfaces. No DB schema changes. Two implementation plans afterward (UI plan, triggers plan), one design.

## Goals

- Surface what the athlete is actually eating — protein-source mix, carb-source mix, cooking-method mix — not just whether they hit macro numbers.
- Make Nora a real proactive coach: fire when a meaningful signal crosses a threshold; stay quiet otherwise.
- Reuse existing infrastructure: `lib/coach/trends/` payload pattern, `lib/coach/proactive/` cron + dedup, `MetricCard` sparkline, `SectionPills` navigation.
- No DB migration. All compute layer; classifier reads `food_db_cache.raw_payload.foodCategory` for USDA-resolved items and falls back to name tokens otherwise.

## Non-goals

- Cuisine / meal-archetype tagging (deferred — brittle without explicit user tagging).
- Nutrient-gap analysis (sodium, sat fat, omega-3 grams). The food log has too many LLM-resolved items with no detailed nutrient data for these to be reliable in v1.
- Daily "Nora's read" card or weekly nutrition review. v1 ships proactive nudges only.
- Long-range windows (6mo, 1y). Food log history is <12w deep; sparse data would mislead.
- New tools in Nora's partition. Triggers join `workouts` server-side; chat follow-ups quote from the nudge card's `ui` payload.

## Decisions locked during brainstorm

1. **Scope**: one spec, two implementation plans.
2. **Nora cadence**: proactive nudges only (current pattern). No daily card, no weekly review in v1.
3. **Coaching axes (all four)**: body composition, macro adherence + GLP-1, food quality / behavioral, training × nutrition.
4. **Pill structure**: split Composition → Body + Nutrition. New pill list: Performance / Body / Nutrition / Cross.
5. **Trigger set**: 7 triggers total (4 new + 3 added during quality discussion). `library_drift` rejected as administrative; replaced with `monotone_protein` + `fried_heavy`.
6. **Windows**: keep existing 4w / 12w. No 6mo / 1y.
7. **Chart fidelity**: reuse `MetricCard` sparkline-with-area pattern. No new chart libraries; recharts already in.
8. **Food-quality scope**: protein sources, carb sources, cooking method, diet diversity. No nutrient-gap or cuisine tagging.

## Architecture

### New module: `lib/coach/nutrition-intelligence/`

```
lib/coach/nutrition-intelligence/
├── classify.ts                    # Pure classifiers (no Supabase)
├── compose-food-quality.ts        # 14d aggregation composer
├── word-lists.ts                  # Protein/carb/cooking word lists
└── thresholds.ts                  # Shared thresholds for triggers + UI callouts
```

### Classifier — `classify.ts`

Pure functions, no I/O. Three classifiers per food item:

```ts
type ProteinCategory =
  | 'poultry' | 'red_meat' | 'fish_seafood' | 'eggs'
  | 'dairy_protein' | 'plant_protein' | 'protein_supplement'
  | 'mixed' | 'unknown';

type CarbCategory =
  | 'whole_grain' | 'refined_grain' | 'starchy_veg' | 'non_starchy_veg'
  | 'fruit' | 'legume' | 'sugar_sweets' | 'unknown';

type CookingMethod =
  | 'grilled' | 'baked' | 'pan_fried' | 'deep_fried' | 'air_fried'
  | 'steamed' | 'boiled' | 'roasted' | 'raw' | 'smoked' | 'unknown';

type Confidence = 'high' | 'medium' | 'low';

function classifyProtein(name: string, usdaCategory?: string): { category: ProteinCategory; confidence: Confidence };
function classifyCarb(name: string, usdaCategory?: string): { category: CarbCategory; confidence: Confidence };
function classifyCookingMethod(name: string): { method: CookingMethod; confidence: Confidence };
```

Classification rules:

1. **USDA category override** (high confidence) — if `usdaCategory` matches a known mapping (e.g., `"Poultry Products"` → `poultry`, `"Beef Products"` → `red_meat`, `"Finfish and Shellfish Products"` → `fish_seafood`), use it directly.
2. **Name-token match** (medium confidence) — lowercase the name, scan for category-specific tokens. First match wins. Word lists in `word-lists.ts`; English-only in v1.
3. **No match → `unknown`** (low confidence). Counted separately in aggregates.

Cooking method is name-token only — there's no USDA equivalent. Items without a method token are marked `unknown` and excluded from the cooking-method mix.

Examples:
- `"grilled chicken breast"` → protein: `poultry` (high if USDA-resolved, medium if LLM), method: `grilled` (medium).
- `"salmon fillet"` → protein: `fish_seafood`, method: `unknown`.
- `"chickpea curry"` → protein: `plant_protein` (be careful: `chick` matches poultry — must check `chickpea` before `chick`).

### Composer — `compose-food-quality.ts`

```ts
type FoodQualityTrend = {
  schema_version: 1;
  window_days: 14;
  protein_sources: Array<{ category: ProteinCategory; grams: number; pct: number }>;
  carb_sources: Array<{ category: CarbCategory; grams: number; pct: number }>;
  cooking_methods: Array<{ method: CookingMethod; count: number; pct: number }>;
  diversity: {
    distinct_items: number;
    fish_meals_per_week: number;
    veg_servings_per_day: number;
  };
  data_completeness: {
    protein_classified_pct: number;     // share of protein-g classified to non-unknown
    carb_classified_pct: number;
    cooking_method_inferable_pct: number;
  };
  total_items: number;
};

export async function composeFoodQuality(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<FoodQualityTrend>;
```

Reads:
- `food_log_entries` for the last 14 days (item-level rows with `name`, `protein_g`, `carbs_g`, `db_ref`, `meal_slot`).
- `food_db_cache` joined on `db_ref->>'canonical_id'` to pull `raw_payload->>'foodCategory'` for USDA-resolved items.

Aggregation:
- `protein_sources` weighted by `protein_g` per item.
- `carb_sources` weighted by `carbs_g` per item.
- `cooking_methods` weighted by item count, excluding `unknown`.
- `distinct_items` = count of distinct lowercased names.
- `fish_meals_per_week` = (count of distinct meal-slot-on-date with any `fish_seafood` item in 14d) / 2.
- `veg_servings_per_day` = (count of `non_starchy_veg` items in 14d) / 14.

### Extended payload — `CoachTrendsPayload`

In `lib/data/types.ts`, the existing payload type grows:

```ts
type CoachTrendsPayload = {
  // ... existing fields (strength, recovery, cross_insights, headline)
  body: BodyTrend;                       // existing
  nutrition: NutritionAdherenceTrend;    // existing, with one addition
  food_quality: FoodQualityTrend;        // NEW
  // ...
};

type NutritionAdherenceTrend = {
  // ... existing fields (protein, kcal, deficit_kcal)
  per_meal_slot: {                       // NEW
    protein_g: Record<MealSlot, { avg_14d: number; target_g: number | null; pct_of_target: number | null }>;
    kcal: Record<MealSlot, { avg_14d: number; target_kcal: number | null; pct_of_target: number | null }>;
  };
};
```

Per-meal-slot targets derive from `targetsForAllSlots()` (existing helper in `lib/food/meal-targets.ts`) using `profiles.nutrition_overrides.meal_ratios` or the default 30/35/30/5.

### Trends compute orchestrator

`lib/coach/trends/index.ts` (`generateCoachTrends`) gains one new parallel fetch:

```ts
const [strength, recovery, body, nutrition, foodQuality, crossInsights] = await Promise.all([
  composeStrength(args), composeRecovery(args), composeBody(args),
  composeNutrition(args),
  composeFoodQuality(args),     // NEW
  composeCross(args),
]);
```

The `pickHeadline` function adds `recomp_success` and `recomp_drift` as candidate headlines (positive recomp wins over off-pace; drift slots between plateau and off-pace).

### Proactive triggers — `lib/coach/proactive/`

The existing `off_pace_weight` (Nora-owned) check stays — it fires on scale drift; `recomp_drift` (new) catches the orthogonal "scale flat + BF% up" case. Total Nora trigger count after this spec: **8** (1 existing + 7 new).

Five new check files. Each reads from the shared `CoachTrendsPayload` (same pattern as existing checks):

```
lib/coach/proactive/
├── check-recomp.ts                 # NEW — emits recomp_success or recomp_drift
├── check-protein-floor.ts          # NEW — emits protein_under OR glp1_protein_floor
├── check-monotone-protein.ts       # NEW — emits monotone_protein
├── check-fried-heavy.ts            # NEW — emits fried_heavy
├── check-training-undereat.ts      # NEW — joins workouts server-side
├── check-plateau.ts                # existing
├── check-off-pace.ts               # existing (off_pace_weight, Nora-owned)
├── check-hrv.ts                    # existing
├── index.ts                        # extend TRIGGER_OWNER + check loop
└── render-card.ts                  # extend with new card variants
```

`check-protein-floor.ts` enforces the GLP-1 vs classical mutual exclusion in one file: reads `profiles.glp1_status`, fires `glp1_protein_floor` in active mode, `protein_under` otherwise. Two triggers, one check function — keeps the threshold logic together.

Trigger thresholds (defined in `lib/coach/nutrition-intelligence/thresholds.ts`, shared between UI callouts and checks):

| Trigger | Condition | Owner | Severity |
|---|---|---|---|
| `recomp_success` | LBM Δ4w ≥ +0.3 kg AND BF% Δ4w ≤ −0.5 pts | Nora | positive |
| `recomp_drift` | weight Δ4w within ±0.3 kg AND BF% Δ4w ≥ +0.5 pts | Nora | warn |
| `protein_under` | protein hit rate < 60% over last 7 logged days. **Suppressed when GLP-1 active.** | Nora | warn |
| `glp1_protein_floor` | GLP-1 active AND protein < (1.8 × bw_kg) on ≥ 3 of last 5 days | Nora | warn |
| `monotone_protein` | single protein source ≥ 70% of classified protein-g over 14d AND ≥ 30 classified items | Nora | info |
| `fried_heavy` | (pan_fried + deep_fried) / (known-method items) ≥ 0.40 over 14d AND ≥ 30 classified items | Nora | info |
| `training_day_undereat` | kcal < (target − 300) on ≥ 50% of lift days in last 4w (≥ 6 lift days minimum) | Nora | warn |

All four new owners route to Nora in `TRIGGER_OWNER`. Existing 7-day dedup via `proactive_nudge_dedup` applies unchanged.

### UI — `/metrics` top section

`components/coach/trends/`:

```
├── CoachTrendsView.tsx               # existing — wires sections + URL
├── SectionPills.tsx                  # extend: add 'body' | 'nutrition', drop 'composition'
├── TrendsHeader.tsx                  # existing
├── BodySection.tsx                   # NEW
├── NutritionSection.tsx              # NEW (replaces CompositionSection.tsx's nutrition half)
├── PerformanceSection.tsx            # existing
├── CrossSection.tsx                  # existing
├── InlineNudgeCallout.tsx            # NEW — amber callout shown on a card when matching trigger active
└── CompositionSection.tsx            # DELETED
```

`SectionPills` updates:
- `TrendsSection` type: `'performance' | 'body' | 'nutrition' | 'cross'`
- `?section=composition` → server-side redirect to `?section=body` (one-line server-component change in `app/metrics/page.tsx` or `MetricsClient.tsx`).

`BodySection.tsx`:
- Recomp banner at top (green, `recomp_success` event payload) — only when trigger is active.
- Weight card: `MetricCard` with sparkline + target band overlay (CSS dashed lines at band edges).
- LBM card: `MetricCard` sparkline.
- BF% card: `MetricCard` sparkline.
- Speaker chip: `<SpeakerChip speaker="nora" />` at section header.

`NutritionSection.tsx` (three blocks):
- **Adherence block**: Protein adherence card (sparkline) + Kcal adherence card (sparkline, amber when off-band) + Macro split donut (existing logic, unchanged shape).
- **By meal slot block**: Protein-per-slot bars (4 bars, value + pct of target) + Kcal-per-slot bars (4 bars with tick mark at target).
- **Food quality block**: Protein sources (horizontal stacked bar by grams) + Carb sources (same shape) + Cooking method (donut) + Diet diversity (3-cell grid: distinct items / fish per week / veg per day).

`InlineNudgeCallout.tsx`:
- Reads `proactive_nudge_dedup` rows for the user where `trigger_key IN (...)` and `fired_on >= today - 7d` (matches existing 7-day dedup window).
- Rendered inline on the card whose trigger is currently firing. Amber background (`#fef3c7`) + 1-line message synthesized from the trigger's headline.
- Cards with a possible inline callout: Protein sources (`monotone_protein`), Cooking method (`fried_heavy`), Kcal adherence (`protein_under` if it carries a kcal context, `glp1_protein_floor`), Kcal-per-slot (`training_day_undereat`), Body section's weight card (`recomp_drift`).
- The chat-row nudge (`chat_messages.kind='proactive_nudge'`) still fires once per dedup window. The inline callout persists while the dedup row is active.

### Cron wiring

`/api/coach/proactive/check` (existing) — extends its check list:

```ts
const events: ProactiveEvent[] = [
  ...checkPlateau(trends),
  ...checkOffPace(trends),
  ...checkHrv(trends),
  ...checkRecomp(trends),                          // NEW
  ...await checkProteinFloor(trends, { supabase, userId }),  // NEW — reads glp1_status
  ...checkMonotoneProtein(trends),                 // NEW
  ...checkFriedHeavy(trends),                      // NEW
  ...await checkTrainingUndereat(trends, { supabase, userId, today }),  // NEW — joins workouts
];
```

`check-training-undereat.ts` and `check-protein-floor.ts` do their own Supabase fetches (workouts join and GLP-1 status respectively); the daily cron runs with service-role access. The other three new checks (recomp, monotone-protein, fried-heavy) read purely from the trends payload — no extra fetches.

### Nora's chat voice for new nudges

`render-card.ts` extends with templates per trigger. Voice matches Nora's `NORA_BASE` prompt — warm-but-technical. Examples:

- `recomp_success` (positive):
  > "Composition's moving in the right direction — LBM up 0.6 kg, body fat down 0.8 pts over 4 weeks. Protein adherence at 82% is what made this possible. Keep the lever where it is."
- `recomp_drift` (warn):
  > "Scale weight is flat the last 4 weeks but body fat ticked up 0.7 points. That's a recomp drift — the deficit isn't deep enough to lose fat at maintenance protein. Worth looking at training-day kcal and protein floor."
- `monotone_protein` (info):
  > "Protein has been ~62% poultry for the last 2 weeks. Adding fish 2× / week (omega-3) and cycling in red meat (iron) covers gaps poultry doesn't. Want me to suggest swaps?"
- `fried_heavy` (info):
  > "About 28% of your items used frying methods last 2 weeks. Swapping pan-fried for grilled or air-fried on the 3 most-frequent items would cut ~150 kcal/day at the same protein."
- `training_day_undereat` (warn):
  > "On lift days last month, you came in ~340 kcal under target on 6 of 9 sessions. That's why dinner protein keeps spiking and slot kcal is dinner-heavy. Worth bumping pre-lift snack to ~200 kcal."

Each card carries the underlying numbers in `ui.evidence` so the athlete can ask Nora a follow-up and she can quote from the chip without a new query.

## Data flow

```
food_log_entries  ──┐
food_db_cache    ──┤── composeFoodQuality ──┐
                    │                         │
daily_logs       ──┼── composeBody          ├── CoachTrendsPayload
                    │── composeNutrition     │       │
profiles         ──┘── getTodayTargets       │       │
                                              │       │
workouts        ──── (for trainingUndereat) ─┘       │
                                                      │
                          ┌──────────────────────────┴───────────────────────┐
                          │                                                   │
                  /api/coach/trends                       /api/coach/proactive/check (cron)
                          │                                                   │
              CoachTrendsView (UI)                              runProactiveChecks ──> chat_messages
                          │                                                   │
              InlineNudgeCallout reads ◄─────── proactive_nudge_dedup ◄───────┘
```

## Schema impact

**None.** All compute layer.

- `food_db_cache.raw_payload` already stores the full USDA response → `foodCategory` accessible.
- `food_log_entries`, `user_food_items`, `daily_logs`, `workouts`, `proactive_nudge_dedup`, `chat_messages` all unchanged.
- `CoachTrendsPayload` shape grows (`food_quality` field added, `nutrition` grows `per_meal_slot`). Bumping `schema_version` to 2 in the payload (not the DB).

## Edge cases & error handling

- **Sparse food log**: when the 14d window has < 30 classified items, `monotone_protein` and `fried_heavy` triggers are suppressed (avoids "100% chicken" firing from 5 logged items).
- **GLP-1 + low protein**: `protein_under` is suppressed when GLP-1 active mode is set; only `glp1_protein_floor` fires (higher threshold).
- **No workouts**: `check-training-undereat` requires ≥ 6 lift days in the 4w window to fire.
- **Unknown classification**: items that don't match any token contribute to `data_completeness.{protein,carb,cooking_method}_classified_pct`. Stacked bars visually shrink (sum < 100%); user-facing copy is the data_completeness metric, not the missing slice.
- **Empty body comp**: when `body_fat_pct` history is empty, `recomp_success` / `recomp_drift` both null out; no card, no trigger.
- **First-week users**: 14d window with < 7 days of data returns null trends; UI shows "Not enough data yet" placeholder on the affected cards.

## Testing strategy

- **Classifier**: unit tests for the word lists. Adversarial cases: `chickpea` (must not be poultry), `cottage cheese` (must be dairy not refined_grain), `salmon teriyaki` (fish, glazed not fried), `breaded chicken` (poultry, deep_fried).
- **Composer**: integration test against a fixture user with a known 14d food log. Snapshot the `FoodQualityTrend` payload.
- **Triggers**: golden-input tests for each — synthetic `CoachTrendsPayload` that should fire each trigger, plus negative cases (one signal below threshold).
- **Audit script**: `scripts/audit-nutrition-intelligence.mjs` (set `AUDIT_USER_ID`) — runs `composeFoodQuality` and prints classified items + bar percentages, lets the user inspect mis-classifications.

## Build sequence

Two implementation plans afterward, ordered:

1. **Plan 1 — UI plan** (lower risk, independently shippable):
   - `classify.ts` + `word-lists.ts` + `compose-food-quality.ts`
   - Payload extension (`CoachTrendsPayload.food_quality`, `nutrition.per_meal_slot`)
   - Split `CompositionSection` into `BodySection` + `NutritionSection`
   - `SectionPills` 4-pill structure + `composition→body` redirect
   - `InlineNudgeCallout` reading existing `proactive_nudge_dedup`
   - Audit script

2. **Plan 2 — Triggers plan** (depends on Plan 1's classifier + composer):
   - Four new check files in `lib/coach/proactive/`
   - `TRIGGER_OWNER` map update
   - `render-card.ts` extensions
   - Cron extension in `/api/coach/proactive/check`
   - Trigger golden-input tests

## Open questions

None blocking. Two minor items to confirm during implementation:

- Whether the recomp banner survives the page reload until the dedup window closes (currently designed yes — derived from `proactive_nudge_dedup`).
- Whether `fish_meals_per_week` should round (1.5 displays awkwardly with 14-day window: 3 meals / 2 weeks). Suggest displaying as "3 / 2w" instead of "1.5 / wk" — revisit when wiring the card.
