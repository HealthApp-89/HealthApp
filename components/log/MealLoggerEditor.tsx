"use client";
// components/log/MealLoggerEditor.tsx
//
// Inline per-item qty editor for a draft food_log_entries row. Replaces the
// preview card in place when the user taps Edit. Save → PATCH /api/food/
// entries/[id]/items, then swap back to preview view.

import { useState } from "react";
import type { FoodLogEntry, FoodItem } from "@/lib/food/types";
import { macrosForQty } from "@/lib/food/types";
import { fmtNum } from "@/lib/ui/score";

type Props = {
  entry: FoodLogEntry;
  onSaved: (updated: FoodLogEntry) => void;
  onCancel: () => void;
};

export function MealLoggerEditor({ entry, onSaved, onCancel }: Props) {
  const [items, setItems] = useState<FoodItem[]>(entry.items);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setQty = (idx: number, qty_g: number) => {
    setItems((prev) =>
      prev.map((it, i) =>
        i === idx
          ? { ...it, qty_g, ...macrosForQty(it.per_100g, qty_g) }
          : it,
      ),
    );
  };

  const removeItem = (idx: number) => {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  };

  const save = async () => {
    if (items.length === 0) {
      setError("Add at least one item.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/food/entries/${entry.id}/items`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    if (!res.ok) {
      setError("Save failed — try again.");
      setBusy(false);
      return;
    }
    const json = (await res.json()) as { entry: FoodLogEntry };
    setBusy(false);
    onSaved(json.entry);
  };

  return (
    <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-3 text-sm">
      <div className="space-y-2">
        {items.map((it, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <span className="flex-1 text-zinc-200 truncate">{it.name}</span>
            <input
              type="number"
              min={1}
              step={1}
              value={Math.round(it.qty_g)}
              onChange={(e) => setQty(idx, Math.max(1, parseInt(e.target.value || "0", 10)))}
              className="w-16 rounded bg-zinc-800 text-right text-zinc-100 px-2 py-1 text-xs tabular-nums"
            />
            <span className="text-zinc-500 text-xs">g</span>
            <span className="w-14 text-right text-zinc-400 tabular-nums text-xs">
              {fmtNum(it.kcal)}kcal
            </span>
            <button
              type="button"
              onClick={() => removeItem(idx)}
              className="text-zinc-500 hover:text-zinc-300 text-xs px-1"
              title="Remove"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={save}
          className="flex-1 rounded-lg bg-zinc-100 text-zinc-900 px-3 py-1.5 text-xs font-medium disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="rounded-lg bg-zinc-800 text-zinc-400 px-3 py-1.5 text-xs"
        >
          Back
        </button>
      </div>
      {error && <div className="mt-2 text-xs text-amber-400">{error}</div>}
    </div>
  );
}
