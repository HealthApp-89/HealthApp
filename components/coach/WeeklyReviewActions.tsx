"use client";
import { Card, SectionLabel } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import type { WeeklyReviewRow } from "@/lib/data/types";

export function WeeklyReviewActions({
  reviewRow,
}: {
  reviewRow: WeeklyReviewRow;
}) {
  void reviewRow;
  return (
    <Card style={{ opacity: 0.7 }}>
      <SectionLabel>ACTIONS · COMING IN SLICE 5</SectionLabel>
      <div
        style={{
          fontSize: 11,
          color: COLOR.textMuted,
          marginTop: 8,
        }}
      >
        (Wires up in Slice 5: Commit · Swap a day · Adjust deficit · Regenerate ·
        Discuss in chat.)
      </div>
    </Card>
  );
}
