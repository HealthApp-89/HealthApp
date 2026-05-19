"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useFoodEntries } from "@/lib/query/hooks/useFoodEntries";
import { useTodayTargets } from "@/lib/query/hooks/useTodayTargets";
import { MealLoggerSheet } from "@/components/log/MealLoggerSheet";
import { FoodEntryEditSheet } from "@/components/log/FoodEntryEditSheet";
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

  // Date scrubber — bump date by ±1 day via URL.
  const shift = (deltaDays: number) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + deltaDays);
    router.push(`/meal?date=${d.toISOString().slice(0, 10)}`);
  };

  // The actual rendering (day summary + 4 slot cards) lands in Task 11.
  // For now, prove the data path works and mount the sheets so they're
  // reachable.
  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-32">
      <h1 className="text-xl font-semibold">Meal · {date}</h1>
      <p className="mt-2 text-xs text-zinc-500">
        Entries: {entries.length} · Target kcal: {targets?.kcal ?? "—"}
      </p>
      <div className="mt-3 flex gap-2 text-xs">
        <button onClick={() => shift(-1)} className="rounded border border-zinc-700 px-2 py-1">‹ prev</button>
        <button onClick={() => shift(1)} className="rounded border border-zinc-700 px-2 py-1">next ›</button>
      </div>

      {loggerOpen && (
        <MealLoggerSheet
          open
          onClose={() => setLoggerOpen(null)}
          initialMealSlot={loggerOpen}
          initialEatenAt={
            date === new Date().toISOString().slice(0, 10)
              ? new Date().toISOString()
              : `${date}T12:00:00.000Z`
          }
        />
      )}
      {editing && (
        <FoodEntryEditSheet entry={editing} onClose={() => setEditing(null)} />
      )}
    </main>
  );
}
