// components/meal/MealSlotEmptyCard.tsx
"use client";

import { fmtNum } from "@/lib/ui/score";
import { mealSlotLabel } from "@/lib/food/meal-slot";
import type { MealSlot } from "@/lib/food/types";

export function MealSlotEmptyCard({
  slot,
  targetKcal,
  onLog,
}: {
  slot: MealSlot;
  targetKcal: number | null;
  onLog: () => void;
}) {
  return (
    <section className="rounded-lg border border-dashed border-zinc-700">
      <header className="flex items-center justify-between p-3">
        <div>
          <div className="text-sm font-semibold text-zinc-300">{mealSlotLabel(slot)}</div>
          {targetKcal !== null && (
            <div className="text-xs text-zinc-500">0 / {fmtNum(targetKcal)} target</div>
          )}
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
    </section>
  );
}
