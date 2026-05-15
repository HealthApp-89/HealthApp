"use client";

import Link from "next/link";
import { Card, SectionLabel } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import { useWeeklyReview } from "@/lib/query/hooks/useWeeklyReview";

/**
 * Mid-week discoverability banner for the weekly review document.
 *
 * Surfaces on /coach when a draft (or committed-with-unanswered-questions)
 * weekly_review row exists for the just-finished week (Monday of the week
 * that ended last Sunday).
 *
 * Four states are reachable here:
 *   - draft + has unanswered questions   → "Review ready · N questions to confirm"
 *   - draft + all questions answered     → "Review ready"
 *   - committed + has unanswered         → "Week committed · N questions to confirm"
 *   - committed + all answered           → suppressed (nothing left to do)
 *
 * Visibility gating (Tue-Sat only) is handled by the caller — the banner
 * itself only checks the data shape, so it stays portable.
 */
export function WeekReviewBanner({
  userId,
  weekStart,
}: {
  userId: string;
  weekStart: string; // Monday of the just-finished week
}) {
  const { data: row } = useWeeklyReview(userId, weekStart);
  if (!row) return null;

  const unanswered = row.payload.reconfirm.filter(
    (r) => !row.reconfirm_responses[r.id]
  ).length;
  const committed = row.status === "committed";

  // Committed and every question answered → nothing actionable.
  if (committed && unanswered === 0) return null;

  const label = committed ? "WEEK COMMITTED" : "REVIEW READY";
  const cta = committed ? "Re-open review →" : "Open review →";
  const suffix =
    unanswered > 0
      ? ` · ${unanswered} question${unanswered === 1 ? "" : "s"} to confirm`
      : "";

  return (
    <Card>
      <SectionLabel>{label}</SectionLabel>
      <div
        style={{
          fontSize: 16,
          fontWeight: 700,
          color: COLOR.textStrong,
          marginTop: 6,
        }}
      >
        Wk {row.payload.header.week_n} review{suffix}
      </div>
      <Link
        href={`/coach/weeks/${weekStart}`}
        style={{
          display: "inline-block",
          marginTop: 10,
          padding: "10px 14px",
          background: COLOR.accent,
          color: "#fff",
          borderRadius: 9999,
          fontWeight: 700,
          fontSize: 13,
          textDecoration: "none",
        }}
      >
        {cta}
      </Link>
    </Card>
  );
}
