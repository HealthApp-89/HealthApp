"use client";

import { Card } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { HealthTrendPoint } from "@/lib/query/fetchers/healthTrend";

type Field = {
  key: keyof Pick<
    HealthTrendPoint,
    "weight_kg" | "body_fat_pct" | "fat_mass_kg" | "fat_free_mass_kg" | "muscle_mass_kg"
  >;
  label: string;
  unit: string;
  /** Direction "good" — lower BF% / fat_mass = good; higher lean / muscle = good. */
  goodWhenLower: boolean;
};

const FIELDS: Field[] = [
  { key: "weight_kg",        label: "Weight",     unit: "kg", goodWhenLower: true },
  { key: "body_fat_pct",     label: "Body fat",   unit: "%",  goodWhenLower: true },
  { key: "fat_mass_kg",      label: "Fat mass",   unit: "kg", goodWhenLower: true },
  { key: "fat_free_mass_kg", label: "Lean mass",  unit: "kg", goodWhenLower: false },
  { key: "muscle_mass_kg",   label: "Muscle",     unit: "kg", goodWhenLower: false },
];

/** Latest non-null value within window. */
function latest(points: HealthTrendPoint[], key: Field["key"]): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const v = points[i][key];
    if (v != null) return v;
  }
  return null;
}

/** Most recent non-null reading whose date is in [today-35, today-25]. */
function baseline35to25(
  points: HealthTrendPoint[],
  todayIso: string,
  key: Field["key"],
): number | null {
  const today = new Date(todayIso + "T00:00:00Z");
  const lo = new Date(today);
  lo.setUTCDate(lo.getUTCDate() - 35);
  const hi = new Date(today);
  hi.setUTCDate(hi.getUTCDate() - 25);
  const loIso = lo.toISOString().slice(0, 10);
  const hiIso = hi.toISOString().slice(0, 10);

  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    if (p.date < loIso || p.date > hiIso) continue;
    if (p[key] != null) return p[key]!;
  }
  return null;
}

export function BodyCompCard({
  points,
  todayIso,
}: {
  points: HealthTrendPoint[];
  todayIso: string;
}) {
  return (
    <Card>
      <div style={{ fontSize: "11px", fontWeight: 700, color: COLOR.textMuted, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: "10px" }}>
        Body composition · vs 30d
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: "6px 12px", alignItems: "baseline" }}>
        {FIELDS.map((f) => {
          const curr = latest(points, f.key);
          const prev = baseline35to25(points, todayIso, f.key);
          const d = curr != null && prev != null ? curr - prev : null;
          const isGood =
            d == null
              ? null
              : f.goodWhenLower
              ? d < 0
              : d > 0;
          const deltaColor =
            d == null
              ? COLOR.textFaint
              : d === 0
              ? COLOR.textFaint
              : isGood
              ? COLOR.success
              : COLOR.danger;
          return (
            <FieldRow
              key={f.key}
              label={f.label}
              value={curr}
              unit={f.unit}
              delta={d}
              deltaColor={deltaColor}
            />
          );
        })}
      </div>
    </Card>
  );
}

function FieldRow({
  label,
  value,
  unit,
  delta,
  deltaColor,
}: {
  label: string;
  value: number | null;
  unit: string;
  delta: number | null;
  deltaColor: string;
}) {
  return (
    <>
      <span style={{ fontSize: "13px", color: COLOR.textMid }}>{label}</span>
      <span data-tnum style={{ fontSize: "15px", fontWeight: 700, color: COLOR.textStrong, textAlign: "right" }}>
        {fmtNum(value)} {unit}
      </span>
      <span data-tnum style={{ fontSize: "12px", fontWeight: 600, color: deltaColor, textAlign: "right" }}>
        {delta == null ? "—" : `${delta > 0 ? "+" : ""}${fmtNum(delta)}`}
      </span>
    </>
  );
}
