"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useFoodEntries } from "@/lib/query/hooks/useFoodEntries";
import { useTodayTargets } from "@/lib/query/hooks/useTodayTargets";
import { MealLoggerSheet } from "@/components/log/MealLoggerSheet";
import { FoodEntryEditSheet } from "@/components/log/FoodEntryEditSheet";
import { HistoryPickerSheet } from "@/components/log/HistoryPickerSheet";
import { MealJournalDay } from "@/components/meal/MealJournalDay";
import { MealSlotCard } from "@/components/meal/MealSlotCard";
import { MealSlotEmptyCard } from "@/components/meal/MealSlotEmptyCard";
import { targetsForAllSlots } from "@/lib/food/meal-targets";
import { MEAL_SLOTS } from "@/lib/food/meal-slot";
import { todayInUserTz } from "@/lib/time";
import type { FoodLogEntry, MealSlot } from "@/lib/food/types";

export function MealJournalClient({
  userId,
  date,
}: {
  userId: string;
  date: string;
}) {
  const router = useRouter();
  const { data: entries = [] } = useFoodEntries(userId, date, date);
  const { data: targets } = useTodayTargets(userId, date);
  const [loggerOpen, setLoggerOpen] = useState<MealSlot | null>(null);
  const [editing, setEditing] = useState<FoodLogEntry | null>(null);
  const [historyPickerOpen, setHistoryPickerOpen] = useState<MealSlot | null>(null);

  const shift = (deltaDays: number) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + deltaDays);
    router.push(`/meal?date=${d.toISOString().slice(0, 10)}`);
  };

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

  // initialEatenAt for the MealLoggerSheet: now() if scrubber is on today,
  // else noon of the scrubbed day. Uses todayInUserTz() (not UTC) so the
  // "is this today?" check matches how `date` is computed upstream.
  const initialEatenAtForLogger = (): string => {
    if (date === todayInUserTz()) return new Date().toISOString();
    return `${date}T12:00:00.000Z`;
  };

  return (
    <main className="mx-auto max-w-md space-y-3 px-4 pt-6 pb-32">
      <MealJournalDay
        entries={entries}
        targets={targets ?? null}
        date={date}
        onShiftDate={shift}
      />

      {MEAL_SLOTS.map((slot) => {
        const slotEntries = entriesBySlot[slot];
        const slotTarget = slotTargets?.[slot] ?? null;
        if (slotEntries.length === 0) {
          return (
            <MealSlotEmptyCard
              key={slot}
              slot={slot}
              targetKcal={slotTarget}
              date={date}
              onLog={() => setLoggerOpen(slot)}
              onPickFromHistory={() => setHistoryPickerOpen(slot)}
            />
          );
        }
        return (
          <MealSlotCard
            key={slot}
            slot={slot}
            entries={slotEntries}
            targetKcal={slotTarget}
            onLog={() => setLoggerOpen(slot)}
            onTapEntry={setEditing}
          />
        );
      })}

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
          open={true}
          onClose={() => setHistoryPickerOpen(null)}
          userId={userId}
          initialDestinationSlot={historyPickerOpen}
          initialEatenAt={initialEatenAtForLogger()}
          onCommitted={() => setHistoryPickerOpen(null)}
        />
      )}
      {editing && (
        <FoodEntryEditSheet entry={editing} userId={userId} onClose={() => setEditing(null)} />
      )}
    </main>
  );
}
