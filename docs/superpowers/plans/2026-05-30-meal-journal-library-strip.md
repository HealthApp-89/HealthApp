# Meal Journal Library Strip + Nora Recipe Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Saved" strip atop the `/diet` journal showing the user's recent `user_food_items` with one-tap re-log; auto-refresh when Nora saves via chat; extend `query_food_log` so Nora knows which ingredients came from saved recipes.

**Architecture:** Three thin slices that ship independently:
1. **UI:** new `JournalLibraryStrip` reads from a new `userFoodItems.recent` TanStack key (limit=8); one-tap → existing `/api/food/library/draft` → `/api/food/commit` flow.
2. **Backend:** extend `/api/food/library/draft` `source_kind` enum with `user_item` and `user_recipe` cases (the current six don't cover direct `user_food_items` taps).
3. **Coach awareness:** add two columns (`recipe_id`, joined `recipe_name`) to `query_food_log`'s select + one NORA_BASE paragraph.

**Tech Stack:** Next.js 15 App Router, Supabase PostgREST, TanStack Query (hybrid SSR-hydrate per repo convention), Tailwind v4. No new dependencies, no migrations (schema columns already exist per migration 0028).

**Verification cadence:** repo has no test suite and no working linter — verify each task with `npm run typecheck` plus targeted manual browser exercise on `npm run dev`.

**Spec:** [docs/superpowers/specs/2026-05-30-meal-journal-library-strip-design.md](docs/superpowers/specs/2026-05-30-meal-journal-library-strip-design.md)

**V1 deviations from spec (deliberate simplifications, flagged for awareness):**
- `UserFoodItem` does not have `default_meal_slot` (that's `FoodItemFavorite`'s column on a different table). Strip taps always default to `deriveMealSlot(now)`.
- Strip card kcal display: items show `per_100g.kcal` rounded (label "kcal / 100g"); recipes show "Recipe · N items" instead of sum-of-components. Skipping cache-only ingredient resolution in v1 — the user knows their saved meals by name, and the per-ingredient resolution adds an N+1 query pattern that doesn't earn its weight on a strip card. Real macros land when the entry is logged via the existing draft → commit pipeline (which already resolves ingredients).

---

## File Structure

| Path | Action | Responsibility |
|------|--------|----------------|
| [lib/query/keys.ts](lib/query/keys.ts) | Modify | Add `userFoodItems.recent(userId)` key |
| [lib/query/fetchers/userFoodItems.ts](lib/query/fetchers/userFoodItems.ts) | Modify | Add `fetchUserFoodItemsRecent{Server,Browser}` (limit=8, otherwise identical select) |
| [lib/query/hooks/useUserFoodItems.ts](lib/query/hooks/useUserFoodItems.ts) | Modify | Add `useUserFoodItemsRecent` hook |
| [app/api/food/library/draft/route.ts](app/api/food/library/draft/route.ts) | Modify | Add `user_item` + `user_recipe` to `source_kind` enum and if/else chain |
| [components/diet/JournalLibraryStrip.tsx](components/diet/JournalLibraryStrip.tsx) | Create | Strip UI; horizontal-scroll cards, tap-to-log with undo toast |
| [components/diet/DietJournalClient.tsx](components/diet/DietJournalClient.tsx) | Modify | Render `<JournalLibraryStrip />` in journal view between scrubber and SummaryCard |
| [app/diet/page.tsx](app/diet/page.tsx) | Modify | Prefetch `userFoodItems.recent` alongside existing prefetches |
| [components/chat/ChatPanel.tsx](components/chat/ChatPanel.tsx) | Modify | Branch in existing `inlineToolCalls` handler → invalidate `userFoodItems.recent` on `save_to_library` success |
| [lib/coach/tools.ts](lib/coach/tools.ts) | Modify | Extend `FoodLogEntryRow` type + `executeQueryFoodLog` select string with `recipe_id` + joined `recipe(name)` |
| [lib/coach/system-prompts.ts](lib/coach/system-prompts.ts) | Modify | One-paragraph addition to NORA_BASE on recipe-context awareness |

---

## Task 1: Data layer — `userFoodItems.recent` key, fetcher, hook

**Goal:** Set up the foundation the strip will read from. Mirrors the existing `userFoodItems.all` pair (which loads 200 rows for `/profile/library`) but caps at 8 for the strip's fast-path.

**Files:**
- Modify: [lib/query/keys.ts](lib/query/keys.ts:167-171)
- Modify: [lib/query/fetchers/userFoodItems.ts](lib/query/fetchers/userFoodItems.ts)
- Modify: [lib/query/hooks/useUserFoodItems.ts](lib/query/hooks/useUserFoodItems.ts)

- [ ] **Step 1: Add `recent` key**

Edit [lib/query/keys.ts](lib/query/keys.ts) — locate the `userFoodItems` block (lines 167-171) and add a `recent` key:

```ts
userFoodItems: {
  all: (userId: string) => ["user-food-items", userId] as const,
  search: (userId: string, q: string) =>
    ["user-food-items", userId, q] as const,
  recent: (userId: string) => ["user-food-items", userId, "recent"] as const,
},
```

- [ ] **Step 2: Add fetchers (Server + Browser)**

Edit [lib/query/fetchers/userFoodItems.ts](lib/query/fetchers/userFoodItems.ts) — add two new exports below the existing `fetchUserFoodItemsBrowser`. Keep the same `SELECT` constant for consistency:

```ts
export async function fetchUserFoodItemsRecentServer(
  supabase: SupabaseClient,
  userId: string,
): Promise<UserFoodItem[]> {
  const { data, error } = await supabase
    .from("user_food_items")
    .select(SELECT)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(8);
  if (error) throw error;
  return (data ?? []) as unknown as UserFoodItem[];
}

export async function fetchUserFoodItemsRecentBrowser(
  supabase: SupabaseClient,
  userId: string,
): Promise<UserFoodItem[]> {
  const { data, error } = await supabase
    .from("user_food_items")
    .select(SELECT)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(8);
  if (error) throw error;
  return (data ?? []) as unknown as UserFoodItem[];
}
```

- [ ] **Step 3: Add the hook**

Edit [lib/query/hooks/useUserFoodItems.ts](lib/query/hooks/useUserFoodItems.ts) — add a second export below the existing `useUserFoodItems`. Import the new fetcher.

```ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  fetchUserFoodItemsBrowser,
  fetchUserFoodItemsRecentBrowser,
} from "@/lib/query/fetchers/userFoodItems";
import { queryKeys } from "@/lib/query/keys";

export function useUserFoodItems(userId: string) {
  const supabase = createSupabaseBrowserClient();
  return useQuery({
    queryKey: queryKeys.userFoodItems.all(userId),
    queryFn: () => fetchUserFoodItemsBrowser(supabase, userId),
  });
}

export function useUserFoodItemsRecent(userId: string) {
  const supabase = createSupabaseBrowserClient();
  return useQuery({
    queryKey: queryKeys.userFoodItems.recent(userId),
    queryFn: () => fetchUserFoodItemsRecentBrowser(supabase, userId),
  });
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS — no new errors.

- [ ] **Step 5: Commit**

```bash
git add lib/query/keys.ts lib/query/fetchers/userFoodItems.ts lib/query/hooks/useUserFoodItems.ts
git commit -m "$(cat <<'EOF'
feat(query): add userFoodItems.recent (limit=8) for journal strip

Foundation for the Saved strip on /diet — same select/sort as the
existing all() pair, capped at 8 for the strip's fast-path. Cache
key is distinct from .all() so /profile/library and the strip
each get their own invalidation surface.
EOF
)"
```

---

## Task 2: Extend `/api/food/library/draft` with `user_item` and `user_recipe` source_kinds

**Goal:** The strip needs to draft an entry directly from a `user_food_items.id`. The current six `source_kind` enum values cover favorites/recents/catalog/history-picker — none read from `user_food_items` directly. Add two new cases that mirror the existing flow shape but pull macros from `user_food_items`.

**Files:**
- Modify: [app/api/food/library/draft/route.ts](app/api/food/library/draft/route.ts)

- [ ] **Step 1: Widen the `BodySchema` source_kind enum**

Edit [app/api/food/library/draft/route.ts](app/api/food/library/draft/route.ts) — extend the enum:

```ts
const BodySchema = z.object({
  source_kind: z.enum([
    "favorite_meal",
    "favorite_item",
    "recent",
    "frequent",
    "catalog",
    "history_picker",
    "user_item",     // NEW — direct read from user_food_items (single item)
    "user_recipe",   // NEW — direct read from user_food_items (recipe with composite_of)
  ]),
  // ... rest unchanged
});
```

- [ ] **Step 2: Add the `user_item` branch**

Below the existing `catalog` branch (around line 124) and before the `recent|frequent` branch, add a new branch. The pattern mirrors `favorite_item` (single-item shape, `per_100g` scaled by qty):

```ts
} else if (body.source_kind === "user_item") {
  if (!body.source_id) return NextResponse.json({ error: "source_id_required" }, { status: 400 });
  const { data: row } = await supabase
    .from("user_food_items")
    .select("id, name, per_100g, composite_of")
    .eq("id", body.source_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "user_item_not_found" }, { status: 404 });
  if (row.composite_of !== null) {
    return NextResponse.json({ error: "user_item_is_recipe_use_user_recipe_kind" }, { status: 400 });
  }
  if (row.per_100g === null) {
    return NextResponse.json({ error: "user_item_missing_per_100g" }, { status: 500 });
  }
  const qty = body.qty_g ?? 100;
  const macros = macrosForQty(row.per_100g as FoodMacros, qty);
  items = [{
    name: row.name,
    qty_g: qty,
    ...macros,
    per_100g: row.per_100g as FoodMacros,
    source: "db",
    db_ref: { source: "user_library", canonical_id: row.id },
    confidence: "high",
    match_score: null,
  }];
}
```

- [ ] **Step 3: Add the `user_recipe` branch**

Reuse the existing [expandLibraryRecipe](lib/food/lookup.ts:408) helper — it already takes a `UserFoodItem` recipe row and resolves every `composite_of` ingredient through the standard chain, returning `FoodItem[]` scaled to a given qty. Add this branch after the `user_item` branch:

```ts
} else if (body.source_kind === "user_recipe") {
  if (!body.source_id) return NextResponse.json({ error: "source_id_required" }, { status: 400 });
  const { data: row } = await supabase
    .from("user_food_items")
    .select("id, user_id, name, per_100g, composite_of, default_serving_g, source, notes, created_at, updated_at")
    .eq("id", body.source_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "user_recipe_not_found" }, { status: 404 });
  if (row.composite_of === null) {
    return NextResponse.json({ error: "user_recipe_missing_composite_of_use_user_item_kind" }, { status: 400 });
  }
  if (row.default_serving_g === null) {
    return NextResponse.json({ error: "user_recipe_missing_default_serving_g" }, { status: 500 });
  }
  const qty = body.qty_g ?? row.default_serving_g;
  items = await expandLibraryRecipe(row as UserFoodItem, qty, user.id);
  // recipe_id is stamped on the inserted row in Step 4.
}
```

Add the imports at the top of the file:

```ts
import { expandLibraryRecipe } from "@/lib/food/lookup";
import type { UserFoodItem } from "@/lib/food/types";
```

Note: the `as UserFoodItem` cast is necessary because Supabase's `select(...)` returns `unknown` shape — `expandLibraryRecipe` reads `composite_of`, `default_serving_g`, and `id` from the row, all of which the select pulls.

- [ ] **Step 4: Set `recipe_id` on the insert when source_kind is user_recipe**

The current insert (lines 156-171) doesn't set `recipe_id`. Modify the insert to conditionally include it. Around line 158:

```ts
const insertRow: Record<string, unknown> = {
  user_id: user.id,
  eaten_at: body.eaten_at ?? new Date().toISOString(),
  meal_slot: body.meal_slot,
  kind: "library",
  raw_input: rawInput,
  items,
  totals,
  is_estimated,
  is_favorite: false,
  status: "draft",
};
if (body.source_kind === "user_recipe" && body.source_id) {
  insertRow.recipe_id = body.source_id;
}
const { data: inserted, error } = await supabase
  .from("food_log_entries")
  .insert(insertRow)
  .select("id, eaten_at, meal_slot, kind, items, totals, is_estimated, is_favorite, status, recipe_id")
  .single();
```

Also add `recipe_id` to the returned select string (last line above) so the client gets it back — useful for the undo flow and for the new `query_food_log` shape in Task 6.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Smoke-test the new branches**

Start dev server: `npm run dev`

In a terminal, hit the endpoint with a real `user_food_items.id`. Find one with:

```bash
psql "$(grep '^DATABASE_URL' .env.local | cut -d= -f2-)" -c "select id, name, case when composite_of is null then 'item' else 'recipe' end from user_food_items limit 5;"
```

Then curl with auth cookie copied from a browser session, or just exercise via the UI in Task 4. For now, just confirm the route compiles and a malformed body returns the new error codes:

```bash
curl -s -X POST http://localhost:3000/api/food/library/draft \
  -H 'Content-Type: application/json' \
  -d '{"source_kind":"user_item","meal_slot":"lunch"}'
```

Expected: `{"error":"unauthorized"}` (401, since no auth cookie). If you see a Zod error about `source_kind`, the enum widening didn't land — revisit Step 1.

- [ ] **Step 7: Commit**

```bash
git add app/api/food/library/draft/route.ts
git commit -m "$(cat <<'EOF'
feat(api): add user_item + user_recipe source_kinds to /api/food/library/draft

Lets a UI tap a user_food_items row directly and get back a draft
food_log_entries row. user_item is single-shape (per_100g scaled by
qty). user_recipe expands composite_of through resolveItemMacros
(same chain the chat tools use) and stamps recipe_id on the inserted
row so query_food_log can surface recipe-context to Nora.
EOF
)"
```

---

## Task 3: Build the `JournalLibraryStrip` component

**Goal:** Pure-display strip with tap-to-log. Reads from `useUserFoodItemsRecent` (Task 1). Tap → POST `/api/food/library/draft` (using `user_item`/`user_recipe` from Task 2) → POST `/api/food/commit`. Toast with 5s undo.

**Files:**
- Create: [components/diet/JournalLibraryStrip.tsx](components/diet/JournalLibraryStrip.tsx)

- [ ] **Step 1: Check toast infrastructure**

Search for any existing toast utility in the codebase:

```bash
grep -rln "toast\|sonner\|useToast\|showToast" components/ lib/ | grep -v "\.test\." | head -10
```

If a toast primitive exists (e.g., `sonner` or a custom one), use it. If not, implement an inline minimal toast inside the strip component (a `useState`-driven absolutely-positioned div at the bottom of the strip). Pick whichever is present in the repo and document in Step 2's code.

- [ ] **Step 2: Write the component**

Create [components/diet/JournalLibraryStrip.tsx](components/diet/JournalLibraryStrip.tsx). The implementation below assumes NO existing toast utility — adjust the toast section to use the repo's primitive if one exists.

```tsx
// components/diet/JournalLibraryStrip.tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useUserFoodItemsRecent } from "@/lib/query/hooks/useUserFoodItems";
import { queryKeys } from "@/lib/query/keys";
import { deriveMealSlot } from "@/lib/food/meal-slot";
import { fmtNum } from "@/lib/ui/score";
import { COLOR } from "@/lib/ui/theme";
import type { UserFoodItem, MealSlot } from "@/lib/food/types";

type Props = {
  userId: string;
  /** ISO yyyy-mm-dd date currently selected on /diet — used to invalidate
   *  the right foodEntries key after a commit. */
  date: string;
};

type Toast = {
  text: string;
  entryId: string;
} | null;

export function JournalLibraryStrip({ userId, date }: Props) {
  const { data: items = [] } = useUserFoodItemsRecent(userId);
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<Toast>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  if (items.length === 0) return null;

  const handleTap = async (item: UserFoodItem) => {
    if (pendingId) return; // prevent double-tap during in-flight commit
    setPendingId(item.id);
    const slot: MealSlot = deriveMealSlot(new Date());
    const kind = item.composite_of !== null ? "user_recipe" : "user_item";

    try {
      const draftRes = await fetch("/api/food/library/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_kind: kind,
          source_id: item.id,
          meal_slot: slot,
          eaten_at: new Date().toISOString(),
        }),
      });
      if (!draftRes.ok) throw new Error(`draft_failed_${draftRes.status}`);
      const { entry } = await draftRes.json() as { entry: { id: string } };

      const commitRes = await fetch("/api/food/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry_id: entry.id }),
      });
      if (!commitRes.ok) throw new Error(`commit_failed_${commitRes.status}`);

      queryClient.invalidateQueries({
        queryKey: queryKeys.foodEntries.range(userId, date, date),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.dailyLogs.range(userId, date, date),
      });

      setToast({ text: `Logged to ${slot}`, entryId: entry.id });
      window.setTimeout(() => setToast(null), 5000);
    } catch (err) {
      console.error("[JournalLibraryStrip] tap failed", err);
      setToast({ text: "Couldn't log — try again", entryId: "" });
      window.setTimeout(() => setToast(null), 3000);
    } finally {
      setPendingId(null);
    }
  };

  const handleUndo = async () => {
    if (!toast || !toast.entryId) return;
    const id = toast.entryId;
    setToast(null);
    try {
      await fetch(`/api/food/entries/${id}`, { method: "DELETE" });
      queryClient.invalidateQueries({
        queryKey: queryKeys.foodEntries.range(userId, date, date),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.dailyLogs.range(userId, date, date),
      });
    } catch (err) {
      console.error("[JournalLibraryStrip] undo failed", err);
    }
  };

  return (
    <div className="px-4 pt-2 pb-3">
      <div className="flex items-center justify-between mb-2">
        <span
          className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: COLOR.textMuted }}
        >
          Saved
        </span>
        <Link
          href="/profile/library"
          className="text-[11px] font-medium"
          style={{ color: COLOR.textMuted }}
        >
          View all →
        </Link>
      </div>
      <div className="flex gap-2 overflow-x-auto snap-x snap-mandatory -mx-4 px-4 pb-1">
        {items.map((item) => {
          const isRecipe = item.composite_of !== null;
          const kcalLabel = isRecipe
            ? `Recipe · ${item.composite_of?.length ?? 0} items`
            : item.per_100g
              ? `${fmtNum(item.per_100g.kcal)} kcal / 100g`
              : "—";
          const isBusy = pendingId === item.id;
          return (
            <button
              key={item.id}
              type="button"
              disabled={isBusy}
              onClick={() => handleTap(item)}
              className="snap-start shrink-0 w-[140px] text-left rounded-lg border p-3 transition-opacity"
              style={{
                background: "#fff",
                borderColor: "#e5e7eb",
                color: COLOR.textStrong,
                opacity: isBusy ? 0.5 : 1,
              }}
            >
              <div className="text-xs font-medium leading-snug line-clamp-2 mb-1">
                {isRecipe ? "🍽 " : ""}{item.name}
              </div>
              <div className="text-[11px]" style={{ color: COLOR.textMuted }}>
                {kcalLabel}
              </div>
            </button>
          );
        })}
      </div>
      {toast && (
        <div
          className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-full px-4 py-2 text-xs shadow-lg"
          style={{ background: "#111", color: "#fff" }}
        >
          <span>{toast.text}</span>
          {toast.entryId && (
            <button
              type="button"
              onClick={handleUndo}
              className="font-semibold underline-offset-2 underline"
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}
```

Notes:
- `deriveMealSlot` is at [lib/food/meal-slot.ts](lib/food/meal-slot.ts). It takes a Date and returns the slot for that time-of-day.
- `fmtNum` is the repo's numeric formatter — already used elsewhere on `/diet`. Per CLAUDE.md, all UI numbers must go through it.
- `COLOR` is from [lib/ui/theme.ts](lib/ui/theme.ts). Confirm it's the right import; `DietJournalClient.tsx:20` uses it too — match that pattern.
- Toast positioning at `bottom-24` keeps it above the bottom nav. If the project uses a `Toaster` provider, replace the inline toast block with whatever the repo's pattern is.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS. If `COLOR.textMuted` / `COLOR.textStrong` are undefined, check [lib/ui/theme.ts](lib/ui/theme.ts) for the actual export names and adjust.

- [ ] **Step 4: Commit (component only — wiring happens in Task 4)**

```bash
git add components/diet/JournalLibraryStrip.tsx
git commit -m "$(cat <<'EOF'
feat(diet): JournalLibraryStrip component (unwired)

Horizontal-scroll strip of recent user_food_items with tap-to-log
via /api/food/library/draft + /api/food/commit. 5s undo toast.
Recipes show "Recipe · N items"; items show per-100g kcal.
Hides itself when the library is empty.

Wired into DietJournalClient in the next commit.
EOF
)"
```

---

## Task 4: Wire `JournalLibraryStrip` into `DietJournalClient` + SSR prefetch

**Goal:** Mount the strip in the journal view between the date scrubber and the SummaryCard; prefetch on the server so it shows on first paint.

**Files:**
- Modify: [components/diet/DietJournalClient.tsx](components/diet/DietJournalClient.tsx)
- Modify: [app/diet/page.tsx](app/diet/page.tsx)

- [ ] **Step 1: Add SSR prefetch**

Edit [app/diet/page.tsx](app/diet/page.tsx) — add the import alongside the existing fetcher imports:

```ts
import { fetchUserFoodItemsRecentServer } from "@/lib/query/fetchers/userFoodItems";
```

Then add a prefetch entry inside the `Promise.all` block (lines 50-85), right after the `dailyLogs` prefetch:

```ts
// Recent saved library items for the Saved strip on the journal view
qc.prefetchQuery({
  queryKey: queryKeys.userFoodItems.recent(user.id),
  queryFn: () => fetchUserFoodItemsRecentServer(supabase, user.id),
}),
```

- [ ] **Step 2: Render the strip in DietJournalClient**

Edit [components/diet/DietJournalClient.tsx](components/diet/DietJournalClient.tsx) — add the import at the top alongside existing component imports:

```ts
import { JournalLibraryStrip } from "./JournalLibraryStrip";
```

Then find the journal-view block (starts at `{view === "journal" && (` around line 171). The current order is:
1. Inline date scrubber
2. SummaryCard
3. Four MealSlotCardCollapsed

Insert `<JournalLibraryStrip />` **between the scrubber and the SummaryCard**. Read the file to find the exact insertion point — look for the closing tag of the scrubber's outer `<div>` and the opening of `<SummaryCard ... />`. Insert:

```tsx
<JournalLibraryStrip userId={userId} date={date} />
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Manual exercise — empty state and populated state**

Start dev: `npm run dev`. Open [http://localhost:3000/diet](http://localhost:3000/diet).

Confirm:
1. If the test account has zero `user_food_items` rows, the strip is **not visible** (no empty box, no header).
2. If it has saved items (you can seed one by saving a meal via Nora in `/coach` or directly in DB), the "Saved" header + cards render between the date scrubber and the kcal ring.
3. Tap a card → toast appears bottom-center → slot card updates with the new entry → kcal ring updates.
4. Tap "Undo" within 5s → entry disappears from the slot card → kcal ring reverts.

If the strip flashes empty on first paint, the SSR prefetch isn't landing — re-check Step 1.

- [ ] **Step 5: Commit**

```bash
git add app/diet/page.tsx components/diet/DietJournalClient.tsx
git commit -m "$(cat <<'EOF'
feat(diet): wire JournalLibraryStrip into journal view

SSR-prefetches userFoodItems.recent on /diet so the strip paints
on first load without a flash. Renders between the date scrubber
and SummaryCard; hidden when library is empty.
EOF
)"
```

---

## Task 5: Chat-side cache invalidation when Nora saves to library

**Goal:** Close the loop — when Nora's `save_to_library` tool fires in `/coach`, the strip on `/diet` should auto-refresh so the new save appears at the left edge within ~1s of the chat chip. Single branch in the existing `inlineToolCalls` handler.

**Files:**
- Modify: [components/chat/ChatPanel.tsx](components/chat/ChatPanel.tsx) (lines 535-559)

- [ ] **Step 1: Add the invalidation branch**

Edit [components/chat/ChatPanel.tsx](components/chat/ChatPanel.tsx) — locate the block at lines 535-559 where `committedSessionToday` / `committedSessionTemplate` are detected. Below the `committedSessionTemplate` branch and **before** the next `else if (ev.type === "handoff")` block, add:

```ts
const savedToLibrary = (inlineToolCalls ?? []).some(
  (c) => c.name === "save_to_library" && !c.error,
);
if (savedToLibrary) {
  queryClient.invalidateQueries({
    queryKey: queryKeys.userFoodItems.recent(userId),
  });
  queryClient.invalidateQueries({
    queryKey: queryKeys.userFoodItems.all(userId),
  });
}
```

Invalidating both `.recent()` and `.all()` keeps `/profile/library` consistent too — same pattern as `commit_session_template` blowing the `userSessionTemplates.all` namespace as a defensive fallback.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Manual exercise — chat → strip auto-refresh**

With dev server running:
1. Open `/coach` in one tab, `/diet` in another.
2. Tell Nora something like: "Save Greek yogurt with berries as a saved item — 200g yogurt + 50g blueberries." Wait for her to call `save_to_library`.
3. Confirm the save chip renders in chat (`✓ Saved: Greek yogurt with berries` or similar).
4. Switch to the `/diet` tab — the new item should be at the **left edge** of the Saved strip within 1-2s (no manual refresh required).

If the strip doesn't auto-update, open devtools → React Query devtools (if installed) and confirm the `["user-food-items", userId, "recent"]` key was invalidated.

- [ ] **Step 4: Commit**

```bash
git add components/chat/ChatPanel.tsx
git commit -m "$(cat <<'EOF'
feat(chat): invalidate userFoodItems on save_to_library tool result

Closes the chat→journal auto-refresh loop — when Nora saves a meal
or recipe via /coach chat, the Saved strip on /diet repaints with
the new item at the visible left edge within ~1s. Persistent
confirmation surface beyond the easy-to-miss chat chip.
EOF
)"
```

---

## Task 6: Extend `query_food_log` with recipe context + NORA_BASE update

**Goal:** Surface `recipe_id` and joined `recipe_name` on every row `query_food_log` returns, so Nora can identify which ingredients came from a saved recipe. Add one paragraph to NORA_BASE teaching her how to use it.

**Files:**
- Modify: [lib/coach/tools.ts](lib/coach/tools.ts) (lines 804-915)
- Modify: [lib/coach/system-prompts.ts](lib/coach/system-prompts.ts)

- [ ] **Step 1: Extend `FoodLogEntryRow` type**

Edit [lib/coach/tools.ts](lib/coach/tools.ts) — find the `FoodLogEntryRow` type around line 804:

```ts
type FoodLogEntryRow = {
  eaten_at: string;
  meal_slot: MealSlot;
  kind: string;
  items: FoodLogItem[];
  totals: { kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number };
  recipe_id: string | null;     // NEW — back-reference to user_food_items
  recipe_name: string | null;   // NEW — flattened from PostgREST join
};
```

- [ ] **Step 2: Extend the select string and flatten the join**

Find the `.select("eaten_at, meal_slot, kind, items, totals")` call around line 885 and change to:

```ts
.select("eaten_at, meal_slot, kind, items, totals, recipe_id, recipe:recipe_id(name)")
```

Then update the result coercion around line 905. The PostgREST embed returns `recipe: { name } | null` — we want to flatten it to `recipe_name`:

```ts
type FoodLogEntryRowRaw = Omit<FoodLogEntryRow, "recipe_name"> & {
  recipe: { name: string } | null;
};
let rows: FoodLogEntryRow[] = ((data ?? []) as FoodLogEntryRowRaw[]).map((r) => ({
  eaten_at: r.eaten_at,
  meal_slot: r.meal_slot,
  kind: r.kind,
  items: r.items,
  totals: r.totals,
  recipe_id: r.recipe_id,
  recipe_name: r.recipe?.name ?? null,
}));
```

The existing `itemFilter` block right below this assignment still works — it operates on `rows` after the map.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Update NORA_BASE**

Edit [lib/coach/system-prompts.ts](lib/coach/system-prompts.ts) — find the NORA_BASE constant. Locate the section that describes how Nora should read `query_food_log` results (look for "query_food_log" or "food log" mentions). Add a paragraph in that section:

```
When `query_food_log` rows have `recipe_id` set, those `items` are
the ingredients of a saved recipe (`recipe_name`). Treat them as a
single saved unit — suggestions can be recipe-level (e.g., "sub the
rice in your Chicken teriyaki bowl for cauliflower rice") rather
than item-level. The user has the recipe in their library and can
update it once to change every future log.
```

If NORA_BASE doesn't currently have a `query_food_log` section, add this paragraph under the food-log analysis section (search for keywords like "analyze" or "nutrition"). Keep it concise — ~50 words.

- [ ] **Step 5: Smoke-test the query shape**

With dev server running, exercise Nora in `/coach`:
1. First, log a saved recipe via the strip from Task 4 (so there's a `food_log_entries` row with `recipe_id` set).
2. In `/coach`, ask Nora: "Look at what I ate today."
3. She should call `query_food_log`. Open devtools → Network → find the SSE stream → confirm the `tool_result` payload includes `recipe_id` and `recipe_name` on the row that was logged from the recipe.

If `recipe_name` is null when it shouldn't be: the PostgREST embed didn't resolve. Check that the FK on `food_log_entries.recipe_id` → `user_food_items.id` exists (migration 0028). Test the select manually:

```bash
psql "$(grep '^DATABASE_URL' .env.local | cut -d= -f2-)" -c \
  "select id, recipe_id from food_log_entries where recipe_id is not null limit 3;"
```

- [ ] **Step 6: Commit**

```bash
git add lib/coach/tools.ts lib/coach/system-prompts.ts
git commit -m "$(cat <<'EOF'
feat(coach): query_food_log surfaces recipe_id + recipe_name to Nora

Adds two fields to every row Nora gets back so she can identify
which ingredients came from a saved recipe (recipe_id back-ref from
migration 0028, joined name via PostgREST embed). NORA_BASE
teaches her to make recipe-level suggestions when entries share
a recipe_id rather than item-by-item swaps.

No new tool, no migration — the column already exists.
EOF
)"
```

---

## Task 7: End-to-end verification + CLAUDE.md update

**Goal:** Walk the full user flow once before declaring done; document the new strip in CLAUDE.md.

**Files:**
- Modify: [CLAUDE.md](CLAUDE.md)

- [ ] **Step 1: Full E2E walk**

With dev server running and a logged-in test account:

1. **Empty state:** if test account has no `user_food_items`, confirm `/diet` shows no Saved strip.
2. **Save via Nora:** in `/coach`, ask Nora to save a recipe ("Save my standard breakfast: 3 eggs, 2 slices sourdough, 1 tbsp butter as a recipe called 'Standard breakfast'"). Confirm the chip lands in chat.
3. **Strip auto-refresh:** switch to `/diet` (don't refresh). The new recipe appears at the left edge of the Saved strip.
4. **Tap to log:** tap the recipe card. Toast: "Logged to <slot>". The relevant slot card on `/diet` now shows the entry with the expanded ingredient list (eggs / sourdough / butter as separate items). Kcal ring updates.
5. **Undo:** tap "Undo" within 5s. Entry disappears, kcal ring reverts.
6. **Re-log + Nora awareness:** tap the card again to commit. Then in `/coach`, ask Nora "What did I have for breakfast?" — she should reference "Standard breakfast" by name (not "eggs, sourdough, butter" as three standalone items).
7. **View all link:** tap "View all →" — lands on `/profile/library` showing the same items plus more.

- [ ] **Step 2: Add a section to CLAUDE.md**

Edit [CLAUDE.md](CLAUDE.md) — find the existing in-app food logging section (the bullet starting with `**In-app food logging**`). Below the existing v1.2 paragraph (or wherever the latest food-logging update lives), add a new bullet/paragraph describing the strip + Nora recipe-awareness changes. Match the style/density of surrounding entries — terse, file-path-linked, surfaces non-obvious facts (the V1 deviations from spec, the two new source_kind enum values, etc.).

Example tone (adjust phrasing to match the surrounding entries):

```
- **Journal library strip (this arc, 2026-05-30)**: `JournalLibraryStrip`
  at [components/diet/JournalLibraryStrip.tsx](components/diet/JournalLibraryStrip.tsx)
  reads `userFoodItems.recent` (limit=8) and renders a horizontal-scroll
  row above SummaryCard on `/diet` journal view. Tap → [/api/food/library/draft](app/api/food/library/draft/route.ts)
  with new `user_item` / `user_recipe` source_kinds → /api/food/commit;
  5s undo toast. Auto-refreshes when Nora fires `save_to_library` (invalidation
  branch in [components/chat/ChatPanel.tsx](components/chat/ChatPanel.tsx) around
  the existing inlineToolCalls handler). V1 cuts: recipes show "Recipe · N
  items" instead of cache-resolved kcal; tap-to-log always defaults to
  `deriveMealSlot(now)` since `user_food_items` lacks `default_meal_slot`.
  `query_food_log` ([lib/coach/tools.ts](lib/coach/tools.ts)) now returns
  `recipe_id` + joined `recipe_name` per row; NORA_BASE teaches recipe-level
  suggestions when entries share a `recipe_id`.
```

- [ ] **Step 3: Typecheck (final)**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit and ready for PR**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(claude-md): document journal library strip + Nora recipe awareness
EOF
)"
```

Branch is now ready. Push and open PR against `main`:

```bash
git push -u origin feat/meal-journal-library-strip
gh pr create --title "feat(diet): saved library strip on journal + Nora recipe awareness" --body "$(cat <<'EOF'
## Summary
- Adds a horizontal-scroll "Saved" strip atop the /diet journal showing recent user_food_items, with one-tap re-log (5s undo)
- Closes the auto-refresh loop: when Nora saves to library via /coach chat, the strip repaints with the new item visible
- Extends query_food_log to surface recipe_id + joined recipe_name so Nora can suggest recipe-level swaps rather than per-ingredient

## Test plan
- [ ] Empty state: no user_food_items → no strip
- [ ] Save via Nora in /coach → switch to /diet → recipe appears at left edge of strip within 1-2s
- [ ] Tap card → entry commits to time-derived slot, kcal ring updates
- [ ] Undo within 5s → entry deletes, ring reverts
- [ ] Re-log → ask Nora about the meal → she references it by recipe name (not as standalone ingredients)
- [ ] "View all →" lands on /profile/library

Spec: docs/superpowers/specs/2026-05-30-meal-journal-library-strip-design.md
Plan: docs/superpowers/plans/2026-05-30-meal-journal-library-strip.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

(Do NOT run the push/PR commands automatically — present them for the user to run when ready.)

---

## Notes for the implementing engineer

- **Branch:** all work goes on `feat/meal-journal-library-strip` (already created off `main`, contains just the spec commit).
- **No migrations** — every column needed (`food_log_entries.recipe_id`, `user_food_items.*`) already exists per migration 0028.
- **No new dependencies** — uses existing TanStack Query, Supabase client, and Tailwind primitives.
- **Toast primitive** — Task 3 Step 1 checks for an existing one; if none, the inline `useState`-driven toast in the component is fine for v1. If the repo later adopts `sonner` or similar, the inline toast is the one-place migration target.
- **Multi-worktree caution** — this repo has 6+ worktrees per `git worktree list`. Always `git status` before any branch-mutating operation to confirm which worktree you're in.
- **Commit cadence** — one commit per task, with the message bodies above. Six task commits total + one CLAUDE.md commit = seven commits for the PR.
