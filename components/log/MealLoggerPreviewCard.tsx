"use client";
// components/log/MealLoggerPreviewCard.tsx
//
// Read-only preview of a draft food_log_entries row, rendered inside the
// meal-log chat thread (one bubble per draft). Three actions: Confirm
// (calls /api/food/commit), Edit (swaps to MealLoggerEditor in place),
// Cancel (deletes the draft row).

import { useState } from "react";
import type { FoodLogEntry } from "@/lib/food/types";
import { fmtNum } from "@/lib/ui/score";

type Props = {
  entry: FoodLogEntry;
  onCommitted: () => void;
  onCancelled: () => void;
  onEdit: () => void;
};

export function MealLoggerPreviewCard({ entry, onCommitted, onCancelled, onEdit }: Props) {
  const [busy, setBusy] = useState<"confirm" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy("confirm");
    setError(null);
    const res = await fetch("/api/food/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry_id: entry.id }),
    });
    if (!res.ok) {
      setError("Couldn't commit — try again.");
      setBusy(null);
      return;
    }
    onCommitted();
  };

  const cancel = async () => {
    setBusy("cancel");
    setError(null);
    const res = await fetch(`/api/food/entries/${entry.id}`, { method: "DELETE" });
    if (!res.ok) {
      setError("Couldn't cancel — try again.");
      setBusy(null);
      return;
    }
    onCancelled();
  };

  return (
    <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-3 text-sm">
      <div className="space-y-1.5">
        {entry.items.map((it, idx) => (
          <div key={idx} className="flex items-baseline justify-between gap-3">
            <span className="text-zinc-200">
              {it.name}
              <span className="text-zinc-500"> · {fmtNum(it.qty_g)}g</span>
              {it.confidence === "low" && <span className="ml-1 text-amber-500 text-xs">est.</span>}
              {it.confidence === "medium" && <span className="ml-1 text-amber-400 text-xs">~</span>}
            </span>
            <span className="text-zinc-400 tabular-nums text-xs">
              {fmtNum(it.kcal)}kcal · {fmtNum(it.protein_g)}P
            </span>
          </div>
        ))}
      </div>
      <div className="mt-3 pt-3 border-t border-zinc-800 flex items-baseline justify-between text-xs">
        <span className="text-zinc-500">Total</span>
        <span className="text-zinc-200 tabular-nums">
          {fmtNum(entry.totals.kcal)}kcal · {fmtNum(entry.totals.protein_g)}P · {fmtNum(entry.totals.carbs_g)}C · {fmtNum(entry.totals.fat_g)}F
        </span>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={confirm}
          className="flex-1 rounded-lg bg-zinc-100 text-zinc-900 px-3 py-1.5 text-xs font-medium disabled:opacity-50"
        >
          {busy === "confirm" ? "Saving…" : "Confirm"}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={onEdit}
          className="rounded-lg bg-zinc-800 text-zinc-200 px-3 py-1.5 text-xs"
        >
          Edit
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={cancel}
          className="rounded-lg bg-zinc-800 text-zinc-400 px-3 py-1.5 text-xs"
        >
          {busy === "cancel" ? "…" : "Cancel"}
        </button>
      </div>
      {error && <div className="mt-2 text-xs text-amber-400">{error}</div>}
    </div>
  );
}
