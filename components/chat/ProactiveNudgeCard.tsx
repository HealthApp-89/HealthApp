"use client";
import Link from "next/link";
import { Card, SectionLabel } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import type { ProactiveNudgeCard as ProactiveNudgeCardUI } from "@/lib/data/types";

/** Card rendered for chat_messages with kind='proactive_nudge'. Visual
 *  lineage mirrors WeeklyReviewCard.tsx — same Card wrapper, same Link
 *  CTA pattern, warn-colored severity tag. */
export function ProactiveNudgeCard({ ui }: { ui: ProactiveNudgeCardUI }) {
  const accent = "#d97706"; // warn-amber, matches lib/coach/trends/ TrendsHeader

  return (
    <div style={{ padding: "6px 12px" }}>
      <Card>
        <SectionLabel>
          <span style={{ color: accent }}>{ui.severity.toUpperCase()}</span> · COACH
        </SectionLabel>
        <div
          style={{
            fontSize: 14,
            fontWeight: 700,
            marginTop: 6,
            color: COLOR.textStrong,
          }}
        >
          {ui.headline}
        </div>
        <p
          style={{
            fontSize: 12,
            color: COLOR.textMuted,
            marginTop: 6,
            lineHeight: 1.5,
          }}
        >
          {ui.body_md}
        </p>
        <Link
          href={ui.deep_link.href}
          style={{
            display: "inline-block",
            marginTop: 10,
            padding: "8px 12px",
            background: COLOR.accent,
            color: "#fff",
            borderRadius: 9999,
            fontWeight: 700,
            fontSize: 12,
            textDecoration: "none",
          }}
        >
          {ui.deep_link.label}
        </Link>
      </Card>
    </div>
  );
}
