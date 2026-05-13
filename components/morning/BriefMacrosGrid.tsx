"use client";

import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { MorningBriefMacros } from "@/lib/data/types";

export function BriefMacrosGrid({ macros }: { macros: MorningBriefMacros }) {
  const cells: Array<{ label: string; value: string }> = [
    { label: "Calories", value: `${fmtNum(macros.kcal_target)} kcal` },
    { label: "Protein", value: `${fmtNum(macros.protein_target_g)}g` },
    { label: "Carb", value: `${fmtNum(macros.carb_target_g)}g` },
    { label: "Fat", value: `${fmtNum(macros.fat_target_g)}g` },
  ];
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        gap: 8,
      }}
    >
      {cells.map((c) => (
        <div
          key={c.label}
          style={{
            background: COLOR.accentSoft,
            borderRadius: 10,
            padding: "10px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
          aria-label={`${c.label}: ${c.value}`}
        >
          <div style={{ fontSize: 16, fontWeight: 700, color: COLOR.textStrong, lineHeight: 1.2 }}>
            {c.value}
          </div>
          <div style={{ fontSize: 11, color: COLOR.accentDeep, fontWeight: 600 }}>
            {c.label}
          </div>
        </div>
      ))}
    </div>
  );
}
