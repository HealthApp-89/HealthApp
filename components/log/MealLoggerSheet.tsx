"use client";
import { useState } from "react";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { MealLoggerTypeTab } from "./MealLoggerTypeTab";
import { MealLoggerScanTab } from "./MealLoggerScanTab";
import { MealLoggerComingSoonTab } from "./MealLoggerComingSoonTab";
import { useQueryClient } from "@tanstack/react-query";

type Tab = "type" | "scan" | "photo" | "voice";

export function MealLoggerSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("type");
  const queryClient = useQueryClient();

  const onCommitted = async () => {
    // Invalidate by query-key prefix without needing userId — single-user app,
    // matches all food-entries and daily-logs queries regardless of userId arg.
    await queryClient.invalidateQueries({
      predicate: (q) => q.queryKey[0] === "food-entries",
    });
    await queryClient.invalidateQueries({
      predicate: (q) => q.queryKey[0] === "daily-logs",
    });
    onClose();
  };

  return (
    <BottomSheet open={open} onClose={onClose} title="Log meal">
      <div className="flex gap-1 border-b border-zinc-800 px-3 pt-2">
        {(["type", "scan", "photo", "voice"] as const).map((t) => (
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
        {tab === "type" && <MealLoggerTypeTab onCommitted={onCommitted} />}
        {tab === "scan" && <MealLoggerScanTab onCommitted={onCommitted} />}
        {tab === "photo" && <MealLoggerComingSoonTab modality="photo" />}
        {tab === "voice" && <MealLoggerComingSoonTab modality="voice" />}
      </div>
    </BottomSheet>
  );
}
