"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { COLOR } from "@/lib/ui/theme";
import { queryKeys } from "@/lib/query/keys";

/**
 * Mounted with `open=true` by the parent (WeeklyReviewActions) — BottomSheet
 * itself returns null when closed, so unmounting on close is fine. The
 * caller's `setShowAdjust(false)` triggers the unmount.
 */
export function AdjustDeficitSheet({
  reviewId,
  userId,
  weekStart,
  onClose,
}: {
  reviewId: string;
  userId: string;
  weekStart: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function adjust(delta: number) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/coach/weekly-review/${reviewId}/adjust-nutrition`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kcal_delta: delta }),
        },
      );
      if (!r.ok) throw new Error(await r.text());
      await queryClient.invalidateQueries({
        queryKey: queryKeys.weeklyReviews.one(userId, weekStart),
      });
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet open={true} onClose={onClose} title="Adjust deficit">
      <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "8px 0 16px" }}>
        <p
          style={{
            fontSize: 13,
            color: COLOR.textMuted,
            margin: 0,
            lineHeight: 1.4,
          }}
        >
          Apply a kcal delta to next week&apos;s nutrition target. Protein
          floor and fat are preserved; carbs absorb the change.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          {[-200, -100, 100, 200].map((d) => (
            <button
              key={d}
              type="button"
              disabled={busy}
              onClick={() => adjust(d)}
              style={{
                flex: 1,
                padding: "10px 0",
                background: d < 0 ? "#7c2d12" : "#14532d",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                fontWeight: 700,
                fontSize: 13,
                cursor: busy ? "wait" : "pointer",
                opacity: busy ? 0.6 : 1,
              }}
            >
              {d > 0 ? `+${d}` : d}
            </button>
          ))}
        </div>
        {error && (
          <div style={{ fontSize: 11, color: COLOR.warning }}>{error}</div>
        )}
      </div>
    </BottomSheet>
  );
}
