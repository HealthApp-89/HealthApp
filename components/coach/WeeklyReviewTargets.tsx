"use client";
import { Card, SectionLabel } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { WeeklyReviewPayload } from "@/lib/data/types";

export function WeeklyReviewTargets({
  targets,
}: {
  targets: WeeklyReviewPayload["targets"];
}) {
  return (
    <Card>
      <SectionLabel>TARGETS NEXT WEEK</SectionLabel>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
          marginTop: 8,
          fontSize: 11,
          color: COLOR.textStrong,
        }}
      >
        <Pair label="Kcal" v={`${fmtNum(targets.nutrition.kcal)}`} />
        <Pair label="Protein" v={`${fmtNum(targets.nutrition.protein_g)}g`} />
        <Pair label="Carbs" v={`${fmtNum(targets.nutrition.carbs_g)}g`} />
        <Pair label="Fat" v={`${fmtNum(targets.nutrition.fat_g)}g`} />
        <Pair
          label="Sleep"
          v={`${fmtNum(targets.sleep.hours)}h @ ${targets.sleep.efficiency_pct}%`}
        />
        <Pair
          label="Recovery"
          v={targets.recovery_focus.join(", ") || "—"}
        />
      </div>
    </Card>
  );
}

function Pair({ label, v }: { label: string; v: string }) {
  return (
    <div>
      <div style={{ color: COLOR.textMuted }}>{label}</div>
      <div>{v}</div>
    </div>
  );
}
