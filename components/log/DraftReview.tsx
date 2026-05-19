"use client";
import type { FoodLogEntry } from "@/lib/food/types";
import { fmtNum } from "@/lib/ui/score";

/** Renders a draft food entry for review before commit. Shared by the TYPE,
 *  SCAN, and (forthcoming) SEARCH tabs. Task 7+ will add Edit/Delete affordances
 *  on rows. */
export function DraftReview({
  entry,
  busy,
  error,
  onCommit,
  onDiscard,
}: {
  entry: Pick<FoodLogEntry, "id" | "items" | "totals" | "is_estimated">;
  busy: boolean;
  error: string | null;
  onCommit: () => Promise<void>;
  onDiscard: () => Promise<void>;
}) {
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
