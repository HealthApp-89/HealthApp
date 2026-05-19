"use client";
import Link from "next/link";
import { CoachCard } from "@/components/coach/CoachCard";
import { SpeakerChip } from "@/components/chat/SpeakerChip";
import { COLOR } from "@/lib/ui/theme";
import type { ProactiveNudgeCard as ProactiveNudgeCardUI } from "@/lib/data/types";

/** Card rendered for chat_messages with kind='proactive_nudge'. Visual
 *  lineage mirrors WeeklyReviewCard.tsx — same CoachCard chrome, same Link
 *  CTA pattern, warn-toned accent bar. */
const SEVERITY_TO_TONE: Record<string, "default" | "alert" | "ok" | "accent"> = {
  warn:  "alert",
  alert: "alert",
  ok:    "ok",
  info:  "accent",
};

export function ProactiveNudgeCard({ ui }: { ui: ProactiveNudgeCardUI }) {
  const tone = SEVERITY_TO_TONE[ui.severity] ?? "default";
  const accent = "#d97706"; // warn-amber, matches lib/coach/trends/ TrendsHeader

  return (
    <div style={{ padding: "6px 12px" }}>
      <CoachCard tone={tone}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <CoachCard.Eyebrow>
            <span style={{ color: accent }}>{ui.severity.toUpperCase()}</span> · COACH
          </CoachCard.Eyebrow>
          {ui.speaker && <SpeakerChip speaker={ui.speaker} size="sm" />}
        </div>
        <CoachCard.Title>{ui.headline}</CoachCard.Title>
        <CoachCard.Body>
          <p
            style={{
              fontSize: 12,
              color: COLOR.textMuted,
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            {ui.body_md}
          </p>
        </CoachCard.Body>
        <CoachCard.Actions>
          <Link
            href={ui.deep_link.href}
            style={{
              display: "inline-block",
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
        </CoachCard.Actions>
      </CoachCard>
    </div>
  );
}
