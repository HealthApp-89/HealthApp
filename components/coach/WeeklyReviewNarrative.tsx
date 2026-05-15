"use client";
import { Card, SectionLabel } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";

export function WeeklyReviewNarrative({ md }: { md: string }) {
  return (
    <Card>
      <SectionLabel>WHAT CHANGES &amp; WHY</SectionLabel>
      <p
        style={{
          fontSize: 12,
          color: COLOR.textStrong,
          lineHeight: 1.6,
          marginTop: 6,
          fontStyle: "italic",
          whiteSpace: "pre-wrap",
        }}
      >
        {md}
      </p>
    </Card>
  );
}
