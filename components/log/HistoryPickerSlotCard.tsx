"use client";

import { mealSlotLabel } from "@/lib/food/meal-slot";
import { fmtNum } from "@/lib/ui/score";
import type { FoodItem, FoodLogEntry, MealSlot } from "@/lib/food/types";

type ItemKey = string;

export function HistoryPickerSlotCard({
  date,
  slot,
  entries,
  selectedKeys,
  onToggleItem,
  onSelectAllInSlot,
}: {
  date: string;
  slot: MealSlot;
  entries: FoodLogEntry[];
  selectedKeys: Set<ItemKey>;
  onToggleItem: (entry: FoodLogEntry, itemIdx: number) => void;
  onSelectAllInSlot: (entries: FoodLogEntry[]) => void;
}) {
  if (entries.length === 0) return null;
  const totalItems = entries.reduce((a, e) => a + e.items.length, 0);

  return (
    <section className="rounded-lg border border-zinc-800">
      <header className="flex items-center justify-between border-b border-zinc-900 px-3 py-2">
        <div className="text-xs uppercase tracking-wider text-zinc-400">
          {date} — {mealSlotLabel(slot)} ({totalItems} {totalItems === 1 ? "item" : "items"})
        </div>
        <button
          type="button"
          onClick={() => onSelectAllInSlot(entries)}
          className="text-xs text-zinc-100 underline"
        >
          Select all
        </button>
      </header>
      <ul>
        {entries.flatMap((e) =>
          e.items.map((it: FoodItem, idx: number) => {
            const key: ItemKey = `${e.id}::${idx}`;
            const checked = selectedKeys.has(key);
            return (
              <li key={key} className="flex items-center gap-2 border-b border-zinc-900 px-3 py-2 last:border-b-0">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleItem(e, idx)}
                  className="h-4 w-4"
                />
                <div className="flex-1 text-xs text-zinc-300">
                  <div className="font-medium text-zinc-100">{it.name}</div>
                  <div className="text-zinc-500">
                    {fmtNum(it.qty_g)}g · {fmtNum(it.kcal)} kcal · {fmtNum(it.protein_g)}P · {fmtNum(it.carbs_g)}C · {fmtNum(it.fat_g)}F
                  </div>
                </div>
              </li>
            );
          }),
        )}
      </ul>
    </section>
  );
}
