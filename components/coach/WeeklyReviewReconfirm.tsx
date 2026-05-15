"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, SectionLabel } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import { queryKeys } from "@/lib/query/keys";
import type {
  WeeklyReviewPayload,
  ReconfirmResponses,
} from "@/lib/data/types";

export function WeeklyReviewReconfirm({
  reviewId,
  reconfirm,
  responses,
  userId,
  weekStart,
}: {
  reviewId: string;
  reconfirm: WeeklyReviewPayload["reconfirm"];
  responses: ReconfirmResponses;
  userId: string;
  weekStart: string;
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (reconfirm.length === 0) return null;

  async function answerChip(reconfirmId: string, chipValue: string) {
    setPending(reconfirmId);
    setError(null);
    try {
      const r = await fetch(
        `/api/coach/weekly-review/${reviewId}/reconfirm`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            reconfirm_id: reconfirmId,
            chip_value: chipValue,
          }),
        },
      );
      if (!r.ok) throw new Error(await r.text());
      await queryClient.invalidateQueries({
        queryKey: queryKeys.weeklyReviews.one(userId, weekStart),
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setPending(null);
    }
  }

  return (
    <Card>
      <SectionLabel>RECONFIRM ({reconfirm.length})</SectionLabel>
      {reconfirm.map((r) => {
        const selectedValue = responses[r.id]?.chip_value;
        const loading = pending === r.id;
        return (
          <div key={r.id} style={{ marginTop: 8, fontSize: 11 }}>
            <div style={{ color: COLOR.textStrong, fontWeight: 600 }}>
              {r.question}
            </div>
            <div
              style={{
                display: "flex",
                gap: 4,
                marginTop: 4,
                flexWrap: "wrap",
              }}
            >
              {r.chips.map((c) => {
                const isSelected = selectedValue === c.value;
                return (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => answerChip(r.id, c.value)}
                    disabled={loading}
                    style={{
                      background: isSelected ? COLOR.accent : COLOR.surfaceAlt,
                      color: isSelected ? "#fff" : COLOR.textStrong,
                      border: "none",
                      borderRadius: 4,
                      padding: "4px 10px",
                      fontSize: 11,
                      cursor: loading ? "wait" : "pointer",
                      opacity: loading ? 0.6 : 1,
                    }}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      {error && (
        <div
          style={{ fontSize: 10, color: COLOR.warning, marginTop: 8 }}
        >
          {error}
        </div>
      )}
    </Card>
  );
}
