"use client";

import Link from "next/link";
import { Card, SectionLabel } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";

export function PlanWeekCTA({
  weekStart,
  weekN,
  isLate,
}: {
  weekStart: string;
  weekN: number | null;
  isLate?: boolean;
}) {
  const headline = weekN
    ? `Plan week ${weekN} of your block`
    : `Plan the week of ${weekStart}`;
  const sub = isLate
    ? "Late but still useful — committing now respects what you've already done."
    : "5-min conversation. Coach reviews last week, asks how you feel, proposes the schedule.";

  return (
    <Card>
      <SectionLabel>{isLate ? "MID-WEEK PLANNING" : "PLAN NEXT WEEK"}</SectionLabel>
      <div style={{ fontSize: "16px", fontWeight: 700, color: COLOR.textStrong, marginTop: "6px" }}>
        {headline}
      </div>
      <p style={{ fontSize: "12px", color: COLOR.textMuted, marginTop: "6px", lineHeight: 1.5 }}>
        {sub}
      </p>
      <Link
        href="/coach?mode=plan_week"
        style={{
          display: "inline-block",
          marginTop: "10px",
          padding: "10px 14px",
          background: COLOR.accent,
          color: "#fff",
          borderRadius: "9999px",
          fontWeight: 700,
          fontSize: "13px",
          textDecoration: "none",
        }}
      >
        {isLate ? "Plan this week →" : "Open planning chat →"}
      </Link>
    </Card>
  );
}
