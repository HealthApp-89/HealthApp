// components/diet/JournalLibraryStrip.tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useUserFoodItemsRecent } from "@/lib/query/hooks/useUserFoodItems";
import { queryKeys } from "@/lib/query/keys";
import { deriveMealSlot } from "@/lib/food/meal-slot";
import { fmtNum } from "@/lib/ui/score";
import { COLOR } from "@/lib/ui/theme";
import type { UserFoodItem, MealSlot } from "@/lib/food/types";

type Props = {
  userId: string;
  /** ISO yyyy-mm-dd date currently selected on /diet — used to invalidate
   *  the right foodEntries key after a commit. */
  date: string;
};

type Toast = {
  text: string;
  entryId: string;
} | null;

export function JournalLibraryStrip({ userId, date }: Props) {
  const { data: items = [] } = useUserFoodItemsRecent(userId);
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<Toast>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  if (items.length === 0) return null;

  const handleTap = async (item: UserFoodItem) => {
    if (pendingId) return; // prevent double-tap during in-flight commit
    setPendingId(item.id);
    const slot: MealSlot = deriveMealSlot(new Date());
    const kind = item.composite_of !== null ? "user_recipe" : "user_item";

    try {
      const draftRes = await fetch("/api/food/library/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_kind: kind,
          source_id: item.id,
          meal_slot: slot,
          eaten_at: new Date().toISOString(),
        }),
      });
      if (!draftRes.ok) throw new Error(`draft_failed_${draftRes.status}`);
      const { entry } = (await draftRes.json()) as { entry: { id: string } };

      const commitRes = await fetch("/api/food/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry_id: entry.id }),
      });
      if (!commitRes.ok) throw new Error(`commit_failed_${commitRes.status}`);

      queryClient.invalidateQueries({
        queryKey: queryKeys.foodEntries.range(userId, date, date),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.dailyLogs.range(userId, date, date),
      });

      setToast({ text: `Logged to ${slot}`, entryId: entry.id });
      window.setTimeout(() => setToast(null), 5000);
    } catch (err) {
      console.error("[JournalLibraryStrip] tap failed", err);
      setToast({ text: "Couldn't log — try again", entryId: "" });
      window.setTimeout(() => setToast(null), 3000);
    } finally {
      setPendingId(null);
    }
  };

  const handleUndo = async () => {
    if (!toast || !toast.entryId) return;
    const id = toast.entryId;
    setToast(null);
    try {
      await fetch(`/api/food/entries/${id}`, { method: "DELETE" });
      queryClient.invalidateQueries({
        queryKey: queryKeys.foodEntries.range(userId, date, date),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.dailyLogs.range(userId, date, date),
      });
    } catch (err) {
      console.error("[JournalLibraryStrip] undo failed", err);
    }
  };

  return (
    <div className="px-4 pt-2 pb-3">
      <div className="flex items-center justify-between mb-2">
        <span
          className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: COLOR.textMuted }}
        >
          Saved
        </span>
        <Link
          href="/profile/library"
          className="text-[11px] font-medium"
          style={{ color: COLOR.textMuted }}
        >
          View all →
        </Link>
      </div>
      <div className="flex gap-2 overflow-x-auto snap-x snap-mandatory -mx-4 px-4 pb-1">
        {items.map((item) => {
          const isRecipe = item.composite_of !== null;
          const kcalLabel = isRecipe
            ? `Recipe · ${item.composite_of?.length ?? 0} items`
            : item.per_100g
              ? `${fmtNum(item.per_100g.kcal)} kcal / 100g`
              : "—";
          const isBusy = pendingId === item.id;
          return (
            <button
              key={item.id}
              type="button"
              disabled={isBusy}
              onClick={() => handleTap(item)}
              className="snap-start shrink-0 w-[140px] text-left rounded-lg border p-3 transition-opacity"
              style={{
                background: "#fff",
                borderColor: "#e5e7eb",
                color: COLOR.textStrong,
                opacity: isBusy ? 0.5 : 1,
              }}
            >
              <div className="text-xs font-medium leading-snug line-clamp-2 mb-1">
                {isRecipe ? "🍽 " : ""}
                {item.name}
              </div>
              <div className="text-[11px]" style={{ color: COLOR.textMuted }}>
                {kcalLabel}
              </div>
            </button>
          );
        })}
      </div>
      {toast && (
        <div
          className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-full px-4 py-2 text-xs shadow-lg"
          style={{ background: "#111", color: "#fff" }}
        >
          <span>{toast.text}</span>
          {toast.entryId && (
            <button
              type="button"
              onClick={handleUndo}
              className="font-semibold underline-offset-2 underline"
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}
