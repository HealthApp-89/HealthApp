// components/meal/MealSlotEmptyCard.tsx
"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { fmtNum } from "@/lib/ui/score";
import { mealSlotLabel } from "@/lib/food/meal-slot";
import type { MealSlot } from "@/lib/food/types";

export function MealSlotEmptyCard({
  slot,
  targetKcal,
  date,
  onLog,
  onPickFromHistory,
}: {
  slot: MealSlot;
  targetKcal: number | null;
  date: string; // today's date (YYYY-MM-DD) in user TZ
  onLog: () => void;
  onPickFromHistory: () => void;
}) {
  const [yesterdayIds, setYesterdayIds] = useState<string[] | null>(null);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  // Probe yesterday-slot endpoint on mount.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/food/yesterday-slot?date=${date}&slot=${slot}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!cancelled && json?.has_entries) setYesterdayIds(json.entry_ids);
      })
      .catch(() => {
        /* silent */
      });
    return () => {
      cancelled = true;
    };
  }, [date, slot]);

  const copyYesterday = async () => {
    if (!yesterdayIds || yesterdayIds.length === 0) return;
    setBusy(true);
    try {
      await Promise.all(
        yesterdayIds.map(async (id) => {
          const draftRes = await fetch(`/api/food/entries/${id}/copy`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ meal_slot: slot }),
          });
          if (!draftRes.ok) throw new Error("copy_failed");
          const { entry } = await draftRes.json();
          const commitRes = await fetch("/api/food/commit", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ entry_id: entry.id }),
          });
          if (!commitRes.ok) throw new Error("commit_failed");
        }),
      );
      await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "food-entries" });
      await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "daily-logs" });
    } finally {
      setBusy(false);
    }
  };

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
      <div className="flex flex-wrap gap-2 px-3 pb-3">
        {yesterdayIds && yesterdayIds.length > 0 && (
          <button
            type="button"
            onClick={copyYesterday}
            disabled={busy}
            className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-100 disabled:opacity-50"
          >
            📋 Copy yesterday ({yesterdayIds.length} {yesterdayIds.length === 1 ? "item" : "items"})
          </button>
        )}
        <button
          type="button"
          onClick={onPickFromHistory}
          className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-100"
        >
          📚 Pick from history
        </button>
      </div>
    </section>
  );
}
