"use client";
import { useState } from "react";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { MealLoggerSearchTab } from "./MealLoggerSearchTab";
import { MealLoggerLibraryTab } from "./MealLoggerLibraryTab";
import { HistoryPickerSheet } from "./HistoryPickerSheet";
import { CustomFoodCreateAndLogSheet } from "./CustomFoodCreateAndLogSheet";
import { useQueryClient } from "@tanstack/react-query";
import type { MealSlot } from "@/lib/food/types";
import { deriveMealSlot, mealSlotLabel } from "@/lib/food/meal-slot";
import { COLOR } from "@/lib/ui/theme";

type Tab = "search" | "library";

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
  const [tab, setTab] = useState<Tab>("search");
  const [historyPickerOpen, setHistoryPickerOpen] = useState(false);
  const [customCreateOpen, setCustomCreateOpen] = useState(false);
  const queryClient = useQueryClient();

  const mealSlot: MealSlot =
    initialMealSlot ?? deriveMealSlot(
      initialEatenAt ? new Date(initialEatenAt) : new Date(),
    );
  const eatenAt = initialEatenAt ?? new Date().toISOString();

  // Invalidate downstream caches after every commit. Do NOT auto-close —
  // the user often logs several items in one sitting and prefers to stay
  // in the sheet between Confirm taps.
  const onCommitted = async () => {
    await queryClient.invalidateQueries({
      predicate: (q) => q.queryKey[0] === "food-entries",
    });
    await queryClient.invalidateQueries({
      predicate: (q) => q.queryKey[0] === "daily-logs",
    });
    await queryClient.invalidateQueries({
      predicate: (q) => q.queryKey[0] === "today-targets",
    });
  };

  const title = initialMealSlot ? `Log ${mealSlotLabel(initialMealSlot)}` : "Log meal";

  return (
    <>
      <BottomSheet open={open} onClose={onClose} title={title}>
        <div className="flex gap-1 px-3 pt-2" style={{ borderBottom: `1px solid ${COLOR.divider}` }}>
          {([
            { key: "search", label: "Add food" },
            { key: "library", label: "Library" },
          ] as const).map((t) => {
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className="px-3 py-2 text-sm"
                style={{
                  color: active ? COLOR.textStrong : COLOR.textMuted,
                  fontWeight: active ? 600 : 500,
                  borderBottom: active ? `2px solid ${COLOR.textStrong}` : "2px solid transparent",
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
        <div className="p-4">
          {tab === "search" && (
            <MealLoggerSearchTab
              userId={userId}
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
              onOpenCustomCreate={() => setCustomCreateOpen(true)}
            />
          )}
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
      <CustomFoodCreateAndLogSheet
        open={customCreateOpen}
        onClose={() => setCustomCreateOpen(false)}
        mealSlot={mealSlot}
        eatenAt={eatenAt}
        onLogged={onCommitted}
      />
    </>
  );
}
