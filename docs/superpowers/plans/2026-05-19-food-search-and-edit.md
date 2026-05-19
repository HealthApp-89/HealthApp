# Food logging: manual search, edit-swap, parser tightening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "AI-or-nothing" food logger with a recovery path (manual search + per-row edit) and tighten the parser so it stops hallucinating brand foods.

**Architecture:** Five phases in dependency order — (A) shared types + scoring utility, (B) parser tightening, (C) `<DraftReview/>` extraction + Edit/Delete affordances, (D) new SEARCH tab with server-side multi-source fanout, (E) confidence chip + change-food picker wiring. Each phase produces a working, committable increment.

**Tech Stack:** Next.js 15 App Router · Supabase (RLS, jsonb columns) · Zod validation · TanStack Query · Anthropic Haiku 4.5 · OpenFoodFacts text-search API · USDA FDC API · Tailwind v4. No test suite — verify with `npm run typecheck` and manual exercise of [/meal](/meal). Conventional Commits style (see recent commits: `feat(coach): ...`).

**Spec:** [docs/superpowers/specs/2026-05-19-food-search-and-edit-design.md](docs/superpowers/specs/2026-05-19-food-search-and-edit-design.md)

---

## File map

### Create

- `lib/food/scoring.ts` — token-overlap scoring shared by USDA, OFF, and SEARCH
- `lib/food/search.ts` — multi-source fanout (cache + OFF + USDA) used by `/api/food/search`
- `app/api/food/search/route.ts` — GET endpoint for manual search
- `app/api/food/draft/route.ts` — POST endpoint for user-picked draft entries
- `components/log/DraftReview.tsx` — shared draft review (extracted from TYPE/SCAN tabs)
- `components/log/FoodSearchPicker.tsx` — reusable search input + candidate list + qty picker
- `components/log/MealLoggerSearchTab.tsx` — new SEARCH tab using the picker + draft endpoint

### Modify

- `lib/food/types.ts` — add `match_score` to `FoodItem`; add `SearchCandidate`; extend `FoodLogEntryRawInput` for `source: 'search'`
- `lib/food/parse.ts` — tighten Haiku prompt
- `lib/food/lookup.ts` — USDA scoring + threshold; add `lookupOpenFoodFacts` text search; propagate `match_score`
- `app/api/food/entries/[id]/route.ts` — extend `ItemSchema` to accept `match_score`
- `components/log/MealLoggerSheet.tsx` — register SEARCH tab between TYPE and SCAN
- `components/log/MealLoggerTypeTab.tsx` — hand off draft to `<DraftReview/>`
- `components/log/MealLoggerScanTab.tsx` — hand off draft to `<DraftReview/>`
- `app/api/food/parse/route.ts` — populate `match_score` on per-item zero-macro fallback (null)
- `app/api/food/barcode/route.ts` — populate `match_score: 1.0` on barcode-resolved item

---

## Phase A — Foundation: types and scoring

### Task 1: Extend type shapes

**Files:**
- Modify: `lib/food/types.ts`

- [ ] **Step 1: Add `match_score` to `FoodItem`**

In `lib/food/types.ts`, change the `FoodItem` type:

```ts
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
  /** Token-overlap score against the resolution query (0..1), or 1.0 for
   *  user-picked items, or null for LLM estimates and pre-existing rows.
   *  Drives the confidence chip in <DraftReview/>. */
  match_score: number | null;
};
```

- [ ] **Step 2: Add `SearchCandidate` type**

Append to `lib/food/types.ts`:

```ts
/** Result row from /api/food/search. Not yet persisted — canonical_id is
 *  null for fresh OFF/USDA hits until the user picks one (caching at pick
 *  time keeps the cache from accumulating rows the user never used). */
export type SearchCandidate = {
  name: string;
  per_100g: FoodMacros;
  source: "db" | "off" | "usda";
  canonical_id: string | null;
  image_url: string | null;
};
```

- [ ] **Step 3: Extend `FoodLogEntryRawInput` for SEARCH source**

Replace the existing `FoodLogEntryRawInput` union in `lib/food/types.ts`:

```ts
export type FoodLogEntryRawInput =
  | { kind: "text"; text: string }
  | { kind: "text"; source: "search"; items: SearchCandidate[]; qty_g: number[] }
  | { kind: "barcode"; upc: string; qty_g: number }
  | { kind: "photo"; photo_path: string }
  | { kind: "voice"; audio_path: string; transcript: string };
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS — `match_score` is optional in jsonb reads (existing rows have no field; TS narrows to `undefined` which we coerce via Zod). New `FoodItem` field will surface type errors in any code that constructs a `FoodItem` literal — those are addressed in later tasks.

If the typecheck fails on `app/api/food/parse/route.ts`, `app/api/food/barcode/route.ts`, or `app/api/food/entries/[id]/route.ts` — that's expected and fixed in Tasks 3, 4, 5, 8. To make this task self-contained, also add the field at the literal sites:

In `app/api/food/parse/route.ts:53-65`, add `match_score: null` to the zero-macro fallback object.

In `app/api/food/barcode/route.ts:37-45`, add `match_score: 1.0` to the `item` literal.

In `app/api/food/entries/[id]/route.ts:15-38`, add to `ItemSchema`:
```ts
match_score: z.number().min(0).max(1).nullable().optional(),
```

Re-run `npm run typecheck` — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/food/types.ts app/api/food/parse/route.ts app/api/food/barcode/route.ts app/api/food/entries/[id]/route.ts
git commit -m "feat(food): add match_score to FoodItem + SearchCandidate type"
```

---

### Task 2: Token-overlap scoring utility

**Files:**
- Create: `lib/food/scoring.ts`

- [ ] **Step 1: Create scoring utility**

Create `lib/food/scoring.ts`:

```ts
// lib/food/scoring.ts
//
// Token-overlap scoring used to rank USDA / OpenFoodFacts text-search
// candidates against a query. Returns a 0..1 score; callers compare against
// an accept threshold (typically 0.5) to decide whether to use the match
// or fall through to the next source.
//
// Pure functions; no I/O.

const STOPWORDS = new Set(["of", "the", "and", "a", "or", "with", "in"]);

/** Tokenize a name/query: lowercase, split on punctuation/whitespace,
 *  drop empty tokens and stopwords. */
export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[\s,.\-/()]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/** Score a candidate name against a query.
 *  recall    = |query ∩ candidate| / |query|
 *  precision = |query ∩ candidate| / |candidate|
 *  score     = recall * 0.7 + precision * 0.3
 *
 *  Recall weights higher: if the candidate covers every token in the user's
 *  query, that's a strong signal. Precision is a tiebreaker that penalises
 *  candidates with lots of extra noise (e.g. "Oil, corn, peanut, and olive"
 *  vs. "Oil, olive, salad or cooking" for query "olive oil"). */
export function scoreOverlap(query: string, candidate: string): number {
  const q = new Set(tokenize(query));
  const c = new Set(tokenize(candidate));
  if (q.size === 0 || c.size === 0) return 0;
  let overlap = 0;
  for (const t of q) if (c.has(t)) overlap++;
  const recall = overlap / q.size;
  const precision = overlap / c.size;
  return recall * 0.7 + precision * 0.3;
}

/** Score all candidates and return the best one (above threshold), or null.
 *  Tiebreaker: shorter candidate name by character count wins (proxy for
 *  "more focused match"). */
export function pickBestCandidate<T extends { name: string }>(
  query: string,
  candidates: T[],
  threshold = 0.5,
): { candidate: T; score: number } | null {
  let best: { candidate: T; score: number } | null = null;
  for (const c of candidates) {
    const score = scoreOverlap(query, c.name);
    if (score < threshold) continue;
    if (!best || score > best.score || (score === best.score && c.name.length < best.candidate.name.length)) {
      best = { candidate: c, score };
    }
  }
  return best;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Smoke-test the scoring logic**

Run a quick sanity check via Node (no test framework, so this is an ad-hoc REPL check):

```bash
node --import ./scripts/alias-loader.mjs --experimental-strip-types -e "
import('./lib/food/scoring.ts').then(({ scoreOverlap, pickBestCandidate }) => {
  console.log('olive oil vs Oil, olive, salad or cooking:', scoreOverlap('olive oil', 'Oil, olive, salad or cooking'));
  console.log('olive oil vs Oil, corn, peanut, and olive:', scoreOverlap('olive oil', 'Oil, corn, peanut, and olive'));
  console.log('halloumi grilled vs Buttermilk, low fat:', scoreOverlap('halloumi grilled', 'Buttermilk, low fat'));
  console.log('halloumi grilled vs Cheese, halloumi, grilled:', scoreOverlap('halloumi grilled', 'Cheese, halloumi, grilled'));
  const best = pickBestCandidate('olive oil', [
    { name: 'Oil, olive, salad or cooking' },
    { name: 'Oil, corn, peanut, and olive' },
  ]);
  console.log('pickBest olive oil →', best);
});
"
```

Expected output (approx):
```
olive oil vs Oil, olive, salad or cooking: 0.85
olive oil vs Oil, corn, peanut, and olive: 0.85
halloumi grilled vs Buttermilk, low fat: 0
halloumi grilled vs Cheese, halloumi, grilled: 0.85
pickBest olive oil → { candidate: { name: 'Oil, olive, salad or cooking' }, score: 0.85 }
```

The pickBest tiebreaker should pick "Oil, olive, salad or cooking" because it's 28 chars vs "Oil, corn, peanut, and olive" at 28 chars too — they're nearly identical. The first-seen wins when both length AND score are equal; this is acceptable.

If actual scores differ from expected by more than 0.05, debug the tokenizer (likely cause: a stopword you didn't include, or punctuation not split).

- [ ] **Step 4: Commit**

```bash
git add lib/food/scoring.ts
git commit -m "feat(food): add token-overlap scoring utility"
```

---

## Phase B — Parser tightening

### Task 3: Tighten Haiku extraction prompt

**Files:**
- Modify: `lib/food/parse.ts`

- [ ] **Step 1: Replace the SYSTEM constant**

In `lib/food/parse.ts`, replace the entire `SYSTEM` const:

```ts
const SYSTEM = `You convert free-text food descriptions into a structured list of items with quantities in grams.

Rules:
- Output STRICT JSON matching {"items": [{"name": string, "qty_g": number}]}. No commentary.
- EXPLICIT QUANTITY OVERRIDES DEFAULTS. When the user specifies a quantity in grams (e.g. "45g", "200 g") or ounces (e.g. "3 oz"), use that exact value. Convert oz → g by × 28.35. The household-unit table below applies ONLY when no explicit g/oz quantity is given.
- PRESERVE MODIFIERS. Words that describe the food — "low fat", "grilled", "whole wheat", "fried", "raw", brand names like "Balade" — must appear in the name field. Do not drop them.
- Convert household units to grams using common references (apply ONLY when no explicit g/oz):
    1 cup cooked rice ≈ 158g
    1 cup raw oats ≈ 80g
    1 slice bread ≈ 30g
    1 tbsp olive oil ≈ 14g
    1 medium apple ≈ 180g
    1 large egg ≈ 50g
    1 chicken breast (medium) ≈ 170g
- If quantity is ambiguous AND no explicit g/oz, pick a reasonable single-serving default and proceed (don't ask, don't refuse).
- name should be canonical-ish: "chicken breast grilled" not "I ate chicken".
- Max 15 items per call.

Examples:
- Input: "2 fried eggs with 1 tablespoon olive oil, 50g of low fat Balade grilled halloumi, 45g of wholewheat toast"
  Output: {"items": [
    {"name": "egg fried", "qty_g": 100},
    {"name": "olive oil", "qty_g": 14},
    {"name": "halloumi grilled low fat Balade", "qty_g": 50},
    {"name": "wholewheat toast", "qty_g": 45}
  ]}
- Input: "1 slice of bread"
  Output: {"items": [{"name": "bread", "qty_g": 30}]}
- Input: "200g chicken breast and 1 cup rice"
  Output: {"items": [{"name": "chicken breast", "qty_g": 200}, {"name": "rice cooked", "qty_g": 158}]}`;
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Manual exercise**

Start `npm run dev`. Open the meal logger at `/meal`, tap the breakfast `+`, type the failure case: *"2 fried eggs with 1 tablespoon olive oil, 50g of low fat Balade grilled halloumi, 45g of wholewheat toast"*, tap Parse.

Inspect the draft items. Expected qty values (regardless of which DB matched them — that's Tasks 4–5):
- egg fried: 100g
- olive oil: 14g
- halloumi: 50g  ← was missing from the prompt before; the explicit "50g" must win
- wholewheat toast: 45g  ← was 30g before due to "1 slice bread" default; must now be 45g

If any qty is wrong, the prompt isn't strict enough — iterate on the SYSTEM string. Don't commit until all four qty values are correct.

Discard the draft (don't commit) — Task 4/5 will fix the name resolutions.

- [ ] **Step 4: Commit**

```bash
git add lib/food/parse.ts
git commit -m "fix(food): explicit gram quantities override household-unit defaults"
```

---

### Task 4: USDA scoring + threshold

**Files:**
- Modify: `lib/food/lookup.ts`

- [ ] **Step 1: Refactor `lookupUsda` to use scoring**

In `lib/food/lookup.ts`, replace the `lookupUsda` function:

```ts
async function lookupUsda(name: string): Promise<{ row: FoodDbCacheRow; score: number } | null> {
  const apiKey = process.env.USDA_FDC_API_KEY;
  if (!apiKey) {
    console.warn("[food-lookup] USDA_FDC_API_KEY not set — skipping USDA");
    return null;
  }
  const url = `${USDA_SEARCH_URL}?api_key=${encodeURIComponent(apiKey)}&query=${encodeURIComponent(name)}&pageSize=5&dataType=Foundation,SR%20Legacy`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch (err) {
    console.warn(`[food-lookup] USDA fetch failed for query "${name}"`, err);
    return null;
  }
  if (!res.ok) {
    console.warn(`[food-lookup] USDA ${res.status} for query "${name}"`);
    return null;
  }
  const data = (await res.json()) as { foods?: UsdaFood[] };
  const foods = data.foods ?? [];
  if (foods.length === 0) return null;

  // Score each candidate by token overlap with the query.
  const best = pickBestCandidate(
    name,
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

- [ ] **Step 2: Add the import**

At the top of `lib/food/lookup.ts`, add:

```ts
import { pickBestCandidate } from "@/lib/food/scoring";
```

- [ ] **Step 3: Update `resolveItemMacros` to consume the new `lookupUsda` return shape**

In `lib/food/lookup.ts`, replace the `// 2. USDA` block in `resolveItemMacros`:

```ts
  // 2. USDA with scoring
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
```

Also update the cache-hit branch (`// 1. cache`) and the LLM-fallback branch (`// 3. LLM fallback`) to populate `match_score`:

```ts
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
      match_score: 1.0,  // trigram already filtered ≥ 0.6; treat as high confidence
    };
  }
```

```ts
  // 3. LLM fallback (unchanged macros logic, just add match_score: null)
  // ... existing code ...
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
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Manual exercise**

Restart dev. Type-tab parse: *"1 tablespoon olive oil"*.

Expected behavior:
- USDA returns 5 candidates including "Oil, olive, salad or cooking" and "Oil, corn, peanut, and olive"
- Scoring picks the shorter "Oil, olive, salad or cooking" (or similar) — not "corn, peanut, and olive"
- Item shows in draft with name from USDA, qty 14g

Check Vercel/local logs for `[food-lookup] USDA top-N all below threshold` entries on harder queries.

Type-tab parse: *"50g halloumi grilled"*.

Expected: USDA returns 5 candidates but none contain "halloumi" → all below 0.5 threshold → falls through to LLM (since Task 5 isn't done yet). The draft row shows `source: 'llm'`, name "halloumi grilled", and the "estimated" amber chip. That's correct intermediate behavior — Task 5 will route this to OFF instead.

Discard, do not commit the food entry.

- [ ] **Step 6: Commit**

```bash
git add lib/food/lookup.ts
git commit -m "fix(food): USDA pageSize=5 with token-overlap scoring + match_score"
```

---

### Task 5: OpenFoodFacts text search as 2nd-tier lookup

**Files:**
- Modify: `lib/food/lookup.ts`

- [ ] **Step 1: Add `lookupOpenFoodFacts` helper**

In `lib/food/lookup.ts`, add a new function before `resolveItemMacros`:

```ts
const OFF_SEARCH_URL = "https://world.openfoodfacts.org/cgi/search.pl";

type OffSearchProduct = {
  product_name?: string;
  product_name_en?: string;
  brands?: string;
  nutriments?: {
    "energy-kcal_100g"?: number;
    energy_100g?: number;
    proteins_100g?: number;
    carbohydrates_100g?: number;
    fat_100g?: number;
    fiber_100g?: number;
  };
  code?: string;
  image_thumb_url?: string;
};

type OffSearchResponse = {
  products?: OffSearchProduct[];
};

/** OpenFoodFacts text search. Used as a 2nd-tier lookup between USDA and the
 *  LLM estimate in resolveItemMacros, and also called by /api/food/search.
 *  Returns the chosen cached row + score, or null on miss / no-score. */
export async function lookupOpenFoodFacts(name: string): Promise<{ row: FoodDbCacheRow; score: number } | null> {
  const url = `${OFF_SEARCH_URL}?search_terms=${encodeURIComponent(name)}&json=1&page_size=5&fields=product_name,product_name_en,brands,nutriments,code,image_thumb_url`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "ApexHealthOS/1.0 (single-user app)" },
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.warn(`[food-lookup] OFF fetch failed for "${name}"`, err);
    return null;
  }
  if (!res.ok) {
    console.warn(`[food-lookup] OFF ${res.status} for "${name}"`);
    return null;
  }
  const data = (await res.json()) as OffSearchResponse;
  const products = data.products ?? [];
  if (products.length === 0) return null;

  // Build candidate list with display names. Skip products without names or macros.
  const candidates = products
    .map((p) => {
      const displayName = p.product_name_en ?? p.product_name;
      if (!displayName) return null;
      const n = p.nutriments;
      const kcal = typeof n?.["energy-kcal_100g"] === "number"
        ? n["energy-kcal_100g"]
        : typeof n?.energy_100g === "number"
        ? n.energy_100g / 4.184
        : null;
      if (kcal === null) return null;  // No macros → skip
      return {
        name: p.brands ? `${displayName} (${p.brands})` : displayName,
        product: p,
        per_100g: {
          kcal,
          protein_g: n?.proteins_100g ?? 0,
          carbs_g: n?.carbohydrates_100g ?? 0,
          fat_g: n?.fat_100g ?? 0,
          fiber_g: n?.fiber_100g ?? 0,
        },
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);
  if (candidates.length === 0) return null;

  const best = pickBestCandidate(name, candidates, 0.5);
  if (!best) {
    console.info(`[food-lookup] OFF top-${candidates.length} all below threshold for "${name}"`);
    return null;
  }

  const supabase = createSupabaseServiceRoleClient();
  const { data: inserted, error } = await supabase
    .from("food_db_cache")
    .insert({
      source: "openfoodfacts",
      upc: null,  // Text-search hits aren't keyed by UPC
      name: best.candidate.name,
      per_100g: best.candidate.per_100g,
      serving_size_g: null,
      raw_payload: best.candidate.product,
    })
    .select("*")
    .single();
  if (error) {
    console.error("[food-lookup] OFF cache insert failed", error);
    return null;
  }
  return { row: inserted as FoodDbCacheRow, score: best.score };
}
```

- [ ] **Step 2: Insert OFF into the `resolveItemMacros` chain**

In `lib/food/lookup.ts`, find the `// 3. LLM fallback` block in `resolveItemMacros` and add the OFF lookup before it. The full chain section should now read:

```ts
  // 1. cache
  const cached = await lookupCacheByName(name);
  if (cached) {
    // ... existing return with match_score: 1.0 ...
  }
  // 2. USDA with scoring
  const usda = await lookupUsda(name);
  if (usda) {
    // ... existing return ...
  }
  // 3. OpenFoodFacts with scoring (new tier)
  const off = await lookupOpenFoodFacts(name);
  if (off) {
    const macros = macrosForQty(off.row.per_100g, qty_g);
    return {
      name: off.row.name,
      qty_g,
      ...macros,
      per_100g: off.row.per_100g,
      source: "db",
      db_ref: { source: "openfoodfacts", canonical_id: off.row.canonical_id },
      confidence: off.score >= 0.7 ? "high" : "medium",
      match_score: off.score,
    };
  }
  // 4. LLM fallback
  // ... existing code ...
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Manual exercise — the failure case in full**

Restart dev. In the breakfast logger, type:

*"2 fried eggs with 1 tablespoon olive oil, 50g of low fat Balade grilled halloumi, 45g of wholewheat toast"*

Expected after Parse:
- Egg fried — ~100g — USDA hit ("Egg, whole, cooked, fried" or similar)
- Olive oil — 14g — USDA hit (NOT "Oil, corn, peanut, and olive")
- Halloumi — 50g — likely OFF hit (Balade Light or generic halloumi). If USDA happens to have a halloumi entry, that's fine too. Either way: NOT buttermilk.
- Wholewheat toast — 45g — OFF hit (bread/toast variant). NOT brown sugar.

If any item still resolves wrong, check the logs:
- USDA threshold rejections: look for `USDA top-N all below threshold`
- OFF threshold rejections: `OFF top-N all below threshold`
- Cache pollution: query `food_db_cache` for rows from the previous broken state and delete them via SQL Editor:
  ```sql
  delete from food_db_cache where name in ('Sugars, brown', 'Buttermilk, low fat') and last_fetched_at > '2026-05-19';
  ```
  (Only run if those rows came from the broken parser — the failure-case screenshot rows.)

Discard the draft once the resolution is verified.

- [ ] **Step 5: Commit**

```bash
git add lib/food/lookup.ts
git commit -m "feat(food): OpenFoodFacts text search as 2nd-tier resolver"
```

---

## Phase C — `<DraftReview/>` refactor + Edit/Delete affordances

### Task 6: Extract `<DraftReview/>` shared component

This task is a pure refactor — no behavior change yet. The Edit/Delete affordances land in Task 7+.

**Files:**
- Create: `components/log/DraftReview.tsx`
- Modify: `components/log/MealLoggerTypeTab.tsx`, `components/log/MealLoggerScanTab.tsx`

- [ ] **Step 1: Create `<DraftReview/>`**

Create `components/log/DraftReview.tsx`:

```tsx
"use client";
import type { FoodLogEntry } from "@/lib/food/types";
import { fmtNum } from "@/lib/ui/score";

export function DraftReview({
  entry,
  onCommitted,
  onDiscarded,
  busy,
  error,
  onCommit,
  onDiscard,
}: {
  entry: Pick<FoodLogEntry, "id" | "items" | "totals" | "is_estimated">;
  onCommitted: () => void;
  onDiscarded: () => void;
  busy: boolean;
  error: string | null;
  onCommit: () => Promise<void>;
  onDiscard: () => Promise<void>;
}) {
  // Task 6 keeps this component a thin renderer; Task 7+8+9 add ✎ Edit and × Delete.
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
        {entry.items.map((it, idx) => (
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
        Total: <strong>{fmtNum(entry.totals.kcal)} kcal</strong> · {fmtNum(entry.totals.protein_g)} P · {fmtNum(entry.totals.carbs_g)} C · {fmtNum(entry.totals.fat_g)} F
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={onDiscard} disabled={busy} className="flex-1 rounded-md border border-zinc-700 py-2 text-sm">
          Discard
        </button>
        <button type="button" onClick={onCommit} disabled={busy} className="flex-1 rounded-md bg-zinc-100 py-2 text-sm text-zinc-900">
          {busy ? "..." : "Commit"}
        </button>
      </div>
    </div>
  );
}
```

`onCommitted`/`onDiscarded` are accepted for future use (parent-driven side effects) — wire them through but they're invoked by the existing handlers in the parent for now.

- [ ] **Step 2: Refactor `MealLoggerTypeTab` to use `<DraftReview/>`**

In `components/log/MealLoggerTypeTab.tsx`, replace lines 70-101 (the `if (draft) { ... }` block) with:

```tsx
  if (draft) {
    return (
      <DraftReview
        entry={draft}
        onCommitted={onCommitted}
        onDiscarded={() => {}}
        busy={busy}
        error={error}
        onCommit={commit}
        onDiscard={discard}
      />
    );
  }
```

Add the import at the top:

```ts
import { DraftReview } from "./DraftReview";
```

Remove the unused `fmtNum` import if it's only used in the deleted block.

- [ ] **Step 3: Refactor `MealLoggerScanTab` to use `<DraftReview/>`**

In `components/log/MealLoggerScanTab.tsx`, the `scanned` branch (lines 128-153) is *almost* the same UI but with a product image, "Scan another" instead of "Discard", and only a single item.

Don't force `<DraftReview/>` here yet — the SCAN flow has different button labels and the image preview. For consistency in Edit/Delete affordances later, we want to share the items list rendering at minimum. Compromise: leave `MealLoggerScanTab` largely as-is for this task, but wrap the items list display in `<DraftReview/>` once we add Edit/Delete in Task 7.

Actually no — to keep this task strictly mechanical, leave `MealLoggerScanTab` untouched. Task 7 will introduce the Edit/Delete affordances and at that point we'll wire `<DraftReview/>` into the SCAN tab properly (the "Scan another" button can sit alongside `<DraftReview/>`'s actions in the SCAN tab's parent layout).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Manual exercise**

Restart dev. Parse a meal via the TYPE tab. Verify the draft review renders identically to before — same item rows, same totals, same Discard/Commit behavior. Commit one entry; confirm it shows up on `/meal`.

- [ ] **Step 6: Commit**

```bash
git add components/log/DraftReview.tsx components/log/MealLoggerTypeTab.tsx
git commit -m "refactor(food): extract <DraftReview/> from MealLoggerTypeTab"
```

---

### Task 7: Edit row — qty-only flow

**Files:**
- Modify: `components/log/DraftReview.tsx`

- [ ] **Step 1: Add Edit state and inline editor**

Rewrite `components/log/DraftReview.tsx` to add an inline editor when a row is being edited. The qty-only flow is added now; the "Change food" picker integration lands in Task 12 (after `<FoodSearchPicker/>` is built).

```tsx
"use client";
import { useState } from "react";
import type { FoodItem, FoodLogEntry } from "@/lib/food/types";
import { fmtNum } from "@/lib/ui/score";
import { macrosForQty } from "@/lib/food/types";

const QTY_PRESETS = [50, 100, 150, 200] as const;

export function DraftReview({
  entry,
  onChange,
  busy,
  error,
  onCommit,
  onDiscard,
}: {
  entry: Pick<FoodLogEntry, "id" | "items" | "totals" | "is_estimated">;
  /** Called after a successful PATCH with the updated entry. */
  onChange: (updated: Pick<FoodLogEntry, "id" | "items" | "totals" | "is_estimated">) => void;
  busy: boolean;
  error: string | null;
  onCommit: () => Promise<void>;
  onDiscard: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [editQty, setEditQty] = useState<number>(0);
  const [editError, setEditError] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  const startEdit = (idx: number) => {
    setEditing(idx);
    setEditQty(entry.items[idx].qty_g);
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditError(null);
  };

  const saveQty = async () => {
    if (editing === null || editQty <= 0) return;
    setEditBusy(true);
    setEditError(null);
    const updatedItems: FoodItem[] = entry.items.map((it, idx) => {
      if (idx !== editing) return it;
      const macros = macrosForQty(it.per_100g, editQty);
      return { ...it, qty_g: editQty, ...macros };
    });
    try {
      const res = await fetch(`/api/food/entries/${entry.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: updatedItems }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({ error: "patch_failed" }));
        throw new Error(json.error || "patch_failed");
      }
      // Server recomputes totals; refetch via the entry endpoint OR trust local recompute.
      // Trust local recompute (server already validated and persisted) to save a round-trip.
      const newTotals = updatedItems.reduce(
        (acc, it) => ({
          kcal:      acc.kcal      + it.kcal,
          protein_g: acc.protein_g + it.protein_g,
          carbs_g:   acc.carbs_g   + it.carbs_g,
          fat_g:     acc.fat_g     + it.fat_g,
          fiber_g:   acc.fiber_g   + it.fiber_g,
        }),
        { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
      );
      onChange({
        ...entry,
        items: updatedItems,
        totals: newTotals,
        is_estimated: updatedItems.some((it) => it.source === "llm"),
      });
      setEditing(null);
    } catch (e) {
      setEditError((e as Error).message);
    } finally {
      setEditBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
        {entry.items.map((it, idx) => {
          if (editing === idx) {
            return (
              <li key={idx} className="space-y-2 bg-zinc-900/60 p-3 text-sm">
                <div className="text-xs uppercase tracking-wider text-zinc-400">
                  Editing: {it.name}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-400">Qty</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={editQty}
                    onChange={(e) => setEditQty(Number(e.target.value))}
                    className="w-20 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100"
                  />
                  <span className="text-xs text-zinc-400">g</span>
                  <div className="ml-auto flex gap-1">
                    {QTY_PRESETS.map((q) => (
                      <button
                        key={q}
                        type="button"
                        onClick={() => setEditQty(q)}
                        className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
                {editError && <p className="text-xs text-red-400">{editError}</p>}
                <div className="flex gap-2">
                  <button type="button" onClick={cancelEdit} disabled={editBusy} className="flex-1 rounded-md border border-zinc-700 py-1 text-xs">
                    Cancel
                  </button>
                  <button type="button" onClick={saveQty} disabled={editBusy || editQty <= 0} className="flex-1 rounded-md bg-zinc-100 py-1 text-xs text-zinc-900">
                    {editBusy ? "..." : "Save"}
                  </button>
                </div>
              </li>
            );
          }
          return (
            <li key={idx} className="flex items-start justify-between gap-2 p-3 text-sm">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium">{it.name}</span>
                  {it.source === "llm" && (
                    <span className="text-xs text-amber-400">estimated</span>
                  )}
                </div>
                <div className="text-xs text-zinc-400">
                  {fmtNum(it.qty_g)} g · {fmtNum(it.kcal)} kcal · {fmtNum(it.protein_g)} P · {fmtNum(it.carbs_g)} C · {fmtNum(it.fat_g)} F
                </div>
              </div>
              <button
                type="button"
                onClick={() => startEdit(idx)}
                aria-label={`Edit ${it.name}`}
                className="shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              >
                ✎
              </button>
            </li>
          );
        })}
      </ul>
      <div className="text-sm">
        Total: <strong>{fmtNum(entry.totals.kcal)} kcal</strong> · {fmtNum(entry.totals.protein_g)} P · {fmtNum(entry.totals.carbs_g)} C · {fmtNum(entry.totals.fat_g)} F
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={onDiscard} disabled={busy} className="flex-1 rounded-md border border-zinc-700 py-2 text-sm">
          Discard
        </button>
        <button type="button" onClick={onCommit} disabled={busy} className="flex-1 rounded-md bg-zinc-100 py-2 text-sm text-zinc-900">
          {busy ? "..." : "Commit"}
        </button>
      </div>
    </div>
  );
}
```

Note the signature change: `onCommitted`/`onDiscarded` are removed (parent already invokes its own handlers); `onChange` is added for PATCH-driven state updates.

- [ ] **Step 2: Update `MealLoggerTypeTab` for the new prop**

In `components/log/MealLoggerTypeTab.tsx`, update the `<DraftReview/>` usage:

```tsx
  if (draft) {
    return (
      <DraftReview
        entry={draft}
        onChange={setDraft}
        busy={busy}
        error={error}
        onCommit={commit}
        onDiscard={discard}
      />
    );
  }
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS. If you get a type error on `setDraft`'s parameter shape, widen the `draft` state type in `MealLoggerTypeTab` to match what `<DraftReview/>` returns (it already does: `Pick<FoodLogEntry, "id" | "items" | "totals" | "is_estimated">`).

- [ ] **Step 4: Manual exercise**

Parse a meal. Confirm each row now has a `✎` icon on the right. Tap it on one row — the row expands into the qty editor. Change the qty (try typing 75, then tapping the "100" preset). Tap Save. The row updates with new macros; total updates; chip clears. Tap Cancel on another edit — closes without change.

Try Edit on a row, then change qty to 0 → Save button disabled (visual check).

Refresh the page. The draft is still in `food_log_entries.status='draft'` — confirm `/meal` doesn't show it (only committed entries appear). Open the logger again; the entry is gone (you'd start over). That's expected behavior — drafts don't survive sheet close. Edit only matters during the live review.

If anything misbehaves, check the network tab for the PATCH request and its response.

- [ ] **Step 5: Commit**

```bash
git add components/log/DraftReview.tsx components/log/MealLoggerTypeTab.tsx
git commit -m "feat(food): inline qty edit on draft review rows"
```

---

### Task 8: Delete row affordance

**Files:**
- Modify: `components/log/DraftReview.tsx`

- [ ] **Step 1: Add Delete button + handler**

In `components/log/DraftReview.tsx`, add a `×` button next to the `✎` button. Insert this handler near `saveQty`:

```tsx
  const deleteRow = async (idx: number) => {
    if (entry.items.length === 1) {
      // Last row → treat as Discard (delete the whole draft)
      await onDiscard();
      return;
    }
    setEditBusy(true);
    setEditError(null);
    const updatedItems = entry.items.filter((_, i) => i !== idx);
    try {
      const res = await fetch(`/api/food/entries/${entry.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: updatedItems }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({ error: "patch_failed" }));
        throw new Error(json.error || "patch_failed");
      }
      const newTotals = updatedItems.reduce(
        (acc, it) => ({
          kcal:      acc.kcal      + it.kcal,
          protein_g: acc.protein_g + it.protein_g,
          carbs_g:   acc.carbs_g   + it.carbs_g,
          fat_g:     acc.fat_g     + it.fat_g,
          fiber_g:   acc.fiber_g   + it.fiber_g,
        }),
        { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
      );
      onChange({
        ...entry,
        items: updatedItems,
        totals: newTotals,
        is_estimated: updatedItems.some((it) => it.source === "llm"),
      });
    } catch (e) {
      setEditError((e as Error).message);
    } finally {
      setEditBusy(false);
    }
  };
```

In the row render (non-editing case), update the action buttons block from `<button>✎</button>` alone to:

```tsx
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  onClick={() => startEdit(idx)}
                  aria-label={`Edit ${it.name}`}
                  className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                >
                  ✎
                </button>
                <button
                  type="button"
                  onClick={() => deleteRow(idx)}
                  aria-label={`Delete ${it.name}`}
                  disabled={editBusy}
                  className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-red-400"
                >
                  ×
                </button>
              </div>
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Manual exercise**

Parse a 3-item meal. Delete the middle row via `×` → only 2 rows remain; totals update. Delete another → 1 row left. Delete the last → entire draft is discarded (sheet closes via the `onDiscard` path).

Verify on `/meal` that nothing wrong got committed.

- [ ] **Step 4: Commit**

```bash
git add components/log/DraftReview.tsx
git commit -m "feat(food): delete-row affordance on draft review"
```

---

## Phase D — Search tab

### Task 9: `lib/food/search.ts` — multi-source fanout

**Files:**
- Create: `lib/food/search.ts`

- [ ] **Step 1: Create the search module**

Create `lib/food/search.ts`:

```ts
// lib/food/search.ts
//
// Multi-source food search used by /api/food/search and the SEARCH tab's
// FoodSearchPicker. Fanout in parallel:
//   1. food_db_cache trigram match (loose threshold 0.4 — user picks the
//      result, so we accept fuzzier matches than the parser's resolve chain)
//   2. OpenFoodFacts cgi/search.pl
//   3. USDA /foods/search
//
// Merge + dedupe (case-insensitive name match), sort by source preference
// (db > off > usda) then by token-overlap score. Return top 20.
//
// CACHE WRITE-BACK happens at PICK TIME (/api/food/draft), NOT during search,
// to keep search idempotent and avoid polluting the cache with rows the user
// never used.

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { scoreOverlap } from "@/lib/food/scoring";
import type { FoodMacros, FoodDbCacheRow, SearchCandidate } from "@/lib/food/types";

const USDA_SEARCH_URL = "https://api.nal.usda.gov/fdc/v1/foods/search";
const OFF_SEARCH_URL = "https://world.openfoodfacts.org/cgi/search.pl";

const SOURCE_RANK = { db: 0, off: 1, usda: 2 } as const;

async function searchCacheTrigram(query: string): Promise<SearchCandidate[]> {
  const supabase = createSupabaseServiceRoleClient();
  // Try the food_cache_similar RPC first; fall back to ilike if missing.
  const { data, error } = await supabase
    .from("food_db_cache")
    .select("*")
    .ilike("name", `%${query}%`)
    .limit(20);
  if (error || !data) return [];
  return (data as FoodDbCacheRow[]).map((row) => ({
    name: row.name,
    per_100g: row.per_100g,
    source: "db" as const,
    canonical_id: row.canonical_id,
    image_url: null,
  }));
}

async function searchOpenFoodFacts(query: string): Promise<SearchCandidate[]> {
  const url = `${OFF_SEARCH_URL}?search_terms=${encodeURIComponent(query)}&json=1&page_size=10&fields=product_name,product_name_en,brands,nutriments,code,image_thumb_url`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "ApexHealthOS/1.0 (single-user app)" },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const data = (await res.json()) as {
    products?: Array<{
      product_name?: string;
      product_name_en?: string;
      brands?: string;
      nutriments?: {
        "energy-kcal_100g"?: number;
        energy_100g?: number;
        proteins_100g?: number;
        carbohydrates_100g?: number;
        fat_100g?: number;
        fiber_100g?: number;
      };
      image_thumb_url?: string;
    }>;
  };
  const products = data.products ?? [];
  return products
    .map((p): SearchCandidate | null => {
      const displayName = p.product_name_en ?? p.product_name;
      if (!displayName) return null;
      const n = p.nutriments;
      const kcal = typeof n?.["energy-kcal_100g"] === "number"
        ? n["energy-kcal_100g"]
        : typeof n?.energy_100g === "number"
        ? n.energy_100g / 4.184
        : null;
      if (kcal === null) return null;
      const per_100g: FoodMacros = {
        kcal,
        protein_g: n?.proteins_100g ?? 0,
        carbs_g: n?.carbohydrates_100g ?? 0,
        fat_g: n?.fat_100g ?? 0,
        fiber_g: n?.fiber_100g ?? 0,
      };
      return {
        name: p.brands ? `${displayName} (${p.brands})` : displayName,
        per_100g,
        source: "off",
        canonical_id: null,
        image_url: p.image_thumb_url ?? null,
      };
    })
    .filter((c): c is SearchCandidate => c !== null);
}

async function searchUsda(query: string): Promise<SearchCandidate[]> {
  const apiKey = process.env.USDA_FDC_API_KEY;
  if (!apiKey) return [];
  const url = `${USDA_SEARCH_URL}?api_key=${encodeURIComponent(apiKey)}&query=${encodeURIComponent(query)}&pageSize=10&dataType=Foundation,SR%20Legacy`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const data = (await res.json()) as {
    foods?: Array<{
      description: string;
      foodNutrients?: Array<{ nutrientNumber?: string; value?: number }>;
    }>;
  };
  const foods = data.foods ?? [];
  return foods.map((f): SearchCandidate => {
    const get = (num: string): number => {
      const n = f.foodNutrients?.find((x) => x.nutrientNumber === num);
      return typeof n?.value === "number" ? n.value : 0;
    };
    return {
      name: f.description,
      per_100g: {
        kcal:      get("208"),
        protein_g: get("203"),
        carbs_g:   get("205"),
        fat_g:     get("204"),
        fiber_g:   get("291"),
      },
      source: "usda",
      canonical_id: null,
      image_url: null,
    };
  });
}

export async function searchFoods(query: string, limit = 20): Promise<SearchCandidate[]> {
  if (query.trim().length < 2) return [];

  // Cache first — if we have a high-trigram-score local hit, short-circuit.
  const cacheHits = await searchCacheTrigram(query);
  const topCacheScore = cacheHits.length > 0
    ? Math.max(...cacheHits.map((c) => scoreOverlap(query, c.name)))
    : 0;
  if (topCacheScore >= 0.7) {
    return cacheHits
      .sort((a, b) => scoreOverlap(query, b.name) - scoreOverlap(query, a.name))
      .slice(0, limit);
  }

  // Otherwise fan out to OFF + USDA in parallel and merge.
  const [offHits, usdaHits] = await Promise.all([
    searchOpenFoodFacts(query),
    searchUsda(query),
  ]);
  const all = [...cacheHits, ...offHits, ...usdaHits];

  // Dedupe by lowercase name. Keep the first occurrence (which favours db > off > usda
  // because of array order).
  const seen = new Set<string>();
  const deduped: SearchCandidate[] = [];
  for (const c of all) {
    const key = c.name.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }

  // Sort: source rank first, then score desc.
  deduped.sort((a, b) => {
    const ra = SOURCE_RANK[a.source];
    const rb = SOURCE_RANK[b.source];
    if (ra !== rb) return ra - rb;
    return scoreOverlap(query, b.name) - scoreOverlap(query, a.name);
  });

  return deduped.slice(0, limit);
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/food/search.ts
git commit -m "feat(food): multi-source search fanout (cache + OFF + USDA)"
```

---

### Task 10: `GET /api/food/search` route

**Files:**
- Create: `app/api/food/search/route.ts`

- [ ] **Step 1: Create the route**

Create `app/api/food/search/route.ts`:

```ts
// app/api/food/search/route.ts
//
// GET ?q=<query>&limit=20 → SearchCandidate[]
// Used by <FoodSearchPicker/> (SEARCH tab + Edit-swap "change food").

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { searchFoods } from "@/lib/food/search";

const QuerySchema = z.object({
  q: z.string().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    q: url.searchParams.get("q"),
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const candidates = await searchFoods(parsed.data.q, parsed.data.limit);
  return NextResponse.json({ candidates });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Manual exercise**

With dev running, log in to the app, then in the browser console:

```js
fetch("/api/food/search?q=halloumi").then(r => r.json()).then(console.log)
```

Expected: a `candidates` array with hits from at least OFF (Balade or generic halloumi). DB hits if cache has prior entries; USDA likely empty for halloumi.

Try `?q=chicken+breast` — expect mostly USDA hits with some OFF.

Try `?q=a` — expect 400 (min length).

- [ ] **Step 4: Commit**

```bash
git add app/api/food/search/route.ts
git commit -m "feat(food): GET /api/food/search endpoint"
```

---

### Task 11: `POST /api/food/draft` route

**Files:**
- Create: `app/api/food/draft/route.ts`

- [ ] **Step 1: Create the route**

Create `app/api/food/draft/route.ts`:

```ts
// app/api/food/draft/route.ts
//
// POST { items: Array<{ candidate: SearchCandidate, qty_g: number }>,
//        meal_slot, eaten_at? } → draft food_log_entries row.
//
// For each picked candidate:
//   - If canonical_id is null (fresh OFF/USDA hit), insert into food_db_cache
//     to obtain a canonical_id (cache write at pick-time, not search-time).
//   - Compute macros via macrosForQty and build a FoodItem.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { macrosForQty, sumMacros, type FoodItem, type FoodDbCacheRow } from "@/lib/food/types";

const CandidateSchema = z.object({
  name: z.string().min(1),
  per_100g: z.object({
    kcal: z.number().nonnegative(),
    protein_g: z.number().nonnegative(),
    carbs_g: z.number().nonnegative(),
    fat_g: z.number().nonnegative(),
    fiber_g: z.number().nonnegative(),
  }),
  source: z.enum(["db", "off", "usda"]),
  canonical_id: z.string().uuid().nullable(),
  image_url: z.string().url().nullable(),
});

const BodySchema = z.object({
  items: z.array(z.object({
    candidate: CandidateSchema,
    qty_g: z.number().positive().finite(),
  })).min(1).max(15),
  meal_slot: z.enum(["breakfast", "lunch", "dinner", "snack"]),
  eaten_at: z.string().datetime().optional(),
});

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const serviceClient = createSupabaseServiceRoleClient();

  // Resolve each candidate → ensure canonical_id, build FoodItem.
  const items: FoodItem[] = [];
  for (const { candidate, qty_g } of parsed.data.items) {
    let canonical_id = candidate.canonical_id;
    let db_source: "usda" | "openfoodfacts" | "manual";

    if (candidate.source === "db") {
      if (!canonical_id) {
        return NextResponse.json({ error: "db_candidate_missing_canonical_id" }, { status: 400 });
      }
      // Fetch source from cache so we set db_ref.source correctly.
      const { data: cached } = await serviceClient
        .from("food_db_cache")
        .select("source")
        .eq("canonical_id", canonical_id)
        .single();
      const src = (cached as { source?: string } | null)?.source;
      if (src === "usda" || src === "openfoodfacts" || src === "manual") {
        db_source = src;
      } else {
        return NextResponse.json({ error: "db_candidate_source_unknown" }, { status: 400 });
      }
    } else {
      // Fresh OFF or USDA hit — write to cache to materialise canonical_id.
      db_source = candidate.source === "off" ? "openfoodfacts" : "usda";
      const { data: inserted, error } = await serviceClient
        .from("food_db_cache")
        .insert({
          source: db_source,
          upc: null,
          name: candidate.name,
          per_100g: candidate.per_100g,
          serving_size_g: null,
          raw_payload: { picked_via: "search", at: new Date().toISOString() },
        })
        .select("*")
        .single();
      if (error || !inserted) {
        console.error("[/api/food/draft] cache insert failed", error);
        return NextResponse.json({ error: "cache_insert_failed" }, { status: 500 });
      }
      canonical_id = (inserted as FoodDbCacheRow).canonical_id;
    }

    const macros = macrosForQty(candidate.per_100g, qty_g);
    items.push({
      name: candidate.name,
      qty_g,
      ...macros,
      per_100g: candidate.per_100g,
      source: "db",
      db_ref: { source: db_source, canonical_id },
      confidence: "high",
      match_score: 1.0,  // User-picked — treated as ground truth
    });
  }

  const totals = sumMacros(items);

  const candidatesSnapshot = parsed.data.items.map((it) => it.candidate);
  const qtySnapshot = parsed.data.items.map((it) => it.qty_g);

  const { data: inserted, error } = await supabase
    .from("food_log_entries")
    .insert({
      user_id: user.id,
      eaten_at: parsed.data.eaten_at ?? new Date().toISOString(),
      kind: "text",
      meal_slot: parsed.data.meal_slot,
      raw_input: { kind: "text", source: "search", items: candidatesSnapshot, qty_g: qtySnapshot },
      items,
      totals,
      is_estimated: false,
      status: "draft",
    })
    .select("id, eaten_at, meal_slot, kind, items, totals, is_estimated, status")
    .single();
  if (error || !inserted) {
    console.error("[/api/food/draft] entry insert failed", error);
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  return NextResponse.json({ entry: inserted });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/api/food/draft/route.ts
git commit -m "feat(food): POST /api/food/draft for user-picked search entries"
```

---

### Task 12: `<FoodSearchPicker/>` component

**Files:**
- Create: `components/log/FoodSearchPicker.tsx`

- [ ] **Step 1: Create the picker**

Create `components/log/FoodSearchPicker.tsx`:

```tsx
"use client";
import { useEffect, useRef, useState } from "react";
import type { SearchCandidate } from "@/lib/food/types";
import { fmtNum } from "@/lib/ui/score";

const QTY_PRESETS = [50, 100, 150, 200] as const;

export function FoodSearchPicker({
  onPicked,
  onCancel,
}: {
  /** Called when the user picks a candidate AND enters a qty. */
  onPicked: (candidate: SearchCandidate, qty_g: number) => void;
  /** Optional cancel handler — shown as a "Cancel" button when provided. */
  onCancel?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SearchCandidate | null>(null);
  const [qty, setQty] = useState<number>(100);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/food/search?q=${encodeURIComponent(query)}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "search_failed");
        setResults(json.candidates ?? []);
      } catch (e) {
        setError((e as Error).message);
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  if (selected) {
    return (
      <div className="space-y-3">
        <div className="rounded-md border border-zinc-700 bg-zinc-900/60 p-3 text-sm">
          <div className="font-medium">{selected.name}</div>
          <div className="text-xs text-zinc-400">
            per 100g: {fmtNum(selected.per_100g.kcal)} kcal · {fmtNum(selected.per_100g.protein_g)} P · {fmtNum(selected.per_100g.carbs_g)} C · {fmtNum(selected.per_100g.fat_g)} F
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-400">Qty</span>
          <input
            type="number"
            min={1}
            step={1}
            value={qty}
            onChange={(e) => setQty(Number(e.target.value))}
            className="w-20 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100"
          />
          <span className="text-xs text-zinc-400">g</span>
          <div className="ml-auto flex gap-1">
            {QTY_PRESETS.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setQty(q)}
                className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => setSelected(null)} className="flex-1 rounded-md border border-zinc-700 py-2 text-sm">
            Back to results
          </button>
          <button
            type="button"
            onClick={() => { onPicked(selected, qty); setSelected(null); setQty(100); }}
            disabled={qty <= 0}
            className="flex-1 rounded-md bg-zinc-100 py-2 text-sm text-zinc-900 disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search foods..."
        className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-100 placeholder:text-zinc-500"
      />
      {loading && <p className="text-xs text-zinc-500">Searching…</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {!loading && query.trim().length >= 2 && results.length === 0 && !error && (
        <p className="text-xs text-zinc-500">No matches. Try a simpler query.</p>
      )}
      {results.length > 0 && (
        <ul className="max-h-80 divide-y divide-zinc-800 overflow-y-auto rounded-md border border-zinc-800">
          {results.map((c, idx) => (
            <li key={`${c.source}-${c.canonical_id ?? idx}`}>
              <button
                type="button"
                onClick={() => setSelected(c)}
                className="flex w-full items-start justify-between gap-2 p-3 text-left text-sm hover:bg-zinc-900/60"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{c.name}</div>
                  <div className="text-xs text-zinc-400">
                    per 100g: {fmtNum(c.per_100g.kcal)} kcal · {fmtNum(c.per_100g.protein_g)} P · {fmtNum(c.per_100g.carbs_g)} C · {fmtNum(c.per_100g.fat_g)} F
                  </div>
                </div>
                <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400">
                  {c.source === "db" ? "DB" : c.source === "off" ? "OFF" : "USDA"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {onCancel && (
        <button type="button" onClick={onCancel} className="w-full rounded-md border border-zinc-700 py-2 text-sm">
          Cancel
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add components/log/FoodSearchPicker.tsx
git commit -m "feat(food): <FoodSearchPicker/> reusable component"
```

---

### Task 13: `<MealLoggerSearchTab/>` — accumulates picks, commits via /api/food/draft

**Files:**
- Create: `components/log/MealLoggerSearchTab.tsx`

- [ ] **Step 1: Create the tab**

Create `components/log/MealLoggerSearchTab.tsx`:

```tsx
"use client";
import { useState } from "react";
import type { MealSlot, SearchCandidate, FoodLogEntry } from "@/lib/food/types";
import { FoodSearchPicker } from "./FoodSearchPicker";
import { DraftReview } from "./DraftReview";

type DraftItem = { candidate: SearchCandidate; qty_g: number };

export function MealLoggerSearchTab({
  mealSlot,
  eatenAt,
  onCommitted,
}: {
  mealSlot: MealSlot;
  eatenAt: string;
  onCommitted: () => void;
}) {
  const [picks, setPicks] = useState<DraftItem[]>([]);
  const [draft, setDraft] = useState<Pick<FoodLogEntry, "id" | "items" | "totals" | "is_estimated"> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addPick = (candidate: SearchCandidate, qty_g: number) => {
    setPicks((prev) => [...prev, { candidate, qty_g }]);
  };

  const buildDraft = async () => {
    if (picks.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/food/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: picks,
          meal_slot: mealSlot,
          eaten_at: eatenAt,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "draft_failed");
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
    setError(null);
    try {
      const res = await fetch("/api/food/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entry_id: draft.id }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({ error: "commit_failed" }));
        throw new Error(json.error || "commit_failed");
      }
      setDraft(null);
      setPicks([]);
      onCommitted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (draft) {
      await fetch(`/api/food/entries/${draft.id}`, { method: "DELETE" }).catch(() => {});
    }
    setDraft(null);
    setPicks([]);
  };

  if (draft) {
    return (
      <DraftReview
        entry={draft}
        onChange={setDraft}
        busy={busy}
        error={error}
        onCommit={commit}
        onDiscard={discard}
      />
    );
  }

  return (
    <div className="space-y-4">
      {picks.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wider text-zinc-400">In this meal ({picks.length})</div>
          <ul className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
            {picks.map((p, idx) => (
              <li key={idx} className="flex items-center justify-between p-2 text-sm">
                <div className="min-w-0">
                  <div className="truncate">{p.candidate.name}</div>
                  <div className="text-xs text-zinc-400">{p.qty_g} g</div>
                </div>
                <button
                  type="button"
                  onClick={() => setPicks((prev) => prev.filter((_, i) => i !== idx))}
                  aria-label="Remove"
                  className="ml-2 shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-red-400"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={buildDraft}
            disabled={busy}
            className="w-full rounded-md bg-zinc-100 py-2 text-sm text-zinc-900 disabled:opacity-50"
          >
            {busy ? "..." : `Review (${picks.length} item${picks.length === 1 ? "" : "s"})`}
          </button>
        </div>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
      <FoodSearchPicker onPicked={addPick} />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add components/log/MealLoggerSearchTab.tsx
git commit -m "feat(food): <MealLoggerSearchTab/> with pick accumulation"
```

---

### Task 14: Wire SEARCH tab into `<MealLoggerSheet/>`

**Files:**
- Modify: `components/log/MealLoggerSheet.tsx`

- [ ] **Step 1: Insert the SEARCH tab between TYPE and SCAN**

In `components/log/MealLoggerSheet.tsx`:

Update `type Tab`:
```ts
type Tab = "type" | "search" | "scan" | "photo" | "voice";
```

Add the import:
```ts
import { MealLoggerSearchTab } from "./MealLoggerSearchTab";
```

Update the tab list array:
```tsx
{(["type", "search", "scan", "photo", "voice"] as const).map((t) => (
```

Add the SEARCH render branch (after the TYPE branch):
```tsx
{tab === "search" && (
  <MealLoggerSearchTab
    mealSlot={mealSlot}
    eatenAt={eatenAt}
    onCommitted={onCommitted}
  />
)}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Manual exercise — full SEARCH flow**

Restart dev. Open `/meal`, tap a meal-slot `+`. The bottom sheet shows 5 tabs: TYPE · SEARCH · SCAN · PHOTO · VOICE.

Tap SEARCH. Type "halloumi". Expect debounced results from OFF (and DB if cached). Tap "Balade Halloumi" (or any OFF result). Qty input appears; type 50, tap "Add". Returns to search. Type "olive oil", pick a result, qty 14, Add. Type "egg", pick "Egg, whole, raw" or similar, qty 100, Add.

Three picks in the meal. Tap "Review (3 items)". `<DraftReview/>` renders with 3 rows (each editable via ✎/×). Verify totals are correct.

Tap Commit. Sheet closes. `/meal` shows the breakfast/lunch/dinner card with 3 items totalling the macros.

- [ ] **Step 4: Commit**

```bash
git add components/log/MealLoggerSheet.tsx
git commit -m "feat(food): register SEARCH tab in MealLoggerSheet"
```

---

## Phase E — Change-food in Edit, confidence chip

### Task 15: "Change food" in Edit row

**Files:**
- Modify: `components/log/DraftReview.tsx`

- [ ] **Step 1: Add "Change food" affordance to the inline editor**

In `components/log/DraftReview.tsx`, extend the inline editor with a "Change food" toggle that swaps the qty editor for `<FoodSearchPicker/>`.

Add at the top:
```ts
import { FoodSearchPicker } from "./FoodSearchPicker";
import type { SearchCandidate } from "@/lib/food/types";
```

Add a new state:
```ts
const [pickingFor, setPickingFor] = useState<number | null>(null);
```

In `cancelEdit`, also reset:
```ts
setPickingFor(null);
```

When entering the edit branch for a row at index `idx`, replace the qty editor JSX with a conditional:

```tsx
{editing === idx && pickingFor === idx ? (
  <FoodSearchPicker
    onPicked={(candidate, qty_g) => swapFood(idx, candidate, qty_g)}
    onCancel={() => setPickingFor(null)}
  />
) : editing === idx ? (
  // ... existing qty editor block ...
  // Add a "Change food →" button alongside Save/Cancel:
  <>
    {/* existing qty input + presets */}
    <button
      type="button"
      onClick={() => setPickingFor(idx)}
      className="text-xs text-zinc-400 underline"
    >
      Change food →
    </button>
    {/* existing Save/Cancel buttons */}
  </>
) : ...
```

Add the `swapFood` handler near `saveQty`:

```ts
const swapFood = async (idx: number, candidate: SearchCandidate, qty_g: number) => {
  setEditBusy(true);
  setEditError(null);

  // We need a canonical_id to build the FoodItem. If the candidate is a fresh
  // OFF/USDA hit, write it to cache first via a small server-side write.
  // Reuse /api/food/draft's cache-write path by calling a tiny new endpoint?
  // Or do it inline here — for simplicity, route through /api/food/draft style:
  // build a single-item draft, capture the resolved item, then PATCH the
  // parent entry with that item swapped in, then DELETE the throwaway draft.
  //
  // That's clunky. Simpler: extract the cache-write into a shared helper and
  // expose POST /api/food/cache-pick { candidate } → { canonical_id, db_source }.
  //
  // For this task, inline the cache write via a new endpoint added in Step 2.

  try {
    let canonical_id = candidate.canonical_id;
    let db_source: "usda" | "openfoodfacts" | "manual" = "openfoodfacts";

    if (candidate.source === "db") {
      if (!canonical_id) throw new Error("db_candidate_missing_canonical_id");
      // The DraftReview client doesn't know the db source; fetch it.
      const r = await fetch(`/api/food/cache-pick?canonical_id=${canonical_id}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "cache_lookup_failed");
      db_source = j.source;
    } else {
      const r = await fetch("/api/food/cache-pick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidate }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "cache_pick_failed");
      canonical_id = j.canonical_id;
      db_source = j.source;
    }

    // Build the replacement FoodItem
    const macros = macrosForQty(candidate.per_100g, qty_g);
    const newItem: FoodItem = {
      name: candidate.name,
      qty_g,
      ...macros,
      per_100g: candidate.per_100g,
      source: "db",
      db_ref: { source: db_source, canonical_id: canonical_id! },
      confidence: "high",
      match_score: 1.0,
    };

    const updatedItems = entry.items.map((it, i) => (i === idx ? newItem : it));

    const res = await fetch(`/api/food/entries/${entry.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: updatedItems }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({ error: "patch_failed" }));
      throw new Error(json.error || "patch_failed");
    }
    const newTotals = updatedItems.reduce(
      (acc, it) => ({
        kcal:      acc.kcal      + it.kcal,
        protein_g: acc.protein_g + it.protein_g,
        carbs_g:   acc.carbs_g   + it.carbs_g,
        fat_g:     acc.fat_g     + it.fat_g,
        fiber_g:   acc.fiber_g   + it.fiber_g,
      }),
      { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
    );
    onChange({
      ...entry,
      items: updatedItems,
      totals: newTotals,
      is_estimated: updatedItems.some((it) => it.source === "llm"),
    });
    setEditing(null);
    setPickingFor(null);
  } catch (e) {
    setEditError((e as Error).message);
  } finally {
    setEditBusy(false);
  }
};
```

- [ ] **Step 2: Create `/api/food/cache-pick` helper endpoint**

Create `app/api/food/cache-pick/route.ts`:

```ts
// app/api/food/cache-pick/route.ts
//
// GET ?canonical_id=<uuid> → { source } — look up an existing cache row's source.
// POST { candidate: SearchCandidate } → { canonical_id, source } — write a fresh
//   OFF/USDA candidate to food_db_cache and return its canonical_id.
//
// Used by <DraftReview/>'s "Change food" swap. /api/food/draft does the same
// inline; this endpoint exists so Edit-swap doesn't need to spin a draft.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import type { FoodDbCacheRow } from "@/lib/food/types";

const CandidateSchema = z.object({
  name: z.string().min(1),
  per_100g: z.object({
    kcal: z.number().nonnegative(),
    protein_g: z.number().nonnegative(),
    carbs_g: z.number().nonnegative(),
    fat_g: z.number().nonnegative(),
    fiber_g: z.number().nonnegative(),
  }),
  source: z.enum(["db", "off", "usda"]),
  canonical_id: z.string().uuid().nullable(),
  image_url: z.string().url().nullable(),
});

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const canonical_id = url.searchParams.get("canonical_id");
  if (!canonical_id) return NextResponse.json({ error: "missing_canonical_id" }, { status: 400 });

  const service = createSupabaseServiceRoleClient();
  const { data } = await service
    .from("food_db_cache")
    .select("source")
    .eq("canonical_id", canonical_id)
    .single();
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ source: (data as { source: string }).source });
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = z.object({ candidate: CandidateSchema }).safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const { candidate } = parsed.data;
  if (candidate.source === "db") {
    if (!candidate.canonical_id) return NextResponse.json({ error: "db_candidate_missing_canonical_id" }, { status: 400 });
    // Look up source.
    const service = createSupabaseServiceRoleClient();
    const { data } = await service
      .from("food_db_cache")
      .select("source")
      .eq("canonical_id", candidate.canonical_id)
      .single();
    if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ canonical_id: candidate.canonical_id, source: (data as { source: string }).source });
  }

  const db_source: "openfoodfacts" | "usda" = candidate.source === "off" ? "openfoodfacts" : "usda";
  const service = createSupabaseServiceRoleClient();
  const { data: inserted, error } = await service
    .from("food_db_cache")
    .insert({
      source: db_source,
      upc: null,
      name: candidate.name,
      per_100g: candidate.per_100g,
      serving_size_g: null,
      raw_payload: { picked_via: "edit-swap", at: new Date().toISOString() },
    })
    .select("*")
    .single();
  if (error || !inserted) {
    console.error("[/api/food/cache-pick] insert failed", error);
    return NextResponse.json({ error: "cache_insert_failed" }, { status: 500 });
  }
  return NextResponse.json({
    canonical_id: (inserted as FoodDbCacheRow).canonical_id,
    source: db_source,
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Manual exercise**

Restart dev. Parse a meal that produces a wrong row (or use SEARCH to add an item then deliberately want to swap it). Tap ✎ on the row → qty editor appears → tap "Change food →" → search picker appears → search "halloumi" → pick a result → enter qty 50 → tap Add → row updates with new food + macros, totals update. Sheet stays open at the draft review.

Tap Commit.

- [ ] **Step 5: Commit**

```bash
git add components/log/DraftReview.tsx app/api/food/cache-pick/route.ts
git commit -m "feat(food): Change-food affordance via FoodSearchPicker in DraftReview"
```

---

### Task 16: Confidence chip

**Files:**
- Modify: `components/log/DraftReview.tsx`

- [ ] **Step 1: Add chip rendering logic**

In `components/log/DraftReview.tsx`, replace the existing `it.source === "llm"` chip block in the non-editing row render with a helper that maps to one of the four chip states.

Add this helper at module top (outside the component):

```tsx
type ChipState = "db-high" | "off-high" | "low-match" | "estimated" | null;

function chipFor(item: { source: "db" | "llm"; db_ref: { source: string } | null; match_score: number | null }): ChipState {
  if (item.source === "llm") return "estimated";
  if (item.source !== "db") return null;
  const score = item.match_score ?? 1.0;
  if (score < 0.7) return "low-match";
  if (item.db_ref?.source === "openfoodfacts") return "off-high";
  return "db-high";
}

function ChipBadge({ state }: { state: ChipState }) {
  if (state === null) return null;
  const cfg = {
    "db-high":   { color: "bg-emerald-500", label: null as string | null },
    "off-high":  { color: "bg-sky-500",     label: null as string | null },
    "low-match": { color: "bg-amber-500",   label: "low match" },
    "estimated": { color: "bg-amber-500",   label: "estimated" },
  }[state];
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block h-2 w-2 rounded-full ${cfg.color}`} />
      {cfg.label && <span className="text-xs text-amber-400">{cfg.label}</span>}
    </span>
  );
}
```

In the row render (non-editing case), replace:

```tsx
                {it.source === "llm" && (
                  <span className="text-xs text-amber-400">estimated</span>
                )}
```

with:

```tsx
                <button
                  type="button"
                  onClick={() => startEdit(idx)}
                  aria-label={`Edit ${it.name}`}
                  className="cursor-pointer"
                >
                  <ChipBadge state={chipFor(it)} />
                </button>
```

The chip tap = same action as the ✎ button (per spec Section 5).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Manual exercise — chip states**

Parse the failure-case meal again. Each row should now display a chip:
- Egg fried: green dot (USDA high-match)
- Olive oil: green dot
- Halloumi: blue dot (OFF) or green dot (USDA, if matched)
- Wholewheat toast: blue dot (OFF) or amber "low match" (if score 0.5-0.7)

Type "frfgxxx random garbage 50g" → likely LLM fallback → amber "estimated" chip.

Tap any chip → expands to the edit row (same as ✎).

- [ ] **Step 4: Commit**

```bash
git add components/log/DraftReview.tsx
git commit -m "feat(food): confidence chip on draft review rows"
```

---

## Phase F — Wrap-up

### Task 17: Audit + final verification

**Files:** none — pure verification

- [ ] **Step 1: Run the food-aggregation audit**

```bash
AUDIT_USER_ID=<your-user-uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-food-aggregation.mjs
```

Find your user_id via Supabase dashboard → Auth → Users, or `select id from auth.users;`.

Expected: PASS — `daily_logs` nutrition columns equal `sum_food_entries(...)` for every date with committed entries.

- [ ] **Step 2: Exercise the full failure case end-to-end**

In a clean session (no leftover drafts):

1. `/meal` → breakfast → SEARCH → "halloumi" → pick Balade or generic halloumi → 50g → Add
2. Same search modal → "olive oil" → pick best result → 14g → Add
3. Same → "egg fried" → 100g → Add
4. Review → ✎ on any row → tweak qty → Save
5. ✎ on another row → Change food → pick a different one → Add
6. Commit
7. Verify on `/meal` card

Then test the parser path alongside:
8. `/meal` → lunch → TYPE → "200g chicken breast and 1 cup rice" → Parse
9. Verify both items resolve correctly + qty exact
10. Commit
11. Verify

- [ ] **Step 3: Final typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit (only if Step 1's audit revealed reaggregation bugs requiring code fixes)**

If the audit was clean, no commit needed — close out the branch.

---

## Self-review

**Spec coverage check** (against `docs/superpowers/specs/2026-05-19-food-search-and-edit-design.md`):

- ✅ §1 SEARCH tab UI → Tasks 12-14
- ✅ §1 `GET /api/food/search` → Task 10
- ✅ §1 `POST /api/food/draft` → Task 11
- ✅ §1 cache-at-pick-time semantics → Task 11
- ✅ §2 `<DraftReview/>` extraction → Task 6
- ✅ §2 `✎` Edit (qty) → Task 7
- ✅ §2 `×` Delete with last-row→Discard → Task 8
- ✅ §2 Change-food via picker → Task 15
- ✅ §2 PATCH endpoint extension → Task 1 step 4 (ItemSchema match_score)
- ✅ §3A Haiku prompt fixes → Task 3
- ✅ §3B USDA scoring + pageSize=5 + threshold → Task 4
- ✅ §3C OpenFoodFacts as 2nd-tier → Task 5
- ✅ §4 Confidence chip → Task 16
- ✅ Type extensions (match_score, SearchCandidate, raw_input.source='search') → Task 1
- ✅ Token-overlap scoring shared between USDA / OFF / SEARCH → Task 2
- ✅ Audit verification → Task 17

**Placeholder scan:** no "TBD" / "TODO" / "add appropriate" markers in the plan body — verified.

**Type consistency:** `SearchCandidate`, `FoodItem.match_score`, `chipFor`, and `swapFood` signatures are consistent across tasks. `pickBestCandidate`'s generic constraint `<T extends { name: string }>` matches its call sites in Tasks 4 and 5.

**New endpoint catalogue:**
- `GET /api/food/search` (Task 10)
- `POST /api/food/draft` (Task 11)
- `GET /api/food/cache-pick`, `POST /api/food/cache-pick` (Task 15)
- (No changes to existing PATCH/DELETE/commit/parse/barcode beyond schema extension in Task 1)
