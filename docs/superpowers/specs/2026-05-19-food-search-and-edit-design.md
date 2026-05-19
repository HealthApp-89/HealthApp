# Food logging: manual search, per-row edit-swap, parser tightening

**Status:** design
**Date:** 2026-05-19
**Owner:** single-user app — Abdelouahed

## Problem

The AI text parser fails badly on common real-world meals. Concrete failure case (2026-05-19):

| User input | Parser output | Failure |
|---|---|---|
| 2 fried eggs | 100g egg ✅ | (correct) |
| 1 tbsp olive oil | "Oil, corn, peanut, **and olive**" — 14g | USDA `pageSize=1` returns the highest-ranked text match without quality scoring |
| 50g Balade halloumi | "Buttermilk, low fat" — 50g | Trigram cache threshold (0.6) is too loose; shared "low fat" tokens push similarity over the line. USDA has no halloumi at all |
| 45g wholewheat toast | "Sugars, brown" — 30g | Haiku's prompt has "1 slice bread ≈ 30g" as a household-unit default and overrode the user's explicit 45g; USDA returned garbage |

Three out of four items wrong. Recovery today: Discard the whole entry and retype. There is **no search bar** in the meal logger — `<MealLoggerSheet/>` only offers TYPE (free-text → AI), SCAN (barcode), and two coming-soon tabs. No way to manually pick a food, no way to fix a wrong row on the draft.

## Goals

1. Give the user a reliable manual path to log foods today — even when the parser fails on a brand or regional item.
2. Make any parser mistake cheap to fix without re-typing the meal.
3. Reduce the parser's mistake rate on the common failure modes (USDA garbage matches, ignored explicit quantities).
4. Surface confidence so ambiguous resolutions visually nudge the user to verify.

## Non-goals

- PHOTO / VOICE logging tabs (remain "coming soon")
- Editing committed entries (immutability is a future "edit history" spec)
- A user-owned custom-foods table for personal recipes (future spec)
- Schema changes to `food_db_cache` (existing `source` check already accepts `'openfoodfacts'`)
- Schema changes to `food_log_entries.kind` (search-built drafts use `kind='text'` with provenance in `raw_input.source`)
- FatSecret / Edamam / regional food APIs (revisit after a week of real OFF coverage; explicitly deferred)
- Daily-log aggregation, `sum_food_entries`, or Yazio-ingest precedence — unchanged

## Approach

Combined: ship the recovery path first, then tighten the parser.

1. **Manual food search** (SEARCH tab) — unblocks regional / brand foods today
2. **Per-row Edit-swap** on the draft review screen — one-tap fix instead of Discard+retype
3. **Parser tightening** — Haiku prompt, USDA scoring, OpenFoodFacts as 2nd-tier lookup
4. **Confidence chip** on each draft row — visual nudge for low-match resolutions

This order makes step 1 immediately useful, step 2 turns every parser miss into a one-tap fix, step 3 reduces miss rate, step 4 makes the remaining misses visible. Each step is independently shippable; if 3 or 4 slip, 1 and 2 still solve the core complaint.

## Architecture

### 1. SEARCH tab

**New file:** `components/log/MealLoggerSearchTab.tsx` — fourth tab in `<MealLoggerSheet/>`, inserted between TYPE and SCAN. Replaces the current "search bar" gap.

**UI** (mobile, within the bottom sheet):

```
[ Search input — debounced 300ms ]

results:
  [ Halloumi cheese, semi-hard            DB ]
    per 100g: 316 kcal · 22 P · 2 C · 25 F
  [ Balade Halloumi Light                OFF ]
    per 100g: 230 kcal · 24 P · 1 C · 14 F
  [ Halloumi, grilled                   USDA ]

after tap:
  qty: [ 50 ] g    [50] [100] [150] [200]
                   [ + Add to meal ]

running draft list (above search):
  1. Eggs, fried — 100g · 196 kcal    [✎] [×]
  2. Olive oil   —  14g · 124 kcal    [✎] [×]

footer:
  [           Commit (2 items, 320 kcal)           ]
```

Multiple picks accumulate into a single `food_log_entries` row (matches the parser's multi-item shape).

**New endpoint:** `GET /api/food/search?q=<query>&limit=20`

Server-side parallel fanout:
1. `food_db_cache` trigram match (threshold `0.4` — looser than the parser's `0.6` because the user picks the result themselves)
2. OpenFoodFacts `cgi/search.pl?search_terms=<q>&json=1&page_size=10&fields=product_name,nutriments,code,image_thumb_url` — 5s timeout
3. USDA `/foods/search?pageSize=10&dataType=Foundation,SR%20Legacy` — 5s timeout

Merge + dedupe (case-insensitive name match), sort by `(source: db > off > usda, then trigram score)`, return top 20. If cache trigram score ≥ 0.7 on the top hit, short-circuit OFF/USDA to save latency.

Response shape:

```ts
type SearchCandidate = {
  name: string;
  per_100g: FoodMacros;
  source: "db" | "off" | "usda";
  canonical_id: string | null;    // null until cached (cached at pick-time, not search-time)
  image_url: string | null;       // OFF thumbnails only
};
```

**New endpoint:** `POST /api/food/draft`

Body: `{ items: Array<{ candidate: SearchCandidate, qty_g: number }>, meal_slot, eaten_at }`

For each item:
- If `candidate.canonical_id` is null (fresh OFF/USDA hit), insert into `food_db_cache` and capture the new `canonical_id`
- Compute macros via [macrosForQty](lib/food/types.ts)
- Build `FoodItem` with `source: 'db'`, `db_ref: { source: candidate.source === 'off' ? 'openfoodfacts' : candidate.source, canonical_id }`, `match_score: 1.0` (user-confirmed), `confidence: 'high'`

Insert one `food_log_entries` row with `kind='text'`, `raw_input: { source: 'search', items: candidates_snapshot }`, the resolved items, computed totals, `status='draft'`. Returns the entry.

`POST /api/food/commit { entry_id }` (existing) flips status to committed — unchanged.

### 2. Per-row Edit-swap on the draft

**Required refactor first:** the draft review UI is currently duplicated inline in `MealLoggerTypeTab.tsx` and `MealLoggerScanTab.tsx`. Extract to a shared component before adding Edit affordances.

**New file:** `components/log/DraftReview.tsx`

```ts
type DraftReviewProps = {
  entry: FoodLogEntry;
  onChange: (updated: FoodLogEntry) => void;  // after PATCH
  onCommitted: () => void;
  onDiscarded: () => void;
};
```

Renders: items list with `✎` and `×` per row, totals footer, Discard + Commit buttons.

Used by TYPE, SCAN, and the new SEARCH tab. Each tab keeps its own input flow but hands off to `<DraftReview/>` for the review phase.

**Edit flow** (inline, no modal stack):

Tapping `✎` on row index `i` expands that row into an editor:

```
─── editing item 3 ───
Food:  Sugars, brown                  [Change food →]
Qty:   [ 45 ] g    [50] [100] [150] [200]
                                    [Cancel] [Save]
```

- *Qty change only:* live-recomputes macros locally via `macrosForQty` — no network until Save.
- *Change food →:* replaces the inline editor with the same `<FoodSearchPicker/>` used by the SEARCH tab (extracted from `MealLoggerSearchTab.tsx`), in single-pick mode. Picking a candidate fills the food + keeps the current qty.
- Save → `PATCH /api/food/entries/[id]` with the new full items array → on 200, parent updates draft state via `onChange`.
- Cancel → discard local changes, collapse the row.

**Delete flow:**

Tapping `×` on a row:
- If the row is the only item → behaves as Discard (calls existing `DELETE /api/food/entries/[id]`, then `onDiscarded`)
- Otherwise → `PATCH /api/food/entries/[id]` with the remaining items

**Existing endpoint** `PATCH /api/food/entries/[id]` already supports items replacement on same-UTC-day entries (the today-only invariant lets the user fix mistakes even after commit). Reuse as-is, but:

- Extend `ItemSchema` to accept optional `match_score: number | null` (Section 5)
- Server already recomputes `totals` and `is_estimated` from items — no change needed
- Server already calls `reaggregateDay` after update — committed-entry edits flow through to `daily_logs` correctly
- Same-UTC-day invariant means yesterday's committed entries are immutable in practice (returns 403 `edit_past_day_disallowed`)

Server-side recompute is defense-in-depth: `daily_logs` is aggregated via `sum_food_entries` from committed items, and trusting client totals opens a skew vector. The existing handler already does this correctly.

### 3. Parser tightening

**A. Haiku prompt** ([lib/food/parse.ts](lib/food/parse.ts)) — append two rules:

1. *Explicit quantity overrides defaults.* "When the user specifies a quantity in grams or oz, use that exact quantity. The household-unit table below applies ONLY when no explicit g/oz quantity is given."
2. *Preserve modifiers.* "Modifiers in the description — 'low fat', 'grilled', 'whole wheat', 'fried', brand names — must appear in the `name` field. Do not drop them."

Rule 1 fixes "45g wholewheat toast" → 30g. Rule 2 helps downstream scoring (a name of "halloumi grilled" scores against USDA's "Cheese, halloumi, grilled" candidate; bare "halloumi" doesn't).

**B. USDA scoring** ([lib/food/lookup.ts](lib/food/lookup.ts)):

- `pageSize=5` (not 1)
- Tokenize query and candidate names: lowercase, split on punctuation/whitespace, drop stopwords (`of`, `the`, `and`, `a`, `or`)
- Score each candidate:
  ```
  recall    = |query_tokens ∩ candidate_tokens| / |query_tokens|
  precision = |query_tokens ∩ candidate_tokens| / |candidate_tokens|
  score     = recall * 0.7 + precision * 0.3
  ```
- **Accept** if best `score ≥ 0.5`. Tiebreaker: shorter candidate name by character count wins (proxy for "more focused match").
- **Reject** all 5 if best `score < 0.5` → fall through to OpenFoodFacts.
- The chosen `score` is returned on the resolved `FoodItem` as `match_score` (Section 5).

Walk-through:
- *"olive oil"* (tokens `{olive, oil}`): top USDA hits include "Oil, olive, salad or cooking" (`{oil, olive, salad, cooking}` — stopword `or` dropped; recall=1.0, precision=2/4=0.5, score=0.85) and "Oil, corn, peanut, and olive" (`{oil, corn, peanut, olive}`; recall=1.0, precision=0.5, score=0.85; longer name → tiebreaker picks "olive salad"). ✓
- *"halloumi grilled"* (tokens `{halloumi, grilled}`): USDA has no halloumi. Best candidate misses `halloumi`, recall ≤ 0.5, score < 0.5 → reject → fall to OFF. ✓

**C. OpenFoodFacts as 2nd-tier lookup** in `resolveItemMacros`:

New helper `lookupOpenFoodFacts(name)`:
- `https://world.openfoodfacts.org/cgi/search.pl?search_terms=<name>&json=1&page_size=5`
- 5s timeout
- Convert `nutriments` to per-100g: `energy-kcal_100g`, `proteins_100g`, `carbohydrates_100g`, `fat_100g`, `fiber_100g`
- Apply same token-overlap scoring + 0.5 threshold as USDA
- On accept: insert into `food_db_cache` with `source='openfoodfacts'`, return cached row

Updated chain in `resolveItemMacros`:
1. Cache trigram (≥ 0.6) — existing
2. USDA with scoring — modified
3. **OpenFoodFacts** with scoring — new, between USDA and LLM
4. LLM estimate flagged `source='llm'` / `confidence='low'` — existing

### 4. Confidence chip

Per-row chip in `<DraftReview/>`, driven by `FoodItem.source`, `db_ref.source`, and the new `match_score`:

| Status | Color | Label | Trigger |
|---|---|---|---|
| `db` high | green dot | (none) | `source='db'`, `db_ref.source` ∈ {`usda`,`manual`}, `match_score ≥ 0.7` |
| `off` | blue dot | (none) | `source='db'`, `db_ref.source='openfoodfacts'`, `match_score ≥ 0.7` |
| `low-match` | amber dot | "low match" | `source='db'`, `0.5 ≤ match_score < 0.7` |
| `estimated` | amber dot | "estimated" | `source='llm'` (already exists in current UI) |

Tapping the chip = same action as tapping `✎`. Two affordances, one outcome — the chip is the visual nudge, the pencil is the universal edit handle.

**Type extension** ([lib/food/types.ts](lib/food/types.ts)):

```ts
export type FoodItem = {
  // ... existing fields ...
  match_score: number | null;  // null for LLM/manual; 0..1 for db/off lookups
};
```

`food_log_entries.items` is `jsonb`, so adding `match_score` is non-breaking. Pre-existing entries without `match_score` render with no chip beyond the source color. No migration.

## Data shapes

**`SearchCandidate`** (new, in `lib/food/types.ts`):

```ts
export type SearchCandidate = {
  name: string;
  per_100g: FoodMacros;
  source: "db" | "off" | "usda";
  canonical_id: string | null;
  image_url: string | null;
};
```

**`FoodLogEntryRawInput`** extension — add `'search'` source variant:

```ts
export type FoodLogEntryRawInput =
  | { kind: "text"; text: string; source?: "parse" | "search" }
  | { kind: "barcode"; upc: string; qty_g: number }
  | { kind: "photo"; photo_path: string }
  | { kind: "voice"; audio_path: string; transcript: string };
```

When `source='search'`, the `raw_input` shape also carries the original candidate snapshots:

```ts
| { kind: "text"; source: "search"; items: SearchCandidate[]; qty_g: number[] }
```

(Captures what the user picked vs what the macros resolved to — useful for future debugging.)

**`FoodItem.db_ref`** — `manual` value already exists in the schema but is unused; keep it reserved for the future custom-foods spec.

## API surface (new + modified)

| Endpoint | Method | Purpose | Status |
|---|---|---|---|
| `/api/food/search` | GET | Multi-source candidate search | new |
| `/api/food/draft` | POST | Create draft from user-picked items | new |
| `/api/food/entries/[id]` | PATCH | Update items on a same-day entry | existing — extend ItemSchema for `match_score` |
| `/api/food/entries/[id]` | DELETE | Discard / un-commit an entry (sets status='rejected') | existing — unchanged |
| `/api/food/parse` | POST | Free-text → draft entry | existing — unchanged (parser internals tighten) |
| `/api/food/barcode` | POST | UPC → draft entry | existing — unchanged |
| `/api/food/commit` | POST | Flip draft → committed | existing — unchanged |

## Module layout

```
lib/food/
  parse.ts            — Haiku prompt tightened (Section 3A)
  lookup.ts           — USDA scoring + OFF lookup added (Section 3B/C)
  types.ts            — FoodItem.match_score, SearchCandidate, raw_input.source (Section 5)
  search.ts           — NEW: server-side fanout (cache + OFF + USDA), token-overlap scoring shared with lookup.ts
  meal-slot.ts        — unchanged
  barcode.ts          — unchanged

components/log/
  MealLoggerSheet.tsx        — adds SEARCH tab
  MealLoggerTypeTab.tsx      — input-only; hands off to <DraftReview/>
  MealLoggerScanTab.tsx      — input-only; hands off to <DraftReview/>
  MealLoggerSearchTab.tsx    — NEW
  MealLoggerComingSoonTab.tsx — unchanged
  DraftReview.tsx            — NEW: shared draft review with ✎/×
  FoodSearchPicker.tsx       — NEW: search input + candidate list + qty entry (used by SEARCH tab and Edit-swap)

app/api/food/
  search/route.ts            — NEW
  draft/route.ts             — NEW
  entries/[id]/route.ts      — adds PATCH handler
```

Shared token-overlap scoring lives in `lib/food/search.ts` (despite the name, it's the matching engine used by both the SEARCH endpoint and the parser's resolve chain).

## Error handling

- **OFF or USDA timeout** during search → return partial results from sources that did respond; no error toast. Empty results → "No matches" with no error.
- **OFF or USDA timeout** during parser resolve → fall through chain. LLM estimate still available as final fallback.
- **Cache write failure** during search-pick → still return the resolved candidate to the client; user can proceed (the cache miss just means the next user/parser run for the same query has to re-hit OFF/USDA). Log the error.
- **PATCH `/api/food/entries/[id]`** with empty items array → existing handler already rejects (Zod `min(1)`), 400. Client auto-routes last-row delete to DELETE.
- **PATCH** on an entry whose `eaten_at` is not today (UTC) → existing handler returns 403 `edit_past_day_disallowed`. UI surfaces "Only today's entries can be edited."

## Testing

No automated test suite in this project. Verify manually:

**Happy paths:**
1. SEARCH tab — search "chicken breast", pick top result, qty 200g, Commit → row appears in `/meal` journal with correct macros
2. SEARCH tab — search "halloumi", confirm OFF result appears, pick "Balade Halloumi Light" or similar, qty 50g, Commit → row appears
3. Edit-swap — parse "2 fried eggs and 50g halloumi", on draft tap `✎` on the halloumi row, change food via picker, Save → row updates with new food name + recomputed macros, total updates

**Parser regression on the failure case:**
4. Parse "2 fried eggs with 1 tablespoon olive oil, 50g of low fat Balade grilled halloumi, 45g of wholewheat toast" — expect:
   - 2 fried eggs (100g) ✓
   - Olive oil 14g → "Oil, olive, salad or cooking" or similar (not "corn, peanut, and olive")
   - Halloumi 50g → either USDA halloumi entry OR OFF Balade halloumi (not buttermilk)
   - Wholewheat toast 45g → OFF bread match (not brown sugar); qty=45g exactly

**Confidence chip:**
5. Parse a meal that triggers each chip state — verify color + label render correctly, tapping opens edit

**RLS / 409:**
6. Try PATCH on a committed entry → expect 409 + clear error message

**Audit:**
7. After mixed parse + search + edit + commit usage across a day, run `AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-food-aggregation.mjs` → expect `daily_logs` matches `sum_food_entries` for that date.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| OFF rate-limiting under heavy search use | Cache writes mean repeat queries hit cache; OFF free tier is generous for single-user app |
| Token-overlap scoring is too aggressive (rejects valid matches) | Threshold is tunable; LLM-estimate fallback still available |
| Token-overlap scoring is too permissive (accepts garbage) | Confidence chip surfaces low-match results visually; Edit-swap is one tap |
| Adding `match_score` field to `FoodItem` breaks Yazio ingest reading old rows | `match_score?: number \| null` is optional everywhere; defaults to null |
| SEARCH and parser write to same cache, race on first-time entry | `food_db_cache` has no uniqueness on `(source, name)` — duplicates possible but harmless (trigram still finds the right one). UPC-uniqueness preserved via existing `food_db_cache_source_upc_unique` |
| OFF returns multilingual product names (e.g., Arabic + English) | Use `product_name` field which is the user's locale preference (default English from the API host) |

## Open questions

None.

## Future work

- **Custom foods table** — let the user save their own "Mom's chili" or "halloumi I usually buy" entries (`food_db_cache.source='manual'` is already reserved for this)
- **FatSecret as 4th-tier** — if OFF coverage proves thin in real Dubai use, add as a parallel lookup
- **Edit history / versioned committed entries** — currently committed = immutable; future spec could allow corrections that preserve audit trail
- **Photo and voice tabs** — separate specs

## References

- Failure case screenshot: 2026-05-19 user-reported breakfast log
- [lib/food/parse.ts](lib/food/parse.ts) — current Haiku extraction
- [lib/food/lookup.ts](lib/food/lookup.ts) — current cache → USDA → LLM chain
- [components/log/MealLoggerSheet.tsx](components/log/MealLoggerSheet.tsx) — current 4-tab sheet
- [components/log/MealLoggerTypeTab.tsx](components/log/MealLoggerTypeTab.tsx) — current inline draft review
- [supabase/migrations/0018_food_logging.sql](supabase/migrations/0018_food_logging.sql) — food_db_cache schema, already supports `source='openfoodfacts'`
