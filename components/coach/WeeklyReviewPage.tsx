"use client";

import { useWeeklyReview } from "@/lib/query/hooks/useWeeklyReview";
import { CHAT, COLOR } from "@/lib/ui/theme";
import { WeeklyReviewHeader } from "./WeeklyReviewHeader";
import { WeeklyReviewRecap } from "./WeeklyReviewRecap";
import { WeeklyReviewReconfirm } from "./WeeklyReviewReconfirm";
import { WeeklyReviewTrends } from "./WeeklyReviewTrends";
import { WeeklyReviewPrescription } from "./WeeklyReviewPrescription";
import { WeeklyReviewNarrative } from "./WeeklyReviewNarrative";
import { WeeklyReviewTargets } from "./WeeklyReviewTargets";
import { WeeklyReviewActions } from "./WeeklyReviewActions";

export function WeeklyReviewPage({
  userId,
  weekStart,
}: {
  userId: string;
  weekStart: string;
}) {
  const { data: row } = useWeeklyReview(userId, weekStart);
  if (!row) return null;
  const p = row.payload;

  return (
    <div
      style={{
        maxWidth: CHAT.feedMaxWidth,
        margin: "0 auto",
        padding: "12px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        color: COLOR.textStrong,
      }}
    >
      <WeeklyReviewHeader header={p.header} />
      <WeeklyReviewRecap recap={p.recap} />
      <WeeklyReviewReconfirm
        reviewId={row.id}
        reconfirm={p.reconfirm}
        responses={row.reconfirm_responses}
      />
      <WeeklyReviewTrends trends={p.trends} />
      <WeeklyReviewPrescription prescription={p.prescription} recap={p.recap} />
      <WeeklyReviewNarrative md={row.narrative_md} />
      <WeeklyReviewTargets targets={p.targets} />
      <WeeklyReviewActions reviewRow={row} />
    </div>
  );
}
