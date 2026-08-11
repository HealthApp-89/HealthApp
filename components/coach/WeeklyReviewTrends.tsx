"use client";
import Link from "next/link";
import { Card, SectionLabel } from "@/components/ui/Card";
import { SpeakerChip } from "@/components/chat/SpeakerChip";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { WeeklyReviewPayload } from "@/lib/data/types";

export function WeeklyReviewTrends({
  trends,
}: {
  trends: WeeklyReviewPayload["trends"];
}) {
  return (
    <Card>
      <SectionLabel>TREND SIGNALS · 4-WEEK</SectionLabel>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
          marginTop: 8,
          fontSize: 11,
        }}
      >
        <Cell
          label="Loss rate"
          value={
            trends.weight_loss_kg_per_week != null
              ? `${fmtNum(trends.weight_loss_kg_per_week)}kg/wk`
              : "—"
          }
          ok={trends.loss_rate_in_target_band}
          href="/health?tab=trends"
          speaker="nora"
        />
        <Cell
          label="Strength slope"
          value={
            trends.strength_slope_pct_per_week != null
              ? `${fmtNum(trends.strength_slope_pct_per_week * 100)}%/wk`
              : "—"
          }
          href="/strength?tab=blocks"
          speaker="carter"
        />
        <Cell
          label="/LBM slope"
          value={
            trends.lbm_slope_pct_per_week != null
              ? `${fmtNum(trends.lbm_slope_pct_per_week * 100)}%/wk`
              : "—"
          }
          href="/health?tab=trends"
          speaker="nora"
        />
        <Cell
          label="Plateaus"
          value={
            trends.plateau_flags.length > 0
              ? trends.plateau_flags
                  .map((p) => p.lift.replace(/\s*\([^)]+\)/, ""))
                  .join(", ")
              : "none"
          }
          ok={trends.plateau_flags.length === 0 ? true : false}
          href="/strength?tab=blocks"
          speaker="carter"
        />
      </div>
      {/* These used to deep-link into /coach/progress, which does not exist —
          every one of them 404'd. Routed by each cell's own semantics instead:
          composition (Nora) to the Health trends tab, performance (Carter) to
          the Blocks tab, which is where strength progress and plateaus live. */}
      <Link
        href="/health?tab=trends"
        style={{
          display: "inline-block",
          marginTop: 8,
          fontSize: 11,
          color: COLOR.accent,
          textDecoration: "none",
        }}
      >
        See full trends →
      </Link>
    </Card>
  );
}

function Cell({
  label,
  value,
  ok,
  href,
  speaker,
}: {
  label: string;
  value: string;
  ok?: boolean | null;
  href?: string;
  speaker?: "peter" | "carter" | "nora" | "remi";
}) {
  const content = (
    <div>
      <div
        style={{
          color: COLOR.textMuted,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 4,
        }}
      >
        <span>{label}</span>
        {speaker && <SpeakerChip speaker={speaker} size="sm" />}
      </div>
      <div
        style={{
          color:
            ok === true
              ? COLOR.success
              : ok === false
                ? COLOR.danger
                : COLOR.textStrong,
        }}
      >
        {value}
      </div>
    </div>
  );
  if (!href) return content;
  return (
    <Link href={href} style={{ textDecoration: "none", color: "inherit" }}>
      {content}
    </Link>
  );
}
