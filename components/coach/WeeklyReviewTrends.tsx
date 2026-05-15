"use client";
import { Card, SectionLabel } from "@/components/ui/Card";
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
        />
        <Cell
          label="Strength slope"
          value={
            trends.strength_slope_pct_per_week != null
              ? `${fmtNum(trends.strength_slope_pct_per_week * 100)}%/wk`
              : "—"
          }
        />
        <Cell
          label="/LBM slope"
          value={
            trends.lbm_slope_pct_per_week != null
              ? `${fmtNum(trends.lbm_slope_pct_per_week * 100)}%/wk`
              : "—"
          }
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
        />
      </div>
    </Card>
  );
}

function Cell({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok?: boolean | null;
}) {
  return (
    <div>
      <div style={{ color: COLOR.textMuted }}>{label}</div>
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
}
