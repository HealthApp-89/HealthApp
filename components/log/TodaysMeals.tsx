"use client";

import { useState } from "react";
import { useFoodEntries } from "@/lib/query/hooks/useFoodEntries";
import { FoodEntryEditSheet } from "./FoodEntryEditSheet";
import { fmtNum } from "@/lib/ui/score";
import type { FoodLogEntry } from "@/lib/food/types";

export function TodaysMeals({ userId, date }: { userId: string; date: string }) {
  const { data: entries = [], isLoading } = useFoodEntries(userId, date, date);
  const [editing, setEditing] = useState<FoodLogEntry | null>(null);

  if (isLoading) return <div className="text-xs text-zinc-500">Loading meals…</div>;
  if (entries.length === 0) {
    return (
      <div className="rounded-md border border-zinc-800 p-4 text-sm text-zinc-500">
        No meals logged today. Use the Log button below.
      </div>
    );
  }

  const total = entries.reduce(
    (acc, e) => ({
      kcal: acc.kcal + e.totals.kcal,
      protein_g: acc.protein_g + e.totals.protein_g,
      carbs_g: acc.carbs_g + e.totals.carbs_g,
      fat_g: acc.fat_g + e.totals.fat_g,
    }),
    { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
  );

  return (
    <section className="space-y-3">
      <header className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-400">
          Today&apos;s meals
        </h2>
        <div className="text-xs text-zinc-400">
          {fmtNum(total.kcal)} kcal · {fmtNum(total.protein_g)} P ·{" "}
          {fmtNum(total.carbs_g)} C · {fmtNum(total.fat_g)} F
        </div>
      </header>
      <ul className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
        {entries.map((e) => (
          <li key={e.id} className="p-3">
            <button
              type="button"
              onClick={() => setEditing(e)}
              className="block w-full text-left"
            >
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-zinc-500">
                  {new Date(e.eaten_at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}{" "}
                  · {e.kind}
                  {e.is_estimated && (
                    <span className="ml-1 text-amber-400">estimated</span>
                  )}
                </span>
                <span className="text-xs text-zinc-400">
                  {fmtNum(e.totals.kcal)} kcal
                </span>
              </div>
              <div className="mt-1 text-sm">
                {e.items.map((it) => it.name).join(", ")}
              </div>
            </button>
          </li>
        ))}
      </ul>
      {editing && (
        <FoodEntryEditSheet entry={editing} onClose={() => setEditing(null)} />
      )}
    </section>
  );
}
