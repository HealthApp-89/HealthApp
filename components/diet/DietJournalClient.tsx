// components/diet/DietJournalClient.tsx
"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useFoodEntries } from "@/lib/query/hooks/useFoodEntries";
import { useTodayTargets } from "@/lib/query/hooks/useTodayTargets";
import { useDailyLogs } from "@/lib/query/hooks/useDailyLogs";
import { MealLoggerSheet } from "@/components/log/MealLoggerSheet";
import { FoodEntryEditSheet } from "@/components/log/FoodEntryEditSheet";
import { HistoryPickerSheet } from "@/components/log/HistoryPickerSheet";
import { MealJournalDay } from "@/components/meal/MealJournalDay";
import { SummaryCard } from "./SummaryCard";
import { MealSlotCardCollapsed } from "./MealSlotCardCollapsed";
import { targetsForAllSlots } from "@/lib/food/meal-targets";
import { MEAL_SLOTS } from "@/lib/food/meal-slot";
import { todayInUserTz } from "@/lib/time";
import { COLOR } from "@/lib/ui/theme";
import type { FoodLogEntry, MealSlot } from "@/lib/food/types";

type Props = { userId: string; initialDate: string };

export function DietJournalClient({ userId, initialDate }: Props) {
  const router = useRouter();
  const [loggerOpen, setLoggerOpen] = useState<MealSlot | null>(null);
  const [editing, setEditing] = useState<FoodLogEntry | null>(null);
  const [historyPickerOpen, setHistoryPickerOpen] = useState<MealSlot | null>(null);

  // `initialDate` is the SSR-resolved date; the /diet page drives date via
  // the URL param, so navigation (prev/next day) uses router.push like
  // MealJournalClient does for /meal.
  const date = initialDate;

  const { data: entries = [] } = useFoodEntries(userId, date, date);
  const { data: targets } = useTodayTargets(userId, date);
  const { data: dailyLogs = [] } = useDailyLogs(userId, date, date);

  const dailyLog = dailyLogs[0] ?? null;

  const shift = (deltaDays: number) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + deltaDays);
    router.push(`/diet?date=${d.toISOString().slice(0, 10)}`);
  };

  // Per-meal kcal targets — derive from day target + meal_ratios.
  // targetsForAllSlots takes (dayKcal, ratios) separately, not a targets obj.
  const slotTargets = useMemo(() => {
    if (!targets) return null;
    return targetsForAllSlots(targets.kcal, targets.meal_ratios);
  }, [targets]);

  const entriesBySlot = useMemo(() => {
    const grouped: Record<MealSlot, FoodLogEntry[]> = {
      breakfast: [], lunch: [], dinner: [], snack: [],
    };
    for (const e of entries) grouped[e.meal_slot].push(e);
    return grouped;
  }, [entries]);

  // Macro totals from committed food entries (mirrors MealJournalDay approach).
  const macroTotals = useMemo(
    () =>
      entries.reduce(
        (a, e) => ({
          kcal:      a.kcal      + e.totals.kcal,
          protein_g: a.protein_g + e.totals.protein_g,
          carbs_g:   a.carbs_g   + e.totals.carbs_g,
          fat_g:     a.fat_g     + e.totals.fat_g,
        }),
        { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
      ),
    [entries],
  );

  // Prefer the daily_log aggregated value (set by sum_food_entries on commit)
  // over the live sum — they should match; fall back to live sum for instant
  // optimistic feedback before reaggregation completes.
  const eaten  = dailyLog?.calories_eaten ?? macroTotals.kcal;
  const burned = dailyLog?.active_calories ?? null;
  const target = targets?.kcal ?? 0;

  // initialEatenAt: same logic as MealJournalClient.
  const initialEatenAtForLogger = (): string => {
    if (date === todayInUserTz()) return new Date().toISOString();
    return `${date}T12:00:00.000Z`;
  };

  return (
    <main className="mx-auto max-w-md px-0 pt-6 pb-32">
      {/* Day scrubber — same component MealJournalClient uses */}
      <div className="px-4 mb-4">
        <MealJournalDay
          entries={entries}
          targets={targets ?? null}
          date={date}
          onShiftDate={shift}
        />
      </div>

      {/* kcal ring + macro bars */}
      <SummaryCard
        eaten={eaten}
        target={target}
        burned={burned}
        macros={{
          carbs: {
            eaten:  macroTotals.carbs_g,
            target: targets?.carb_g ?? 0,
          },
          protein: {
            eaten:  macroTotals.protein_g,
            target: targets?.protein_g ?? 0,
          },
          fat: {
            eaten:  macroTotals.fat_g,
            target: targets?.fat_g ?? 0,
          },
        }}
      />

      {/* Four collapsed meal-slot cards */}
      <div className="mt-5">
        <div
          className="mx-4 mb-2 text-[11px] uppercase tracking-wider"
          style={{ color: COLOR.textMuted }}
        >
          Meals
        </div>
        {MEAL_SLOTS.map((slot) => (
          <MealSlotCardCollapsed
            key={slot}
            slot={slot}
            entries={entriesBySlot[slot]}
            targetKcal={slotTargets?.[slot] ?? null}
            date={date}
            onLog={(s) => setLoggerOpen(s)}
            onTapEntry={setEditing}
            onPickFromHistory={() => setHistoryPickerOpen(slot)}
          />
        ))}
      </div>

      {/* Sheets — same trio as MealJournalClient */}
      {loggerOpen && (
        <MealLoggerSheet
          open
          onClose={() => setLoggerOpen(null)}
          userId={userId}
          initialMealSlot={loggerOpen}
          initialEatenAt={initialEatenAtForLogger()}
        />
      )}
      {historyPickerOpen && (
        <HistoryPickerSheet
          open
          onClose={() => setHistoryPickerOpen(null)}
          userId={userId}
          initialDestinationSlot={historyPickerOpen}
          initialEatenAt={initialEatenAtForLogger()}
          onCommitted={() => setHistoryPickerOpen(null)}
        />
      )}
      {editing && (
        <FoodEntryEditSheet
          entry={editing}
          userId={userId}
          onClose={() => setEditing(null)}
        />
      )}
    </main>
  );
}
