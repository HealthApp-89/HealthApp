"use client";

import { Card, SectionLabel } from "@/components/ui/Card";
import { SpeakerChip } from "@/components/chat/SpeakerChip";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { CoachTrendsPayload } from "@/lib/data/types";
import { SectionSubHeader } from "./SectionSubHeader";

export function CompositionSection({
  body,
  nutrition,
}: {
  body: CoachTrendsPayload["body"];
  nutrition: CoachTrendsPayload["nutrition"];
}) {
  const bandText = `${body.weight.target_band.lower} to ${body.weight.target_band.upper} kg/wk`;
  const inBandColor = body.weight.in_band === true ? "#16a34a" : body.weight.in_band === false ? "#dc2626" : COLOR.textMuted;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <SectionSubHeader label="Body composition" />
        <SpeakerChip speaker="nora" size="sm" />
      </div>
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
          Δ4w {body.body_fat_pct.delta_4w_pct != null ? `${body.body_fat_pct.delta_4w_pct > 0 ? "+" : ""}${fmtNum(body.body_fat_pct.delta_4w_pct)} pts` : "n/a"}
        </div>
      </Card>

      <SectionSubHeader label="Nutrition" />
      <Card>
        <SectionLabel>PROTEIN ADHERENCE</SectionLabel>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
          {nutrition.protein.pct_4w != null ? `${fmtNum(nutrition.protein.pct_4w * 100)}%` : "n/a"} · 4w
        </div>
        <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
          {nutrition.protein.days_hit_4w}/{nutrition.protein.days_total_4w} days hit target ({nutrition.protein.target_g ?? "n/a"}g)
        </div>
      </Card>
      <Card>
        <SectionLabel>KCAL ADHERENCE</SectionLabel>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
          {nutrition.kcal.pct_4w != null ? `${fmtNum(nutrition.kcal.pct_4w * 100)}%` : "n/a"} · 4w
        </div>
        <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
          {nutrition.kcal.days_hit_4w}/{nutrition.kcal.days_total_4w} days within ±5% of {nutrition.kcal.target ?? "n/a"} kcal target
        </div>
      </Card>
      <Card>
        <SectionLabel>DEFICIT MAGNITUDE</SectionLabel>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
          {nutrition.deficit_kcal.avg_4w != null ? `${nutrition.deficit_kcal.avg_4w > 0 ? "+" : ""}${fmtNum(nutrition.deficit_kcal.avg_4w)} kcal/day` : "n/a"}
        </div>
        <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
          4w average vs target. Negative = deficit; positive = surplus.
        </div>
      </Card>
    </div>
  );
}
