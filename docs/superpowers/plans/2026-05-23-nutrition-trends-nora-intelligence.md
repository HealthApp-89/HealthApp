# Nutrition trends view + Nora proactive intelligence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two surfaces that share one compute spine: (a) split the existing Composition pill in `CoachTrendsView` into dedicated Body + Nutrition pills with rich food-quality cards (protein/carb source mix, cooking method, diet diversity), and (b) extend `lib/coach/proactive/` with 7 new Nora-owned triggers driven by the same compute module.

**Architecture:** Two phases in one plan. **Phase 1 (Tasks 1–15)** builds the shared compute spine (`lib/coach/nutrition-intelligence/`) — pure-TS classifiers, thresholds, food-quality composer — extends `CoachTrendsPayload`, splits `SectionPills` from 3 → 4 pills, deletes `CompositionSection.tsx`, ships `BodySection.tsx` + `NutritionSection.tsx` + `InlineNudgeCallout.tsx`. **Phase 2 (Tasks 16–25)** adds 5 new proactive check files emitting 7 new trigger keys, wires `TRIGGER_OWNER` to Nora, extends `render-card.ts` with the new card templates, and updates `/api/coach/proactive/check` + the audit script.

**Tech Stack:** Next.js 15 App Router · Supabase (linked CLI) · TanStack Query (hybrid SSR-hydrate per CLAUDE.md) · Recharts (already in via `MetricCard`) · TypeScript strict · no test framework — verification via `npm run typecheck` + audit scripts + manual dev-server exercise.

**Reference spec:** [docs/superpowers/specs/2026-05-23-nutrition-trends-nora-intelligence-design.md](../specs/2026-05-23-nutrition-trends-nora-intelligence-design.md)

---

## File map

**New files (Phase 1 — compute):**
- `lib/coach/nutrition-intelligence/word-lists.ts`
- `lib/coach/nutrition-intelligence/thresholds.ts`
- `lib/coach/nutrition-intelligence/classify.ts`
- `lib/coach/nutrition-intelligence/compose-food-quality.ts`
- `scripts/audit-nutrition-intelligence.mjs`

**New files (Phase 1 — UI):**
- `components/coach/trends/BodySection.tsx`
- `components/coach/trends/NutritionSection.tsx`
- `components/coach/trends/InlineNudgeCallout.tsx`
- `lib/query/hooks/useActiveNudges.ts`

**New files (Phase 2 — triggers):**
- `lib/coach/proactive/check-recomp.ts`
- `lib/coach/proactive/check-protein-floor.ts`
- `lib/coach/proactive/check-monotone-protein.ts`
- `lib/coach/proactive/check-fried-heavy.ts`
- `lib/coach/proactive/check-training-undereat.ts`

**Modified files:**
- `lib/data/types.ts` — extend `CoachTrendsPayload`, `NutritionAdherenceTrend`, `ProactiveTriggerType`, add `FoodQualityTrend`, add `ProactiveEvent.severity`
- `lib/coach/trends/index.ts` — add `composeFoodQuality` call, extend `pickHeadline` for recomp
- `lib/coach/trends/compose-nutrition.ts` — add `per_meal_slot` block
- `lib/coach/proactive/index.ts` — extend `TRIGGER_OWNER`, add new checks to event loop
- `lib/coach/proactive/render-card.ts` — extend with 7 new render variants
- `components/coach/trends/SectionPills.tsx` — 3 → 4 pills, drop `composition`
- `components/coach/trends/CoachTrendsView.tsx` — route Body + Nutrition
- `app/metrics/page.tsx` — `?section=composition` → `?section=body` redirect
- `scripts/audit-proactive-cron.mjs` — register new trigger keys

**Deleted files:**
- `components/coach/trends/CompositionSection.tsx`

---

## Phase 1 — Shared compute + UI split

### Task 1: Word lists for classifier

**Files:**
- Create: `lib/coach/nutrition-intelligence/word-lists.ts`

- [ ] **Step 1: Write the word-list file**

```ts
// lib/coach/nutrition-intelligence/word-lists.ts
//
// Token vocabularies for classifying food_log_entries by name.
// Order within each list matters: longer / more-specific tokens come first
// so that `chickpea` is matched before `chick` (which would mis-classify
// to poultry).

export type ProteinCategory =
  | "poultry" | "red_meat" | "fish_seafood" | "eggs"
  | "dairy_protein" | "plant_protein" | "protein_supplement"
  | "mixed" | "unknown";

export type CarbCategory =
  | "whole_grain" | "refined_grain" | "starchy_veg" | "non_starchy_veg"
  | "fruit" | "legume" | "sugar_sweets" | "unknown";

export type CookingMethod =
  | "grilled" | "baked" | "pan_fried" | "deep_fried" | "air_fried"
  | "steamed" | "boiled" | "roasted" | "raw" | "smoked" | "unknown";

/** Tokens checked LEFT-TO-RIGHT — first hit per category wins.
 *  Disambiguators (e.g. `chickpea` before any `chick` test) must come first. */
export const PROTEIN_TOKENS: Array<{ cat: ProteinCategory; tokens: string[] }> = [
  // Disambiguators first — chickpea must lose its "chick" prefix before poultry sees it.
  { cat: "plant_protein", tokens: [
    "chickpea", "chick pea", "garbanzo",
    "tofu", "tempeh", "seitan", "edamame", "soybean", "tvp",
    "lentil", "chana", "moong", "mung",
    "black bean", "kidney bean", "navy bean", "pinto bean", "white bean", "lima bean",
    "hummus", "falafel", "nutritional yeast", "hemp seed", "hemp protein",
  ]},
  { cat: "protein_supplement", tokens: [
    "whey protein", "casein protein", "protein powder", "protein shake",
    "protein bar", "mass gainer", "bcaa",
  ]},
  { cat: "poultry", tokens: [
    "chicken", "turkey", "duck", "hen", "quail", "pheasant", "cornish",
  ]},
  { cat: "red_meat", tokens: [
    "ground beef", "beef", "steak", "ribeye", "sirloin", "tenderloin",
    "filet mignon", "brisket", "chuck", "veal", "lamb", "mutton",
    "venison", "bison", "elk",
    "pork", "ham", "bacon", "sausage", "chorizo", "salami", "prosciutto",
    "pepperoni", "spare rib", "ribs",
  ]},
  { cat: "fish_seafood", tokens: [
    "salmon", "tuna", "cod", "halibut", "mackerel", "sardine", "anchovy",
    "shrimp", "prawn", "lobster", "crab", "oyster", "mussel", "scallop",
    "sole", "tilapia", "trout", "bass", "snapper", "swordfish", "herring",
    "calamari", "squid", "octopus", "clam", "fish",
  ]},
  { cat: "eggs", tokens: [
    "egg white", "egg whites", "scrambled egg", "fried egg", "boiled egg",
    "poached egg", "omelet", "omelette", "frittata", "egg",
  ]},
  { cat: "dairy_protein", tokens: [
    "greek yogurt", "cottage cheese", "ricotta", "kefir", "skyr",
    "milk", "yogurt", "cheese", "feta", "parmesan", "mozzarella",
  ]},
];

export const CARB_TOKENS: Array<{ cat: CarbCategory; tokens: string[] }> = [
  { cat: "whole_grain", tokens: [
    "rolled oats", "steel cut oat", "oatmeal", "oats", "oat",
    "brown rice", "wild rice", "quinoa", "barley", "bulgur", "farro",
    "buckwheat", "millet", "whole wheat", "whole grain", "whole-wheat",
    "spelt", "rye bread", "sourdough whole",
  ]},
  { cat: "refined_grain", tokens: [
    "white rice", "jasmine rice", "basmati rice",
    "pasta", "noodle", "spaghetti", "macaroni", "penne", "fettuccine",
    "bread", "bagel", "baguette", "ciabatta", "tortilla", "wrap",
    "cracker", "pretzel", "cereal", "couscous",
  ]},
  { cat: "starchy_veg", tokens: [
    "sweet potato", "yam", "plantain", "cassava", "yuca",
    "potato", "fries", "mashed potato", "corn", "peas", "pea",
  ]},
  { cat: "fruit", tokens: [
    "apple", "banana", "berry", "berries", "strawberry", "blueberry",
    "raspberry", "blackberry", "grape", "orange", "mango", "peach",
    "pear", "pineapple", "watermelon", "melon", "kiwi", "cherry",
    "plum", "apricot", "papaya", "fig", "date", "raisin",
  ]},
  { cat: "legume", tokens: [
    "lentil", "chickpea", "chick pea", "garbanzo", "chana", "mung", "moong",
    "black bean", "kidney bean", "navy bean", "pinto bean", "white bean",
    "lima bean", "hummus",
  ]},
  { cat: "non_starchy_veg", tokens: [
    "broccoli", "spinach", "kale", "lettuce", "cabbage", "cauliflower",
    "zucchini", "asparagus", "cucumber", "tomato", "pepper", "bell pepper",
    "green bean", "brussels sprout", "arugula", "chard", "collard",
    "bok choy", "celery", "leek", "onion", "garlic", "mushroom",
    "eggplant", "radish", "salad",
  ]},
  { cat: "sugar_sweets", tokens: [
    "candy", "chocolate", "ice cream", "cookie", "cake", "pastry",
    "doughnut", "donut", "soda", "juice", "lemonade", "sweets",
    "honey", "maple syrup", "jam", "jelly",
  ]},
];

export const COOKING_METHOD_TOKENS: Array<{ method: CookingMethod; tokens: string[] }> = [
  { method: "grilled",     tokens: ["grilled", "char-grilled", "chargrilled", "bbq", "barbecue", "barbecued", "charred"] },
  { method: "deep_fried",  tokens: ["deep-fried", "deep fried", "battered", "breaded", "tempura"] },
  { method: "air_fried",   tokens: ["air-fried", "air fried", "air fryer"] },
  { method: "pan_fried",   tokens: ["pan-fried", "pan fried", "stir-fried", "stir fried", "stir-fry", "sauteed", "sautéed", "fried"] },
  { method: "baked",       tokens: ["baked", "oven-baked"] },
  { method: "roasted",     tokens: ["roasted", "roast"] },
  { method: "steamed",     tokens: ["steamed", "steam"] },
  { method: "boiled",      tokens: ["boiled", "poached", "simmered", "braised", "stewed"] },
  { method: "smoked",      tokens: ["smoked"] },
  { method: "raw",         tokens: ["raw", "tartare", "sashimi", "carpaccio", "ceviche"] },
];

/** USDA `foodCategory` → ProteinCategory (high-confidence override).
 *  Source: usda FDC FoodDataCentral category names from cached payloads. */
export const USDA_PROTEIN_CATEGORY: Record<string, ProteinCategory> = {
  "Poultry Products":              "poultry",
  "Beef Products":                 "red_meat",
  "Pork Products":                 "red_meat",
  "Lamb, Veal, and Game Products": "red_meat",
  "Sausages and Luncheon Meats":   "red_meat",
  "Finfish and Shellfish Products":"fish_seafood",
  "Dairy and Egg Products":        "dairy_protein", // post-process eggs subset by name
  "Legumes and Legume Products":   "plant_protein",
};

export const USDA_CARB_CATEGORY: Record<string, CarbCategory> = {
  "Cereal Grains and Pasta":            "refined_grain", // post-process whole-grain subset by name
  "Breakfast Cereals":                  "refined_grain",
  "Baked Products":                     "refined_grain",
  "Vegetables and Vegetable Products":  "non_starchy_veg", // post-process starchy_veg subset by name
  "Fruits and Fruit Juices":            "fruit",
  "Legumes and Legume Products":        "legume",
  "Sweets":                             "sugar_sweets",
  "Beverages":                          "sugar_sweets", // juice/soda dominant
};
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: zero new errors.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/nutrition-intelligence/word-lists.ts
git commit -m "$(cat <<'EOF'
feat(coach): word lists for nutrition-intelligence classifier

Token vocabularies for protein / carb / cooking-method classification of
food_log_entries.name + USDA foodCategory overrides. Disambiguators (e.g.
chickpea before poultry's chick) ordered first per category.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Thresholds (shared between checks + UI callouts)

**Files:**
- Create: `lib/coach/nutrition-intelligence/thresholds.ts`

- [ ] **Step 1: Write the thresholds file**

```ts
// lib/coach/nutrition-intelligence/thresholds.ts
//
// Constants shared between proactive checks (Phase 2) and InlineNudgeCallout.
// Pulling these into one module so we never get drift between "what fires"
// and "what the inline callout claims is firing".

/** Body comp triggers — 4-week window deltas. */
export const RECOMP_SUCCESS_LBM_DELTA_KG = 0.3;       // ≥ +0.3 kg
export const RECOMP_SUCCESS_BF_DELTA_PTS = -0.5;      // ≤ −0.5 pts
export const RECOMP_DRIFT_WEIGHT_TOL_KG  = 0.3;       // within ±0.3 kg
export const RECOMP_DRIFT_BF_DELTA_PTS   = 0.5;       // ≥ +0.5 pts

/** Protein adherence triggers — 7-day window. */
export const PROTEIN_UNDER_HIT_RATE     = 0.60;       // < 60% hit rate fires
export const PROTEIN_UNDER_MIN_LOGGED   = 5;          // require ≥ 5 logged days

/** GLP-1 protein floor — 5-day window. */
export const GLP1_PROTEIN_FLOOR_G_PER_KG = 1.8;       // active mode floor
export const GLP1_PROTEIN_MISS_DAYS      = 3;         // misses on ≥ 3 of last 5

/** Food-quality triggers — 14-day window with min-volume gate. */
export const MONOTONE_PROTEIN_SHARE_THRESHOLD = 0.70; // ≥ 70% from one source
export const QUALITY_MIN_CLASSIFIED_ITEMS    = 30;    // suppress below this

export const FRIED_HEAVY_SHARE_THRESHOLD = 0.40;      // (pan + deep) / known ≥ 0.40

/** Training × nutrition triggers — 4-week window. */
export const TRAINING_UNDEREAT_KCAL_GAP   = 300;      // kcal < (target − 300) counts
export const TRAINING_UNDEREAT_HIT_RATIO  = 0.50;     // ≥ 50% of lift days
export const TRAINING_UNDEREAT_MIN_DAYS   = 6;        // ≥ 6 lift days in 4w

/** Inline-callout severity colors (matches existing ProactiveNudgeCard styling). */
export const CALLOUT_AMBER_BG     = "#fef3c7";
export const CALLOUT_AMBER_BORDER = "#fde68a";
export const CALLOUT_AMBER_FG     = "#92400e";
export const CALLOUT_GREEN_BG     = "#dcfce7";
export const CALLOUT_GREEN_BORDER = "#bbf7d0";
export const CALLOUT_GREEN_FG     = "#166534";

/** Aggregation window for the food-quality composer. */
export const FOOD_QUALITY_WINDOW_DAYS = 14;
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: zero new errors.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/nutrition-intelligence/thresholds.ts
git commit -m "$(cat <<'EOF'
feat(coach): nutrition-intelligence thresholds

One module owns every numeric threshold used by both proactive checks and
the inline-nudge callouts in the trends view. Prevents drift between
'what fires' and 'what the UI claims is firing'.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Classifier (pure functions)

**Files:**
- Create: `lib/coach/nutrition-intelligence/classify.ts`

- [ ] **Step 1: Write the classifier**

```ts
// lib/coach/nutrition-intelligence/classify.ts
//
// Pure classifiers for food_log_entries.name → protein / carb / cooking
// categories. No I/O. Caller passes the optional USDA category extracted
// from food_db_cache.raw_payload.foodCategory.

import {
  CARB_TOKENS,
  COOKING_METHOD_TOKENS,
  PROTEIN_TOKENS,
  USDA_CARB_CATEGORY,
  USDA_PROTEIN_CATEGORY,
  type CarbCategory,
  type CookingMethod,
  type ProteinCategory,
} from "./word-lists";

export type Confidence = "high" | "medium" | "low";

export function classifyProtein(
  name: string,
  usdaCategory?: string | null,
): { category: ProteinCategory; confidence: Confidence } {
  const lower = name.toLowerCase();

  // 1. USDA category override (high confidence).
  if (usdaCategory) {
    const mapped = USDA_PROTEIN_CATEGORY[usdaCategory];
    if (mapped) {
      // Dairy-and-eggs ambiguity: split by name token.
      if (mapped === "dairy_protein" && /\begg(s|\b)/.test(lower)) {
        return { category: "eggs", confidence: "high" };
      }
      return { category: mapped, confidence: "high" };
    }
  }

  // 2. Name-token match — first hit wins.
  for (const bucket of PROTEIN_TOKENS) {
    if (bucket.tokens.some((t) => lower.includes(t))) {
      return { category: bucket.cat, confidence: "medium" };
    }
  }
  return { category: "unknown", confidence: "low" };
}

export function classifyCarb(
  name: string,
  usdaCategory?: string | null,
): { category: CarbCategory; confidence: Confidence } {
  const lower = name.toLowerCase();

  if (usdaCategory) {
    const mapped = USDA_CARB_CATEGORY[usdaCategory];
    if (mapped) {
      // "Cereal Grains and Pasta" — promote whole grains by name.
      if (mapped === "refined_grain" && /\b(oat|brown rice|quinoa|wild rice|barley|farro|whole)/.test(lower)) {
        return { category: "whole_grain", confidence: "high" };
      }
      // "Vegetables and Vegetable Products" — promote starchy.
      if (mapped === "non_starchy_veg" && /\b(potato|sweet potato|yam|corn|plantain)/.test(lower)) {
        return { category: "starchy_veg", confidence: "high" };
      }
      return { category: mapped, confidence: "high" };
    }
  }

  for (const bucket of CARB_TOKENS) {
    if (bucket.tokens.some((t) => lower.includes(t))) {
      return { category: bucket.cat, confidence: "medium" };
    }
  }
  return { category: "unknown", confidence: "low" };
}

export function classifyCookingMethod(
  name: string,
): { method: CookingMethod; confidence: Confidence } {
  const lower = name.toLowerCase();

  // Order matters — deep_fried / air_fried before pan_fried so the more
  // specific match wins on items like "deep fried tofu".
  for (const bucket of COOKING_METHOD_TOKENS) {
    if (bucket.tokens.some((t) => lower.includes(t))) {
      return { method: bucket.method, confidence: "medium" };
    }
  }
  return { method: "unknown", confidence: "low" };
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: zero new errors.

- [ ] **Step 3: Manual smoke-test with a small Node script**

Open a one-off REPL (no file commit) — paste in `node --import ./scripts/alias-loader.mjs --experimental-strip-types` and import the classifier. Expected results:

```
classifyProtein("grilled chicken breast")         → { category: "poultry",      confidence: "medium" }
classifyProtein("chickpea curry")                 → { category: "plant_protein", confidence: "medium" }
classifyProtein("Salmon, raw", "Finfish and Shellfish Products") → { category: "fish_seafood",  confidence: "high" }
classifyProtein("scrambled eggs", "Dairy and Egg Products") → { category: "eggs",            confidence: "high" }
classifyProtein("cottage cheese")                 → { category: "dairy_protein", confidence: "medium" }
classifyCarb("brown rice")                        → { category: "whole_grain",   confidence: "medium" }
classifyCarb("Rice, white, cooked", "Cereal Grains and Pasta") → { category: "refined_grain", confidence: "high" }
classifyCarb("Sweet potato, baked", "Vegetables and Vegetable Products") → { category: "starchy_veg", confidence: "high" }
classifyCookingMethod("grilled chicken")          → { method: "grilled",         confidence: "medium" }
classifyCookingMethod("salmon fillet")            → { method: "unknown",         confidence: "low" }
classifyCookingMethod("deep fried tofu")          → { method: "deep_fried",      confidence: "medium" }
classifyCookingMethod("breaded chicken cutlet")   → { method: "deep_fried",      confidence: "medium" }
```

If any disagree, fix `word-lists.ts` ordering or `classify.ts` regex and re-run before committing.

- [ ] **Step 4: Commit**

```bash
git add lib/coach/nutrition-intelligence/classify.ts
git commit -m "$(cat <<'EOF'
feat(coach): classify food log items by protein/carb/cooking

Pure classifiers reading name + optional USDA foodCategory. USDA category
override is high-confidence; name-token fallback is medium. Disambiguation
for chickpea (not poultry), eggs-within-dairy USDA bucket, whole-grain
promotion inside the cereal-and-pasta bucket, starchy-veg promotion inside
the vegetables bucket.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Extend `lib/data/types.ts` with `FoodQualityTrend` + per-meal-slot

**Files:**
- Modify: `lib/data/types.ts`

- [ ] **Step 1: Add `FoodQualityTrend` type and extend `NutritionAdherenceTrend`**

Open `lib/data/types.ts`. Find the existing `NutritionAdherenceTrend` type — it ends with the `deficit_kcal` field. Append the `per_meal_slot` block:

```ts
// Append inside NutritionAdherenceTrend, after deficit_kcal:
  per_meal_slot: {
    protein_g: Record<MealSlot, {
      avg_14d: number | null;
      target_g: number | null;
      pct_of_target: number | null;
    }>;
    kcal: Record<MealSlot, {
      avg_14d: number | null;
      target_kcal: number | null;
      pct_of_target: number | null;
    }>;
  };
```

If `MealSlot` is not already imported in this file, add the import at the top:

```ts
import type { MealSlot } from "@/lib/food/types";
```

Find `CoachTrendsPayload` and add `food_quality` as a required field; bump `schema_version` to 2:

```ts
export type CoachTrendsPayload = {
  schema_version: 2;                          // was 1
  generated_at: string;
  strength: StrengthTrend;
  body: BodyTrend;
  nutrition: NutritionAdherenceTrend;
  recovery: RecoveryTrend;
  food_quality: FoodQualityTrend;             // NEW
  cross_insights: CrossInsight[];
  headline: { /* unchanged */ };
};
```

Insert `FoodQualityTrend` immediately before `CoachTrendsPayload`:

```ts
export type ProteinCategory =
  | "poultry" | "red_meat" | "fish_seafood" | "eggs"
  | "dairy_protein" | "plant_protein" | "protein_supplement"
  | "mixed" | "unknown";

export type CarbCategory =
  | "whole_grain" | "refined_grain" | "starchy_veg" | "non_starchy_veg"
  | "fruit" | "legume" | "sugar_sweets" | "unknown";

export type CookingMethod =
  | "grilled" | "baked" | "pan_fried" | "deep_fried" | "air_fried"
  | "steamed" | "boiled" | "roasted" | "raw" | "smoked" | "unknown";

export type FoodQualityTrend = {
  schema_version: 1;
  window_days: 14;
  protein_sources: Array<{ category: ProteinCategory; grams: number; pct: number }>;
  carb_sources:    Array<{ category: CarbCategory;    grams: number; pct: number }>;
  cooking_methods: Array<{ method: CookingMethod;     count: number; pct: number }>;
  diversity: {
    distinct_items:      number;
    fish_meals_per_week: number;
    veg_servings_per_day: number;
  };
  data_completeness: {
    protein_classified_pct:       number;
    carb_classified_pct:          number;
    cooking_method_inferable_pct: number;
  };
  total_items: number;
};
```

- [ ] **Step 2: Extend `ProactiveTriggerType` union (Phase 2 prep — done now to keep schema migrations single-shot)**

Find the existing `ProactiveTriggerType`:

```ts
export type ProactiveTriggerType =
  | "plateau"
  | "off_pace_weight"
  | "hrv_below_baseline"
  // NEW — body comp
  | "recomp_success"
  | "recomp_drift"
  // NEW — adherence
  | "protein_under"
  | "glp1_protein_floor"
  // NEW — quality
  | "monotone_protein"
  | "fried_heavy"
  // NEW — training × nutrition
  | "training_day_undereat";
```

Find `ProactiveNudgeCard` and widen `severity` to include `"info"` and `"ok"`:

```ts
  severity: "ok" | "info" | "warn";           // was "warn" only
```

The existing `ProactiveEvent` is fine — its `payload: Record<string, unknown>` already carries arbitrary data. Do NOT change it.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: many errors in places that pattern-match `severity` and `trigger_type` (intentional — Phase 1 doesn't fix them all, Phase 2 closes them). The errors in `lib/coach/proactive/check-*.ts`, `lib/coach/proactive/render-card.ts`, and `lib/coach/trends/index.ts` (missing `food_quality` in payload return) are expected and will be resolved by Tasks 5, 7, and Phase 2.

If errors appear in unrelated files (e.g. `components/chat/ProactiveNudgeCard.tsx` widening on severity), patch them in this commit — add a `"info"` and `"ok"` case mirroring `"warn"` (same color treatment for now; Task 13 introduces the proper severity palette).

- [ ] **Step 4: Commit**

```bash
git add lib/data/types.ts components/chat/ProactiveNudgeCard.tsx
git commit -m "$(cat <<'EOF'
feat(types): FoodQualityTrend + per_meal_slot + 7 new trigger types

Bumps CoachTrendsPayload.schema_version to 2. ProactiveNudgeCard.severity
widens 'warn' → 'ok' | 'info' | 'warn' for positive nudges like
recomp_success. The trends compose modules + check files break against
this commit; Tasks 5-7 + Phase 2 fix them.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Food-quality composer

**Files:**
- Create: `lib/coach/nutrition-intelligence/compose-food-quality.ts`

- [ ] **Step 1: Write the composer**

```ts
// lib/coach/nutrition-intelligence/compose-food-quality.ts
//
// 14-day aggregation: per-item classification → category-grouped grams /
// counts. Reads food_log_entries (status='committed') and joins
// food_db_cache via db_ref->>'canonical_id' for the USDA foodCategory.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  FoodQualityTrend,
  ProteinCategory,
  CarbCategory,
  CookingMethod,
} from "@/lib/data/types";
import { FOOD_QUALITY_WINDOW_DAYS } from "./thresholds";
import { classifyProtein, classifyCarb, classifyCookingMethod } from "./classify";

type FoodLogRow = {
  id: string;
  name: string;
  protein_g: number | null;
  carbs_g: number | null;
  meal_slot: string;
  eaten_at: string;
  db_ref: { source: string; canonical_id: string } | null;
};

type CacheRow = {
  canonical_id: string;
  raw_payload: Record<string, unknown> | null;
};

export async function composeFoodQuality(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<FoodQualityTrend> {
  const { supabase, userId, today } = args;
  const windowStart = shiftDays(today, -FOOD_QUALITY_WINDOW_DAYS);
  const windowStartIso = `${windowStart}T00:00:00Z`;
  const todayIso = `${today}T23:59:59Z`;

  // 1. Fetch committed food log entries in the window.
  const { data: entries, error } = await supabase
    .from("food_log_entries")
    .select("id, name, protein_g, carbs_g, meal_slot, eaten_at, db_ref")
    .eq("user_id", userId)
    .eq("status", "committed")
    .gte("eaten_at", windowStartIso)
    .lte("eaten_at", todayIso);
  if (error) throw error;
  const rows = (entries as FoodLogRow[] | null) ?? [];

  // 2. Batch-fetch USDA category from food_db_cache for items with db_ref.
  const canonicalIds = [
    ...new Set(
      rows
        .map((r) => r.db_ref?.canonical_id)
        .filter((x): x is string => typeof x === "string"),
    ),
  ];
  const cacheByCanonical = new Map<string, string | null>();
  if (canonicalIds.length > 0) {
    const { data: cacheRows, error: cacheErr } = await supabase
      .from("food_db_cache")
      .select("canonical_id, raw_payload")
      .in("canonical_id", canonicalIds);
    if (cacheErr) throw cacheErr;
    for (const c of (cacheRows as CacheRow[] | null) ?? []) {
      const cat = extractUsdaCategory(c.raw_payload);
      cacheByCanonical.set(c.canonical_id, cat);
    }
  }

  // 3. Classify each row + accumulate.
  const proteinBuckets = new Map<ProteinCategory, number>();
  const carbBuckets    = new Map<CarbCategory,    number>();
  const cookingBuckets = new Map<CookingMethod,   number>();

  let proteinClassifiedG = 0;
  let proteinTotalG = 0;
  let carbClassifiedG = 0;
  let carbTotalG = 0;
  let cookingClassifiedN = 0;
  const distinctNames = new Set<string>();
  const fishMealKeys = new Set<string>();   // `${date}|${meal_slot}` if any fish item
  let vegItemCount = 0;

  for (const r of rows) {
    const usdaCat = r.db_ref?.canonical_id
      ? cacheByCanonical.get(r.db_ref.canonical_id) ?? null
      : null;

    const p = classifyProtein(r.name, usdaCat);
    const c = classifyCarb(r.name, usdaCat);
    const m = classifyCookingMethod(r.name);

    const pg = r.protein_g ?? 0;
    const cg = r.carbs_g ?? 0;

    proteinTotalG += pg;
    if (p.category !== "unknown") {
      proteinBuckets.set(p.category, (proteinBuckets.get(p.category) ?? 0) + pg);
      proteinClassifiedG += pg;
    }

    carbTotalG += cg;
    if (c.category !== "unknown") {
      carbBuckets.set(c.category, (carbBuckets.get(c.category) ?? 0) + cg);
      carbClassifiedG += cg;
    }

    if (m.method !== "unknown") {
      cookingBuckets.set(m.method, (cookingBuckets.get(m.method) ?? 0) + 1);
      cookingClassifiedN += 1;
    }

    distinctNames.add(r.name.toLowerCase().trim());

    if (p.category === "fish_seafood") {
      const dateKey = r.eaten_at.slice(0, 10);
      fishMealKeys.add(`${dateKey}|${r.meal_slot}`);
    }
    if (c.category === "non_starchy_veg") vegItemCount += 1;
  }

  const protein_sources = [...proteinBuckets.entries()]
    .map(([category, grams]) => ({
      category,
      grams,
      pct: proteinClassifiedG > 0 ? grams / proteinClassifiedG : 0,
    }))
    .sort((a, b) => b.grams - a.grams);

  const carb_sources = [...carbBuckets.entries()]
    .map(([category, grams]) => ({
      category,
      grams,
      pct: carbClassifiedG > 0 ? grams / carbClassifiedG : 0,
    }))
    .sort((a, b) => b.grams - a.grams);

  const cooking_methods = [...cookingBuckets.entries()]
    .map(([method, count]) => ({
      method,
      count,
      pct: cookingClassifiedN > 0 ? count / cookingClassifiedN : 0,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    schema_version: 1,
    window_days: FOOD_QUALITY_WINDOW_DAYS,
    protein_sources,
    carb_sources,
    cooking_methods,
    diversity: {
      distinct_items: distinctNames.size,
      fish_meals_per_week: fishMealKeys.size / (FOOD_QUALITY_WINDOW_DAYS / 7),
      veg_servings_per_day: vegItemCount / FOOD_QUALITY_WINDOW_DAYS,
    },
    data_completeness: {
      protein_classified_pct:       proteinTotalG > 0 ? proteinClassifiedG / proteinTotalG : 0,
      carb_classified_pct:          carbTotalG    > 0 ? carbClassifiedG / carbTotalG       : 0,
      cooking_method_inferable_pct: rows.length   > 0 ? cookingClassifiedN / rows.length   : 0,
    },
    total_items: rows.length,
  };
}

/** USDA FDC top-level food category lives under one of these keys depending
 *  on dataType (foundation vs branded). Returns the description string. */
function extractUsdaCategory(raw: Record<string, unknown> | null): string | null {
  if (!raw) return null;
  const fc = (raw as { foodCategory?: unknown }).foodCategory;
  if (typeof fc === "string") return fc;
  if (fc && typeof fc === "object" && typeof (fc as { description?: unknown }).description === "string") {
    return (fc as { description: string }).description;
  }
  const branded = (raw as { brandedFoodCategory?: unknown }).brandedFoodCategory;
  if (typeof branded === "string") return branded;
  return null;
}

function shiftDays(d: string, days: number): string {
  const dt = new Date(`${d}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: this file is now clean. `lib/coach/trends/index.ts` still errors (Task 7 fixes).

- [ ] **Step 3: Commit**

```bash
git add lib/coach/nutrition-intelligence/compose-food-quality.ts
git commit -m "$(cat <<'EOF'
feat(coach): composeFoodQuality reads 14d window + USDA category join

Per-item classify → grouped grams (protein, carb) + grouped item counts
(cooking method) + diversity numbers. food_db_cache.raw_payload.foodCategory
extraction handles both foundation (string) and branded (string under
brandedFoodCategory) USDA payload shapes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Extend `compose-nutrition.ts` with per-meal-slot block

**Files:**
- Modify: `lib/coach/trends/compose-nutrition.ts`

- [ ] **Step 1: Add per-slot aggregation**

At the top of the file, add imports:

```ts
import type { MealSlot } from "@/lib/food/types";
import { targetsForAllSlots, DEFAULT_MEAL_RATIOS, type MealRatios } from "@/lib/food/meal-targets";
```

Inside `composeNutrition`, after the existing `kcalAvg12w` computation and before the `return`, add:

```ts
  // ── Per-meal-slot 14d averages ─────────────────────────────────────────
  const slot14wCutoff = shiftDays(today, -14);
  const { data: slotEntries, error: slotErr } = await supabase
    .from("food_log_entries")
    .select("meal_slot, protein_g, kcal, eaten_at")
    .eq("user_id", userId)
    .eq("status", "committed")
    .gte("eaten_at", `${slot14wCutoff}T00:00:00Z`)
    .lte("eaten_at", `${today}T23:59:59Z`);
  if (slotErr) throw slotErr;

  type SlotRow = { meal_slot: MealSlot; protein_g: number | null; kcal: number | null; eaten_at: string };
  const slotRows = (slotEntries as SlotRow[] | null) ?? [];

  // Aggregate by (date, slot) → then average across days.
  const byDaySlot = new Map<string, { protein: number; kcal: number }>();
  for (const r of slotRows) {
    const dateKey = r.eaten_at.slice(0, 10);
    const k = `${dateKey}|${r.meal_slot}`;
    const cell = byDaySlot.get(k) ?? { protein: 0, kcal: 0 };
    cell.protein += r.protein_g ?? 0;
    cell.kcal += r.kcal ?? 0;
    byDaySlot.set(k, cell);
  }

  // Average by slot across days observed.
  const slotTotals: Record<MealSlot, { proteinSum: number; kcalSum: number; daysObserved: number }> = {
    breakfast: { proteinSum: 0, kcalSum: 0, daysObserved: 0 },
    lunch:     { proteinSum: 0, kcalSum: 0, daysObserved: 0 },
    dinner:    { proteinSum: 0, kcalSum: 0, daysObserved: 0 },
    snack:     { proteinSum: 0, kcalSum: 0, daysObserved: 0 },
  };
  for (const [k, cell] of byDaySlot.entries()) {
    const slot = k.split("|")[1] as MealSlot;
    slotTotals[slot].proteinSum += cell.protein;
    slotTotals[slot].kcalSum += cell.kcal;
    slotTotals[slot].daysObserved += 1;
  }

  // Per-slot targets: kcal via meal_ratios, protein evenly distributed.
  const ratios: MealRatios = DEFAULT_MEAL_RATIOS; // future: read from profiles.nutrition_overrides.meal_ratios
  const slotKcalTargets = kcalTarget != null ? targetsForAllSlots(kcalTarget, ratios) : null;
  const slotProteinTarget = proteinTarget != null ? proteinTarget / 4 : null; // even split — 25% per slot

  function buildSlot(slot: MealSlot, kind: "protein_g" | "kcal") {
    const t = slotTotals[slot];
    const avg = t.daysObserved > 0
      ? (kind === "protein_g" ? t.proteinSum : t.kcalSum) / t.daysObserved
      : null;
    const target = kind === "protein_g"
      ? slotProteinTarget
      : slotKcalTargets?.[slot] ?? null;
    const pct = avg != null && target != null && target > 0 ? avg / target : null;
    return { avg_14d: avg, [kind === "protein_g" ? "target_g" : "target_kcal"]: target, pct_of_target: pct } as
      { avg_14d: number | null; target_g?: number | null; target_kcal?: number | null; pct_of_target: number | null };
  }

  const per_meal_slot = {
    protein_g: {
      breakfast: buildSlot("breakfast", "protein_g") as { avg_14d: number | null; target_g: number | null; pct_of_target: number | null },
      lunch:     buildSlot("lunch",     "protein_g") as { avg_14d: number | null; target_g: number | null; pct_of_target: number | null },
      dinner:    buildSlot("dinner",    "protein_g") as { avg_14d: number | null; target_g: number | null; pct_of_target: number | null },
      snack:     buildSlot("snack",     "protein_g") as { avg_14d: number | null; target_g: number | null; pct_of_target: number | null },
    },
    kcal: {
      breakfast: buildSlot("breakfast", "kcal") as { avg_14d: number | null; target_kcal: number | null; pct_of_target: number | null },
      lunch:     buildSlot("lunch",     "kcal") as { avg_14d: number | null; target_kcal: number | null; pct_of_target: number | null },
      dinner:    buildSlot("dinner",    "kcal") as { avg_14d: number | null; target_kcal: number | null; pct_of_target: number | null },
      snack:     buildSlot("snack",     "kcal") as { avg_14d: number | null; target_kcal: number | null; pct_of_target: number | null },
    },
  };
```

Append `per_meal_slot` to the returned object inside the same `return` statement.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: `compose-nutrition.ts` is clean. `lib/coach/trends/index.ts` still errors (missing `food_quality` — Task 7 fixes).

- [ ] **Step 3: Commit**

```bash
git add lib/coach/trends/compose-nutrition.ts
git commit -m "$(cat <<'EOF'
feat(coach): per-meal-slot 14d averages in composeNutrition

Adds protein_g + kcal averages per slot (breakfast/lunch/dinner/snack)
with the corresponding meal_ratios-derived kcal target and an evenly-split
protein-per-slot target. Powers the 'By meal slot' block in the new
NutritionSection (Task 13) and the training_day_undereat trigger context
(Task 21).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Wire `composeFoodQuality` into orchestrator + extend `pickHeadline`

**Files:**
- Modify: `lib/coach/trends/index.ts`

- [ ] **Step 1: Add import + parallel-fetch + payload field**

Replace the file body:

```ts
// lib/coach/trends/index.ts
//
// Orchestrator: parallel-fetch supabase reads via the 6 composers,
// pick a headline insight from severity priority, return CoachTrendsPayload.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoachTrendsPayload } from "@/lib/data/types";
import { composeStrength } from "./compose-strength";
import { composeBody } from "./compose-body";
import { composeNutrition } from "./compose-nutrition";
import { composeRecovery } from "./compose-recovery";
import { composeCross } from "./compose-cross";
import { composeFoodQuality } from "@/lib/coach/nutrition-intelligence/compose-food-quality";
import {
  RECOMP_SUCCESS_LBM_DELTA_KG,
  RECOMP_SUCCESS_BF_DELTA_PTS,
  RECOMP_DRIFT_WEIGHT_TOL_KG,
  RECOMP_DRIFT_BF_DELTA_PTS,
} from "@/lib/coach/nutrition-intelligence/thresholds";

export async function generateCoachTrends(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<CoachTrendsPayload> {
  const [strength, body, nutrition, recovery, food_quality, cross_insights] = await Promise.all([
    composeStrength(args),
    composeBody(args),
    composeNutrition(args),
    composeRecovery(args),
    composeFoodQuality(args),
    composeCross(args),
  ]);

  return {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    strength,
    body,
    nutrition,
    recovery,
    food_quality,
    cross_insights,
    headline: pickHeadline({ strength, body, recovery }),
  };
}

function pickHeadline(input: {
  strength: CoachTrendsPayload["strength"];
  body: CoachTrendsPayload["body"];
  recovery: CoachTrendsPayload["recovery"];
}): CoachTrendsPayload["headline"] {
  // 1. Recomp success (positive) — wins over any negative headline because
  //    it's earned good news the athlete should see immediately.
  const lbm4w = input.body.lbm.delta_4w_kg;
  const bf4w  = input.body.body_fat_pct.delta_4w_pct;
  if (
    lbm4w != null && lbm4w >= RECOMP_SUCCESS_LBM_DELTA_KG &&
    bf4w  != null && bf4w  <= RECOMP_SUCCESS_BF_DELTA_PTS
  ) {
    return {
      severity: "ok",
      title: "Recomp working",
      body_md: `LBM +${lbm4w.toFixed(1)} kg, body fat ${bf4w.toFixed(1)} pts over 4 weeks. Whatever the lever is, keep it.`,
    };
  }

  const plateauedLifts = input.strength.per_lift.filter((p) => p.plateau_active);
  if (plateauedLifts.length > 0) {
    const longest = plateauedLifts.reduce((a, b) =>
      b.plateau_weeks_flat > a.plateau_weeks_flat ? b : a,
    );
    const short = longest.lift.replace(/\s*\([^)]+\)/, "");
    return {
      severity: "warn",
      title: `${short} plateau — ${longest.plateau_weeks_flat} weeks flat`,
      body_md: `e1RM has not moved on ${short} for ${longest.plateau_weeks_flat} weeks. Coach will propose a rep-shift or deload at the next weekly review.`,
    };
  }

  // 2. Recomp drift — scale flat + BF% up.
  const wRate4w = input.body.weight.rate_kg_per_wk_4w;
  if (
    wRate4w != null && Math.abs(wRate4w * 4) <= RECOMP_DRIFT_WEIGHT_TOL_KG &&
    bf4w != null && bf4w >= RECOMP_DRIFT_BF_DELTA_PTS
  ) {
    return {
      severity: "warn",
      title: `Recomp drift — body fat +${bf4w.toFixed(1)} pts`,
      body_md: "Scale weight is roughly flat over 4 weeks but body fat ticked up. The deficit isn't deep enough at maintenance protein — Nora has details.",
    };
  }

  if (input.body.weight.in_band === false && input.body.weight.rate_kg_per_wk_4w != null) {
    const rate = input.body.weight.rate_kg_per_wk_4w;
    const aggressive = rate < input.body.weight.target_band.lower;
    return {
      severity: "warn",
      title: aggressive
        ? `Weight dropping ${rate.toFixed(1)} kg/wk — aggressive`
        : `Weight ${rate >= 0 ? "rising" : "falling slowly"} (${rate.toFixed(1)} kg/wk)`,
      body_md: aggressive
        ? "Loss rate is below the target band. Risk of LBM and strength loss — coach may hold loads at the next review."
        : "Loss rate is above the target band. If a cut is intended, deficit needs deepening; if maintenance, you're on track.",
    };
  }

  if (input.recovery.hrv.vs_baseline_pct_4w != null && input.recovery.hrv.vs_baseline_pct_4w < -0.05) {
    const pct = Math.abs(input.recovery.hrv.vs_baseline_pct_4w * 100);
    return {
      severity: "warn",
      title: `HRV ${pct.toFixed(0)}% below baseline`,
      body_md: "Average HRV over the last 4 weeks is below your 30-day baseline. Sleep, stress, or training load are candidates — check the Recovery section.",
    };
  }

  return {
    severity: "ok",
    title: "On track",
    body_md: "No plateau, weight loss in band, recovery near baseline. Stay the course.",
  };
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: `lib/coach/trends/index.ts` is now clean. Phase 2 files (`lib/coach/proactive/render-card.ts` etc.) still error and that's expected.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/trends/index.ts
git commit -m "$(cat <<'EOF'
feat(coach): wire composeFoodQuality + recomp headlines into trends

generateCoachTrends now parallel-fetches all 6 composers. pickHeadline
gets two new candidates: recomp_success (positive — overrides any warn)
and recomp_drift (between plateau and off-pace in priority).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Audit script for nutrition-intelligence

**Files:**
- Create: `scripts/audit-nutrition-intelligence.mjs`

- [ ] **Step 1: Write the audit script**

```js
// scripts/audit-nutrition-intelligence.mjs
//
// Read-only audit. Set AUDIT_USER_ID. Runs composeFoodQuality + prints
// per-item classification rows + final bar percentages. Use to inspect
// mis-classifications before they propagate to the live trends view.
//
// Run: AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs \
//      --experimental-strip-types --env-file=.env.local \
//      scripts/audit-nutrition-intelligence.mjs

import { createClient } from "@supabase/supabase-js";
import { composeFoodQuality } from "../lib/coach/nutrition-intelligence/compose-food-quality.ts";
import { classifyProtein, classifyCarb, classifyCookingMethod } from "../lib/coach/nutrition-intelligence/classify.ts";

const userId = process.env.AUDIT_USER_ID;
if (!userId) {
  console.error("AUDIT_USER_ID env var required");
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const today = new Date().toISOString().slice(0, 10);

console.log(`\n── Nutrition intelligence audit · user=${userId} · today=${today} ──\n`);

// 1. Per-item classification dump.
const { data: entries, error } = await supabase
  .from("food_log_entries")
  .select("id, name, protein_g, carbs_g, meal_slot, eaten_at, db_ref")
  .eq("user_id", userId)
  .eq("status", "committed")
  .gte("eaten_at", new Date(Date.now() - 14 * 86400000).toISOString())
  .order("eaten_at", { ascending: false });
if (error) { console.error(error); process.exit(1); }

console.log(`Last 14d: ${entries?.length ?? 0} committed entries\n`);
console.log("Item                                        Protein         Carb            Cooking");
console.log("─".repeat(110));
for (const e of entries ?? []) {
  const p = classifyProtein(e.name);
  const c = classifyCarb(e.name);
  const m = classifyCookingMethod(e.name);
  console.log(
    `${e.name.padEnd(44).slice(0,44)}${p.category.padEnd(16)}${c.category.padEnd(16)}${m.method}`,
  );
}

// 2. Composer output.
console.log("\n── composeFoodQuality output ──\n");
const trend = await composeFoodQuality({ supabase, userId, today });
console.log(`Total items: ${trend.total_items}`);
console.log(`Data completeness: protein ${(trend.data_completeness.protein_classified_pct*100).toFixed(0)}% · carb ${(trend.data_completeness.carb_classified_pct*100).toFixed(0)}% · cooking ${(trend.data_completeness.cooking_method_inferable_pct*100).toFixed(0)}%`);

console.log("\nProtein sources (% of classified protein-g):");
for (const s of trend.protein_sources) {
  console.log(`  ${s.category.padEnd(20)}${(s.pct*100).toFixed(1).padStart(6)}%  (${s.grams.toFixed(0)}g)`);
}

console.log("\nCarb sources (% of classified carb-g):");
for (const s of trend.carb_sources) {
  console.log(`  ${s.category.padEnd(20)}${(s.pct*100).toFixed(1).padStart(6)}%  (${s.grams.toFixed(0)}g)`);
}

console.log("\nCooking methods (% of classified-method items):");
for (const m of trend.cooking_methods) {
  console.log(`  ${m.method.padEnd(20)}${(m.pct*100).toFixed(1).padStart(6)}%  (${m.count} items)`);
}

console.log(`\nDiversity: ${trend.diversity.distinct_items} distinct · ${trend.diversity.fish_meals_per_week.toFixed(1)} fish/wk · ${trend.diversity.veg_servings_per_day.toFixed(1)} veg/day\n`);
```

- [ ] **Step 2: Run the audit** (only if you have committed food log data)

Run:

```
AUDIT_USER_ID=$YOUR_UUID node --import ./scripts/alias-loader.mjs \
  --experimental-strip-types --env-file=.env.local \
  scripts/audit-nutrition-intelligence.mjs
```

Expected: a table of items + classification, then aggregated bar percentages. Spot-check the items table for mis-classifications. If any rows look wrong, fix `word-lists.ts` (re-run Task 1) before continuing.

- [ ] **Step 3: Commit**

```bash
git add scripts/audit-nutrition-intelligence.mjs
git commit -m "$(cat <<'EOF'
chore(scripts): audit nutrition-intelligence classifier + composer

Per-item classification dump + composer output for the last 14 days.
First-pass diagnostic for word-list tuning before live UI changes ship.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Active-nudges query hook

**Files:**
- Create: `lib/query/hooks/useActiveNudges.ts`

- [ ] **Step 1: Write the hook**

```ts
// lib/query/hooks/useActiveNudges.ts
//
// Reads proactive_nudge_dedup rows in the last 7 days. Drives the
// InlineNudgeCallout decoration on trends cards: a callout shows when
// a matching trigger_key has fired within the dedup window (i.e. the
// chat-row nudge has either been delivered or is still in the active
// dedup window).

import { useQuery } from "@tanstack/react-query";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { queryKeys } from "@/lib/query/keys";

export type ActiveNudgeRow = {
  trigger_key: string;
  fired_at: string;
};

export function useActiveNudges(userId: string) {
  return useQuery<ActiveNudgeRow[]>({
    queryKey: queryKeys.activeNudges.byUser(userId),
    queryFn: async () => {
      const supabase = createSupabaseBrowserClient();
      const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
      const { data, error } = await supabase
        .from("proactive_nudge_dedup")
        .select("trigger_key, fired_at")
        .eq("user_id", userId)
        .gte("fired_at", cutoff)
        .order("fired_at", { ascending: false });
      if (error) throw error;
      return (data as ActiveNudgeRow[] | null) ?? [];
    },
    staleTime: 60_000,
  });
}
```

- [ ] **Step 2: Add the key to `lib/query/keys.ts`**

Open `lib/query/keys.ts` and add (alphabetically inside the `queryKeys` object):

```ts
  activeNudges: {
    all:     (userId: string) => ["activeNudges", userId] as const,
    byUser:  (userId: string) => ["activeNudges", userId] as const,
  },
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add lib/query/hooks/useActiveNudges.ts lib/query/keys.ts
git commit -m "$(cat <<'EOF'
feat(query): useActiveNudges hook reading proactive_nudge_dedup

Backs the InlineNudgeCallout component (next task). 7-day window matches
the existing dedup invariant in lib/coach/proactive/index.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: InlineNudgeCallout component

**Files:**
- Create: `components/coach/trends/InlineNudgeCallout.tsx`

- [ ] **Step 1: Write the component**

```tsx
"use client";

import { useActiveNudges } from "@/lib/query/hooks/useActiveNudges";
import {
  CALLOUT_AMBER_BG,
  CALLOUT_AMBER_BORDER,
  CALLOUT_AMBER_FG,
  CALLOUT_GREEN_BG,
  CALLOUT_GREEN_BORDER,
  CALLOUT_GREEN_FG,
} from "@/lib/coach/nutrition-intelligence/thresholds";

type Variant = "warn" | "ok";

export function InlineNudgeCallout({
  userId,
  triggerKey,
  variant = "warn",
  title,
  body,
}: {
  userId: string;
  /** Exact trigger_key or trigger_key prefix (e.g. "monotone_protein"). */
  triggerKey: string;
  variant?: Variant;
  title: string;
  body: string;
}) {
  const { data: nudges } = useActiveNudges(userId);
  if (!nudges) return null;

  const active = nudges.some((n) =>
    n.trigger_key === triggerKey || n.trigger_key.startsWith(`${triggerKey}:`),
  );
  if (!active) return null;

  const palette = variant === "ok"
    ? { bg: CALLOUT_GREEN_BG, border: CALLOUT_GREEN_BORDER, fg: CALLOUT_GREEN_FG }
    : { bg: CALLOUT_AMBER_BG, border: CALLOUT_AMBER_BORDER, fg: CALLOUT_AMBER_FG };

  return (
    <div
      style={{
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: 6,
        padding: "8px 10px",
        marginTop: 6,
        fontSize: 10,
        color: palette.fg,
        lineHeight: 1.5,
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 10 }}>{title}</div>
      <div style={{ marginTop: 2 }}>{body}</div>
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add components/coach/trends/InlineNudgeCallout.tsx
git commit -m "$(cat <<'EOF'
feat(coach): InlineNudgeCallout — card-level decoration tied to dedup

Reads proactive_nudge_dedup via useActiveNudges. Renders nothing when
no matching trigger_key (exact or prefix) is in the 7d window. Amber
default; green for 'ok'-severity nudges like recomp_success.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: BodySection.tsx

**Files:**
- Create: `components/coach/trends/BodySection.tsx`

- [ ] **Step 1: Write the section**

```tsx
"use client";

import { Card, SectionLabel } from "@/components/ui/Card";
import { SpeakerChip } from "@/components/chat/SpeakerChip";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { CoachTrendsPayload } from "@/lib/data/types";
import { SectionSubHeader } from "./SectionSubHeader";
import { InlineNudgeCallout } from "./InlineNudgeCallout";

export function BodySection({
  body,
  userId,
}: {
  body: CoachTrendsPayload["body"];
  userId: string;
}) {
  const bandText = `${body.weight.target_band.lower} to ${body.weight.target_band.upper} kg/wk`;
  const inBandColor =
    body.weight.in_band === true  ? "#16a34a" :
    body.weight.in_band === false ? "#dc2626" :
                                    COLOR.textMuted;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <SectionSubHeader label="Body" />
        <SpeakerChip speaker="nora" size="sm" />
      </div>

      {/* Recomp banner — rendered only when recomp_success dedup row is active. */}
      <InlineNudgeCallout
        userId={userId}
        triggerKey="recomp_success"
        variant="ok"
        title="↑ Recomp signal — keep this"
        body={
          body.lbm.delta_4w_kg != null && body.body_fat_pct.delta_4w_pct != null
            ? `LBM ${body.lbm.delta_4w_kg > 0 ? "+" : ""}${fmtNum(body.lbm.delta_4w_kg)} kg, body fat ${body.body_fat_pct.delta_4w_pct > 0 ? "+" : ""}${fmtNum(body.body_fat_pct.delta_4w_pct)} pts over 4w.`
            : "Lean mass up and body fat down over 4 weeks."
        }
      />

      <Card>
        <SectionLabel>WEIGHT</SectionLabel>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
          {body.weight.now_kg != null ? `${fmtNum(body.weight.now_kg)} kg` : "n/a"}
        </div>
        <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
          4w rate: <span style={{ color: inBandColor, fontWeight: 600 }}>
            {body.weight.rate_kg_per_wk_4w != null
              ? `${body.weight.rate_kg_per_wk_4w > 0 ? "+" : ""}${fmtNum(body.weight.rate_kg_per_wk_4w)} kg/wk`
              : "n/a"}
          </span> · target band {bandText}
        </div>

        <InlineNudgeCallout
          userId={userId}
          triggerKey="recomp_drift"
          variant="warn"
          title="Recomp drifting wrong way"
          body="Scale flat over 4 weeks but body fat ticked up. Worth checking deficit depth and protein floor."
        />
      </Card>

      <Card>
        <SectionLabel>LBM</SectionLabel>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
          {body.lbm.now_kg != null ? `${fmtNum(body.lbm.now_kg)} kg` : "n/a"}
        </div>
        <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
          Δ4w {body.lbm.delta_4w_kg != null ? `${body.lbm.delta_4w_kg > 0 ? "+" : ""}${fmtNum(body.lbm.delta_4w_kg)} kg` : "n/a"} ·
          Δ12w {body.lbm.delta_12w_kg != null ? `${body.lbm.delta_12w_kg > 0 ? "+" : ""}${fmtNum(body.lbm.delta_12w_kg)} kg` : "n/a"}
        </div>
      </Card>

      <Card>
        <SectionLabel>BODY FAT %</SectionLabel>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
          {body.body_fat_pct.now != null ? `${fmtNum(body.body_fat_pct.now)}%` : "n/a"}
        </div>
        <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
          Δ4w {body.body_fat_pct.delta_4w_pct != null ? `${body.body_fat_pct.delta_4w_pct > 0 ? "+" : ""}${fmtNum(body.body_fat_pct.delta_4w_pct)} pts` : "n/a"} ·
          Δ12w {body.body_fat_pct.delta_12w_pct != null ? `${body.body_fat_pct.delta_12w_pct > 0 ? "+" : ""}${fmtNum(body.body_fat_pct.delta_12w_pct)} pts` : "n/a"}
        </div>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add components/coach/trends/BodySection.tsx
git commit -m "$(cat <<'EOF'
feat(coach): BodySection — weight + LBM + BF% with recomp callouts

InlineNudgeCallout decorates the Weight card (recomp_drift) and renders
as a top-of-section banner (recomp_success). Cards mirror the existing
CompositionSection styling — preserves visual continuity during the split.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: NutritionSection.tsx — Adherence + By-meal-slot blocks

**Files:**
- Create: `components/coach/trends/NutritionSection.tsx`

- [ ] **Step 1: Write the section with the top two blocks**

```tsx
"use client";

import { Card, SectionLabel } from "@/components/ui/Card";
import { SpeakerChip } from "@/components/chat/SpeakerChip";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { CoachTrendsPayload } from "@/lib/data/types";
import type { MealSlot } from "@/lib/food/types";
import { SectionSubHeader } from "./SectionSubHeader";
import { InlineNudgeCallout } from "./InlineNudgeCallout";

const SLOT_ORDER: MealSlot[] = ["breakfast", "lunch", "dinner", "snack"];
const SLOT_LABEL: Record<MealSlot, string> = {
  breakfast: "Brkfst", lunch: "Lunch", dinner: "Dinner", snack: "Snack",
};

export function NutritionSection({
  nutrition,
  foodQuality,
  userId,
}: {
  nutrition: CoachTrendsPayload["nutrition"];
  foodQuality: CoachTrendsPayload["food_quality"];
  userId: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <SectionSubHeader label="Nutrition" />
        <SpeakerChip speaker="nora" size="sm" />
      </div>

      {/* ── Adherence block ─────────────────────────────────────────────── */}
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: COLOR.textMuted, marginTop: 8 }}>
        Adherence
      </div>

      <Card>
        <SectionLabel>PROTEIN ADHERENCE</SectionLabel>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
          {nutrition.protein.pct_4w != null ? `${fmtNum(nutrition.protein.pct_4w * 100)}%` : "n/a"} · 4w
        </div>
        <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
          {nutrition.protein.days_hit_4w}/{nutrition.protein.days_total_4w} days hit target ({nutrition.protein.target_g ?? "n/a"}g)
        </div>
        <InlineNudgeCallout
          userId={userId}
          triggerKey="protein_under"
          variant="warn"
          title="Protein under target too often"
          body="Hit rate has dropped below 60% over the last week."
        />
        <InlineNudgeCallout
          userId={userId}
          triggerKey="glp1_protein_floor"
          variant="warn"
          title="GLP-1 protein floor missed"
          body="Protein has come in under 1.8 g/kg on at least 3 of the last 5 days."
        />
      </Card>

      <Card>
        <SectionLabel>KCAL ADHERENCE</SectionLabel>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
          {nutrition.kcal.pct_4w != null ? `${fmtNum(nutrition.kcal.pct_4w * 100)}%` : "n/a"} · 4w
        </div>
        <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
          {nutrition.kcal.days_hit_4w}/{nutrition.kcal.days_total_4w} days within ±5% of {nutrition.kcal.target ?? "n/a"} kcal target
        </div>
      </Card>

      <Card>
        <SectionLabel>DEFICIT MAGNITUDE</SectionLabel>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
          {nutrition.deficit_kcal.avg_4w != null ? `${nutrition.deficit_kcal.avg_4w > 0 ? "+" : ""}${fmtNum(nutrition.deficit_kcal.avg_4w)} kcal/day` : "n/a"}
        </div>
        <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
          4w average vs target. Negative = deficit; positive = surplus.
        </div>
      </Card>

      {/* ── By-meal-slot block ──────────────────────────────────────────── */}
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: COLOR.textMuted, marginTop: 14, paddingTop: 8, borderTop: "1px dashed #e5e7eb" }}>
        By meal slot · 14d avg
      </div>

      <Card>
        <SectionLabel>PROTEIN PER SLOT</SectionLabel>
        {SLOT_ORDER.map((slot) => {
          const cell = nutrition.per_meal_slot.protein_g[slot];
          const pct = cell.pct_of_target;
          const width = pct != null ? Math.max(2, Math.min(100, pct * 100)) : 0;
          return (
            <div key={slot} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
              <span style={{ fontSize: 10, width: 50, color: COLOR.textMuted }}>{SLOT_LABEL[slot]}</span>
              <span style={{ flex: 1, height: 8, background: "#f3f4f6", borderRadius: 4, overflow: "hidden" }}>
                <span style={{ display: "block", height: "100%", width: `${width}%`, background: "#3b82f6", borderRadius: 4 }} />
              </span>
              <span style={{ fontSize: 10, color: COLOR.textMuted, width: 70, textAlign: "right" }}>
                {cell.avg_14d != null ? `${fmtNum(cell.avg_14d)}g` : "—"}
                {pct != null ? ` · ${fmtNum(pct * 100)}%` : ""}
              </span>
            </div>
          );
        })}
      </Card>

      <Card>
        <SectionLabel>KCAL PER SLOT</SectionLabel>
        {SLOT_ORDER.map((slot) => {
          const cell = nutrition.per_meal_slot.kcal[slot];
          const pct = cell.pct_of_target;
          const width = pct != null ? Math.max(2, Math.min(120, pct * 100)) : 0;
          const targetMarker = cell.target_kcal != null && cell.avg_14d != null && cell.target_kcal > 0
            ? Math.min(100, (cell.target_kcal / Math.max(cell.target_kcal, cell.avg_14d, 1)) * 100)
            : null;
          return (
            <div key={slot} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
              <span style={{ fontSize: 10, width: 50, color: COLOR.textMuted }}>{SLOT_LABEL[slot]}</span>
              <span style={{ flex: 1, height: 8, background: "#f3f4f6", borderRadius: 4, overflow: "hidden", position: "relative" }}>
                <span style={{ display: "block", height: "100%", width: `${width}%`, background: "#f59e0b", borderRadius: 4 }} />
                {targetMarker != null && (
                  <span style={{ position: "absolute", top: -2, left: `${targetMarker}%`, width: 1.5, height: 12, background: COLOR.textStrong }} />
                )}
              </span>
              <span style={{ fontSize: 10, color: COLOR.textMuted, width: 80, textAlign: "right" }}>
                {cell.avg_14d != null ? `${Math.round(cell.avg_14d)}` : "—"}
                {cell.target_kcal != null ? ` / ${cell.target_kcal}` : ""}
              </span>
            </div>
          );
        })}
        <InlineNudgeCallout
          userId={userId}
          triggerKey="training_day_undereat"
          variant="warn"
          title="Undereating on lift days"
          body="Kcal has come in 300+ under target on at least half of recent lift days."
        />
      </Card>

      {/* Food-quality block is appended in Task 13 (kept here as a placeholder
          for now — Task 13 replaces this comment with the four cards). */}
      <NutritionFoodQuality foodQuality={foodQuality} userId={userId} />
    </div>
  );
}

// Stub — Task 13 implements this.
function NutritionFoodQuality(props: { foodQuality: CoachTrendsPayload["food_quality"]; userId: string }) {
  return null;
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add components/coach/trends/NutritionSection.tsx
git commit -m "$(cat <<'EOF'
feat(coach): NutritionSection — Adherence + By-meal-slot blocks

Mirrors existing CompositionSection's nutrition cards. Adds protein-per-slot
and kcal-per-slot bars with target tick mark. Food-quality block stubbed
for next task. InlineNudgeCallout decorations on protein adherence card
(protein_under, glp1_protein_floor) and kcal-per-slot card (training_day_undereat).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: NutritionSection.tsx — Food quality block

**Files:**
- Modify: `components/coach/trends/NutritionSection.tsx`

- [ ] **Step 1: Replace the `NutritionFoodQuality` stub with the implementation**

Replace the `function NutritionFoodQuality` stub with:

```tsx
const PROTEIN_LEGEND_LABEL: Record<string, string> = {
  poultry: "Poultry", red_meat: "Red meat", fish_seafood: "Fish + seafood",
  eggs: "Eggs", dairy_protein: "Dairy", plant_protein: "Plant",
  protein_supplement: "Supplement", mixed: "Mixed", unknown: "Other",
};
const PROTEIN_LEGEND_COLOR: Record<string, string> = {
  poultry: "#b45309", red_meat: "#dc2626", fish_seafood: "#2563eb",
  eggs: "#f59e0b", dairy_protein: "#84cc16", plant_protein: "#10b981",
  protein_supplement: "#a855f7", mixed: "#6b7280", unknown: "#9ca3af",
};
const CARB_LEGEND_LABEL: Record<string, string> = {
  whole_grain: "Whole grain", refined_grain: "Refined grain",
  starchy_veg: "Starchy veg", non_starchy_veg: "Veg",
  fruit: "Fruit", legume: "Legume", sugar_sweets: "Sweets", unknown: "Other",
};
const CARB_LEGEND_COLOR: Record<string, string> = {
  whole_grain: "#92400e", refined_grain: "#d97706", starchy_veg: "#16a34a",
  non_starchy_veg: "#65a30d", fruit: "#ec4899", legume: "#84cc16",
  sugar_sweets: "#6b7280", unknown: "#9ca3af",
};
const METHOD_LEGEND_LABEL: Record<string, string> = {
  grilled: "Grilled", baked: "Baked", pan_fried: "Pan-fried",
  deep_fried: "Deep-fried", air_fried: "Air-fried", steamed: "Steamed",
  boiled: "Boiled", roasted: "Roasted", raw: "Raw", smoked: "Smoked", unknown: "Other",
};
const METHOD_LEGEND_COLOR: Record<string, string> = {
  grilled: "#16a34a", baked: "#84cc16", pan_fried: "#f59e0b",
  deep_fried: "#dc2626", air_fried: "#fbbf24", steamed: "#06b6d4",
  boiled: "#6366f1", roasted: "#a16207", raw: "#9ca3af", smoked: "#737373", unknown: "#d1d5db",
};

function NutritionFoodQuality({
  foodQuality,
  userId,
}: {
  foodQuality: CoachTrendsPayload["food_quality"];
  userId: string;
}) {
  return (
    <>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: COLOR.textMuted, marginTop: 14, paddingTop: 8, borderTop: "1px dashed #e5e7eb" }}>
        Food quality · last {foodQuality.window_days}d
      </div>

      <Card>
        <SectionLabel>PROTEIN SOURCES BY GRAMS</SectionLabel>
        <StackedBar
          segments={foodQuality.protein_sources.map((s) => ({
            label: PROTEIN_LEGEND_LABEL[s.category] ?? s.category,
            color: PROTEIN_LEGEND_COLOR[s.category] ?? "#9ca3af",
            pct:   s.pct,
            grams: s.grams,
          }))}
        />
        <InlineNudgeCallout
          userId={userId}
          triggerKey="monotone_protein"
          variant="warn"
          title="Protein is monotone"
          body="One source is dominating last 2 weeks. Mix in fish and red meat for variety."
        />
      </Card>

      <Card>
        <SectionLabel>CARB SOURCES BY GRAMS</SectionLabel>
        <StackedBar
          segments={foodQuality.carb_sources.map((s) => ({
            label: CARB_LEGEND_LABEL[s.category] ?? s.category,
            color: CARB_LEGEND_COLOR[s.category] ?? "#9ca3af",
            pct:   s.pct,
            grams: s.grams,
          }))}
        />
      </Card>

      <Card>
        <SectionLabel>COOKING METHOD MIX</SectionLabel>
        <CookingDonut methods={foodQuality.cooking_methods} />
        <div style={{ fontSize: 10, color: COLOR.textMuted, marginTop: 6 }}>
          {fmtNum(foodQuality.data_completeness.cooking_method_inferable_pct * 100)}% of items had inferable method.
        </div>
        <InlineNudgeCallout
          userId={userId}
          triggerKey="fried_heavy"
          variant="warn"
          title="Frying-heavy mix"
          body="Pan-fried + deep-fried items are 40%+ of recent meals. Try swapping the top offenders for grilled or air-fried."
        />
      </Card>

      <Card>
        <SectionLabel>DIET DIVERSITY</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 6 }}>
          <Stat n={foodQuality.diversity.distinct_items} label="Distinct items" />
          <Stat n={fmtNum(foodQuality.diversity.fish_meals_per_week)} label="Fish / week" />
          <Stat n={fmtNum(foodQuality.diversity.veg_servings_per_day)} label="Veg / day" />
        </div>
      </Card>
    </>
  );
}

function StackedBar({
  segments,
}: {
  segments: Array<{ label: string; color: string; pct: number; grams: number }>;
}) {
  return (
    <>
      <div style={{ display: "flex", height: 18, borderRadius: 4, overflow: "hidden", margin: "8px 0 4px", background: "#f3f4f6" }}>
        {segments.map((s) => s.pct > 0 && (
          <div
            key={s.label}
            title={`${s.label}: ${Math.round(s.grams)}g · ${fmtNum(s.pct * 100)}%`}
            style={{
              width: `${s.pct * 100}%`,
              background: s.color,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 9, fontWeight: 600, color: "#fff",
            }}
          >
            {s.pct >= 0.06 ? `${Math.round(s.pct * 100)}%` : ""}
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 8px", fontSize: 9, color: "#4b5563", marginTop: 6 }}>
        {segments.map((s) => (
          <div key={s.label}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, marginRight: 4, background: s.color, verticalAlign: "middle" }} />
            {s.label} · {Math.round(s.grams)}g
          </div>
        ))}
      </div>
    </>
  );
}

function CookingDonut({ methods }: { methods: CoachTrendsPayload["food_quality"]["cooking_methods"] }) {
  if (methods.length === 0) {
    return <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 6 }}>No cooking-method data yet.</div>;
  }
  let acc = 0;
  const stops: string[] = [];
  for (const m of methods) {
    const start = acc;
    acc += m.pct;
    const color = METHOD_LEGEND_COLOR[m.method] ?? "#9ca3af";
    stops.push(`${color} ${(start * 100).toFixed(2)}% ${(acc * 100).toFixed(2)}%`);
  }
  const conic = `conic-gradient(${stops.join(", ")})`;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
      <div style={{ width: 60, height: 60, borderRadius: "50%", background: conic, flexShrink: 0 }} />
      <div style={{ fontSize: 9, color: "#4b5563", lineHeight: 1.6 }}>
        {methods.map((m) => (
          <div key={m.method}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", marginRight: 4, background: METHOD_LEGEND_COLOR[m.method] ?? "#9ca3af", verticalAlign: "middle" }} />
            {METHOD_LEGEND_LABEL[m.method] ?? m.method} {fmtNum(m.pct * 100)}%
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ n, label }: { n: number | string; label: string }) {
  return (
    <div style={{ textAlign: "center", padding: "6px 4px", background: "#f9fafb", borderRadius: 6 }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: COLOR.textStrong }}>{n}</div>
      <div style={{ fontSize: 9, color: COLOR.textMuted, lineHeight: 1.3, marginTop: 2 }}>{label}</div>
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add components/coach/trends/NutritionSection.tsx
git commit -m "$(cat <<'EOF'
feat(coach): food-quality block in NutritionSection

Protein sources stacked bar, carb sources stacked bar, cooking method
donut, diet diversity 3-stat grid. Inline nudge callouts on protein
(monotone_protein) and cooking (fried_heavy) cards.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Update `SectionPills` from 3 to 4 pills

**Files:**
- Modify: `components/coach/trends/SectionPills.tsx`

- [ ] **Step 1: Replace the type + render**

```tsx
"use client";

import { COLOR } from "@/lib/ui/theme";

export type TrendsSection = "performance" | "body" | "nutrition" | "cross";

const SECTIONS: Array<{ key: TrendsSection; label: string }> = [
  { key: "performance", label: "Performance" },
  { key: "body",        label: "Body" },
  { key: "nutrition",   label: "Nutrition" },
  { key: "cross",       label: "Cross" },
];

export function SectionPills({
  active,
  onChange,
}: {
  active: TrendsSection;
  onChange: (section: TrendsSection) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 6, padding: "8px 12px", overflowX: "auto" }}>
      {SECTIONS.map((s) => (
        <button
          key={s.key}
          onClick={() => onChange(s.key)}
          style={{
            padding: "4px 10px",
            fontSize: 11,
            fontWeight: 600,
            borderRadius: 999,
            background: active === s.key ? COLOR.textStrong : "#f3f4f6",
            color:      active === s.key ? "#fff"         : COLOR.textMuted,
            border: `1px solid ${active === s.key ? COLOR.textStrong : "#d1d5db"}`,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: `CoachTrendsView.tsx` errors because it switches on `"composition"`. Next task fixes.

- [ ] **Step 3: Commit**

```bash
git add components/coach/trends/SectionPills.tsx
git commit -m "$(cat <<'EOF'
feat(coach): split SectionPills — performance/body/nutrition/cross

TrendsSection union drops 'composition', adds 'body' and 'nutrition'.
overflowX:auto ensures the 4 pills fit on narrow viewports.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Rewire `CoachTrendsView` + add server-side `composition→body` redirect + delete `CompositionSection`

**Files:**
- Modify: `components/coach/trends/CoachTrendsView.tsx`
- Modify: `app/metrics/page.tsx`
- Delete: `components/coach/trends/CompositionSection.tsx`

- [ ] **Step 1: Update `CoachTrendsView.tsx`**

Replace the existing body:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useCoachTrends } from "@/lib/query/hooks/useCoachTrends";
import { CHAT, COLOR } from "@/lib/ui/theme";
import { formatHeaderDate } from "@/lib/time";
import { SectionPills, type TrendsSection } from "./SectionPills";
import { TrendsHeader } from "./TrendsHeader";
import { PerformanceSection } from "./PerformanceSection";
import { BodySection } from "./BodySection";
import { NutritionSection } from "./NutritionSection";
import { CrossSection } from "./CrossSection";

export function CoachTrendsView({
  userId,
  initialSection,
}: {
  userId: string;
  initialSection: TrendsSection;
}) {
  const router = useRouter();
  const [activeSection, setActiveSection] = useState<TrendsSection>(initialSection);
  const { data: payload } = useCoachTrends(userId);

  if (!payload) return null;

  return (
    <div
      style={{
        maxWidth: CHAT.feedMaxWidth,
        margin: "0 auto",
        minHeight: "100dvh",
        color: COLOR.textStrong,
      }}
    >
      <header style={{ padding: "12px 16px 8px" }}>
        <div style={{ fontSize: 12, color: COLOR.textMuted, fontWeight: 500 }}>
          {formatHeaderDate()}
        </div>
        <h1
          style={{
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: "-0.02em",
            color: COLOR.textStrong,
            margin: "2px 0 0",
          }}
        >
          Trends
        </h1>
      </header>

      <SectionPills
        active={activeSection}
        onChange={(s) => {
          setActiveSection(s);
          const url = new URL(window.location.href);
          url.searchParams.set("section", s);
          router.replace(url.pathname + "?" + url.searchParams.toString(), { scroll: false });
        }}
      />

      <div style={{ padding: "0 12px 24px", display: "flex", flexDirection: "column", gap: 10 }}>
        <TrendsHeader headline={payload.headline} />
        {activeSection === "performance" && (
          <PerformanceSection strength={payload.strength} recovery={payload.recovery} />
        )}
        {activeSection === "body" && (
          <BodySection body={payload.body} userId={userId} />
        )}
        {activeSection === "nutrition" && (
          <NutritionSection
            nutrition={payload.nutrition}
            foodQuality={payload.food_quality}
            userId={userId}
          />
        )}
        {activeSection === "cross" && <CrossSection insights={payload.cross_insights} />}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add `composition→body` redirect in `app/metrics/page.tsx`**

Find where the page reads `searchParams.section`. Before passing it to children, normalize:

```ts
// In the page server component, after pulling searchParams:
const rawSection = (searchParams.section as string | undefined) ?? "performance";
const section: TrendsSection =
  rawSection === "composition" ? "body" :
  (["performance", "body", "nutrition", "cross"].includes(rawSection)
    ? (rawSection as TrendsSection)
    : "performance");
```

Pass `section` (not `rawSection`) into `MetricsClient`'s `initialSection`.

If `MetricsClient` is currently hardcoded to `initialSection="performance"` (per the file inspected during brainstorm), update it to accept and use `initialSection: TrendsSection` props and thread it through.

- [ ] **Step 3: Delete the legacy `CompositionSection.tsx`**

```bash
git rm components/coach/trends/CompositionSection.tsx
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Manual smoke test**

```
npm run dev
```

Visit `http://localhost:3000/metrics`. Click each pill — Performance, Body, Nutrition, Cross. Verify:

- Body pill shows weight / LBM / BF% cards. If recomp_success has fired recently, the green banner appears at the top.
- Nutrition pill shows Adherence block + By-meal-slot block + Food quality block (4 cards: protein sources, carb sources, cooking donut, diversity).
- `?section=composition` in the URL redirects/displays as Body.
- Headline strip continues to render at top regardless of section.

- [ ] **Step 6: Commit**

```bash
git add components/coach/trends/CoachTrendsView.tsx app/metrics/page.tsx components/metrics/MetricsClient.tsx
git rm components/coach/trends/CompositionSection.tsx
git commit -m "$(cat <<'EOF'
feat(coach): split Composition pill → Body + Nutrition

CoachTrendsView routes the 4 sections; SectionPills already has the new
union. ?section=composition URLs redirect to ?section=body in the page
server component to preserve in-flight links. CompositionSection.tsx is
gone — BodySection + NutritionSection replace it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**End of Phase 1.** The trends view ships independently of Phase 2 — the inline callouts simply never render because no new dedup rows exist yet.

---

## Phase 2 — Proactive triggers (Nora's intelligence)

### Task 16: `check-recomp.ts`

**Files:**
- Create: `lib/coach/proactive/check-recomp.ts`

- [ ] **Step 1: Write the check**

```ts
// lib/coach/proactive/check-recomp.ts
//
// Two events from one check, mutually-exclusive shape but not mutually-
// exclusive firing (rare case: LBM up + BF% up = "drift" wins, success
// requires both up-and-down).

import type { CoachTrendsPayload, ProactiveEvent } from "@/lib/data/types";
import {
  RECOMP_SUCCESS_LBM_DELTA_KG,
  RECOMP_SUCCESS_BF_DELTA_PTS,
  RECOMP_DRIFT_WEIGHT_TOL_KG,
  RECOMP_DRIFT_BF_DELTA_PTS,
} from "@/lib/coach/nutrition-intelligence/thresholds";

export function checkRecomp(trends: CoachTrendsPayload): ProactiveEvent[] {
  const events: ProactiveEvent[] = [];
  const lbm4w = trends.body.lbm.delta_4w_kg;
  const bf4w  = trends.body.body_fat_pct.delta_4w_pct;
  const wRate = trends.body.weight.rate_kg_per_wk_4w;

  // Success: LBM up AND BF% down over 4 weeks.
  if (
    lbm4w != null && lbm4w >= RECOMP_SUCCESS_LBM_DELTA_KG &&
    bf4w  != null && bf4w  <= RECOMP_SUCCESS_BF_DELTA_PTS
  ) {
    events.push({
      trigger_type: "recomp_success",
      trigger_key: "recomp_success",
      payload: { lbm_delta_4w_kg: lbm4w, bf_delta_4w_pts: bf4w },
    });
    return events;
  }

  // Drift: scale roughly flat over 4w (rate × 4 within ±0.3kg), BF% up.
  if (
    wRate != null && Math.abs(wRate * 4) <= RECOMP_DRIFT_WEIGHT_TOL_KG &&
    bf4w  != null && bf4w  >= RECOMP_DRIFT_BF_DELTA_PTS
  ) {
    events.push({
      trigger_type: "recomp_drift",
      trigger_key: "recomp_drift",
      payload: {
        weight_rate_kg_per_wk_4w: wRate,
        bf_delta_4w_pts: bf4w,
        weight_change_4w_kg: wRate * 4,
      },
    });
  }
  return events;
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/proactive/check-recomp.ts
git commit -m "$(cat <<'EOF'
feat(coach): check-recomp — recomp_success + recomp_drift triggers

Single check file emits the positive (LBM+, BF%-) and negative (scale
flat, BF%+) recomposition signals. Success short-circuits drift — they
shouldn't both fire on the same window.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: `check-protein-floor.ts`

**Files:**
- Create: `lib/coach/proactive/check-protein-floor.ts`

- [ ] **Step 1: Write the check**

```ts
// lib/coach/proactive/check-protein-floor.ts
//
// Two triggers, mutually exclusive:
//   - GLP-1 active mode → glp1_protein_floor (higher threshold 1.8 g/kg,
//     5-day window, fires on 3+ misses).
//   - Otherwise → protein_under (60% hit rate over last 7 logged days).
// Reads profiles.glp1_status to pick the branch.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoachTrendsPayload, ProactiveEvent } from "@/lib/data/types";
import {
  PROTEIN_UNDER_HIT_RATE,
  PROTEIN_UNDER_MIN_LOGGED,
  GLP1_PROTEIN_FLOOR_G_PER_KG,
  GLP1_PROTEIN_MISS_DAYS,
} from "@/lib/coach/nutrition-intelligence/thresholds";

export async function checkProteinFloor(
  trends: CoachTrendsPayload,
  args: { supabase: SupabaseClient; userId: string; today: string },
): Promise<ProactiveEvent[]> {
  const events: ProactiveEvent[] = [];
  const { supabase, userId, today } = args;

  // Pull current GLP-1 status from profiles.
  const { data: profile } = await supabase
    .from("profiles")
    .select("glp1_status, weight_kg")
    .eq("id", userId)
    .maybeSingle();
  const glp1Status = (profile as { glp1_status?: string } | null)?.glp1_status ?? "none";
  const bw = (profile as { weight_kg?: number | null } | null)?.weight_kg ?? null;

  if (glp1Status === "active" && bw != null && bw > 0) {
    // GLP-1 active branch — fetch last 5 days of daily_logs.protein_g.
    const fiveAgo = shiftDays(today, -5);
    const { data: logs } = await supabase
      .from("daily_logs")
      .select("date, protein_g")
      .eq("user_id", userId)
      .gte("date", fiveAgo)
      .lte("date", today)
      .order("date", { ascending: true });
    const floor = GLP1_PROTEIN_FLOOR_G_PER_KG * bw;
    let misses = 0;
    let observed = 0;
    for (const r of (logs as Array<{ protein_g: number | null }> | null) ?? []) {
      if (r.protein_g == null) continue;
      observed += 1;
      if (r.protein_g < floor) misses += 1;
    }
    if (misses >= GLP1_PROTEIN_MISS_DAYS) {
      events.push({
        trigger_type: "glp1_protein_floor",
        trigger_key: "glp1_protein_floor",
        payload: { misses, observed, floor_g: floor, bw_kg: bw },
      });
    }
    return events;
  }

  // Classical branch — derive 7d hit rate from trends.nutrition.protein.
  // The payload already carries 4w hit-rate; we need a tighter 7d cut.
  const proteinTarget = trends.nutrition.protein.target_g;
  if (proteinTarget == null) return events;

  const sevenAgo = shiftDays(today, -7);
  const { data: logs7 } = await supabase
    .from("daily_logs")
    .select("date, protein_g")
    .eq("user_id", userId)
    .gte("date", sevenAgo)
    .lte("date", today);
  let logged = 0;
  let hit = 0;
  for (const r of (logs7 as Array<{ protein_g: number | null }> | null) ?? []) {
    if (r.protein_g == null) continue;
    logged += 1;
    if (r.protein_g >= proteinTarget) hit += 1;
  }
  if (logged < PROTEIN_UNDER_MIN_LOGGED) return events;
  const rate = hit / logged;
  if (rate < PROTEIN_UNDER_HIT_RATE) {
    events.push({
      trigger_type: "protein_under",
      trigger_key: "protein_under",
      payload: { hit, logged, hit_rate: rate, target_g: proteinTarget },
    });
  }
  return events;
}

function shiftDays(d: string, days: number): string {
  const dt = new Date(`${d}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/proactive/check-protein-floor.ts
git commit -m "$(cat <<'EOF'
feat(coach): check-protein-floor — GLP-1 vs classical mutual exclusion

Single file reads profiles.glp1_status and branches: active → 1.8 g/kg
floor over 5d (3+ misses); otherwise → 60% hit-rate floor over 7d. Two
triggers, one threshold story.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 18: `check-monotone-protein.ts`

**Files:**
- Create: `lib/coach/proactive/check-monotone-protein.ts`

- [ ] **Step 1: Write the check**

```ts
// lib/coach/proactive/check-monotone-protein.ts
//
// Fires when a single protein source carries ≥70% of the classified
// protein-grams over the last 14 days, with a min-volume gate.

import type { CoachTrendsPayload, ProactiveEvent } from "@/lib/data/types";
import {
  MONOTONE_PROTEIN_SHARE_THRESHOLD,
  QUALITY_MIN_CLASSIFIED_ITEMS,
} from "@/lib/coach/nutrition-intelligence/thresholds";

export function checkMonotoneProtein(trends: CoachTrendsPayload): ProactiveEvent[] {
  if (trends.food_quality.total_items < QUALITY_MIN_CLASSIFIED_ITEMS) return [];
  const sources = trends.food_quality.protein_sources;
  if (sources.length === 0) return [];
  const top = sources[0];
  if (top.pct < MONOTONE_PROTEIN_SHARE_THRESHOLD) return [];
  if (top.category === "unknown") return [];
  return [{
    trigger_type: "monotone_protein",
    trigger_key: "monotone_protein",
    payload: {
      dominant_category: top.category,
      dominant_pct: top.pct,
      dominant_grams: top.grams,
      total_items: trends.food_quality.total_items,
    },
  }];
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/proactive/check-monotone-protein.ts
git commit -m "$(cat <<'EOF'
feat(coach): check-monotone-protein trigger

Fires when one protein category ≥70% of classified protein-g over 14d
with ≥30 classified items. Reads pre-computed food_quality payload.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 19: `check-fried-heavy.ts`

**Files:**
- Create: `lib/coach/proactive/check-fried-heavy.ts`

- [ ] **Step 1: Write the check**

```ts
// lib/coach/proactive/check-fried-heavy.ts
//
// Fires when (pan_fried + deep_fried) / classified-method-items ≥ 40%
// over the last 14 days. min-item gate via QUALITY_MIN_CLASSIFIED_ITEMS.

import type { CoachTrendsPayload, ProactiveEvent } from "@/lib/data/types";
import {
  FRIED_HEAVY_SHARE_THRESHOLD,
  QUALITY_MIN_CLASSIFIED_ITEMS,
} from "@/lib/coach/nutrition-intelligence/thresholds";

export function checkFriedHeavy(trends: CoachTrendsPayload): ProactiveEvent[] {
  if (trends.food_quality.total_items < QUALITY_MIN_CLASSIFIED_ITEMS) return [];
  const methods = trends.food_quality.cooking_methods;
  let friedPct = 0;
  for (const m of methods) {
    if (m.method === "pan_fried" || m.method === "deep_fried") friedPct += m.pct;
  }
  if (friedPct < FRIED_HEAVY_SHARE_THRESHOLD) return [];
  return [{
    trigger_type: "fried_heavy",
    trigger_key: "fried_heavy",
    payload: {
      fried_pct: friedPct,
      pan_pct: methods.find((m) => m.method === "pan_fried")?.pct ?? 0,
      deep_pct: methods.find((m) => m.method === "deep_fried")?.pct ?? 0,
      total_items: trends.food_quality.total_items,
    },
  }];
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/proactive/check-fried-heavy.ts
git commit -m "$(cat <<'EOF'
feat(coach): check-fried-heavy trigger

Fires when pan_fried + deep_fried ≥ 40% of known-method items over 14d.
Payload carries the split so Nora can quote both numbers in chat.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 20: `check-training-undereat.ts`

**Files:**
- Create: `lib/coach/proactive/check-training-undereat.ts`

- [ ] **Step 1: Write the check**

```ts
// lib/coach/proactive/check-training-undereat.ts
//
// Joins workouts × daily_logs over the last 28 days. A "lift day" is any
// date with a non-empty workout row. Undereating = kcal eaten on that
// date < (kcal_target − 300). Fires when ratio of undereating lift days
// over total lift days ≥ 0.50 AND total lift days ≥ 6.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoachTrendsPayload, ProactiveEvent } from "@/lib/data/types";
import {
  TRAINING_UNDEREAT_KCAL_GAP,
  TRAINING_UNDEREAT_HIT_RATIO,
  TRAINING_UNDEREAT_MIN_DAYS,
} from "@/lib/coach/nutrition-intelligence/thresholds";

export async function checkTrainingUndereat(
  trends: CoachTrendsPayload,
  args: { supabase: SupabaseClient; userId: string; today: string },
): Promise<ProactiveEvent[]> {
  const { supabase, userId, today } = args;
  const target = trends.nutrition.kcal.target;
  if (target == null) return [];

  const fourAgo = shiftDays(today, -28);

  // 1. Lift days = distinct workout dates with at least one non-empty session.
  const { data: workouts } = await supabase
    .from("workouts")
    .select("date")
    .eq("user_id", userId)
    .gte("date", fourAgo)
    .lte("date", today);
  const liftDates = new Set<string>(
    ((workouts as Array<{ date: string }> | null) ?? []).map((w) => w.date),
  );
  if (liftDates.size < TRAINING_UNDEREAT_MIN_DAYS) return [];

  // 2. Pull daily_logs for those dates only.
  const { data: logs } = await supabase
    .from("daily_logs")
    .select("date, calories_eaten")
    .eq("user_id", userId)
    .in("date", [...liftDates]);

  let undereatCount = 0;
  let observed = 0;
  for (const r of (logs as Array<{ date: string; calories_eaten: number | null }> | null) ?? []) {
    if (r.calories_eaten == null) continue;
    observed += 1;
    if (r.calories_eaten < target - TRAINING_UNDEREAT_KCAL_GAP) undereatCount += 1;
  }
  if (observed < TRAINING_UNDEREAT_MIN_DAYS) return [];
  const ratio = undereatCount / observed;
  if (ratio < TRAINING_UNDEREAT_HIT_RATIO) return [];

  return [{
    trigger_type: "training_day_undereat",
    trigger_key: "training_day_undereat",
    payload: {
      undereat_count: undereatCount,
      lift_days_observed: observed,
      ratio,
      kcal_target: target,
      gap_kcal: TRAINING_UNDEREAT_KCAL_GAP,
    },
  }];
}

function shiftDays(d: string, days: number): string {
  const dt = new Date(`${d}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/proactive/check-training-undereat.ts
git commit -m "$(cat <<'EOF'
feat(coach): check-training-undereat — workouts × daily_logs join

Server-side join inside the cron function — no new Nora chat tool.
Fires when ≥50% of last 28d lift days came in 300+ kcal under target,
with min 6 lift days observed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 21: Wire `TRIGGER_OWNER` + new checks into `proactive/index.ts`

**Files:**
- Modify: `lib/coach/proactive/index.ts`

- [ ] **Step 1: Update the TRIGGER_OWNER map and the event collection**

Find the `TRIGGER_OWNER` constant and extend:

```ts
const TRIGGER_OWNER: Record<string, Speaker> = {
  plateau: "carter",
  off_pace_weight: "nora",
  hrv_below_baseline: "remi",
  // NEW — all Nora.
  recomp_success:        "nora",
  recomp_drift:          "nora",
  protein_under:         "nora",
  glp1_protein_floor:    "nora",
  monotone_protein:      "nora",
  fried_heavy:           "nora",
  training_day_undereat: "nora",
};
```

Find the existing event-collection step (`const events: ProactiveEvent[] = [ ...checkPlateau(trends), ... ]`). Replace with:

```ts
import { checkRecomp }            from "./check-recomp";
import { checkProteinFloor }      from "./check-protein-floor";
import { checkMonotoneProtein }   from "./check-monotone-protein";
import { checkFriedHeavy }        from "./check-fried-heavy";
import { checkTrainingUndereat }  from "./check-training-undereat";

// ... inside runProactiveChecks, replacing the existing events array build:
const events: ProactiveEvent[] = [
  ...checkPlateau(trends),
  ...checkOffPace(trends),
  ...checkHrv(trends),
  ...checkRecomp(trends),
  ...await checkProteinFloor(trends, { supabase, userId, today }),
  ...checkMonotoneProtein(trends),
  ...checkFriedHeavy(trends),
  ...await checkTrainingUndereat(trends, { supabase, userId, today }),
];
```

- [ ] **Step 2: Adjust the chat_messages insert to allow non-warn severity**

Find where the chat_messages row is inserted with `severity: "warn"` literal. Replace with `card.severity` (pulled from the rendered card — Task 22 fills the `severity` field).

If the existing insert doesn't pass severity (it currently relies on `card.severity` already, having been widened in Task 4), no change needed here.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: still errors in `render-card.ts` (Task 22 fixes).

- [ ] **Step 4: Commit**

```bash
git add lib/coach/proactive/index.ts
git commit -m "$(cat <<'EOF'
feat(coach): wire 5 new Nora checks into runProactiveChecks

TRIGGER_OWNER maps all 7 new keys to Nora. checkProteinFloor and
checkTrainingUndereat are async (they fetch profiles / workouts);
recomp/monotone-protein/fried-heavy stay pure synchronous.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 22: Extend `render-card.ts` with 7 new card templates

**Files:**
- Modify: `lib/coach/proactive/render-card.ts`

- [ ] **Step 1: Add a render function per new trigger and wire the switch**

Locate the `switch (event.trigger_type)` in `renderCard`. Extend:

```ts
export function renderCard(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  switch (event.trigger_type) {
    case "plateau":              return renderPlateau(event, ctx);
    case "off_pace_weight":      return renderOffPace(event, ctx);
    case "hrv_below_baseline":   return renderHrv(event, ctx);
    case "recomp_success":       return renderRecompSuccess(event, ctx);
    case "recomp_drift":         return renderRecompDrift(event, ctx);
    case "protein_under":        return renderProteinUnder(event, ctx);
    case "glp1_protein_floor":   return renderGlp1ProteinFloor(event, ctx);
    case "monotone_protein":     return renderMonotoneProtein(event, ctx);
    case "fried_heavy":          return renderFriedHeavy(event, ctx);
    case "training_day_undereat":return renderTrainingUndereat(event, ctx);
  }
}
```

Append the seven render functions (each picks one variant via `pickVariant` for voice rotation):

```ts
function renderRecompSuccess(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const lbm = event.payload.lbm_delta_4w_kg as number;
  const bf  = event.payload.bf_delta_4w_pts as number;
  const variants = [
    `LBM up ${fmt1(lbm)} kg, body fat down ${fmt1(Math.abs(bf))} pts over 4 weeks. Keep the lever where it is.`,
    `Composition is moving the right way — +${fmt1(lbm)} kg lean, −${fmt1(Math.abs(bf))} pts fat in 4w. Whatever you changed, keep it.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: "recomp_success", today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1,
    trigger_type: "recomp_success",
    trigger_key: "recomp_success",
    severity: "ok",
    headline: "Recomp working — keep this",
    body_md: variants[idx],
    deep_link: { label: "View Body trends", href: "/metrics?section=body" },
    speaker: "nora",
  };
}

function renderRecompDrift(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const bf = event.payload.bf_delta_4w_pts as number;
  const variants = [
    `Scale is roughly flat over 4 weeks, but body fat ticked up ${fmt1(bf)} pts. Deficit isn't deep enough at maintenance protein.`,
    `4-week weight is flat — but BF% climbed ${fmt1(bf)} pts. The scale lies; the tape doesn't.`,
  ];
  const idx = pickVariant({ userId: ctx?.userId ?? "", triggerKey: "recomp_drift", today: ctx?.today ?? "", count: variants.length });
  return {
    schema_version: 1,
    trigger_type: "recomp_drift",
    trigger_key: "recomp_drift",
    severity: "warn",
    headline: "Recomp drifting wrong way",
    body_md: variants[idx],
    deep_link: { label: "View Body trends", href: "/metrics?section=body" },
    speaker: "nora",
  };
}

function renderProteinUnder(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const hit = event.payload.hit as number;
  const logged = event.payload.logged as number;
  const target = event.payload.target_g as number;
  return {
    schema_version: 1,
    trigger_type: "protein_under",
    trigger_key: "protein_under",
    severity: "warn",
    headline: "Protein under target too often",
    body_md: `You hit your ${target}g target on ${hit} of the last ${logged} logged days. Two days of front-loading breakfast usually closes the gap.`,
    deep_link: { label: "View Nutrition trends", href: "/metrics?section=nutrition" },
    speaker: "nora",
  };
}

function renderGlp1ProteinFloor(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const misses = event.payload.misses as number;
  const observed = event.payload.observed as number;
  const floor = event.payload.floor_g as number;
  return {
    schema_version: 1,
    trigger_type: "glp1_protein_floor",
    trigger_key: "glp1_protein_floor",
    severity: "warn",
    headline: "Protein floor missed on your protocol",
    body_md: `On your current protocol the floor is ${Math.round(floor)} g — you came in under that on ${misses} of the last ${observed} logged days. LBM protection drops fast below floor.`,
    deep_link: { label: "View Nutrition trends", href: "/metrics?section=nutrition" },
    speaker: "nora",
  };
}

function renderMonotoneProtein(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const cat = event.payload.dominant_category as string;
  const pct = event.payload.dominant_pct as number;
  const labelMap: Record<string, string> = {
    poultry: "poultry", red_meat: "red meat", fish_seafood: "fish",
    eggs: "eggs", dairy_protein: "dairy", plant_protein: "plant protein",
    protein_supplement: "protein supplement",
  };
  const human = labelMap[cat] ?? cat;
  return {
    schema_version: 1,
    trigger_type: "monotone_protein",
    trigger_key: "monotone_protein",
    severity: "info",
    headline: "Protein has gone monotone",
    body_md: `${human} is ${Math.round(pct * 100)}% of your protein over the last 2 weeks. Cycling in fish (omega-3) and red meat (iron) covers gaps a single source can't.`,
    deep_link: { label: "View Nutrition trends", href: "/metrics?section=nutrition" },
    speaker: "nora",
  };
}

function renderFriedHeavy(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const pct = event.payload.fried_pct as number;
  return {
    schema_version: 1,
    trigger_type: "fried_heavy",
    trigger_key: "fried_heavy",
    severity: "info",
    headline: "Frying-heavy mix lately",
    body_md: `${Math.round(pct * 100)}% of items with a known cooking method were pan-fried or deep-fried over the last 2 weeks. Swapping the top 2-3 to grilled or air-fried trims hidden fat kcal at the same macros.`,
    deep_link: { label: "View Nutrition trends", href: "/metrics?section=nutrition" },
    speaker: "nora",
  };
}

function renderTrainingUndereat(event: ProactiveEvent, ctx?: RenderContext): ProactiveNudgeCard {
  const under = event.payload.undereat_count as number;
  const total = event.payload.lift_days_observed as number;
  return {
    schema_version: 1,
    trigger_type: "training_day_undereat",
    trigger_key: "training_day_undereat",
    severity: "warn",
    headline: "Undereating on lift days",
    body_md: `On ${under} of the last ${total} lift days you came in 300+ kcal under target. That's why dinner ends up protein-heavy — a 200 kcal pre-lift snack fixes most of it.`,
    deep_link: { label: "View Nutrition trends", href: "/metrics?section=nutrition" },
    speaker: "nora",
  };
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: clean across the repo.

- [ ] **Step 3: Commit**

```bash
git add lib/coach/proactive/render-card.ts
git commit -m "$(cat <<'EOF'
feat(coach): render templates for 7 new Nora proactive cards

Each card carries speaker:'nora', a domain-appropriate deep_link
(?section=body | ?section=nutrition), and Nora's warm-but-technical voice
per the spec. recomp_success uses severity:'ok'; monotone/fried use
severity:'info'; the rest are 'warn'.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 23: `/api/coach/proactive/check` route — no code change, integration confirmation

**Files:**
- Read-only inspection: `app/api/coach/proactive/check/route.ts`

- [ ] **Step 1: Inspect the route handler**

Open the file and confirm the existing logic:
1. Calls `generateCoachTrends({ supabase, userId, today })`.
2. Passes the resulting payload into `runProactiveChecks({ supabase, userId, trends, dry_run })`.

`runProactiveChecks` is the function we extended in Task 21. The route handler itself needs no change because all new checks are wired inside `runProactiveChecks`.

If the route is passing `today` into `runProactiveChecks` explicitly, ensure the new `checkProteinFloor` and `checkTrainingUndereat` receive `today` too (Task 21 already wires `today: today` through — confirm here).

- [ ] **Step 2: Smoke test the cron route locally**

```bash
npm run dev
# In a second terminal:
curl -X POST 'http://localhost:3000/api/coach/proactive/check' \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"dry_run": true, "user_id": "<your-uuid>"}'
```

Expected: 200 OK with a JSON body listing `fired` events. The response should include events from the new checks if your data crosses the thresholds. For users below the data thresholds, the response is `{ "fired": [], "suppressed": [...] }` and that's fine.

- [ ] **Step 3: If any wiring change was required, commit. Otherwise skip.**

```bash
# Only if you needed to thread today/userId through the route handler:
git add app/api/coach/proactive/check/route.ts
git commit -m "$(cat <<'EOF'
fix(coach): pass today through to async check functions in cron route

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 24: Extend `scripts/audit-proactive-cron.mjs`

**Files:**
- Modify: `scripts/audit-proactive-cron.mjs`

- [ ] **Step 1: Add new trigger keys to the script's allowlist**

Open the script and find the keyword-cue heuristic / trigger-key list (per CLAUDE.md, the audit script flags potential mis-routings). Add the 7 new trigger keys to whatever set it iterates over so dry-run output renders correctly:

```js
// Add to the existing trigger_key list (search for "off_pace_weight"):
const KNOWN_KEYS = [
  "plateau",
  "off_pace_weight",
  "hrv_below_baseline",
  "recomp_success",
  "recomp_drift",
  "protein_under",
  "glp1_protein_floor",
  "monotone_protein",
  "fried_heavy",
  "training_day_undereat",
];
```

If the script has a section dumping last-N proactive_nudge rows, no schema change is needed — the new triggers write the same row shape.

- [ ] **Step 2: Run the script**

```bash
AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs \
  --experimental-strip-types --env-file=.env.local \
  scripts/audit-proactive-cron.mjs
```

Expected: outputs a `dry_run` of `runProactiveChecks`. Every event listed should belong to one of the 10 KNOWN_KEYS. Any unknown key → fix here (likely a render-card switch fall-through from Task 22).

- [ ] **Step 3: Commit**

```bash
git add scripts/audit-proactive-cron.mjs
git commit -m "$(cat <<'EOF'
chore(scripts): audit-proactive-cron knows about 7 new Nora triggers

Adds recomp_*, protein_under, glp1_protein_floor, monotone_protein,
fried_heavy, training_day_undereat to KNOWN_KEYS. Smoke-tests the cron
end-to-end before the daily 11:00 UTC fire.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 25: End-to-end smoke + memory update

- [ ] **Step 1: Manual end-to-end exercise**

```bash
npm run dev
```

In dev:

1. Trigger the cron locally (Task 23's curl) with `dry_run=false` against your own user_id (only if you've already verified the dry run is clean and the cards look right). Cards will write to `chat_messages` and a row to `proactive_nudge_dedup`.
2. Open `/coach` and confirm a new card appeared in Nora's thread (it should — owner is "nora" for every new trigger).
3. Open `/metrics` and click through Performance / Body / Nutrition / Cross. The matching `InlineNudgeCallout` should now render on the relevant card.
4. Re-trigger the cron — verify dedup blocks the same triggers from firing again (response should show them under `suppressed`).

- [ ] **Step 2: Update auto-memory**

Save a project memory noting this sub-project shipped: file `project_nutrition_trends_nora_intel_shipped.md` linked from `MEMORY.md`. Note the trigger names and the location of the spec.

- [ ] **Step 3: Final commit (memory note only, optional)**

If you updated `~/.claude/projects/.../memory/MEMORY.md`, no repo commit is needed — auto-memory is host-side.

---

## Self-review

**Spec coverage:** ✅
- §"Architecture / classifier" → Tasks 1-3
- §"Architecture / composer" → Task 5
- §"Extended payload" → Task 4 (+ Task 6 for per_meal_slot)
- §"Trends compute orchestrator" → Task 7
- §"UI" → Tasks 9-15
- §"Proactive triggers" + threshold table → Tasks 16-21
- §"Nora's chat voice" → Task 22
- §"Cron wiring" → Task 23
- §"Testing strategy" + audit script → Tasks 8, 24
- §"Build sequence" → Phase 1 / Phase 2 split mirrors the spec.

**Placeholder scan:** None. Every step contains the file path, the code, the verification command, the commit message.

**Type consistency:** `FoodQualityTrend`, `ProteinCategory`, `CarbCategory`, `CookingMethod`, the 7 new `ProactiveTriggerType` values, and the per-meal-slot block names are defined in Task 4 and consumed identically in Tasks 5, 6, 7, 10, 11, 12, 13, 16-22.

**Sequencing:** Task 4 (types) deliberately leaves `lib/coach/trends/index.ts` and `render-card.ts` in error state until Tasks 7 and 22 close them. The plan calls out the expected error state at each step so an executing engineer doesn't panic mid-flight.

---

Plan ready.
