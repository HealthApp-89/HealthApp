"use client";
import { useState } from "react";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { MealLoggerChatTab } from "./MealLoggerChatTab";
import { MealLoggerSearchTab } from "./MealLoggerSearchTab";
import { MealLoggerLibraryTab } from "./MealLoggerLibraryTab";
import { HistoryPickerSheet } from "./HistoryPickerSheet";
import { useQueryClient } from "@tanstack/react-query";
import type { MealSlot } from "@/lib/food/types";
import { deriveMealSlot, mealSlotLabel } from "@/lib/food/meal-slot";

type Tab = "chat" | "search" | "library";

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
  const [tab, setTab] = useState<Tab>("chat");
  const [historyPickerOpen, setHistoryPickerOpen] = useState(false);
  const queryClient = useQueryClient();

  const mealSlot: MealSlot =
    initialMealSlot ?? deriveMealSlot(
      initialEatenAt ? new Date(initialEatenAt) : new Date(),
    );
  const eatenAt = initialEatenAt ?? new Date().toISOString();

  // Invalidate downstream caches after every commit. Unlike v1.1, do NOT
  // auto-close the sheet — the chat thread is daily-continuous and the user
  // commonly logs multiple meals or makes corrections without leaving.
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
        <div className="flex gap-1 border-b border-zinc-800 px-3 pt-2">
          {(["chat", "search", "library"] as const).map((t) => (
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
          {tab === "chat" && (
            <MealLoggerChatTab
              userId={userId}
              mealSlot={mealSlot}
              eatenAt={eatenAt}
              onCommitted={onCommitted}
            />
          )}
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
    </>
  );
}
