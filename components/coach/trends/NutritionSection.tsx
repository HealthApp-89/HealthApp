"use client";

import { Card, SectionLabel } from "@/components/ui/Card";
import { SpeakerChip } from "@/components/chat/SpeakerChip";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { CoachTrendsPayload } from "@/lib/data/types";
import type { MealSlot } from "@/lib/food/types";
import { SectionSubHeader } from "./SectionSubHeader";
import { InlineNudgeCallout } from "./InlineNudgeCallout";

const SLOT_ORDER: MealSlot[] = ["breakfast", "lunch", "dinner", "snack"];
const SLOT_LABEL: Record<MealSlot, string> = {
  breakfast: "Brkfst", lunch: "Lunch", dinner: "Dinner", snack: "Snack",
};

export function NutritionSection({
  nutrition,
  foodQuality,
  userId,
}: {
  nutrition: CoachTrendsPayload["nutrition"];
  foodQuality: CoachTrendsPayload["food_quality"];
  userId: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <SectionSubHeader label="Nutrition" />
        <SpeakerChip speaker="nora" size="sm" />
      </div>

      {/* ── Adherence block ─────────────────────────────────────────────── */}
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: COLOR.textMuted, marginTop: 8 }}>
        Adherence
      </div>

      <Card>
        <SectionLabel>PROTEIN ADHERENCE</SectionLabel>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, marginTop: 4 }}>
          {nutrition.protein.pct_4w != null ? `${fmtNum(nutrition.protein.pct_4w * 100)}%` : "n/a"} · 4w
        </div>
        <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 4 }}>
          {nutrition.protein.days_hit_4w}/{nutrition.protein.days_total_4w} days hit target ({nutrition.protein.target_g ?? "n/a"}g)
        </div>
        <InlineNudgeCallout
          userId={userId}
          triggerKey="protein_under"
          variant="warn"
          title="Protein under target too often"
          body="Hit rate has dropped below 60% over the last week."
        />
        <InlineNudgeCallout
          userId={userId}
          triggerKey="glp1_protein_floor"
          variant="warn"
          title="GLP-1 protein floor missed"
          body="Protein has come in under 1.8 g/kg on at least 3 of the last 5 days."
        />
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

      {/* ── By-meal-slot block ──────────────────────────────────────────── */}
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: COLOR.textMuted, marginTop: 14, paddingTop: 8, borderTop: "1px dashed #e5e7eb" }}>
        By meal slot · 14d avg
      </div>

      <Card>
        <SectionLabel>PROTEIN PER SLOT</SectionLabel>
        {SLOT_ORDER.map((slot) => {
          const cell = nutrition.per_meal_slot.protein_g[slot];
          const pct = cell.pct_of_target;
          const width = pct != null ? Math.max(2, Math.min(100, pct * 100)) : 0;
          return (
            <div key={slot} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
              <span style={{ fontSize: 10, width: 50, color: COLOR.textMuted }}>{SLOT_LABEL[slot]}</span>
              <span style={{ flex: 1, height: 8, background: "#f3f4f6", borderRadius: 4, overflow: "hidden" }}>
                <span style={{ display: "block", height: "100%", width: `${width}%`, background: "#3b82f6", borderRadius: 4 }} />
              </span>
              <span style={{ fontSize: 10, color: COLOR.textMuted, width: 70, textAlign: "right" }}>
                {cell.avg_14d != null ? `${fmtNum(cell.avg_14d)}g` : "—"}
                {pct != null ? ` · ${fmtNum(pct * 100)}%` : ""}
              </span>
            </div>
          );
        })}
      </Card>

      <Card>
        <SectionLabel>KCAL PER SLOT</SectionLabel>
        {SLOT_ORDER.map((slot) => {
          const cell = nutrition.per_meal_slot.kcal[slot];
          const pct = cell.pct_of_target;
          const width = pct != null ? Math.max(2, Math.min(120, pct * 100)) : 0;
          const targetMarker = cell.target_kcal != null && cell.avg_14d != null && cell.target_kcal > 0
            ? Math.min(100, (cell.target_kcal / Math.max(cell.target_kcal, cell.avg_14d, 1)) * 100)
            : null;
          return (
            <div key={slot} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
              <span style={{ fontSize: 10, width: 50, color: COLOR.textMuted }}>{SLOT_LABEL[slot]}</span>
              <span style={{ flex: 1, height: 8, background: "#f3f4f6", borderRadius: 4, overflow: "hidden", position: "relative" }}>
                <span style={{ display: "block", height: "100%", width: `${width}%`, background: "#f59e0b", borderRadius: 4 }} />
                {targetMarker != null && (
                  <span style={{ position: "absolute", top: -2, left: `${targetMarker}%`, width: 1.5, height: 12, background: COLOR.textStrong }} />
                )}
              </span>
              <span style={{ fontSize: 10, color: COLOR.textMuted, width: 80, textAlign: "right" }}>
                {cell.avg_14d != null ? `${Math.round(cell.avg_14d)}` : "—"}
                {cell.target_kcal != null ? ` / ${cell.target_kcal}` : ""}
              </span>
            </div>
          );
        })}
        <InlineNudgeCallout
          userId={userId}
          triggerKey="training_day_undereat"
          variant="warn"
          title="Undereating on lift days"
          body="Kcal has come in 300+ under target on at least half of recent lift days."
        />
      </Card>

      {/* Food-quality block is appended in Task 13 (kept here as a placeholder
          for now — Task 13 replaces this comment with the four cards). */}
      <NutritionFoodQuality foodQuality={foodQuality} userId={userId} />
    </div>
  );
}

// Stub — Task 13 implements this.
function NutritionFoodQuality(_props: { foodQuality: CoachTrendsPayload["food_quality"]; userId: string }) {
  return null;
}
