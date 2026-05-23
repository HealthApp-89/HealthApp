// components/diet/MealSlotCardCollapsed.tsx
"use client";

import { useState } from "react";
import { COLOR, RADIUS } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { MealSlot, FoodLogEntry } from "@/lib/food/types";
import { mealSlotLabel } from "@/lib/food/meal-slot";
import { MealSlotCard } from "@/components/meal/MealSlotCard";
import { MealSlotEmptyCard } from "@/components/meal/MealSlotEmptyCard";

const SLOT_ICON: Record<MealSlot, string> = {
  breakfast: "🍳",
  lunch: "🍝",
  dinner: "🥗",
  snack: "🍎",
};

type Props = {
  slot: MealSlot;
  entries: FoodLogEntry[];
  targetKcal: number | null;
  /** YYYY-MM-DD in user TZ — forwarded to MealSlotEmptyCard for yesterday-probe */
  date: string;
  onLog: (slot: MealSlot) => void;
  onTapEntry?: (entry: FoodLogEntry) => void;
  onPickFromHistory?: () => void;
};

/** Collapsed Yazio-style slot card. Tap the card body → expand inline
 *  (renders the existing per-slot detail rows). Tap "+" → open logger
 *  pinned to this slot. */
export function MealSlotCardCollapsed({
  slot,
  entries,
  targetKcal,
  date,
  onLog,
  onTapEntry,
  onPickFromHistory,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const eatenKcal = entries.reduce((sum, e) => sum + e.totals.kcal, 0);

  /** Adapts the slot-aware onLog(slot) signature to the slot-less ()=>void
   *  that MealSlotCard and MealSlotEmptyCard expect. */
  const handleLog = () => onLog(slot);

  /** No-op fallback when the parent doesn't wire up history picking. */
  const handlePickFromHistory = onPickFromHistory ?? (() => {});

  /** No-op fallback when the parent doesn't wire up entry tapping. */
  const handleTapEntry = onTapEntry ?? (() => {});

  return (
    <div
      className="mx-4 mb-2"
      style={{
        background: COLOR.surface,
        borderRadius: RADIUS.card,
        overflow: "hidden",
      }}
    >
      {/* Collapsed header row */}
      <div className="flex items-center px-4 py-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 flex items-center gap-3 text-left"
          aria-expanded={expanded}
        >
          <div className="text-2xl">{SLOT_ICON[slot]}</div>
          <div className="flex-1">
            <div
              className="text-sm font-semibold"
              style={{ color: COLOR.textStrong }}
            >
              {mealSlotLabel(slot)}
            </div>
            <div
              className="text-xs tabular-nums"
              style={{ color: COLOR.textMuted }}
            >
              {fmtNum(eatenKcal)}
              {targetKcal !== null
                ? ` / ${fmtNum(targetKcal)} kcal`
                : " kcal"}
            </div>
          </div>
        </button>

        {/* "+" opens the logger directly; doesn't toggle expansion */}
        <button
          type="button"
          onClick={() => onLog(slot)}
          aria-label={`Log ${mealSlotLabel(slot)}`}
          className="w-9 h-9 rounded-full flex items-center justify-center text-lg font-bold ml-2"
          style={{ background: COLOR.surfaceAlt, color: COLOR.textStrong }}
        >
          +
        </button>
      </div>

      {/* Expanded: has entries */}
      {expanded && entries.length > 0 && (
        <div
          className="px-4 pb-3"
          style={{ borderTop: `1px solid ${COLOR.divider}` }}
        >
          <MealSlotCard
            slot={slot}
            entries={entries}
            targetKcal={targetKcal}
            onLog={handleLog}
            onTapEntry={handleTapEntry}
          />
        </div>
      )}

      {/* Expanded: empty slot */}
      {expanded && entries.length === 0 && (
        <div
          className="px-4 pb-3"
          style={{ borderTop: `1px solid ${COLOR.divider}` }}
        >
          <MealSlotEmptyCard
            slot={slot}
            targetKcal={targetKcal}
            date={date}
            onLog={handleLog}
            onPickFromHistory={handlePickFromHistory}
          />
        </div>
      )}
    </div>
  );
}
