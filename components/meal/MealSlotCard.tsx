// components/meal/MealSlotCard.tsx
"use client";

import { useQueryClient } from "@tanstack/react-query";
import { fmtNum } from "@/lib/ui/score";
import { mealSlotLabel } from "@/lib/food/meal-slot";
import type { FoodLogEntry, MealSlot } from "@/lib/food/types";

export function MealSlotCard({
  slot,
  entries,
  targetKcal,
  onLog,
  onTapEntry,
}: {
  slot: MealSlot;
  entries: FoodLogEntry[];
  targetKcal: number | null;
  onLog: () => void;
  onTapEntry: (e: FoodLogEntry) => void;
}) {
  const qc = useQueryClient();
  const slotKcal = entries.reduce((a, e) => a + e.totals.kcal, 0);
  const earliest = entries.length > 0
    ? new Date(entries[entries.length - 1].eaten_at).toLocaleTimeString([], {
        hour: "2-digit", minute: "2-digit",
      })
    : null;

  return (
    <section className="rounded-lg border border-zinc-800">
      <header className="flex items-center justify-between border-b border-zinc-900 p-3">
        <div>
          <div className="text-sm font-semibold">{mealSlotLabel(slot)}</div>
          <div className="text-xs text-zinc-500">
            {earliest && `${earliest} · `}
            {fmtNum(slotKcal)} kcal
            {targetKcal !== null && ` / ${fmtNum(targetKcal)} target`}
          </div>
        </div>
        <button
          type="button"
          onClick={onLog}
          aria-label={`Log ${mealSlotLabel(slot)}`}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-100 text-lg font-semibold text-zinc-900"
        >
          +
        </button>
      </header>

      <ul>
        {entries.map((e) => (
          <li key={e.id} className="border-b border-zinc-900 last:border-b-0">
            <div className="flex w-full items-start justify-between gap-2 p-3">
              <button
                type="button"
                onClick={() => onTapEntry(e)}
                className="flex flex-1 items-start justify-between text-left"
              >
                <div>
                  <div className="text-sm">
                    {e.items.map((it) => it.name).join(", ")}
                    {e.recipe_id && (
                      <span className="ml-2 rounded bg-zinc-800 text-zinc-400 px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
                        recipe
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-zinc-500">
                    {new Date(e.eaten_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    {" · "}
                    {fmtNum(e.totals.kcal)} kcal · {fmtNum(e.totals.protein_g)} P
                    {e.is_estimated && <span className="ml-1 text-amber-400">estimated</span>}
                  </div>
                </div>
                <span className="text-zinc-600">›</span>
              </button>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label={e.is_favorite ? "Unfavorite" : "Favorite"}
                  onClick={async (evt) => {
                    evt.stopPropagation();
                    const next = !e.is_favorite;
                    const res = await fetch(`/api/food/entries/${e.id}/favorite`, {
                      method: "PATCH",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ value: next }),
                    });
                    if (res.ok) {
                      await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "food-entries" });
                      await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "food-library" });
                    }
                  }}
                  className="text-lg text-zinc-300 hover:text-zinc-100"
                >
                  {e.is_favorite ? "★" : "☆"}
                </button>
                <button
                  type="button"
                  aria-label="Copy to today"
                  onClick={async (evt) => {
                    evt.stopPropagation();
                    const draftRes = await fetch(`/api/food/entries/${e.id}/copy`, {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({}),
                    });
                    if (!draftRes.ok) return;
                    const { entry: draft } = await draftRes.json();
                    const commitRes = await fetch("/api/food/commit", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ entry_id: draft.id }),
                    });
                    if (commitRes.ok) {
                      await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "food-entries" });
                      await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "daily-logs" });
                    }
                  }}
                  className="text-base text-zinc-300 hover:text-zinc-100"
                >
                  📋
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
