"use client";

import { mealSlotLabel } from "@/lib/food/meal-slot";
import { fmtNum } from "@/lib/ui/score";
import { COLOR, RADIUS } from "@/lib/ui/theme";
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
    <section
      style={{
        background: COLOR.surface,
        border: `1px solid ${COLOR.divider}`,
        borderRadius: RADIUS.cardSmall,
      }}
    >
      <header
        className="flex items-center justify-between px-3 py-2"
        style={{ borderBottom: `1px solid ${COLOR.divider}` }}
      >
        <div className="text-xs uppercase tracking-wider" style={{ color: COLOR.textMuted }}>
          {date} — {mealSlotLabel(slot)} ({totalItems} {totalItems === 1 ? "item" : "items"})
        </div>
        <button
          type="button"
          onClick={() => onSelectAllInSlot(entries)}
          className="text-xs font-medium underline"
          style={{ color: COLOR.accent }}
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
              <li
                key={key}
                className="flex items-center gap-2 px-3 py-2 last:border-b-0"
                style={{ borderBottom: `1px solid ${COLOR.divider}` }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleItem(e, idx)}
                  className="h-4 w-4 shrink-0"
                  style={{ accentColor: COLOR.accent }}
                />
                <div className="flex-1 text-xs">
                  <div className="font-medium" style={{ color: COLOR.textStrong }}>{it.name}</div>
                  {/* textMid, not textMuted: this line is data the athlete
                      actually reads, and textMuted (#7a7e95) is only 4.0:1 on
                      white — below AA for 12px text. */}
                  <div style={{ color: COLOR.textMid }}>
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
