"use client";

import { Card, SectionLabel } from "@/components/ui/Card";
import { SpeakerChip } from "@/components/chat/SpeakerChip";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { CoachTrendsPayload } from "@/lib/data/types";
import { SectionSubHeader } from "./SectionSubHeader";
import { InlineNudgeCallout } from "./InlineNudgeCallout";

export function BodySection({
  body,
  userId,
}: {
  body: CoachTrendsPayload["body"];
  userId: string;
}) {
  const bandText = `${body.weight.target_band.lower} to ${body.weight.target_band.upper} kg/wk`;
  const inBandColor =
    body.weight.in_band === true  ? "#16a34a" :
    body.weight.in_band === false ? "#dc2626" :
                                    COLOR.textMuted;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <SectionSubHeader label="Body" />
        <SpeakerChip speaker="nora" size="sm" />
      </div>

      {/* Recomp banner — rendered only when recomp_success dedup row is active. */}
      <InlineNudgeCallout
        userId={userId}
        triggerKey="recomp_success"
        variant="ok"
        title="↑ Recomp signal — keep this"
        body={
          body.lbm.delta_4w_kg != null && body.body_fat_pct.delta_4w_pct != null
            ? `LBM ${body.lbm.delta_4w_kg > 0 ? "+" : ""}${fmtNum(body.lbm.delta_4w_kg)} kg, body fat ${body.body_fat_pct.delta_4w_pct > 0 ? "+" : ""}${fmtNum(body.body_fat_pct.delta_4w_pct)} pts over 4w.`
            : "Lean mass up and body fat down over 4 weeks."
        }
      />

      <Card>
        <SectionLabel>WEIGHT</SectionLabel>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
          {body.weight.now_kg != null ? `${fmtNum(body.weight.now_kg)} kg` : "n/a"}
        </div>
        <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
          4w rate: <span style={{ color: inBandColor, fontWeight: 600 }}>
            {body.weight.rate_kg_per_wk_4w != null
              ? `${body.weight.rate_kg_per_wk_4w > 0 ? "+" : ""}${fmtNum(body.weight.rate_kg_per_wk_4w)} kg/wk`
              : "n/a"}
          </span> · target band {bandText}
        </div>

        <InlineNudgeCallout
          userId={userId}
          triggerKey="recomp_drift"
          variant="warn"
          title="Recomp drifting wrong way"
          body="Scale flat over 4 weeks but body fat ticked up. Worth checking deficit depth and protein floor."
        />
      </Card>

      <Card>
        <SectionLabel>LBM</SectionLabel>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
          {body.lbm.now_kg != null ? `${fmtNum(body.lbm.now_kg)} kg` : "n/a"}
        </div>
        <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
          Δ4w {body.lbm.delta_4w_kg != null ? `${body.lbm.delta_4w_kg > 0 ? "+" : ""}${fmtNum(body.lbm.delta_4w_kg)} kg` : "n/a"} ·
          Δ12w {body.lbm.delta_12w_kg != null ? `${body.lbm.delta_12w_kg > 0 ? "+" : ""}${fmtNum(body.lbm.delta_12w_kg)} kg` : "n/a"}
        </div>
      </Card>

      <Card>
        <SectionLabel>BODY FAT %</SectionLabel>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
          {body.body_fat_pct.now != null ? `${fmtNum(body.body_fat_pct.now)}%` : "n/a"}
        </div>
        <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
          Δ4w {body.body_fat_pct.delta_4w_pct != null ? `${body.body_fat_pct.delta_4w_pct > 0 ? "+" : ""}${fmtNum(body.body_fat_pct.delta_4w_pct)} pts` : "n/a"} ·
          Δ12w {body.body_fat_pct.delta_12w_pct != null ? `${body.body_fat_pct.delta_12w_pct > 0 ? "+" : ""}${fmtNum(body.body_fat_pct.delta_12w_pct)} pts` : "n/a"}
        </div>
      </Card>
    </div>
  );
}
