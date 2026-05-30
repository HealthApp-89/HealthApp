# Meal Journal Library Strip + Nora Recipe Awareness — Design

**Date:** 2026-05-30
**Status:** Spec
**Surface:** [/diet](app/diet/page.tsx) (journal view) + Nora's chat analysis tools

## Problem

When Nora (the nutrition coach in `/coach` chat) saves a frequently-eaten meal as a recipe to the user's library via the `save_to_library` tool, the user has no in-app surface (outside of `/coach` chat history) confirming the save landed or letting them re-log the recipe quickly. The `save_to_library` confirmation chip renders in chat, but it's easy to miss as the conversation scrolls and there's no persistent journal-side surface for saved items. `/profile/library` exists for management but is one nav-tap away from the meal journal where the user is actually eating.

Separately, Nora's `query_food_log` tool returns the *expanded ingredient list* on each `food_log_entries` row (recipes are inlined as their components at log time) but drops the `recipe_id` back-reference. So Nora can analyze macros but can't tell that three ingredients came from a saved recipe she has on file — limiting recipe-level coaching ("swap the rice in your teriyaki bowl for cauliflower rice").

## Goals

1. **Persistent visibility for library saves on the journal.** A "Saved" strip at the top of `/diet` (journal view) shows the user's recent `user_food_items` newest-first. A fresh save from Nora's chat lands visibly at the left edge within ~1s.
2. **One-tap re-log from strip.** Tapping a card drafts and commits a `food_log_entries` row into the item's `default_meal_slot` (fallback: time-of-day-derived slot), with a 5-second undo.
3. **Recipe-context awareness for Nora.** Extend `query_food_log`'s return shape with `recipe_id` and `recipe_name` so Nora can identify which ingredients came from saved recipes.

## Non-goals

- Drag-to-reorder, pin, archive, or edit-in-place on the strip — those stay on `/profile/library`.
- New `get_recipe(id)` tool for Nora — the inline ingredient expansion already carries the macros she needs for analysis. Earned only if recipe-canonical lookup becomes necessary.
- Long-press to drill into recipe components on the strip card — visual noise for a fast-log surface; user can open the underlying entry from the slot card to see ingredients.
- A separate journal tab for the library — placement decision in brainstorming was "compact strip above slots".
- Fixing or investigating the chat `save_to_library` chip — confirmed wired in `PERSIST_RESULT_TOOLS` (already at [lib/coach/chat-stream.ts:105](lib/coach/chat-stream.ts)) and rendered in [components/chat/ChatMessage.tsx:538](components/chat/ChatMessage.tsx). The journal strip is the durable fix; the chip can stay as-is.

## Surface

### Component: `JournalLibraryStrip`

New file at [components/diet/JournalLibraryStrip.tsx](components/diet/JournalLibraryStrip.tsx).

Rendered inside [components/diet/DietJournalClient.tsx](components/diet/DietJournalClient.tsx) when `view === "journal"`, positioned **between the date scrubber and the `SummaryCard`** (so it sits at the top of the eye-line when a user lands on `/diet`, above the kcal ring).

Hidden entirely when the user has zero `user_food_items` rows. No empty-state copy — `/profile/library` owns onboarding.

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│ Saved                                          View all →   │
│ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌─────  │
│ │ 🍽 Chicken   │ │ Greek yogurt │ │ Salmon bowl  │ │ Tuna  │
│ │ teriyaki     │ │ bowl         │ │ recipe       │ │ wrap  │
│ │ 612 kcal     │ │ 280 kcal     │ │ 540 kcal     │ │ 410   │
│ └──────────────┘ └──────────────┘ └──────────────┘ └─────  │
└─────────────────────────────────────────────────────────────┘
```

- **Header:** "Saved" (small caps label, same weight as other section headers on `/diet`) with `View all →` linking to `/profile/library`.
- **Cards:** horizontally scrollable row (`overflow-x-auto`, snap-x), 8 items max. Each card shows:
  - Leading icon: 🍽 for recipes (`composite_of != null`), `·` for single items (`per_100g != null`)
  - Name (truncate at 2 lines, ~18 chars per line on mobile)
  - Computed kcal:
    - Item: `per_100g.kcal * (default_serving_g ?? 100) / 100`
    - Recipe: sum of components — resolve each `composite_of[i].name` via the same chain as logging (library → cache → USDA → LLM is too expensive for a strip render, so cache-only with a fallback dash if any component misses)
  - Subtle border, no per-card actions visible — whole card is the tap target

### Data: existing endpoint, new query key

Reuse [GET /api/food/user-items](app/api/food/user-items/route.ts), which already accepts `limit` and orders by `updated_at desc` in `listLibraryItems` ([lib/food/library.ts:92](lib/food/library.ts)). Call with `?limit=8`.

Add to [lib/query/keys.ts](lib/query/keys.ts):

```ts
userFoodItems: {
  all: (userId) => ["user-food-items", userId] as const,
  search: (userId, q) => ["user-food-items", userId, q] as const,
  recent: (userId) => ["user-food-items", userId, "recent"] as const,  // NEW
},
```

Browser fetcher at `lib/query/fetchers/userFoodItems.ts` (new): `fetchUserFoodItemsRecentBrowser(userId, limit=8)` → calls `/api/food/user-items?limit=8`, returns typed `UserFoodItem[]`. Throws on non-OK as per the client-cache convention.

Hook at `lib/query/hooks/useUserFoodItems.ts` (extend if exists, otherwise new): `useUserFoodItemsRecent(userId)` wrapping `useQuery` with the new key.

Server-side prefetch from [app/diet/page.tsx](app/diet/page.tsx): add a `queryClient.prefetchQuery` call alongside the existing prefetches for `foodEntries` / `todayTargets` so the strip shows on first paint without a flash.

### Tap behavior

```ts
async function onCardTap(item: UserFoodItem) {
  // Resolve slot: item's default → time-of-day if null
  const slot = item.default_meal_slot ?? deriveMealSlot(new Date());

  // Use the same drafting endpoint MealLoggerLibraryTab uses today
  const draft = await fetch("/api/food/library/draft", {
    method: "POST",
    body: JSON.stringify({
      source_kind: item.composite_of ? "user_recipe" : "user_item",
      source_id: item.id,
      meal_slot: slot,
      eaten_at: new Date().toISOString(),
    }),
  }).then((r) => r.json());

  await fetch("/api/food/commit", {
    method: "POST",
    body: JSON.stringify({ entry_id: draft.entry_id }),
  });

  // Invalidate the day's food entries so the slot card re-renders
  queryClient.invalidateQueries({ queryKey: queryKeys.foodEntries.day(userId, today) });

  // Show toast with 5s undo
  showToast({
    text: `Logged to ${slot} · Undo`,
    durationMs: 5000,
    onUndo: () => fetch(`/api/food/entries/${draft.entry_id}`, { method: "DELETE" }),
  });
}
```

**One-tap with undo** chosen over a slot picker because:
- `default_meal_slot` is set by the user when saving (the right answer for the common case)
- The fallback `deriveMealSlot(now)` is what the FAB does — same mental model
- A 5s undo window is cheaper than a confirm chip on every tap

**Source-kind for `/api/food/library/draft`:** the existing endpoint accepts `favorite_meal | favorite_item | recent | frequent | catalog`. We need to verify it accepts a `user_recipe` / `user_item` discriminator pointing at `user_food_items.id`; if not, add those two cases to the endpoint (small extension — same draft shape, lookup table differs). Existing `MealLoggerLibraryTab` taps via `favorite_meal` / `favorite_item` which read from `food_log_entries.is_favorite` and `food_item_favorites` respectively, not directly from `user_food_items`. **This is a real gap** — `pickLibraryItem` rejects recipes, and the v1.1 library endpoint doesn't expose `user_food_items.composite_of` directly as a "tap to log" source.

Resolution: add two new `source_kind` cases (`user_item`, `user_recipe`) to [/api/food/library/draft/route.ts](app/api/food/library/draft/route.ts) that read from `user_food_items` by id and produce the same draft `food_log_entries.items[]` shape — recipes expand their `composite_of` array into per-item rows by name-resolving each component through the existing `resolveItemMacros` chain (library → cache → USDA → LLM). The newly-created draft's `recipe_id` column is set to `user_food_items.id` for recipes, NULL for items.

### Cache invalidation from Nora's chat saves

[components/chat/ChatPanel.tsx](components/chat/ChatPanel.tsx) (lines 535-559) already has the exact pattern for invalidating on tool-result completion — `inlineToolCalls.some(c => c.name === "X" && !c.error)` gating an `invalidateQueries` call. Add a new branch:

```ts
const savedToLibrary = (inlineToolCalls ?? []).some(
  (c) => c.name === "save_to_library" && !c.error,
);
if (savedToLibrary) {
  queryClient.invalidateQueries({
    queryKey: queryKeys.userFoodItems.recent(userId),
  });
}
```

This makes the strip auto-refresh — the freshly saved item appears at the visible left edge within ~1s of Nora's chip rendering. The user gets two confirmations: the chat chip (already wired) AND the journal strip update (new). The latter is durable across chat scroll and tab navigation.

## Nora recipe-context awareness

### `query_food_log` shape extension

Today, [executeQueryFoodLog](lib/coach/tools.ts) selects:

```ts
.select("eaten_at, meal_slot, kind, items, totals")
```

Extend to:

```ts
.select("eaten_at, meal_slot, kind, items, totals, recipe_id, recipe:recipe_id(name)")
```

The `recipe:recipe_id(name)` clause uses Supabase PostgREST embedding — joins `user_food_items` via the existing FK from migration 0028 and returns `recipe: { name } | null`. Flatten in TS:

```ts
type FoodLogEntryRow = {
  eaten_at: string;
  meal_slot: MealSlot;
  kind: string;
  items: FoodLogItem[];
  totals: { ... };
  recipe_id: string | null;   // NEW
  recipe_name: string | null; // NEW (flattened from join)
};
```

### NORA_BASE prompt addition

In [lib/coach/system-prompts.ts](lib/coach/system-prompts.ts), add to NORA_BASE under the food-log analysis section (single paragraph, ~50 words):

> When `query_food_log` rows have `recipe_id` set, those `items` are the ingredients of a saved recipe (`recipe_name`). Suggestions can be recipe-level ("sub the rice in your Chicken teriyaki bowl") rather than item-level — the user has the recipe saved and can update it in one place.

That's it. No new tool. Nora gets recipe-context awareness from two extra fields on an existing query.

## Files touched

| Path | Change |
|------|--------|
| [components/diet/JournalLibraryStrip.tsx](components/diet/JournalLibraryStrip.tsx) | NEW — strip component |
| [components/diet/DietJournalClient.tsx](components/diet/DietJournalClient.tsx) | Render `<JournalLibraryStrip />` between scrubber and SummaryCard inside `view === "journal"` branch |
| [lib/query/keys.ts](lib/query/keys.ts) | Add `userFoodItems.recent(userId)` key |
| `lib/query/fetchers/userFoodItems.ts` | NEW — `fetchUserFoodItemsRecentBrowser` + `Server` variant |
| `lib/query/hooks/useUserFoodItems.ts` | Add `useUserFoodItemsRecent(userId)` hook |
| [app/diet/page.tsx](app/diet/page.tsx) | Prefetch `userFoodItems.recent` alongside existing prefetches |
| [app/api/food/library/draft/route.ts](app/api/food/library/draft/route.ts) | Extend `source_kind` enum with `user_item` + `user_recipe`; lookup via `user_food_items`; set `recipe_id` on draft for recipes |
| [lib/coach/tools.ts](lib/coach/tools.ts) | Extend `FoodLogEntryRow` type + `executeQueryFoodLog`'s select string with `recipe_id` and joined `recipe(name)` |
| [lib/coach/system-prompts.ts](lib/coach/system-prompts.ts) | One-paragraph NORA_BASE addition on recipe-context awareness |
| [components/chat/ChatPanel.tsx](components/chat/ChatPanel.tsx) | Add `save_to_library` branch in the existing `inlineToolCalls` handler (lines 535-559) — invalidate `userFoodItems.recent` |

## Out-of-scope (will not be touched)

- `food_log_entries.is_favorite` flag or `food_item_favorites` table — those drive the v1.1 `MealLoggerSheet` Library tab. The new strip reads `user_food_items` directly, which is a different surface for a different purpose (Nora-saved recipes vs. flagged historical meals).
- `/profile/library` (Manage Library) — unchanged. The `View all →` link points here.
- Logger sheet's Library tab — unchanged. The new strip is the *quick* surface; the sheet's Library tab remains the *browse* surface.

## Verification

After implementation:

1. **Save flow E2E:** open `/coach`, ask Nora to save a meal as a recipe → confirm chip in chat → switch to `/diet` → confirm the recipe appears at the left edge of the Saved strip within 1-2s.
2. **Tap-to-log:** tap a saved recipe in the strip → confirm a `food_log_entries` row is committed to the expected slot with the expanded ingredient list and `recipe_id` set → confirm SummaryCard kcal ring updates → confirm Undo deletes within 5s.
3. **Nora recipe awareness:** in `/coach`, ask Nora about today's eating after logging a recipe → confirm she references the recipe by name (not as N standalone ingredients). Audit the LLM response and the `query_food_log` tool result payload.
4. **Empty state:** for a user with zero `user_food_items` rows, confirm the strip does not render (no empty box, no header).
5. **Typecheck:** `npm run typecheck` clean.

## Open questions

None — all forks resolved in brainstorming.
