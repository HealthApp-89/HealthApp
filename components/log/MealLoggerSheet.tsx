"use client";
import { useState } from "react";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { MealLoggerTypeTab } from "./MealLoggerTypeTab";
import { MealLoggerScanTab } from "./MealLoggerScanTab";
import { MealLoggerLibraryTab } from "./MealLoggerLibraryTab";
import { MealLoggerComingSoonTab } from "./MealLoggerComingSoonTab";
import { HistoryPickerSheet } from "./HistoryPickerSheet";
import { useQueryClient } from "@tanstack/react-query";
import type { MealSlot } from "@/lib/food/types";
import { deriveMealSlot, mealSlotLabel } from "@/lib/food/meal-slot";

type Tab = "type" | "scan" | "library" | "photo" | "voice";

export function MealLoggerSheet({
  open,
  onClose,
  userId,
  initialMealSlot,
  initialEatenAt,
}: {
  open: boolean;
  onClose: () => void;
  userId: string;
  initialMealSlot?: MealSlot;
  initialEatenAt?: string;
}) {
  const [tab, setTab] = useState<Tab>("type");
  const [historyPickerOpen, setHistoryPickerOpen] = useState(false);
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
    <>
    <BottomSheet open={open} onClose={onClose} title={title}>
      <div className="flex gap-1 border-b border-zinc-800 px-3 pt-2">
        {(["type", "scan", "library", "photo", "voice"] as const).map((t) => (
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
        {tab === "scan" && (
          <MealLoggerScanTab
            mealSlot={mealSlot}
            eatenAt={eatenAt}
            onCommitted={onCommitted}
          />
        )}
        {tab === "library" && (
          <MealLoggerLibraryTab
            userId={userId}
            mealSlot={mealSlot}
            eatenAt={eatenAt}
            onCommitted={onCommitted}
            onOpenHistoryPicker={() => setHistoryPickerOpen(true)}
          />
        )}
        {tab === "photo" && <MealLoggerComingSoonTab modality="photo" />}
        {tab === "voice" && <MealLoggerComingSoonTab modality="voice" />}
      </div>
    </BottomSheet>
    <HistoryPickerSheet
      open={historyPickerOpen}
      onClose={() => setHistoryPickerOpen(false)}
      userId={userId}
      initialDestinationSlot={mealSlot}
      initialEatenAt={eatenAt}
      onCommitted={onCommitted}
    />
    </>
  );
}
