"use client";
import { Card, SectionLabel } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import type { WeeklyReviewPayload } from "@/lib/data/types";

export function WeeklyReviewHeader({
  header,
}: {
  header: WeeklyReviewPayload["header"];
}) {
  // Edge case: when the active block starts in the future relative to the
  // recap week, the composer emits week_n <= 0. Rather than rendering
  // "Week -1 → Week 0" (nonsense to the user), fall back to a friendly label.
  const preBlock = header.week_n <= 0;
  const weekLabel = preBlock
    ? "BLOCK NOT YET STARTED"
    : `WEEK ${header.week_n} → WEEK ${header.week_n + 1}`;

  return (
    <Card>
      <SectionLabel>
        {weekLabel}
        {header.late ? " · LATE" : ""}
      </SectionLabel>
      <div
        style={{
          fontSize: 16,
          fontWeight: 700,
          color: COLOR.textStrong,
          marginTop: 4,
        }}
      >
        {header.block_goal_text}
      </div>
      <div
        style={{
          fontSize: 11,
          color: COLOR.textMuted,
          marginTop: 4,
          display: "flex",
          flexWrap: "wrap",
          gap: 4,
          alignItems: "center",
        }}
      >
        <span>
          {header.block_phase_now.toUpperCase()} →{" "}
          {header.block_phase_next.toUpperCase()}
        </span>
        <span>·</span>
        {header.on_pace === true ? (
          <span style={{ color: COLOR.success }}>On pace</span>
        ) : header.on_pace === false ? (
          <span style={{ color: COLOR.danger }}>Off pace</span>
        ) : (
          <span>pace unknown</span>
        )}
        <span>·</span>
        <span>
          {header.weeks_remaining} week{header.weeks_remaining === 1 ? "" : "s"}{" "}
          left
        </span>
      </div>
    </Card>
  );
}
