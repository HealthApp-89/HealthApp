"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { macrosForQty, type FoodItem, type FoodLogEntry } from "@/lib/food/types";
import { fmtNum } from "@/lib/ui/score";
import { MEAL_SLOTS, mealSlotLabel } from "@/lib/food/meal-slot";
import type { MealSlot } from "@/lib/food/types";
import { useFoodItemFavorites } from "@/lib/query/hooks/useFoodItemFavorites";

export function FoodEntryEditSheet({
  entry,
  userId,
  onClose,
}: {
  entry: FoodLogEntry;
  userId: string;
  onClose: () => void;
}) {
  const [items, setItems] = useState<FoodItem[]>(entry.items);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mealSlot, setMealSlot] = useState<MealSlot>(entry.meal_slot);
  const [eatenAt, setEatenAt]   = useState<string>(entry.eaten_at);
  const qc = useQueryClient();
  const { data: itemFavorites = [] } = useFoodItemFavorites(userId);

  const isItemFavorite = (name: string) =>
    itemFavorites.some((f) => f.name.toLowerCase() === name.toLowerCase());

  const setQty = (idx: number, qty_g: number) => {
    setItems((prev) =>
      prev.map((it, i) => {
        if (i !== idx) return it;
        const macros = macrosForQty(it.per_100g, qty_g);
        return { ...it, qty_g, ...macros };
      }),
    );
  };

  const invalidate = async () => {
    // Match MealLoggerSheet pattern: predicate-based invalidation works without
    // userId (single-user app), matches all food-entries and daily-logs queries.
    await qc.invalidateQueries({
      predicate: (q) => q.queryKey[0] === "food-entries",
    });
    await qc.invalidateQueries({
      predicate: (q) => q.queryKey[0] === "daily-logs",
    });
  };

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/food/entries/${entry.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items, meal_slot: mealSlot, eaten_at: eatenAt }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({ error: "update_failed" }));
        throw new Error(json.error || "update_failed");
      }
      await invalidate();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!confirm("Delete this entry?")) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/food/entries/${entry.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({ error: "delete_failed" }));
        throw new Error(json.error || "delete_failed");
      }
      await invalidate();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet open onClose={onClose} title="Edit meal">
      <div className="space-y-3 p-4">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-zinc-400">
            Meal
            <select
              value={mealSlot}
              onChange={(e) => setMealSlot(e.target.value as MealSlot)}
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 p-2 text-sm text-zinc-100"
            >
              {MEAL_SLOTS.map((s) => (
                <option key={s} value={s}>{mealSlotLabel(s)}</option>
              ))}
            </select>
          </label>

          <label className="text-xs text-zinc-400">
            Time
            <input
              type="datetime-local"
              value={toLocalInputValue(eatenAt)}
              onChange={(e) => setEatenAt(fromLocalInputValue(e.target.value))}
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 p-2 text-sm text-zinc-100"
            />
          </label>
        </div>
        {items.map((it, idx) => (
          <div key={idx} className="rounded-md border border-zinc-800 p-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">{it.name}</div>
              <button
                type="button"
                aria-label={isItemFavorite(it.name) ? "Unfavorite item" : "Favorite item"}
                onClick={async () => {
                  const starred = isItemFavorite(it.name);
                  try {
                    if (starred) {
                      const fav = itemFavorites.find((f) => f.name.toLowerCase() === it.name.toLowerCase());
                      if (!fav) return;
                      await fetch(`/api/food/item-favorites/${fav.id}`, { method: "DELETE" });
                    } else {
                      await fetch("/api/food/item-favorites", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({
                          name: it.name,
                          qty_g: it.qty_g,
                          per_100g: it.per_100g,
                          source: it.source,
                          db_ref: it.db_ref ?? null,
                          default_meal_slot: entry.meal_slot,
                        }),
                      });
                    }
                    await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "food-item-favorites" });
                    await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "food-library" });
                  } catch (e) {
                    console.error("Failed to toggle favorite:", e);
                  }
                }}
                className="text-lg"
              >
                {isItemFavorite(it.name) ? "★" : "☆"}
              </button>
            </div>
            <label className="mt-2 block text-xs text-zinc-400">
              Quantity (g)
              <input
                type="number"
                value={it.qty_g}
                onChange={(e) => setQty(idx, parseFloat(e.target.value) || 0)}
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 p-2 text-sm text-zinc-100"
              />
            </label>
            <div className="mt-2 text-xs text-zinc-500">
              {fmtNum(it.kcal)} kcal · {fmtNum(it.protein_g)} P ·{" "}
              {fmtNum(it.carbs_g)} C · {fmtNum(it.fat_g)} F
            </div>
          </div>
        ))}
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={del}
            disabled={busy}
            className="flex-1 rounded-md border border-red-700 py-2 text-sm text-red-400"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="flex-1 rounded-md bg-zinc-100 py-2 text-sm text-zinc-900"
          >
            {busy ? "..." : "Save"}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}

// `datetime-local` expects "YYYY-MM-DDTHH:mm" in local time, no seconds
// or timezone suffix. Helpers translate to/from full ISO strings.
function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInputValue(v: string): string {
  return new Date(v).toISOString();
}
