"use client";
import { useState } from "react";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { MealLoggerTypeTab } from "./MealLoggerTypeTab";
import { MealLoggerSearchTab } from "./MealLoggerSearchTab";
import { MealLoggerScanTab } from "./MealLoggerScanTab";
import { MealLoggerComingSoonTab } from "./MealLoggerComingSoonTab";
import { useQueryClient } from "@tanstack/react-query";
import type { MealSlot } from "@/lib/food/types";
import { deriveMealSlot, mealSlotLabel } from "@/lib/food/meal-slot";

type Tab = "type" | "search" | "scan" | "photo" | "voice";

export function MealLoggerSheet({
  open,
  onClose,
  initialMealSlot,
  initialEatenAt,
}: {
  open: boolean;
  onClose: () => void;
  initialMealSlot?: MealSlot;
  initialEatenAt?: string;
}) {
  const [tab, setTab] = useState<Tab>("type");
  const queryClient = useQueryClient();

  const mealSlot: MealSlot =
    initialMealSlot ?? deriveMealSlot(
      initialEatenAt ? new Date(initialEatenAt) : new Date(),
    );
  const eatenAt = initialEatenAt ?? new Date().toISOString();

  const onCommitted = async () => {
    // Invalidate by query-key prefix without needing userId — single-user app,
    // matches all food-entries and daily-logs queries regardless of userId arg.
    // today-targets predicate is forward-compatible: Task 7 will add a
    // useTodayTargets hook; until then this predicate matches nothing
    // (harmless) but ensures Task 7 doesn't have to come back here.
    await queryClient.invalidateQueries({
      predicate: (q) => q.queryKey[0] === "food-entries",
    });
    await queryClient.invalidateQueries({
      predicate: (q) => q.queryKey[0] === "daily-logs",
    });
    await queryClient.invalidateQueries({
      predicate: (q) => q.queryKey[0] === "today-targets",
    });
    onClose();
  };

  const title = initialMealSlot ? `Log ${mealSlotLabel(initialMealSlot)}` : "Log meal";

  return (
    <BottomSheet open={open} onClose={onClose} title={title}>
      <div className="flex gap-1 border-b border-zinc-800 px-3 pt-2">
        {(["type", "search", "scan", "photo", "voice"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-xs uppercase tracking-wider ${
              tab === t ? "text-zinc-100 border-b-2 border-zinc-100" : "text-zinc-500"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="p-4">
        {tab === "type" && (
          <MealLoggerTypeTab
            mealSlot={mealSlot}
            eatenAt={eatenAt}
            onCommitted={onCommitted}
          />
        )}
        {tab === "search" && (
          <MealLoggerSearchTab
            mealSlot={mealSlot}
            eatenAt={eatenAt}
            onCommitted={onCommitted}
          />
        )}
        {tab === "scan" && (
          <MealLoggerScanTab
            mealSlot={mealSlot}
            eatenAt={eatenAt}
            onCommitted={onCommitted}
          />
        )}
        {tab === "photo" && <MealLoggerComingSoonTab modality="photo" />}
        {tab === "voice" && <MealLoggerComingSoonTab modality="voice" />}
      </div>
    </BottomSheet>
  );
}
