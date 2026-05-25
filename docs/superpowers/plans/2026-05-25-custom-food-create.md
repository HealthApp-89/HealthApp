# Custom food create — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface a manual "create food with macros" form on `/profile/library` (proactive curation) and inline inside `MealLoggerSheet` (create-and-log when search misses), backed by the existing `POST /api/food/user-items` endpoint.

**Architecture:** One pure form component (`CustomFoodForm`) used in two hosts. The Manage Library page hosts it in a plain `BottomSheet` and refreshes after save. The MealLoggerSheet wraps it in a two-step sheet (`CustomFoodCreateAndLogSheet`) that lets the user log a quantity immediately after saving, hitting the existing `/api/food/draft` → `/api/food/commit` pipeline via the already-supported `source: "user_library"` candidate path. A tiny Atwater helper derives kcal from P/C/F live in the form so kcal is optional.

**Tech Stack:** Next.js 15 App Router, React client components, TanStack Query, Tailwind, existing `BottomSheet` primitive, existing `/api/food/user-items` + `/api/food/draft` + `/api/food/commit` endpoints. No migration. No new env vars.

**Spec:** [docs/superpowers/specs/2026-05-25-custom-food-create-design.md](../specs/2026-05-25-custom-food-create-design.md)

**Verification:** This codebase has no test runner ("no test suite and no working linter" per CLAUDE.md). Each task verifies via `npm run typecheck` plus a stated manual UI check. Don't write Jest/Vitest tests — they would not run.

---

### Task 1: Atwater kcal helper

**Files:**
- Create: `lib/food/atwater.ts`

- [ ] **Step 1: Create the helper module**

Write `lib/food/atwater.ts`:

```ts
// lib/food/atwater.ts
//
// Derive kcal from macros using Atwater factors (4·protein + 4·carbs + 9·fat).
// Used by CustomFoodForm so kcal is optional during manual food creation.
// Fiber is ignored (its caloric contribution is small and partially
// non-bioavailable; standard Atwater excludes it). Alcohol-containing foods
// or low-digestible-carb foods may legitimately diverge from this estimate —
// the form surfaces a soft warning on >30% divergence but never blocks.

export function deriveKcalFromMacros(m: {
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}): number {
  const p = Number.isFinite(m.protein_g) ? Math.max(0, m.protein_g) : 0;
  const c = Number.isFinite(m.carbs_g) ? Math.max(0, m.carbs_g) : 0;
  const f = Number.isFinite(m.fat_g) ? Math.max(0, m.fat_g) : 0;
  return 4 * p + 4 * c + 9 * f;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes with no errors related to `lib/food/atwater.ts`.

- [ ] **Step 3: Commit**

```bash
git add lib/food/atwater.ts
git commit -m "feat(food): add Atwater kcal-from-macros helper

Pure function for the custom-food-create form so users can leave kcal
blank when their label only shows P/C/F."
```

---

### Task 2: CustomFoodForm component (pure form, reusable)

**Files:**
- Create: `components/food/CustomFoodForm.tsx`

This is the form used by both surfaces. It has no `BottomSheet` of its own — the host wraps it.

- [ ] **Step 1: Create the directory and component file**

Verify the directory exists or create it:

Run: `mkdir -p components/food`

- [ ] **Step 2: Write `components/food/CustomFoodForm.tsx`**

```tsx
"use client";
// components/food/CustomFoodForm.tsx
//
// Manual "create food with macros" form. Minimum entry: name + P + C + F.
// kcal is derived live via Atwater factors when blank; user can override.
// Fiber defaults to 0. Notes are optional. Storage basis is always per_100g
// on the wire — per_serving entry is a UX affordance that back-calculates.
//
// Two surfaces consume this component:
//   - /profile/library  → LibraryClient hosts it in a plain BottomSheet.
//   - MealLoggerSheet   → CustomFoodCreateAndLogSheet wraps it with a
//     post-save qty step so create-and-log is a single flow.
//
// On 23505 dedup (existing `(user_id, lower(name))` unique idx from
// migration 0030), the error message contains "duplicate" — we surface a
// friendly inline error and stop.

import { useState, useMemo } from "react";
import type { FoodMacros } from "@/lib/food/types";
import { deriveKcalFromMacros } from "@/lib/food/atwater";
import { fmtNum } from "@/lib/ui/score";

type Basis = "per_100g" | "per_serving";

export type SavedItem = {
  id: string;
  name: string;
  per_100g: FoodMacros;
  /** Echoed back so MealLoggerSheet can default qty to the serving size when
   *  the user used the per_serving basis. NULL when basis was per_100g. */
  default_serving_g: number | null;
};

export function CustomFoodForm({
  onSaved,
  onCancel,
}: {
  onSaved: (item: SavedItem) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [basis, setBasis] = useState<Basis>("per_100g");
  const [servingG, setServingG] = useState("");
  const [proteinG, setProteinG] = useState("");
  const [carbsG, setCarbsG] = useState("");
  const [fatG, setFatG] = useState("");
  const [fiberG, setFiberG] = useState("");
  const [kcalOverride, setKcalOverride] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const p = parseFloat(proteinG) || 0;
  const c = parseFloat(carbsG) || 0;
  const f = parseFloat(fatG) || 0;
  const fib = parseFloat(fiberG) || 0;
  const userKcal = parseFloat(kcalOverride);
  const userKcalProvided = Number.isFinite(userKcal) && kcalOverride.trim() !== "";

  const atwaterKcal = useMemo(
    () => deriveKcalFromMacros({ protein_g: p, carbs_g: c, fat_g: f }),
    [p, c, f],
  );
  const finalKcal = userKcalProvided ? userKcal : atwaterKcal;

  const per100g: FoodMacros = useMemo(() => {
    if (basis === "per_100g") {
      return { kcal: finalKcal, protein_g: p, carbs_g: c, fat_g: f, fiber_g: fib };
    }
    const sg = parseFloat(servingG);
    if (!Number.isFinite(sg) || sg <= 0) {
      return { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 };
    }
    const k = 100 / sg;
    return {
      kcal: finalKcal * k,
      protein_g: p * k,
      carbs_g: c * k,
      fat_g: f * k,
      fiber_g: fib * k,
    };
  }, [basis, finalKcal, p, c, f, fib, servingG]);

  const kcalDivergencePct =
    atwaterKcal > 0 && userKcalProvided
      ? Math.abs(userKcal - atwaterKcal) / atwaterKcal
      : 0;
  const showKcalWarning = userKcalProvided && kcalDivergencePct > 0.3;

  const submit = async () => {
    setError(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Give your food a name.");
      return;
    }
    if (p < 0 || c < 0 || f < 0 || fib < 0) {
      setError("Macros must be ≥ 0.");
      return;
    }
    let servingForReturn: number | null = null;
    if (basis === "per_serving") {
      const sg = parseFloat(servingG);
      if (!Number.isFinite(sg) || sg <= 0) {
        setError("Serving size must be > 0 grams.");
        return;
      }
      servingForReturn = sg;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/food/user-items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "item",
          name: trimmedName,
          per_100g: per100g,
          source: "user_manual",
          notes: notes.trim() || null,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({ error: "save_failed" }));
        const msg = String(json.error ?? "").toLowerCase();
        if (msg.includes("duplicate") || msg.includes("23505")) {
          setError(
            `You already have a "${trimmedName}" saved. Open Manage Library to find it.`,
          );
        } else {
          setError(json.error || "save_failed");
        }
        setBusy(false);
        return;
      }
      const { id } = (await res.json()) as { id: string };
      onSaved({
        id,
        name: trimmedName,
        per_100g,
        default_serving_g: servingForReturn,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs text-zinc-400 mb-1">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Greek yogurt 5%"
          className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-2 text-sm text-zinc-100"
        />
      </div>

      <div>
        <label className="block text-xs text-zinc-400 mb-1">Macros are…</label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setBasis("per_100g")}
            className={`flex-1 rounded-md border px-3 py-2 text-sm ${
              basis === "per_100g"
                ? "border-zinc-100 bg-zinc-800 text-zinc-100"
                : "border-zinc-800 text-zinc-400"
            }`}
          >
            Per 100g
          </button>
          <button
            type="button"
            onClick={() => setBasis("per_serving")}
            className={`flex-1 rounded-md border px-3 py-2 text-sm ${
              basis === "per_serving"
                ? "border-zinc-100 bg-zinc-800 text-zinc-100"
                : "border-zinc-800 text-zinc-400"
            }`}
          >
            Per serving
          </button>
        </div>
      </div>

      {basis === "per_serving" && (
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Serving size (g)</label>
          <input
            type="number"
            inputMode="decimal"
            value={servingG}
            onChange={(e) => setServingG(e.target.value)}
            placeholder="e.g. 60"
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-2 text-sm text-zinc-100"
          />
        </div>
      )}

      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Protein (g) *</label>
          <input
            type="number"
            inputMode="decimal"
            value={proteinG}
            onChange={(e) => setProteinG(e.target.value)}
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-2 text-sm text-zinc-100"
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Carbs (g) *</label>
          <input
            type="number"
            inputMode="decimal"
            value={carbsG}
            onChange={(e) => setCarbsG(e.target.value)}
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-2 text-sm text-zinc-100"
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Fat (g) *</label>
          <input
            type="number"
            inputMode="decimal"
            value={fatG}
            onChange={(e) => setFatG(e.target.value)}
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-2 text-sm text-zinc-100"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Fiber (g)</label>
          <input
            type="number"
            inputMode="decimal"
            value={fiberG}
            onChange={(e) => setFiberG(e.target.value)}
            placeholder="0"
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-2 text-sm text-zinc-100"
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Calories (kcal)</label>
          <input
            type="number"
            inputMode="decimal"
            value={kcalOverride}
            onChange={(e) => setKcalOverride(e.target.value)}
            placeholder={fmtNum(atwaterKcal)}
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-2 text-sm text-zinc-100"
          />
        </div>
      </div>

      {showKcalWarning && (
        <p className="text-xs text-amber-400">
          kcal looks {userKcal > atwaterKcal ? "higher" : "lower"} than macros
          suggest (Atwater estimate: {fmtNum(atwaterKcal)} kcal).
        </p>
      )}

      <div>
        <label className="block text-xs text-zinc-400 mb-1">Notes (optional)</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={2000}
          rows={2}
          placeholder="Brand, where the macros come from, etc."
          className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-2 text-sm text-zinc-100"
        />
      </div>

      <div className="rounded-md border border-zinc-800 bg-zinc-900/50 p-3 text-xs text-zinc-400">
        <div className="text-zinc-500 mb-1">Per 100g preview</div>
        <div className="text-zinc-200">
          {fmtNum(per100g.kcal)} kcal · {fmtNum(per100g.protein_g)}P ·{" "}
          {fmtNum(per100g.carbs_g)}C · {fmtNum(per100g.fat_g)}F ·{" "}
          {fmtNum(per100g.fiber_g)} fib
        </div>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="flex-1 rounded-md border border-zinc-800 py-2 text-sm text-zinc-400"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="flex-1 rounded-md bg-zinc-100 py-2 text-sm font-medium text-zinc-900 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save to library"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: passes. (If `fmtNum` import errors, verify `lib/ui/score.ts` exports it — it does, but worth confirming.)

- [ ] **Step 4: Commit**

```bash
git add components/food/CustomFoodForm.tsx
git commit -m "feat(food): CustomFoodForm — reusable manual create form

Pure form component with per-100g/per-serving toggle, live Atwater kcal
derivation, 30% divergence warning, and 23505 dedup handling. No host
wrapper — caller mounts it inside its own BottomSheet."
```

---

### Task 3: Wire into `/profile/library` (Manage Library page)

**Files:**
- Modify: `components/profile/LibraryClient.tsx`

- [ ] **Step 1: Replace `components/profile/LibraryClient.tsx`**

Full replacement (the file is 77 lines; clean rewrite is simpler than surgical edits):

```tsx
"use client";
// components/profile/LibraryClient.tsx
//
// Renders the user's user_food_items list. Read-via-hook, write-via-fetch
// against /api/food/user-items/[id]. The Manage-Library page hands us the
// userId (resolved server-side); we don't refetch auth here.
//
// Create flow: "+ Add custom food" button at top opens a BottomSheet
// hosting <CustomFoodForm>. On save we invalidate the query and the new
// row appears at the top of the list (sorted by updated_at desc).

import { useState } from "react";
import { useUserFoodItems } from "@/lib/query/hooks/useUserFoodItems";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fmtNum } from "@/lib/ui/score";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { CustomFoodForm } from "@/components/food/CustomFoodForm";
import type { UserFoodItem } from "@/lib/food/types";

export function LibraryClient({ userId }: { userId: string }) {
  const { data: items, isLoading, isError } = useUserFoodItems(userId);
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this library item? Past logs are kept.")) return;
    setBusyId(id);
    const res = await fetch(`/api/food/user-items/${id}`, { method: "DELETE" });
    if (res.ok) {
      await queryClient.invalidateQueries({ queryKey: queryKeys.userFoodItems.all(userId) });
    }
    setBusyId(null);
  };

  const handleSaved = async () => {
    setCreateOpen(false);
    await queryClient.invalidateQueries({ queryKey: queryKeys.userFoodItems.all(userId) });
  };

  if (isLoading) return <div className="p-4 text-zinc-500">Loading…</div>;
  if (isError) return <div className="p-4 text-amber-400">Couldn&apos;t load library.</div>;
  const rows = items ?? [];

  return (
    <>
      <main className="px-4 py-6 max-w-2xl mx-auto">
        <h1 className="text-xl font-semibold text-zinc-100 mb-1">My Library</h1>
        <p className="text-zinc-500 text-sm mb-4">
          Saved foods and recipes. These resolve first when you log meals.
        </p>

        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="mb-6 w-full rounded-md bg-zinc-100 py-2 text-sm font-medium text-zinc-900"
        >
          + Add custom food
        </button>

        {rows.length === 0 && (
          <div className="text-zinc-600 text-sm py-12 text-center">
            Nothing saved yet. Tap &ldquo;+ Add custom food&rdquo; above, or save
            a meal from the food log.
          </div>
        )}
        <ul className="space-y-2">
          {rows.map((it: UserFoodItem) => {
            const isRecipe = it.composite_of !== null;
            return (
              <li
                key={it.id}
                className="rounded-2xl bg-zinc-900 border border-zinc-800 p-3 text-sm"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-zinc-100 truncate">{it.name}</div>
                    <div className="text-xs text-zinc-500 mt-0.5">
                      {isRecipe
                        ? `Recipe · ${it.composite_of?.length ?? 0} ingredients · default ${fmtNum(it.default_serving_g ?? 0)}g`
                        : `${fmtNum(it.per_100g?.kcal ?? 0)} kcal · ${fmtNum(it.per_100g?.protein_g ?? 0)}P / 100g`}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busyId === it.id}
                    onClick={() => handleDelete(it.id)}
                    className="text-zinc-500 hover:text-amber-400 text-xs"
                  >
                    {busyId === it.id ? "…" : "Delete"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </main>

      <BottomSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Add custom food"
      >
        <CustomFoodForm onSaved={handleSaved} onCancel={() => setCreateOpen(false)} />
      </BottomSheet>
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 3: Manual UI verification**

Start the dev server if it isn't running: `npm run dev`

Then:
1. Open http://localhost:3000/profile/library
2. Confirm the "+ Add custom food" button renders at the top of the page.
3. Tap it — BottomSheet opens with the form.
4. Enter `name="Test food A"`, `P=20`, `C=10`, `F=5`. Confirm the kcal placeholder shows `165` (`4·20 + 4·10 + 9·5`). Confirm the "Per 100g preview" shows `165 kcal · 20P · 10C · 5F · 0 fib`.
5. Tap **Save to library**. Sheet closes; "Test food A" appears at top of list with `165 kcal · 20P / 100g`.
6. Tap the button again, enter the same name. Confirm the dedup error message: "You already have a 'Test food A' saved. Open Manage Library to find it."
7. Tap again, switch basis to **Per serving**, enter `Serving size=60`, `P=12`, `C=6`, `F=3`, `name="Test food B"`. Confirm preview shows back-calculated per-100g (≈`165 kcal · 20P · 10C · 5F`).
8. Tap Save. Confirm "Test food B" appears.
9. Tap **Delete** on both test rows to clean up.

- [ ] **Step 4: Commit**

```bash
git add components/profile/LibraryClient.tsx
git commit -m "feat(profile): + Add custom food on /profile/library

Hosts CustomFoodForm in a BottomSheet. On save, invalidates the
userFoodItems query so the new row appears immediately. Empty-state
copy now points at the create button instead of the old 'use the
meal log' instruction."
```

---

### Task 4: Inline create-and-log inside MealLoggerSheet

This task ships the second surface. The user is in `MealLoggerSheet` mid-log, search misses their food, they tap "+ Create custom food" → form → save → qty input → log → row commits → sheet closes.

**Files:**
- Create: `components/log/CustomFoodCreateAndLogSheet.tsx`
- Modify: `components/log/MealLoggerLibraryTab.tsx`
- Modify: `components/log/MealLoggerSheet.tsx`

- [ ] **Step 1: Create `components/log/CustomFoodCreateAndLogSheet.tsx`**

```tsx
"use client";
// components/log/CustomFoodCreateAndLogSheet.tsx
//
// Two-step sheet for inline-create-and-log inside MealLoggerSheet.
// Step 1: CustomFoodForm  →  user saves to library
// Step 2: Qty input       →  user logs N grams for the current meal slot
//
// Step 2 hits /api/food/draft with a SearchCandidate { source: "user_library",
// canonical_id: <user_food_items.id> } — the same shape the existing
// /api/food/draft route accepts (and that log_meal_entry uses internally).
// On commit, calls onLogged() so the caller can invalidate downstream caches.
// "Done (skip log)" closes the sheet without logging — the library row was
// still saved in step 1.

import { useState } from "react";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { CustomFoodForm, type SavedItem } from "@/components/food/CustomFoodForm";
import { fmtNum } from "@/lib/ui/score";
import type { MealSlot } from "@/lib/food/types";

export function CustomFoodCreateAndLogSheet({
  open,
  onClose,
  mealSlot,
  eatenAt,
  onLogged,
}: {
  open: boolean;
  onClose: () => void;
  mealSlot: MealSlot;
  eatenAt: string;
  onLogged: () => void;
}) {
  const [step, setStep] = useState<"form" | "qty">("form");
  const [savedItem, setSavedItem] = useState<SavedItem | null>(null);
  const [qtyG, setQtyG] = useState("100");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setStep("form");
    setSavedItem(null);
    setQtyG("100");
    setError(null);
    setBusy(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSaved = (item: SavedItem) => {
    setSavedItem(item);
    setQtyG(String(item.default_serving_g ?? 100));
    setStep("qty");
  };

  const handleLog = async () => {
    if (!savedItem) return;
    const qty = parseFloat(qtyG);
    if (!Number.isFinite(qty) || qty <= 0) {
      setError("Quantity must be > 0g.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const draftRes = await fetch("/api/food/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: [
            {
              candidate: {
                name: savedItem.name,
                per_100g: savedItem.per_100g,
                source: "user_library",
                canonical_id: savedItem.id,
                image_url: null,
              },
              qty_g: qty,
            },
          ],
          meal_slot: mealSlot,
          eaten_at: eatenAt,
        }),
      });
      if (!draftRes.ok) {
        const json = await draftRes.json().catch(() => ({ error: "draft_failed" }));
        throw new Error(json.error || "draft_failed");
      }
      const { entry } = await draftRes.json();
      const commitRes = await fetch("/api/food/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entry_id: entry.id }),
      });
      if (!commitRes.ok) {
        const json = await commitRes.json().catch(() => ({ error: "commit_failed" }));
        throw new Error(json.error || "commit_failed");
      }
      onLogged();
      handleClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet
      open={open}
      onClose={handleClose}
      title={step === "form" ? "Create custom food" : "How much?"}
    >
      {step === "form" && (
        <CustomFoodForm onSaved={handleSaved} onCancel={handleClose} />
      )}
      {step === "qty" && savedItem && (
        <div className="space-y-4">
          <p className="text-sm text-zinc-300">
            Saved &ldquo;{savedItem.name}&rdquo; to your library. Log how much
            you&rsquo;re eating now:
          </p>
          <div className="rounded-md border border-zinc-800 bg-zinc-900/50 p-3 text-xs text-zinc-400">
            <div className="text-zinc-500 mb-1">Per 100g</div>
            <div className="text-zinc-200">
              {fmtNum(savedItem.per_100g.kcal)} kcal ·{" "}
              {fmtNum(savedItem.per_100g.protein_g)}P ·{" "}
              {fmtNum(savedItem.per_100g.carbs_g)}C ·{" "}
              {fmtNum(savedItem.per_100g.fat_g)}F
            </div>
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Quantity (g)</label>
            <input
              type="number"
              inputMode="decimal"
              value={qtyG}
              onChange={(e) => setQtyG(e.target.value)}
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-2 text-sm text-zinc-100"
            />
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleClose}
              disabled={busy}
              className="flex-1 rounded-md border border-zinc-800 py-2 text-sm text-zinc-400"
            >
              Done (skip log)
            </button>
            <button
              type="button"
              onClick={handleLog}
              disabled={busy}
              className="flex-1 rounded-md bg-zinc-100 py-2 text-sm font-medium text-zinc-900 disabled:opacity-50"
            >
              {busy ? "Logging…" : "Log it"}
            </button>
          </div>
        </div>
      )}
    </BottomSheet>
  );
}
```

- [ ] **Step 2: Modify `components/log/MealLoggerLibraryTab.tsx` to add the "+ Create custom food" button**

Change the component signature to accept a new callback prop, then add a button next to the existing "📚 Pick from history" button.

Edit [components/log/MealLoggerLibraryTab.tsx:10-22](../../components/log/MealLoggerLibraryTab.tsx#L10-L22) — extend the props:

```tsx
export function MealLoggerLibraryTab({
  userId,
  mealSlot,
  eatenAt,
  onCommitted,
  onOpenHistoryPicker,
  onOpenCustomCreate,
}: {
  userId: string;
  mealSlot: MealSlot;
  eatenAt: string;
  onCommitted: () => void;
  onOpenHistoryPicker: () => void;
  onOpenCustomCreate: () => void;
}) {
```

Then edit [components/log/MealLoggerLibraryTab.tsx:84-92](../../components/log/MealLoggerLibraryTab.tsx#L84-L92) — replace the single "Pick from history" button with a flex pair:

```tsx
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onOpenHistoryPicker}
          className="flex-1 rounded-md border border-zinc-700 py-2 text-sm text-zinc-100"
        >
          📚 Pick from history
        </button>
        <button
          type="button"
          onClick={onOpenCustomCreate}
          className="flex-1 rounded-md border border-zinc-700 py-2 text-sm text-zinc-100"
        >
          + Create custom food
        </button>
      </div>
```

The rest of the JSX (search input, sections, etc.) is unchanged.

- [ ] **Step 3: Modify `components/log/MealLoggerSheet.tsx` to host the new sub-sheet**

Add the import, the state, the prop pass-down, and the sibling sheet — mirror the HistoryPickerSheet pattern.

Edit the top of the file, adding the new import below the existing imports:

```tsx
import { CustomFoodCreateAndLogSheet } from "./CustomFoodCreateAndLogSheet";
```

Edit the `useState` block (around line 26-27) — add the new state:

```tsx
  const [tab, setTab] = useState<Tab>("search");
  const [historyPickerOpen, setHistoryPickerOpen] = useState(false);
  const [customCreateOpen, setCustomCreateOpen] = useState(false);
```

Edit the `MealLoggerLibraryTab` invocation (around line 82-90) — pass the new callback:

```tsx
          {tab === "library" && (
            <MealLoggerLibraryTab
              userId={userId}
              mealSlot={mealSlot}
              eatenAt={eatenAt}
              onCommitted={onCommitted}
              onOpenHistoryPicker={() => setHistoryPickerOpen(true)}
              onOpenCustomCreate={() => setCustomCreateOpen(true)}
            />
          )}
```

Edit the sibling-sheet section (after the existing `<HistoryPickerSheet>`, before the closing `</>`) — add the new sheet:

```tsx
      <HistoryPickerSheet
        open={historyPickerOpen}
        onClose={() => setHistoryPickerOpen(false)}
        userId={userId}
        initialDestinationSlot={mealSlot}
        initialEatenAt={eatenAt}
        onCommitted={onCommitted}
      />
      <CustomFoodCreateAndLogSheet
        open={customCreateOpen}
        onClose={() => setCustomCreateOpen(false)}
        mealSlot={mealSlot}
        eatenAt={eatenAt}
        onLogged={onCommitted}
      />
    </>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 5: Manual UI verification**

If you wiped `.next/` recently, restart the dev server so the changes load — per the project memory, chunk caching can hide edits to layout-adjacent client components. Then:

1. Open http://localhost:3000/meal
2. Tap "+ Log entry" (or open any meal slot card's "+" entry) → MealLoggerSheet opens.
3. Switch to the **Library** tab.
4. Confirm "📚 Pick from history" and "+ Create custom food" sit side-by-side at the top.
5. Tap "+ Create custom food" — a new BottomSheet opens **above** the meal-logger sheet with title "Create custom food".
6. Enter `name="Inline test bar"`, `P=20`, `C=20`, `F=8`. Tap **Save to library**. The same sheet transitions to step 2 (title "How much?") and shows a per-100g preview + quantity input pre-filled with `100`.
7. Change quantity to `60`. Tap **Log it**. The sheet closes.
8. The parent MealLoggerSheet is still open. Confirm it shows the freshly logged entry in the appropriate slot card on `/meal` after the sheet is dismissed (close the meal-logger sheet to see).
9. Reopen the meal-logger, go to Library tab, tap "+ Create custom food" again. Enter a duplicate name (`"Inline test bar"`) — confirm the dedup error renders inline in step 1.
10. Tap "+ Create custom food" again, save a brand-new item, then on the qty step tap **Done (skip log)**. The sheet closes; navigate to `/profile/library` and confirm the new item is in the list (saved without a log entry).
11. Cleanup: delete the test items from `/profile/library`. If the smoke-test entry on `/meal` is unwanted, delete it from the meal slot card.

- [ ] **Step 6: Commit**

```bash
git add components/log/CustomFoodCreateAndLogSheet.tsx components/log/MealLoggerLibraryTab.tsx components/log/MealLoggerSheet.tsx
git commit -m "feat(meal): inline + Create custom food in MealLoggerSheet

Two-step sheet: CustomFoodForm → qty input → /api/food/draft +
/api/food/commit with source=user_library candidate. Library tab now
shows 'Pick from history' and 'Create custom food' as a pair of CTAs.
Skip-log path keeps the saved library row without logging an entry."
```

---

### Final verification

- [ ] **Run typecheck once more across all the changed files**

Run: `npm run typecheck`
Expected: passes.

- [ ] **End-to-end smoke**

1. From `/meal`, create a custom food via the inline flow and log 50g of it.
2. Open `/coach` chat, ask Nora: "What did I eat for [meal slot] today?" — confirm Nora's `query_food_log` tool returns the just-logged entry with the custom name.
3. Open `/profile/library` — confirm the row is there with the user-entered macros.
4. Test the resolution chain: in the chat, tell Nora "Log 100g of [your custom food name]" — confirm she resolves to the library row (not USDA / LLM), via her `search_library` / `pick_library_item` flow.
