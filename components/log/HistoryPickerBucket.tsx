"use client";

import { MEAL_SLOTS, mealSlotLabel } from "@/lib/food/meal-slot";
import { fmtNum } from "@/lib/ui/score";
import type { FoodItem, MealSlot } from "@/lib/food/types";

export type SelectedItem = {
  item: FoodItem;
  source_entry_id: string;
  source_date: string;
};

export function HistoryPickerBucket({
  selected,
  destinationSlot,
  onChangeDestination,
  onRemove,
  onClearAll,
}: {
  selected: SelectedItem[];
  destinationSlot: MealSlot;
  onChangeDestination: (slot: MealSlot) => void;
  onRemove: (idx: number) => void;
  onClearAll: () => void;
}) {
  if (selected.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-zinc-500 border-b border-zinc-800">
        Tap items below to add them. Selected items will appear here.
      </div>
    );
  }
  return (
    <div className="border-b border-zinc-800 px-3 py-2">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wider text-zinc-400">
          Selected ({selected.length}) — Add to:
        </div>
        <select
          value={destinationSlot}
          onChange={(e) => onChangeDestination(e.target.value as MealSlot)}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100"
        >
          {MEAL_SLOTS.map((s) => (
            <option key={s} value={s}>{mealSlotLabel(s)}</option>
          ))}
        </select>
      </div>
      <ul className="mt-2 space-y-1">
        {selected.map((s, idx) => (
          <li key={`${s.source_entry_id}-${idx}`} className="flex items-center justify-between text-xs text-zinc-300">
            <span>
              {s.item.name} {fmtNum(s.item.qty_g)}g
              <span className="ml-2 text-zinc-500">· {s.source_date}</span>
            </span>
            <button type="button" onClick={() => onRemove(idx)} aria-label="Remove" className="px-2">×</button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={onClearAll} className="mt-1 text-xs text-zinc-500 underline">Clear all</button>
    </div>
  );
}
