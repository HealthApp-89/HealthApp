"use client";

import { Card, SectionLabel } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import type { CoachTrendsPayload } from "@/lib/data/types";

export function TrendsHeader({ headline }: { headline: CoachTrendsPayload["headline"] }) {
  const accent = headline.severity === "warn" ? "#d97706" : headline.severity === "ok" ? "#16a34a" : COLOR.accent;
  return (
    <Card>
      <SectionLabel>
        <span style={{ color: accent }}>{headline.severity.toUpperCase()}</span> · HEADLINE
      </SectionLabel>
      <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
        {headline.title}
      </div>
      <p style={{ fontSize: 12, color: COLOR.textMuted, marginTop: 6, lineHeight: 1.5 }}>
        {headline.body_md}
      </p>
    </Card>
  );
}
