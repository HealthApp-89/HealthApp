// components/meal/MealSlotCard.tsx
"use client";

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
            <button
              type="button"
              onClick={() => onTapEntry(e)}
              className="flex w-full items-start justify-between p-3 text-left"
            >
              <div>
                <div className="text-sm">{e.items.map((it) => it.name).join(", ")}</div>
                <div className="text-xs text-zinc-500">
                  {new Date(e.eaten_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  {" · "}
                  {fmtNum(e.totals.kcal)} kcal · {fmtNum(e.totals.protein_g)} P
                  {e.is_estimated && <span className="ml-1 text-amber-400">estimated</span>}
                </div>
              </div>
              <span className="text-zinc-600">›</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
