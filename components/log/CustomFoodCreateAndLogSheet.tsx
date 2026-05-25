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
import { useQueryClient } from "@tanstack/react-query";
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
  const queryClient = useQueryClient();

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

  const invalidateLibrary = async () => {
    await queryClient.invalidateQueries({
      predicate: (q) => q.queryKey[0] === "food-library" || q.queryKey[0] === "user-food-items",
    });
  };

  const handleClose = () => {
    const hadSavedItem = savedItem !== null;
    reset();
    onClose();
    if (hadSavedItem) {
      void invalidateLibrary();
    }
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
      await invalidateLibrary();
      onLogged();
      reset();
      onClose();
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
