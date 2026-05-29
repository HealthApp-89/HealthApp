# Nora Suggestion Engine — Design

**Date**: 2026-05-29
**Status**: Design — ready for implementation plan
**Owner**: Abdelouahed
**Related**: meal logging chat revamp ([2026-05-21](2026-05-21-meal-logging-chat-revamp-design.md)), nutrition trends + Nora intelligence ([2026-05-23](2026-05-23-nutrition-trends-nora-intelligence-design.md)), Peter dashboard ([2026-05-24](2026-05-24-peter-dashboard-design.md))

## 1. Background

Now that in-app food logging is the primary path (Yazio short-circuit shipped, `food_log_entries` is the source of truth for nutrition columns on `daily_logs`) and the Nutrition view on `/diet?view=nutrition` carries 14-day food-quality classification + 4w/12w adherence trends, Nora has the data shape to do real coaching — but her current prompt does not lean on it.

Today Nora reacts: she answers "what did I eat yesterday" with `query_food_log`, she runs `propose_meal_log` when the athlete states a meal. She does not anticipate, suggest, plan, or learn from history. The intel layer ([lib/coach/nutrition-intelligence/](../../lib/coach/nutrition-intelligence/), [lib/coach/trends/compose-nutrition.ts](../../lib/coach/trends/compose-nutrition.ts), [lib/coach/proactive/check-monotone-protein.ts](../../lib/coach/proactive/check-monotone-protein.ts) etc.) is built but only feeds cards from the daily cron — not Nora's in-chat behavior.

The athlete's ask: Nora should analyze what they eat across the week, suggest meals + alternatives **grounded in what they actually like and don't violate hard exclusions** (pork, allergens, etc.), and notice recipe patterns in their log to save as one-tap re-logs.

## 2. Goals

- Nora suggests meals via tappable cards (1-tap = log), not prose.
- Every suggestion is grounded in the athlete's 90-day eating history (frequent items, frequent combos, slot patterns, monotone signals).
- Hard dietary exclusions (religious, allergen, medical) are enforced deterministically — never possible for Nora to suggest pork to a Muslim athlete.
- Variety pressure is detected and addressed via familiar-but-different recombinations, not novel foods.
- Co-occurrence patterns in the log surface as one-tap "save as recipe" nudges.
- Forward planning (what to eat next, given remaining macros) and recipe discovery (combos from history) fall out of the same engine.

## 3. Non-goals

- Full AI generation of meal options (rejected: hallucination risk for exclusions; loses determinism). Engine is rule-based; AI is only used for the *prose framing* of cards (and only for that line; the engine output drives the data).
- Generating recipes from outside the athlete's repertoire by default. Tier 3 (adjacent substitution) is gated on explicit "give me something different" intent.
- Structured category columns on `user_food_items` (`protein_category`, `carb_category`). Deferred to v2 — name-token classification is sufficient until audit shows otherwise.
- Photo / voice suggestion modalities. v1 is chat text only.
- Per-day automatic suggestion cards at meal times (proactive "lunch in 30 min, here's three options"). Deferred to v2 — v1 is reactive only (athlete asks).
- Cross-meal planning ("here's a 7-day meal plan"). v1 is per-meal suggestions; weekly plans are Peter / weekly-review territory.

## 4. Architecture overview

```
                  Daily cron (03:30 UTC)
                          │
                          ▼
      lib/coach/nora-suggestions/compose-eating-identity.ts
            (90-day rollup → EatingIdentity payload)
                          │
                          ▼
                profiles.eating_identity_cache
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
        ▼                 ▼                 ▼
  Nora snapshot      Suggestion       Recipe-discovery
  prefix (compact)   engine           cron (03:45 UTC)
                     (suggest-meal.ts)
                          │                 │
                          ▼                 ▼
                 propose_meal_      proactive_nudge
                 suggestions tool   (kind='save_recipe')
                          │                 │
                          ▼                 ▼
                 Chat card with     Save-recipe card
                 pre-issued HMAC    with 1-tap save
                 tokens; 1-tap log
```

All composers are pure functions. The engine is deterministic. AI is not in the critical path of suggestion content.

## 5. Section 1 — Data layer: structured exclusions

### 5.1 Migration 0037

```sql
ALTER TABLE profiles
  ADD COLUMN dietary_exclusions jsonb NOT NULL
    DEFAULT '{"tags": [], "free_text": null, "version": 1}'::jsonb,
  ADD COLUMN eating_identity_cache jsonb;

-- Shape comments for grep-ability:
-- dietary_exclusions: { tags: ExclusionTag[], free_text: string | null, version: 1 }
-- eating_identity_cache: EatingIdentity (see §6.1) — nullable; cron-populated.
```

### 5.2 Closed tag vocabulary (v1)

```
pork, shellfish, alcohol, gluten, dairy, eggs, peanuts, tree_nuts,
soy, red_meat, all_meat, fish
```

`caffeine_late` and similar time-of-day rules are NOT in the v1 closed vocabulary — they're context-dependent (slot + time, not food class) and belong in `free_text` for v1. v2 may add a separate `time_rules` jsonb if usage justifies it.

Each tag has a deterministic predicate in `lib/coach/nora-suggestions/exclusions.ts` (name regex + USDA category subset). Free-text is advisory — Nora reads it; the engine does not filter on it.

### 5.3 Profile UI

New section on `/profile` between "Nutrition baseline" and "Sleep baseline":
- Multi-select tag chips (the v1 vocabulary above).
- Free-text textarea for nuance ("no raw fish", "limit dairy at night").
- "Save" → `PATCH /api/profile/dietary-exclusions` (body: `{ tags, free_text }`).

### 5.4 Backfill

One-shot script `scripts/migrate-exclusions.mjs`:
- Walks `profiles` rows where `dietary_exclusions.tags = []`.
- Reads `athlete_profile_documents` (latest acknowledged version) → `intake.nutrition.restrictions` + `intake.health.allergies`.
- Runs regex parser over the free-text fields to infer tags.
- Writes inferred `tags` array; leaves original free-text fields untouched.
- Idempotent. Reports per-user diff for review.

Athlete sees the parsed result on their next `/profile` visit and confirms.

## 6. Section 2 — EatingIdentity composer

### 6.1 Output shape

```ts
type EatingIdentity = {
  generated_on: string;            // ISO date
  window_days: 90;

  top_items: Array<{
    canonical_name: string;        // e.g. "chicken breast" (normalized)
    name_variants: string[];       // ["grilled chicken breast", "chicken breast cooked", ...]
    source: 'user_library' | 'db' | 'llm';
    library_item_id?: string;      // when source === 'user_library'
    log_count: number;
    typical_qty_g: number;         // median across logs
    macros_per_100g: { kcal, protein_g, carbs_g, fat_g, fiber_g };
    slot_distribution: Record<MealSlot, number>;
    last_logged: string;           // ISO date
  }>;

  protein_category_counts: Record<ProteinCategory, number>;
  carb_category_counts: Record<CarbCategory, number>;
  cooking_method_counts: Record<CookingMethod, number>;

  slot_patterns: Record<MealSlot, {
    typical_kcal_avg: number;
    typical_protein_g_avg: number;
    top_items: string[];           // canonical names, top 5 at this slot
  }>;

  frequent_combos: Array<{
    items: string[];               // canonical names, 2-4 items
    co_occurrence_count: number;   // across meals in the window
    last_seen: string;             // ISO date
    avg_slot: MealSlot;            // most common slot
  }>;

  monotone_flags: {
    protein_top_share: number;     // 0..1, top protein category's share of logged meals
    carb_top_share: number;
    most_repeated_meal: { items: string[]; count: number } | null;
  };
};
```

### 6.2 Name canonicalization

`canonicalizeItemName(name: string): string` — strips cooking-method tokens (`grilled`, `roasted`, `boiled`, `steamed`, `fried`, `baked`) and prep modifiers (`cooked`, `raw`, `chopped`, `sliced`, `diced`, `whole`) before frequency counting. Implementation reuses the token lists already in [lib/coach/nutrition-intelligence/word-lists.ts](../../lib/coach/nutrition-intelligence/word-lists.ts).

### 6.3 Library + recipe handling

The composer queries both `food_db_cache` AND `user_food_items`:

- **Single library items** (`composite_of IS NULL`): use the library row's canonical name (not user-typed variant) for grouping. Classifier falls back to name-token (`classify.ts`) since library rows carry no USDA category — same path as today.
- **Library recipes** (`composite_of IS NOT NULL`): for `top_items`, the recipe appears as one row with `log_count = N`. For category counts (`protein_category_counts` etc.), expand `composite_of` and **add ONE proportional vote per component** with weight `component.qty_g / total_qty_g`. This prevents a 3-component recipe from triple-counting against a single-item meal.

### 6.4 Meal grouping for co-occurrence

Entries within the same `(date, meal_slot)` AND within `±90 min` of `eaten_at` count as **one meal**. Combos are counted at meal-granularity, not entry-granularity.

Pairs (2 items) and trios (3 items) only. 4-tuples are noise at this dataset size (~5 logs/day × 90 days = 450 entries; 4-tuple co-occurrence ≥ 4 is statistically rare and the engine doesn't benefit from them).

Recipes treated as atomic in combo detection: a combo containing "Sunday Bowl" (a recipe) is "Sunday Bowl + side", not the recipe's internals.

### 6.5 Caching

- Daily cron `/api/coach/eating-identity/sync` at **03:30 UTC**, `CRON_SECRET`-gated. Walks `profiles` rows, writes `eating_identity_cache`. Idempotent.
- Suggestion engine reads cache. If `generated_on` is > 48h stale, engine triggers inline rebuild and continues (suggestion latency hit but suggestion still served).
- `food_commit` invalidates cache (sets `generated_on` to NULL) when the new commit's items would change a `top_items` rank — heuristic: any logged item whose post-commit count crosses a frequency threshold (3, 5, 10).

### 6.6 Audit script

`scripts/audit-eating-identity.mjs` for `AUDIT_USER_ID`:
- Prints top 20 items, top 10 combos, monotone flags.
- Flags items where `name_variants.length > 5` (canonicalizer leaking variants).
- Reports unknown-share (logged items that fell through both USDA and name-token to `unknown`), broken down by source. > 15% triggers a follow-up review.

## 7. Section 3 — Suggestion engine

### 7.1 Module

`lib/coach/nora-suggestions/suggest-meal.ts`. Pure function. Deterministic.

```ts
suggestMeal({
  userId, slot, count,             // count: 2-4 (default 3)
  eatingIdentity, exclusions,
  remainingMacros,                 // today's targets − today's already-logged
  slotTargets,                     // per-slot kcal/protein from getTodayTargets
  preferNovelty: boolean,          // default false
}): SuggestEngineOutput
```

### 7.2 Three-tier candidate generation

- **Tier 1 — repertoire**: `eatingIdentity.frequent_combos` matching this slot + `user_food_items` recipes with `log_count ≥ 2` at this slot.
- **Tier 2 — recombination of familiar parts**: entered only if tier-1 supply `< count` OR `monotone_flags.protein_top_share > 0.6`. Top-3 proteins × top-3 carbs × top-3 sides at this slot, all components with `log_count ≥ 3`.
- **Tier 3 — adjacent substitution**: entered only when `preferNovelty: true`. Swap one component for a sibling in the same protein/carb category that passes exclusions and has `log_count ≥ 1` in the athlete's repertoire.

Tier 1 fills first; 2/3 only top up.

### 7.3 Hard exclusion filter

`exclusions.ts` exports `passesExclusions(items: Item[], tags: ExclusionTag[]): boolean`. Predicates table:

```ts
const EXCLUSION_PREDICATES: Record<ExclusionTag, (item: Item) => boolean> = {
  pork:       (it) => !/\b(pork|bacon|ham|prosciutto|chorizo|pancetta|jam[oó]n|salami|sausage)\b/i.test(it.name)
                      && !(usdaCategoryOf(it) ?? "").match(/^(Pork|Sausages and Luncheon)/),
  shellfish:  (it) => !/\b(shrimp|prawn|lobster|crab|mussels?|oysters?|clams?|scallops?|crayfish)\b/i.test(it.name),
  alcohol:    (it) => !/\b(wine|beer|whisk(e)?y|vodka|rum|gin|tequila|champagne|prosecco|cocktail|spirits?)\b/i.test(it.name),
  gluten:     (it) => !/\b(wheat|barley|rye|bread|pasta|noodles?|couscous|bulgur|semolina|farro)\b/i.test(it.name),
  dairy:      (it) => !/\b(milk|cheese|yogurt|yoghurt|butter|cream|whey|casein|kefir)\b/i.test(it.name),
  eggs:       (it) => !/\beggs?\b/i.test(it.name),
  peanuts:    (it) => !/\bpeanuts?\b/i.test(it.name),
  tree_nuts:  (it) => !/\b(almonds?|walnuts?|cashews?|pistachios?|hazelnuts?|pecans?|brazil nuts?|macadamia)\b/i.test(it.name),
  soy:        (it) => !/\b(soy|tofu|tempeh|edamame|miso)\b/i.test(it.name),
  red_meat:   (it) => !/\b(beef|lamb|venison|bison)\b/i.test(it.name),
  all_meat:   (it) => !/\b(chicken|turkey|beef|lamb|pork|fish|salmon|tuna|sardines?|bacon|ham|sausage|venison|duck)\b/i.test(it.name),
  fish:       (it) => !/\b(fish|salmon|tuna|sardines?|cod|haddock|mackerel|trout|halibut|anchov(y|ies))\b/i.test(it.name),
};
```

Composite recipes: every component must pass. Any component failure → recipe drops. No partial-suggestion mode in v1.

If all candidates fail → engine returns `{ suggestions: [], error: 'exclusions_exhausted', context }`. Nora's tool surfaces this in prose with ONE specific relaxation suggestion.

### 7.4 Scoring

```
score = macro_fit × (0.5 + 0.5 × familiarity) × (1 + 0.3 × variety_boost) × slot_fit
```

| Factor | Range | Formula |
|---|---|---|
| `macro_fit` | 0..1 | `1 − Σ|cand.macro − remaining.macro| / remaining.macro`, clamped. Protein weighted 2×, kcal 1×, carbs/fat 0.5×. |
| `familiarity` | 0..1 | Tier 1 → 1.0. Tier 2 → mean component log_count / max top_item log_count. Tier 3 → 0.4. |
| `variety_boost` | 0..1 | Boost when candidate's primary protein category was logged in < 20% of last 14 days. `0` when `monotone_top_share < 0.5` (no variety pressure). |
| `slot_fit` | 0..1 | `1 − |cand.kcal − slot_typical_kcal| / slot_typical_kcal`, clamped. |

Familiarity floor `0.5` ensures tier-2 candidates can win on macros while tier-1 edges out ties.

### 7.5 Rationale strings (deterministic templates)

Selected by dominant score factor:
- `slot_fit` dominant → `"Same shape as your typical {slot} (~{kcal} kcal)"`
- `familiarity` dominant → `"Your usual {protein} + {carb} combo"`
- `variety_boost` dominant → `"Mixes up your protein — {top_protein} {N}/{denom} {window} days"`
- `macro_fit` dominant → `"Lighter carb to keep protein on track ({protein_remaining}g left)"`

Templates in `lib/coach/nora-suggestions/rationale.ts`.

### 7.6 Engine output

```ts
type SuggestEngineOutput = {
  suggestions: MealSuggestion[];   // length === count when no error
  context: {
    remaining_macros_for_day: { kcal, protein_g, carbs_g, fat_g };
    slot_target: { kcal, protein_g };
    monotone_signal: { protein_top: string; share: number } | null;
  };
  filter_stats: {
    tier1_candidates: number;
    after_exclusion: number;
    surfaced: number;
  };
  error?: 'exclusions_exhausted' | 'no_history';
};

type MealSuggestion = {
  rank: number;
  source: 'library_recipe' | 'frequent_combo' | 'slot_pattern_recombination' | 'adjacent_substitution';
  source_ref?: { library_item_id?: string; combo_signature?: string };
  items: Array<{
    name: string;
    qty_g: number;
    per_100g: { kcal, protein_g, carbs_g, fat_g, fiber_g };
    library_item_id?: string;
  }>;
  total_macros: { kcal, protein_g, carbs_g, fat_g, fiber_g };
  macro_delta_vs_remaining: {
    kcal: number;
    protein_g: number;
    fits_slot: boolean;            // |total.kcal − slot_target.kcal| ≤ 20%
  };
  rationale: string;               // template result
  scores: { macro_fit, familiarity, variety_boost, slot_fit, final };
};
```

### 7.7 Audit script

`scripts/audit-suggest-meal.mjs` for `AUDIT_USER_ID`:
- Dry-runs the engine for each slot for today.
- Prints top 5 candidates per slot with full score breakdown.
- Asserts every surfaced item passes the exclusion filter.
- Asserts `tier1_candidates >= surfaced` when `monotone_top_share < 0.6` (tier-1 saturation invariant).

## 8. Section 4 — Tool, card, log flow, prompt updates

### 8.1 `propose_meal_suggestions` tool

```ts
{
  name: "propose_meal_suggestions",
  description: "Generate 2-3 meal options for a slot, grounded in the athlete's eating identity, with hard exclusions enforced. Returns a card; each option is one-tap loggable via pre-issued HMAC token.",
  input_schema: {
    slot: MealSlot,                  // required
    count: { type: "number", min: 2, max: 4, default: 3 },
    prefer_novelty: { type: "boolean", default: false },
  },
}
```

Server handler in [lib/coach/tools.ts](../../lib/coach/tools.ts):
1. Load `profiles.eating_identity_cache` (rebuild inline if > 48h stale).
2. Load `profiles.dietary_exclusions`.
3. Compute `remainingMacros = getTodayTargets() − query_food_log(today, today).totals`.
4. Call `suggestMeal(...)`.
5. For each surfaced option, mint HMAC approval token via existing `mintApprovalToken({ user_id, action: 'meal_log', payload: { items, meal_slot: slot, eaten_at: now_iso } })`. 24h TTL.
6. Return `{ suggestions, tokens: ApprovalToken[], context, filter_stats, error? }`.

### 8.2 One-tap log flow

Each card option carries its own HMAC token. Tap "Log this" reuses the existing `[approve:<token>]` short-circuit pipeline in [app/api/chat/messages/route.ts:389-436](../../app/api/chat/messages/route.ts):

- Client submits `[approve:<token>]` as a chat message (same shape the Approve chip already uses for `commit_meal_log`).
- Server short-circuits server-side, calls `commit_meal_log({ approval_token: token })` directly without an Anthropic round-trip.
- Validates HMAC + expiry + payload binding.
- Writes `food_log_entries`, auto-saves non-library singles to `user_food_items`, re-aggregates the day. Unchanged from today's commit path.
- **No second Approve chip**: the suggestion card IS the approval surface; the athlete approved by tapping. **No new HTTP endpoint**: reuses the existing chat message + token short-circuit.

Safety: token is scoped to `(user, action, exact payload, expiry)`; exclusions pre-checked by engine; athlete sees full macros + item list before tapping. Same security model as weekly-review's `commit_training_week` tokens and today's `commit_meal_log` from the Approve chip.

### 8.3 Card UI

New component `components/chat/MealSuggestionsCard.tsx`. Dispatcher in [components/chat/ChatThread.tsx](../../components/chat/ChatThread.tsx) extends the existing switch.

Layout:
```
┌─ Nora suggests: dinner ──────────────────┐
│ Your dinner usually lands ~610 kcal.     │
│                                          │
│ ① Mom's tahini bowl    [Log] [Tweak]    │
│    580 kcal · 38P 52C 22F · fiber 12g    │
│    "Your usual — fits today's gap"       │
│                                          │
│ ② Chicken + jasmine rice + greens [Log] │
│    620 kcal · 45P 65C 14F · fiber 8g     │
│    "Mixes carbs from your repertoire"    │
│                                          │
│ ③ Turkey burger bowl + sweet potato [Log]│
│    600 kcal · 42P 58C 18F · fiber 9g     │
│    "Different protein — chicken 5/7"     │
│                                          │
│ [Show different ideas]                   │
└──────────────────────────────────────────┘
```

- **Log** (primary) → one-tap commit via the option's pre-issued token.
- **Tweak** (secondary) → opens `MealLoggerSheet` pre-populated with the option's items for edits, then commits through the sheet's normal flow.
- **Show different ideas** → types "different ideas, please" into the chat input; Nora's prompt teaches her to recognize this and re-call with `prefer_novelty: true`.
- **Exclusions-exhausted state**: single panel with concise message + ONE relaxation offer ("With pork and alcohol off the table and 320 kcal left, I don't have a clean dinner. Want to relax pork for this meal, or aim for a lighter snack?").

### 8.4 Chat-stream wiring (three known landmines)

1. Add `propose_meal_suggestions` to `PERSIST_RESULT_TOOLS` in [lib/coach/chat-stream.ts](../../lib/coach/chat-stream.ts) so the card survives chat reload (gotcha documented in memory).
2. Add explicit allow for `propose_meal_suggestions` in `modeAllowsTool` for `default` AND `meal_log` modes (default-mode blanket-rejects new propose_* tools — gotcha documented in memory).
3. Add to `NORA_TOOLS` in [lib/coach/tools.ts](../../lib/coach/tools.ts).

### 8.5 Snapshot prefix injection (Nora-only)

New helper `lib/coach/nora-suggestions/render-injection.ts`. Reads `profiles.eating_identity_cache`. Emits a compact markdown block (~25 lines) loaded by [app/api/chat/messages/route.ts](../../app/api/chat/messages/route.ts) for Nora-routed turns. Mirrors `lib/coach/peter-dashboard/render-injection.ts`.

Block contents: top-10 items, protein/carb/cooking category counts, monotone_flags, dietary_exclusions tags + free-text.

**Not included**: `frequent_combos` (verbose; engine reads), `slot_patterns` (verbose; engine reads).

### 8.6 NORA_BASE additions

Three new sections appended to [lib/coach/system-prompts.ts](../../lib/coach/system-prompts.ts) `NORA_BASE`:

```
## Eating identity (in your context)

The "Eating identity" block above is a 90-day rollup: which proteins/carbs/cooking
methods the athlete actually eats, their top items, monotone flags, and structured
exclusions. Reference identity facts directly ("you log chicken 5/7 of last week",
"your top breakfast item is overnight oats") without calling query_food_log first.
For deeper "what did I eat on date X" questions, query_food_log is still the source.

## Suggestion flow

When the athlete asks for ideas ("what should I have for dinner", "alternatives to
chicken", "I'm bored of my breakfasts"), call propose_meal_suggestions immediately.
Do not improvise meal names in prose — the engine is what knows the athlete's
repertoire and respects their exclusions.

- "what should I have for {slot}" → propose_meal_suggestions({ slot, count: 3 })
- "different ideas" / "give me variety" → add prefer_novelty: true
- "I'm bored" without a slot → ask which slot, then call
- After the tool returns, one framing sentence is enough — the card shows the options.
  Name the dominant rationale (slot fit / variety / macro fit) and let the card speak.
- If the engine returns exclusions_exhausted, surface it concisely with ONE specific
  relaxation offer ("relax pork for this meal?") — don't recite the full tag list.

NEVER suggest a meal in prose if propose_meal_suggestions would have served the same
request. Prose-only suggestions are non-loggable — every accepted suggestion should be
one tap to log.

## Hard exclusions

dietary_exclusions.tags are structured hard-NOs. The engine enforces them in cards;
YOU never propose an excluded food in prose either. If the athlete explicitly asks
about an excluded food ("can I eat shrimp once?"), defer the decision to them — do
not unilaterally relax. The free_text field captures nuance ("no raw fish") and is
in your context — avoid violating it in prose too.
```

## 9. Section 5 — Recipe discovery

### 9.1 Trigger threshold

A combo from `eating_identity_cache.frequent_combos` qualifies when ALL:
- `co_occurrence_count ≥ 4` in last 30 days.
- `last_seen ≤ 14 days ago`.
- No existing `user_food_items` recipe whose `composite_of` shares ≥ 2 canonical items with the candidate.
- No member is itself a library recipe. Library singles are fine.

### 9.2 Surface — `proactive_nudge` variant

Extend `ProactiveNudgeCard` payload discriminated union with `kind: 'save_recipe'`. Existing rendering pipeline ([components/chat/ProactiveNudgeCard.tsx](../../components/chat/ProactiveNudgeCard.tsx) + [lib/coach/proactive/render-card.ts](../../lib/coach/proactive/render-card.ts)) gains one new branch. No migration; the `chat_messages.kind='proactive_nudge'` row stays the same.

### 9.3 Card UI

```
┌─ Nora noticed ─────────────────────────────┐
│ You've logged chicken + jasmine rice +     │
│ broccoli together 6× in the last 30 days.  │
│                                            │
│ Save as a recipe? 1 tap to log next time.  │
│                                            │
│  Name: [ Training dinner          ]        │
│                                            │
│  Items                                     │
│  • Chicken breast       180 g (median)     │
│  • Jasmine rice         120 g              │
│  • Broccoli             150 g              │
│                                            │
│  Per 100g: 132 kcal · 12P 14C 3F · 1.2g fiber │
│                                            │
│  [Save to library]  [Not this one]         │
└────────────────────────────────────────────┘
```

- **Name suggestion** — template: `"{slot_capitalized} {meal_word}"` with `meal_word ∈ { breakfast: "plate", lunch: "bowl", dinner: "bowl", snack: "bite" }`. Athlete edits before save.
- **Item qty_g** — median from EatingIdentity's `typical_qty_g`.
- **Per-100g macros** — sum components, divide by total qty. Cached on the card so save doesn't recompute.

### 9.4 Save flow

- **Save to library** → POST calls existing `save_to_library` tool with `{ name, composite_of, per_100g, metadata: { source: 'recipe_discovery', combo_signature } }`. Existing duplicate-handling (23505 → was_duplicate: true short-circuit) applies.
- **Not this one** → POST to `/api/chat/nudge-dismiss` → writes `proactive_nudge_dedup` row with `dismissed_at` set → same `trigger_key` blocked for **90 days** (vs. standard 7-day dedup).

### 9.5 Detection cron

New daily cron `/api/coach/recipe-discovery/check` at **03:45 UTC** (after eating-identity sync at 03:30). `CRON_SECRET`-gated.

- Reads `eating_identity_cache.frequent_combos` (no recomputation).
- Applies qualifying filter + dedup lookup against `proactive_nudge_dedup`.
- Writes at most **1 nudge per day** (highest `co_occurrence_count` wins).
- Max **3 recipe-discovery nudges per 30-day window per user** (rate limit checked against `proactive_nudge_dedup` rows where `trigger_key LIKE 'save_recipe:%'`).
- Trigger key: `save_recipe:<sha1(canonical_names_sorted)[:12]>`.

### 9.6 Tight loop — newly-saved recipe wins next slot

When `save_to_library` commits a recipe with `metadata.source = 'recipe_discovery'`, the next `propose_meal_suggestions` call for the same `avg_slot` pins this recipe at rank 1 in tier 1 for **7 days**.

Implementation: soft boost in scoring — `+0.15` to `familiarity` when the candidate's `library_item_id` matches a recipe with `created_at > now() - 7d AND metadata.source = 'recipe_discovery'`.

### 9.7 Audit script

`scripts/audit-recipe-discovery.mjs` for `AUDIT_USER_ID`:
- Prints qualifying combos with full filter trace.
- Reports which dedup rule blocked which combo.
- Reports current 30-day rate-limit consumption.
- Reports pending nudges (would-fire on next cron tick).

Useful during the first 2-3 weeks for tuning threshold.

## 10. Failure modes + handling

| Failure | Detection | Handling |
|---|---|---|
| `eating_identity_cache = NULL` (new user, never synced) | Engine reads NULL | Engine triggers inline rebuild; if zero log history, returns `error: 'no_history'`. Nora's prompt teaches: surface concisely, ask the athlete to log a few meals first. |
| Stale cache (> 48h since sync) | `generated_on` field check | Inline rebuild; suggestion latency hit but continues. |
| Exclusions remove every candidate | `filter_stats.after_exclusion === 0` | Engine returns `error: 'exclusions_exhausted'`; Nora surfaces with one specific relaxation offer. |
| HMAC token expired before tap | `/api/chat/meal-log/commit` returns `code: 'expired'` | Standard expired-token reply (already wired): "That approval expired before it was committed. Tap Approve again to re-issue and commit." Athlete re-asks for suggestions. |
| `propose_meal_suggestions` not in `modeAllowsTool` allow-list (regression) | Tool call narrated in prose with no DB write | Detected by audit-suggest-meal cross-check; quick fix is to add the allow. Memory note: gotcha to verify. |
| Name canonicalizer over-collapses (e.g., "chicken breast" + "chicken thigh" merged) | `name_variants.length > 5` in audit script | Tune token list. Soft failure — affects familiarity-counting accuracy, doesn't break suggestions. |

## 11. Testing plan

- Unit tests on pure modules (canonicalizer, classify expansion, scoring formula, exclusion predicates). Use existing prescription-rules test pattern.
- Engine smoke test: synthetic 90-day log → engine returns suggestions matching expected items/categories/exclusions.
- Audit scripts ([§6.6](#66-audit-script), [§7.7](#77-audit-script), [§9.7](#97-audit-script)) run weekly against real user data for two weeks post-ship.
- `typecheck` must pass.
- Manual: end-to-end on `/coach`: ask Nora "what should I have for dinner" → card surfaces → tap Log → entry appears on `/diet`.

## 12. Migrations + crons summary

| Item | Detail |
|---|---|
| Migration 0037 | `profiles.dietary_exclusions jsonb`, `profiles.eating_identity_cache jsonb` |
| Migration script | `scripts/migrate-exclusions.mjs` (one-shot backfill from athlete profile free-text) |
| Cron | `/api/coach/eating-identity/sync` daily at 03:30 UTC |
| Cron | `/api/coach/recipe-discovery/check` daily at 03:45 UTC |
| Vercel | Update [vercel.json](../../vercel.json) with both crons |

## 13. New tools, modules, components

**Modules** ([lib/coach/nora-suggestions/](../../lib/coach/nora-suggestions/)):
- `compose-eating-identity.ts`
- `exclusions.ts`
- `suggest-meal.ts`
- `rationale.ts`
- `render-injection.ts`
- `recipe-discovery.ts`

**Tool** ([lib/coach/tools.ts](../../lib/coach/tools.ts)):
- `propose_meal_suggestions` (added to `NORA_TOOLS`)

**Routes**:
- `PATCH /api/profile/dietary-exclusions`
- `POST /api/chat/nudge-dismiss` (or extends existing if present)
- `GET /api/coach/eating-identity/sync` (cron)
- `GET /api/coach/recipe-discovery/check` (cron)

No new commit endpoint for one-tap log — reuses the existing `[approve:<token>]` short-circuit in [app/api/chat/messages/route.ts](../../app/api/chat/messages/route.ts).

**Components**:
- `components/chat/MealSuggestionsCard.tsx`
- `components/profile/DietaryExclusionsSection.tsx`
- Extension to [components/chat/ProactiveNudgeCard.tsx](../../components/chat/ProactiveNudgeCard.tsx) for `save_recipe` variant

**Prompt**: NORA_BASE additions (three new sections).

**Audit scripts**:
- `scripts/audit-eating-identity.mjs`
- `scripts/audit-suggest-meal.mjs`
- `scripts/audit-recipe-discovery.mjs`
- `scripts/migrate-exclusions.mjs`

## 14. Open questions

None blocking. Items deferred to v2:
- Structured `protein_category` / `carb_category` columns on `user_food_items` (if audit shows > 15% unknown share).
- Proactive at-meal-time suggestions (push or chat card 30 min before typical slot eaten_at).
- Photo / voice suggestion modalities.
- Multi-day meal planning ("here's a 7-day plan").
- Intra-entry combo detection (single-meal multi-component patterns).

## 15. Memory landmines applied

This design respects:
- `[reference_persist_result_tools]` — `propose_meal_suggestions` added to `PERSIST_RESULT_TOOLS`.
- `[reference_chat_default_mode_tool_gating]` — explicit allow in `modeAllowsTool` for default + meal_log modes.
- `[reference_chat_invocation_cap]` — engine pre-computes everything; one tool call per Nora turn.
- `[reference_daily_logs_calories_int]` — `food_log_entries.totals` writes via existing `commit_meal_log` path, which already rounds.
- `[reference_block_progress_discriminator]`, `[reference_narrator_allow_list_drift]` — n/a (no Peter / weekly-review narrator changes).
- `[feedback_warmup_sets_rule]`, `[feedback_keep_log_tab]` — n/a (training/log tab untouched).

## 16. Estimated scope

- 1 migration
- 6 new pure modules (~150-300 lines each)
- 1 new tool (~50 lines)
- 2 new routes + 2 new cron routes
- 3 new components (~150-250 lines each) + 1 extension
- 1 prompt update
- 4 audit/migration scripts
- ~3-5 PRs likely (data layer / engine / surface / discovery / polish)
