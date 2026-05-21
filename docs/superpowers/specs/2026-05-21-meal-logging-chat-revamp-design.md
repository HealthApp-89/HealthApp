# Meal Logging Chat Revamp — Design

**Status:** draft
**Author:** Claude (with Abdelouahed)
**Date:** 2026-05-21
**Related:** [2026-05-19-meal-journal-design.md](./2026-05-19-meal-journal-design.md), [2026-05-19-food-logging-v1-1-copy-favorites-library-design.md](./2026-05-19-food-logging-v1-1-copy-favorites-library-design.md), [2026-05-19-multi-coach-team-design.md](./2026-05-19-multi-coach-team-design.md)

## Problem

Free-text meal logging produces nonsense for common foods. Typing "omelette" today fails because:

1. **USDA spelling miss.** USDA has the right baseline filed under "omelet" (`Egg, whole, cooked, omelet`, 154 kcal/100g). The query token "omelette" never overlaps with USDA's "omelet" → 0 hits. Confirmed empirically against the live USDA endpoint with the project key.
2. **OpenFoodFacts noise.** With USDA missing, [lib/food/lookup.ts:resolveItemMacros](../../../lib/food/lookup.ts) falls through to OFF. OFF's text search returns packaged ready-meals: live query for "omelette" gives `spanish spinach omelette (unearthed)` (138 kcal, 5.1g P, 7.1g F) as the top scoring candidate. The token-overlap scorer (0.7·recall + 0.3·precision, threshold 0.5) accepts a single-token query against a 4-token branded product with score 0.775, then caches it.
3. **Search-tab source ranking inverted.** [lib/food/search.ts:28](../../../lib/food/search.ts) ranks `db (0) > off (1) > usda (2)`. OFF beats USDA in the picker — backwards. USDA Foundation/SR Legacy is the curated baseline; OFF is brand packaging.
4. **No personal library.** A user with a regular set of foods ("Balade halloumi", "Abdel's morning omelette") has to retype components or hunt through the LIBRARY tab. The library is a UX affordance, not a resolution-chain participant.
5. **One-shot text input has no disambiguation.** The user types once, the resolver guesses once. When ambiguous ("low fat" — which brand?), there is no chance to clarify before commit.

The user's reference experience — "I tell ChatGPT what I ate, the macros are usually good" — combines (a) conversational input that can clarify, (b) baked-in nutritional knowledge as a graceful fallback, (c) no UI ceremony.

## Goals

- Make free-text meal logging produce trustworthy macros for common foods on the first try.
- Replace the one-shot TEXT tab with a Nora-led chat thread that asks back only when needed.
- Let the user save custom items and recipes into a personal library that beats USDA in the resolution chain.
- Fix the catalog failure modes (spelling, OFF noise, cache poisoning, search ranking) in the same arc.

## Non-goals

- Photo modality. Stays out of scope (the dedicated photo spec, "Spec B" in the v1.1 notes, will tackle it).
- Voice as a separate tab. Folded into the chat composer's mic button. Voice-to-text only.
- Multi-day chat history in /meal. The Nora thread is scoped to today; older days are reachable by changing the date selector.
- Cross-coach routing. /meal's thread is always Nora; Peter/Carter/Remi never appear there.
- Cross-meal "macro budget" advice in /meal. Nora answering "what should I eat tonight to hit my macros" lives in /coach. Meal-log Nora is transactional.

## Architecture overview

Two layers:

**Resolution layer (deterministic).** A server pipeline that turns text into items+macros via the catalog. The pipeline runs on every parse, regardless of whether the user gets a clarification round-trip. Pure functions + DB I/O — no LLM in the hot path except for extraction (item names + grams) and a per-item LLM estimate when all catalog sources miss.

**Conversation layer (LLM-led, sparingly invoked).** Nora streams clarifying questions and suggestion chips only when the resolution layer returns at least one low-confidence item. The conversation layer wraps the resolution layer; it never substitutes for it. Common cases (everything resolved high-confidence) skip the LLM round-trip and render a structured preview directly.

```
                  user types in chat composer (inside MealLoggerSheet)
                                  │
                                  ▼
              POST /api/food/parse   (extract + resolve, deterministic)
                                  │
                  draft food_log_entries row + per-item confidence
                                  │
                ┌─────────────────┴──────────────────┐
                │ all items high-conf?               │ at least one low-conf?
                ▼                                    ▼
   render structured preview          POST /api/chat (mode=meal_log)
   in the thread, Confirm/Edit/         Nora streams clarification +
   Cancel buttons                       suggestion chips, can call
                                        save_to_library / pick_library_item
                                  │
                                  ▼
              user taps Confirm → POST /api/food/commit
                                  │
                                  ▼
           draft → committed, "✓ logged" bubble in thread
```

## Data model

### New table: `user_food_items`

Personal library — user-scoped, beats `food_db_cache` and USDA in the resolution chain. Holds both single foods and composite recipes in a unified shape.

```sql
CREATE TABLE user_food_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  per_100g jsonb,              -- {kcal, protein_g, carbs_g, fat_g, fiber_g}; NULL for recipes
  composite_of jsonb,          -- [{ name, qty_g }] expanded ingredients; NULL for single items
  default_serving_g numeric,   -- recipe-only: typical "1 serving" gram weight (omelette ≈ 100g)
  source text NOT NULL,        -- 'user_manual' | 'user_label' | 'user_recipe'
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- exactly one of per_100g vs composite_of must be present
  CONSTRAINT user_food_items_one_shape_chk
    CHECK ((per_100g IS NOT NULL) <> (composite_of IS NOT NULL))
);

CREATE INDEX user_food_items_user_idx ON user_food_items (user_id);
CREATE INDEX user_food_items_name_trgm_idx
  ON user_food_items USING gin (name gin_trgm_ops);

ALTER TABLE user_food_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user reads own items" ON user_food_items
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "user writes own items" ON user_food_items
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
```

**Why one table.** Recipes are composites of items; items are degenerate recipes. The schema split would force a `kind` discriminator everywhere with no real benefit. The `CHECK` constraint enforces that a row is either a per-100g single food (with macros) OR a composite (with ingredients) — never both, never neither.

**How recipes log.** When the user logs `1× Abdel's omelette`, the API expands `composite_of` into the meal's `food_log_entries.items[]` (the standard per-item shape, each with resolved macros). The row stores the recipe id in a new field:

```sql
ALTER TABLE food_log_entries
  ADD COLUMN recipe_id uuid REFERENCES user_food_items(id) ON DELETE SET NULL;
```

This means: aggregation queries (`sum_food_entries`, "how much egg this week") see the ingredients normally. The journal can collapse the entry under the recipe name when `recipe_id` is set, expanded on tap. Editing the recipe later does not retroactively change past logs — the resolved item rows are frozen in `food_log_entries.items[]` at commit time.

### `chat_messages` extension

The Nora thread inside the MealLoggerSheet posts to the same `chat_messages` table the coach uses. Two extensions:

```sql
-- Extend the existing kind allowlist. Latest set from 0024:
--   'coach','morning_intake','morning_brief','weekly_review',
--   'proactive_nudge','system_routing'
ALTER TABLE chat_messages
  DROP CONSTRAINT IF EXISTS chat_messages_kind_check;
ALTER TABLE chat_messages
  ADD CONSTRAINT chat_messages_kind_check
    CHECK (kind IN (
      'coach','morning_intake','morning_brief','weekly_review',
      'proactive_nudge','system_routing','meal_log'
    ));
```

`speaker='nora'` already exists from the multi-coach migration (0024). No new speaker.

**Filtering in /coach.** The existing `chat_messages_visible_idx` partial index from 0024 filters only `system_routing`. Replace it so `meal_log` is also excluded from the default /coach history reads. /meal queries explicitly select `kind='meal_log'`.

```sql
DROP INDEX IF EXISTS chat_messages_visible_idx;
CREATE INDEX chat_messages_visible_idx
  ON chat_messages (user_id, created_at desc)
  WHERE kind NOT IN ('system_routing','meal_log');
```

### Migration

One migration, `0027_meal_logging_chat_revamp.sql`, that bundles:
- `user_food_items` table + indexes + RLS
- `food_log_entries.recipe_id` column
- `chat_messages_kind_check` extension to include `meal_log`
- Replacement of `chat_messages_visible_idx` to exclude `meal_log` from default /coach history

## Resolution pipeline

### `resolveItemMacros` new chain

In [lib/food/lookup.ts](../../../lib/food/lookup.ts), replace the existing `cache → USDA → OFF → LLM` chain with `library → cache → USDA-with-spelling-fallback → LLM`.

```
1. user_food_items trigram match (scoped to current user)
   - threshold 0.6 same as cache
   - if composite, expand and recursively resolve each ingredient via the
     remaining chain (but a recipe's ingredients should usually already be
     in cache from prior usage)

2. food_db_cache trigram match (shared cache, current behavior)

3. USDA (with spelling fallback)
   - try literal query first
   - if 0 hits AND query contains any British-spelled token, retry with
     a normalised variant (one extra HTTP call, only when needed)
   - score candidates via existing pickBestCandidate; accept >= 0.5

4. LLM estimate (existing fallback; remains uncached as today)

OFF is removed from this chain entirely.
```

OFF stays as a source for [/api/food/barcode/route.ts](../../../app/api/food/barcode/route.ts) — barcode lookups have an exact key and OFF is the right database for them.

### Spelling fallback for USDA

A small static map in [lib/food/spelling.ts](../../../lib/food/spelling.ts) (new file):

```ts
const BRIT_TO_US: Record<string, string> = {
  omelette: "omelet",
  yoghurt: "yogurt",
  courgette: "zucchini",
  aubergine: "eggplant",
  prawn: "shrimp",
  // extensible — only add proven misses
};

/** Return a US-spelled variant of the query, or null if no token maps. */
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

Wired into the USDA call: if first response has 0 foods, call once more with the normalized variant. No extra fan-out, no model call, deterministic.

### Confidence semantics

Each resolved item carries a `confidence: 'high' | 'medium' | 'low'`. The conversation layer only fires when at least one item is `medium` or `low`. Mapping:

- **high** — user_food_items match (score ≥ 0.8), or USDA/cache match (score ≥ 0.7)
- **medium** — USDA/cache match (0.5 ≤ score < 0.7)
- **low** — LLM-estimate source (catalog missed entirely)

### Search-tab source ranking flip

In [lib/food/search.ts:28](../../../lib/food/search.ts), change:

```ts
const SOURCE_RANK = { db: 0, usda: 1, off: 2 } as const;
// Library entries sort first when results are merged via the new branch.
```

Add `user_food_items` to the fan-out alongside cache/USDA/OFF; rank it at 0 (highest). This makes the SEARCH tab return your library first, then USDA-curated baselines, then OFF brand products as the long tail.

### Cache cleanup (one-shot)

A script `scripts/purge-low-precision-off-cache.mjs` (new) iterates `food_db_cache` rows where `source='openfoodfacts'`, recomputes the token-overlap precision of `name` against a synthetic short query (the first token of `name`), and deletes rows where precision < 0.5. Read-only dry-run by default; pass `--apply` to delete. Run once after migration. Catches the "spanish spinach omelette" sitting in cache from past resolves.

## UX flow

### Surface

The /meal page keeps its current journal as the primary view (per-slot cards, totals strip, date selector). The `+ Log entry` floating button and the per-slot `+` buttons open [components/log/MealLoggerSheet.tsx](../../../components/log/MealLoggerSheet.tsx), as today.

Inside the sheet:

- **TEXT tab is removed.** Replaced by a CHAT tab that is the default and pre-focused.
- **SCAN tab is removed.** The barcode scanner button moves into the chat composer.
- **VOICE tab is removed.** The mic button moves into the chat composer (Web Speech API transcribes into the input).
- **SEARCH tab remains** — for browsing without typing. Picking from SEARCH appends a resolved item to the current chat draft (does not commit independently).
- **LIBRARY tab remains** — Favorites / Recent / Frequent / Catalog. Picking appends to the current draft, same as SEARCH.

The CHAT tab renders one Nora thread, scoped to today. The thread persists across sheet open/close — closing the sheet does not clear it. Opening the sheet from a slot's `+` seeds the next `meal_slot` for the entry being drafted, but the thread itself is shared across slots.

### Happy path (high-confidence)

1. User opens sheet from `+` on the Lunch card; CHAT tab is focused. Input shows placeholder "Tell Nora what you ate…"
2. User types: "200g grilled chicken breast and a cup of rice"
3. POST `/api/food/parse` runs. Returns a draft `food_log_entries` row, status `draft`, with two items both `high` confidence (USDA hits for "chicken breast" and "rice cooked").
4. UI inserts a Nora bubble in the thread (`chat_messages` row, `kind='meal_log'`, `ui={ entry_id, items, totals, mode: 'preview' }`). The bubble renders a structured card:
   ```
   Nora:
   From USDA:
   • Chicken breast grilled · 200g · 330 kcal · 62P · 0C · 7F
   • Rice cooked · 158g · 205 kcal · 4P · 45C · 0F
   Total: 535 kcal · 66P · 45C · 7F
   [Confirm] [Edit] [Cancel]
   ```
5. User taps Confirm. POST `/api/food/commit` flips status `draft → committed`. UI inserts a second Nora bubble: `ui={ entry_id, mode: 'committed' }` rendering as a "✓ logged · lunch" pill.
6. The slot card on the journal underneath updates via TanStack Query invalidation.

No LLM round-trip beyond the deterministic Haiku extraction in step 3. Total wall time ≈ 1-2s.

### Clarification path (low-confidence)

1. User types: "low-fat halloumi 50g on toast"
2. Parse returns two items. "halloumi low fat" resolves via USDA to a generic halloumi (`medium` confidence — score ~0.6). "toast" resolves to USDA's "Bread, white, toasted" (`high`).
3. Because at least one item is non-`high`, UI calls `/api/chat` with `mode='meal_log'`, passing the draft entry id and the resolved items.
4. Nora (Haiku 4.5 in `meal_log` mode, restricted tool set — see Tools below) streams:
   > "I matched 'halloumi' to a generic 50g serving (158 kcal). You logged Balade low-fat halloumi twice before — use that instead?"
   >
   > [Use Balade (saved)] [Use generic] [Enter label values]
5. User taps "Use Balade". Nora calls `pick_library_item(item_index: 0, library_item_id: <Balade uuid>)`. Backend updates the draft entry in place, recomputes totals, and Nora posts a new preview bubble with the swap reflected:
   ```
   Nora:
   Updated:
   • Halloumi low fat (Balade) · 50g · 138 kcal · 11P · 1C · 9F
   • Bread white toasted · 30g · 81 kcal · 3P · 15C · 1F
   Total: 219 kcal · 14P · 16C · 10F
   [Confirm] [Edit] [Cancel]
   ```
6. User taps Confirm. Commit as in the happy path.

### Recipe save flow (smart offer)

After the second commit of a similar combo in a week (overlap detected by `find_similar_recent_entries(items, days=7)` — simple set-overlap heuristic, no LLM), Nora's next post-commit bubble appends:

> "You've logged this combination twice this week. Save as a recipe?" [Save] [Not now]

Tapping Save opens a tiny inline form (name + default serving), POSTs to `/api/food/library` with `composite_of=[...the just-committed items]`. The newly created `user_food_items` row now wins the library leg of the resolution chain — typing "Abdel's omelette" next time matches.

For low-confidence first-time misses, the offer fires inside the clarification path itself (step 4 above includes "Enter label values" which creates a single-item library entry).

A manual "Save to library" affordance lives on every committed meal in the journal and on every item chip in a preview bubble.

### Confirm gate

Strict in v1. **Nothing writes to `daily_logs` aggregates until Confirm.** The draft row exists in `food_log_entries` with `status='draft'` but is excluded from `sum_food_entries`. The existing draft expiry job (if present, else add a 24h cleanup cron) deletes orphan drafts.

The Cancel button on a preview bubble deletes the draft row and inserts a Nora bubble: "Cancelled — anything else?"

The Edit button swaps the preview into a small inline editor for that draft: per-item qty fields + an "x" to remove an item + a "+ add item" affordance that does an inline `/api/food/search` autocomplete. Save flips back to preview view with updated totals.

## Tools (Nora in `meal_log` mode)

Nora's tool set in this mode is narrow and transactional. No nutrition advice, no cross-meal analysis, no plan-tweaking.

- `pick_library_item(item_index: number, library_item_id: uuid)` — replace one resolved item in a draft with a specific library entry. Server validates ownership and shape; returns the updated draft.
- `save_to_library({ kind: 'item' | 'recipe', name, per_100g?, composite_of?, default_serving_g? })` — write a `user_food_items` row. For label-entry, the `per_100g` macros come from chips Nora surfaced in the message (kcal/P/C/F fields the user fills in the bubble). Server validates the `one_shape_chk` constraint.
- `search_library(query: string, limit: number)` — fuzzy search over the current user's `user_food_items` only. Returns names + ids for chip suggestions.

That's it. No `commit_meal_entry` tool — the user explicitly taps Confirm. No `delete_entry` tool — that's a journal action. Keeping the tool surface small keeps the LLM honest (it can't accidentally commit or destroy state).

## API surface

### Existing routes — modifications

- [/api/food/parse](../../../app/api/food/parse/route.ts) — unchanged signature. Behavior change: resolution chain swaps in the new order (library → cache → USDA-with-spelling → LLM). The `is_estimated` field on the returned entry stays the same. A new field `needs_clarification: boolean` is added to the response — `true` iff any item has confidence `medium` or `low`. The client uses this flag to decide whether to render a structured preview directly or to call `/api/chat`.
- [/api/food/commit](../../../app/api/food/commit/route.ts) — unchanged. Triggers `sum_food_entries` recompute and writes `daily_logs` (as today).
- [/api/chat](../../../app/api/chat) — extend the `mode` discriminator to include `'meal_log'`. In that mode: speaker is always Nora, tool set is the narrow three above, system prompt is the meal-log variant (see Prompts below), conversation persisted to `chat_messages` with `kind='meal_log'`.

### New routes

- `POST /api/food/library` — create a `user_food_items` row. Body: `{ kind: 'item' | 'recipe', name, per_100g?, composite_of?, default_serving_g?, notes? }`.
- `GET /api/food/library?q=...` — search library. Powers Nora's `search_library` tool and the (existing) LIBRARY tab when displaying personal items.
- `PATCH /api/food/library/[id]` — update name/macros/composite. Used by Manage Library screen.
- `DELETE /api/food/library/[id]` — remove from library (does not retroactively touch past `food_log_entries`).
- `PATCH /api/food/entries/[id]/items` — update items inside a draft entry (used by Nora's `pick_library_item` tool and the Edit button). Refuses on `status='committed'`.

## Prompts

### Haiku extraction (existing, light edit)

Add one rule to the system prompt in [lib/food/parse.ts](../../../lib/food/parse.ts):
> "If a user references a meal name they likely have a recipe for (e.g. 'my usual omelette', 'Abdel's omelette'), emit a single item with that exact name and `qty_g: 100`. The downstream resolver will match it against the user's library."

The catch-it-as-a-recipe-name path lets users invoke their saved recipes by name without picking from a list.

### Nora (meal_log mode)

New prompt fragment in [lib/coach/system-prompts.ts](../../../lib/coach/system-prompts.ts), composed with the existing `NORA_BASE`:

```
You are in meal-logging mode. Your job is to help the user record what they
ate — accurately and quickly. You are NOT giving nutrition advice in this
mode; that's reserved for the /coach surface.

You will receive a draft meal entry with items already resolved to macros.
Each item has a confidence level. Your job, ONLY when at least one item is
non-high-confidence:

- Ask one short clarifying question, focused on the lowest-confidence item.
- Offer 2-3 chip suggestions: a saved library item if one matches, "Enter
  label values" for label-entry, "Use generic" to accept the current macros.
- Use the tools: pick_library_item to swap, save_to_library to add new.

When everything is settled, end your turn — do NOT call any commit tool.
The user taps Confirm in the UI.

Keep it terse. One sentence per turn. No nutrition coaching.
```

The prompt is intentionally narrow: Nora in meal-log mode is a resolution-helper, not a coach. The user's existing `profiles.system_prompt` override (which targets Peter) does not apply here.

## UI components

New / changed files:

- [components/log/MealLoggerSheet.tsx](../../../components/log/MealLoggerSheet.tsx) — restructure tab list: remove TEXT/SCAN/VOICE, add CHAT (default). SEARCH and LIBRARY remain.
- [components/log/MealLoggerChatTab.tsx](../../../components/log/MealLoggerChatTab.tsx) (new) — the Nora thread. Renders `chat_messages` rows of `kind='meal_log'` from today, plus the composer (text input + mic + barcode button + send). Streams Nora responses via SSE.
- [components/log/MealLoggerPreviewCard.tsx](../../../components/log/MealLoggerPreviewCard.tsx) (new) — the structured preview bubble rendered when Nora's `ui` payload is `mode='preview'`. Per-item lines, totals, Confirm/Edit/Cancel buttons.
- [components/log/MealLoggerEditor.tsx](../../../components/log/MealLoggerEditor.tsx) (new) — inline draft editor (qty fields, add/remove items). Replaces the preview view when Edit tapped.
- [components/log/MealLoggerSearchTab.tsx](../../../components/log/MealLoggerSearchTab.tsx) — small change: picking a result appends to the current chat draft instead of committing standalone.
- [components/log/MealLoggerLibraryTab.tsx](../../../components/log/MealLoggerLibraryTab.tsx) — small change: include `user_food_items` rows under the existing Favorites/Recent/Frequent/Catalog sections (new section: "Saved").
- [components/log/MealLoggerScanTab.tsx](../../../components/log/MealLoggerScanTab.tsx) — DELETE. Functionality folded into chat composer button.
- [components/log/MealLoggerTypeTab.tsx](../../../components/log/MealLoggerTypeTab.tsx) — DELETE. Functionality folded into chat composer text input.
- [components/log/MealLoggerComingSoonTab.tsx](../../../components/log/MealLoggerComingSoonTab.tsx) — DELETE. No longer needed; voice/scan no longer have placeholder tabs.

Other touches:

- [components/meal/MealSlotEmptyCard.tsx](../../../components/meal/MealSlotEmptyCard.tsx) — "Copy yesterday's <slot>" pill remains; tapping it still resolves through the existing one-tap commit path (no chat thread involvement).
- [components/meal/MealSlotCard.tsx](../../../components/meal/MealSlotCard.tsx) — display logic: when a row has `recipe_id`, show the recipe name as the collapsed header; expand on tap to show component items.
- New page [/profile/library/page.tsx](../../../app/profile/library) — Manage Library: list of saved items + recipes, edit, delete. Reachable from the existing `/profile` page and from "Manage saved" links elsewhere.

## Data flow

```
                       ┌─────────────────────────────────────┐
                       │   /meal (MealJournalClient)         │
                       │   per-slot cards + totals strip     │
                       └──────────┬──────────────────────────┘
                                  │ user taps + on a slot
                                  ▼
                       ┌─────────────────────────────────────┐
                       │   MealLoggerSheet                    │
                       │   [ CHAT ] [SEARCH] [LIBRARY]        │
                       └──────────┬──────────────────────────┘
                                  │ CHAT tab default
                                  ▼
                       ┌─────────────────────────────────────┐
                       │   MealLoggerChatTab                  │
                       │   - useChatMessages(today,meal_log)  │
                       │   - composer: text + 🎤 + barcode    │
                       └────┬───────────────┬─────────────────┘
                            │               │
              user submits  │               │ user taps Confirm in
              meal text     │               │ MealLoggerPreviewCard
                            ▼               ▼
              POST /api/food/parse    POST /api/food/commit
                            │               │
            ┌───────────────┴────┐          │
            │ resolveItemMacros  │          │
            │ library→cache→USDA │          │
            │ (with spelling)→LLM│          │
            └───────────────┬────┘          │
                            │               │
                            │ all high?     │
                ┌───────────┴───────────┐   │
                │ yes                no │   │
                ▼                       ▼   │
       render preview         POST /api/chat
       directly               (mode=meal_log)
                                       │   │
                                       │   │
                              Nora streams  │
                              clarification │
                              + chips       │
                                       │   │
                              user taps chip│
                                       │   │
                              tool call →   │
                              update draft  │
                                       │   │
                              new preview   │
                              bubble        │
                                       │   │
                                       └───┘ → committed
```

## Error handling

- **Extraction fails.** [/api/food/parse](../../../app/api/food/parse/route.ts) returns 502 with `extraction_failed`. UI inserts a Nora bubble: "I couldn't read that. Try rephrasing — or tap LIBRARY to pick from saved items." No draft is created.
- **All resolution paths fail for one item.** Already handled in `/api/food/parse`'s per-item try/catch (existing): item becomes a zero-macro low-confidence placeholder. Nora's clarification flow runs and offers "Enter label values".
- **USDA timeout.** Existing 5s timeout in [lib/food/lookup.ts](../../../lib/food/lookup.ts) keeps. Falls through to LLM estimate. The clarification flow surfaces "I estimated this — want to enter exact macros?"
- **Anthropic call fails in clarification path.** Render the preview anyway with the low-confidence items visible; the user can Edit manually. A toast: "Nora is offline — you can still log manually."
- **Library write conflict (duplicate name).** API returns 409. Nora's bubble: "You already have a 'Balade halloumi' saved. Use that instead?" [Use existing] [Save with a new name]

## Migration of existing surfaces

- **TEXT tab.** Existing user-facing label gets replaced by CHAT. Any deep links or saved bookmarks (none known) keep working since the sheet opens to CHAT by default.
- **Existing `food_log_entries`.** Untouched. The new `recipe_id` column is nullable; old rows stay null. The journal continues to render them as item lists, no UI regression.
- **Existing `food_db_cache`.** Untouched by migration; the one-shot purge script (deferred to a separate run, not in the migration) cleans up low-precision OFF rows. Library items don't enter the shared cache; they live in `user_food_items` only.
- **Existing `food_log_favorites` / `food_item_favorites`.** Untouched. Favorites are a separate concept (a flag on past entries) from library (a saved canonical food). Both coexist.
- **CSV ingest paths (`/api/ingest/health?source=yazio`).** Untouched. The Yazio short-circuit when in-app entries exist on the same date still applies.

## Auditing & verification

New audit script: [scripts/audit-meal-logging-resolve.mjs](../../../scripts/audit-meal-logging-resolve.mjs).

Set `AUDIT_USER_ID`. Runs `resolveItemMacros` against a fixed test vocabulary covering known traps:
- British spellings: omelette, yoghurt, courgette, aubergine
- Brand-vs-generic: halloumi, greek yogurt, peanut butter
- Composites that should hit library: any user_food_items the user has
- Single-token foods that should hit USDA cleanly: chicken, rice, banana
- Foods we expect LLM-fallback: regional dishes (m'semen, tagine, etc.)

For each, prints: source, name returned, per-100g macros, confidence. Used to verify the spelling fallback works, OFF removal didn't regress anything, and library priority is applied. Run pre-merge and one week post-merge.

Existing [scripts/audit-food-aggregation.mjs](../../../scripts/audit-food-aggregation.mjs) continues to verify `sum_food_entries` parity post-commit and now also catches any recipe-expansion bugs (totals must match either way).

## Testing strategy

No automated test framework in this repo. Verification path:

1. `npm run typecheck` after each implementation chunk.
2. Manual exercise of /meal in `npm run dev`:
   - Happy path: type "200g chicken and a cup rice" → preview appears, two items both high-conf, no Nora question, Confirm writes.
   - Clarification path: type "halloumi" → Nora asks back with chips.
   - Library save: type "Balade halloumi 50g" with low-conf result → "Enter label values" → save → re-type "halloumi" → library wins.
   - Recipe save: log "2-egg omelette and halloumi" twice in same week → Nora offers "Save as recipe" → save → type "my omelette" → recipe expands.
   - Edit flow: tap Edit on a preview → change qty → totals recompute → Confirm.
   - Cancel flow: tap Cancel on a preview → draft deleted, bubble shows "Cancelled".
   - Cross-slot: open sheet from Breakfast +, log, close sheet, open from Lunch + → thread persists, second meal slot = lunch.
3. Audit script against the user's existing data once migrated.
4. One-week soak: track parse-route latency and commit-without-edit rate (proxy for trust). If trust holds, plan v2 trust-mode rollout.

## Out of scope (future work)

- **Trust-mode auto-commit.** Defer until we have soak data showing >90% of high-confidence previews get confirmed without edit. v2.
- **Photo modality.** Standalone spec ("Spec B" in v1.1 notes).
- **Cross-meal coaching in /meal.** Nora answering "what should I eat tonight" stays on /coach.
- **Multi-language input.** English-only for now. The Haiku extractor handles loanwords (halloumi, tagine) but doesn't translate French/Arabic input.
- **Recipe scaling / serving sizes beyond `default_serving_g`.** v2 — for now, recipes log at their default serving and user can edit qty.
- **Library sharing.** Single-user app; non-goal.

## Open questions

None. All five forks closed in brainstorm.

## Implementation order

The plan (next step, via writing-plans skill) should sequence roughly:

1. Migration 0027 + types in [lib/data/types.ts](../../../lib/data/types.ts).
2. New `spelling.ts` + USDA spelling-fallback wired into `lookup.ts`.
3. Library leg added to `resolveItemMacros`; OFF removed from chain; SOURCE_RANK flipped in `search.ts`.
4. Library CRUD routes (`/api/food/library`, `/api/food/library/[id]`).
5. `/api/chat` mode='meal_log' branch + Nora tools (`pick_library_item`, `save_to_library`, `search_library`).
6. `MealLoggerChatTab` + `MealLoggerPreviewCard` + `MealLoggerEditor` components.
7. `MealLoggerSheet` restructure (remove tabs, add CHAT default, fold mic + barcode buttons into composer).
8. `MealSlotCard` recipe-collapse rendering, `MealSlotEmptyCard` unchanged.
9. `/profile/library` page (Manage Library).
10. Cache purge script + audit script.
11. Manual verification per Testing strategy.
12. Restore-defaults CLAUDE.md note on the new resolution chain.
