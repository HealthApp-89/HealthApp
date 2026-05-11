"use client";

import { COLOR } from "@/lib/ui/theme";
import type { MorningBriefRecap } from "@/lib/data/types";

export function BriefRecapStats({ recap }: { recap: MorningBriefRecap }) {
  const stats: Array<{ label: string; value: string; sub?: string }> = [
    {
      label: "Sleep",
      value: recap.sleep_hours !== null ? `${recap.sleep_hours}h` : "—",
    },
    {
      label: "Kcal",
      value: recap.kcal_actual !== null ? `${recap.kcal_actual}` : "—",
      sub: recap.kcal_target > 0 ? `/${recap.kcal_target}` : undefined,
    },
    {
      label: "Protein",
      value:
        recap.protein_actual_g !== null
          ? `${recap.protein_actual_g}g`
          : "—",
      sub: recap.protein_target_g > 0 ? `/${recap.protein_target_g}g` : undefined,
    },
    {
      label: "Trained",
      value: recap.trained_yesterday ?? "—",
      sub: recap.top_e1rm_yesterday
        ? `${recap.top_e1rm_yesterday.lift} ${recap.top_e1rm_yesterday.kg}kg`
        : undefined,
    },
  ];

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
        gap: 8,
      }}
    >
      {stats.map((s) => (
        <div
          key={s.label}
          style={{
            background: COLOR.surfaceAlt,
            borderRadius: 10,
            padding: "10px 8px",
            display: "flex",
            flexDirection: "column",
            gap: 2,
            alignItems: "flex-start",
          }}
          aria-label={`${s.label}: ${s.value}${s.sub ? ` ${s.sub}` : ""}`}
        >
          <div style={{ fontSize: 10, color: COLOR.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            {s.label}
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong, lineHeight: 1.2 }}>
            {s.value}
          </div>
          {s.sub && (
            <div style={{ fontSize: 11, color: COLOR.textFaint, lineHeight: 1.2 }}>
              {s.sub}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
