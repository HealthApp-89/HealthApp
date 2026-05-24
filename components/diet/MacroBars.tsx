// components/diet/MacroBars.tsx
"use client";

import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";

type Macro = { label: string; eaten: number; target: number; color: string };

type Props = {
  carbs: { eaten: number; target: number };
  protein: { eaten: number; target: number };
  fat: { eaten: number; target: number };
};

const OVER_TARGET_COLOR = "#dc2626"; // red-600 — same convention as KcalRing

export function MacroBars({ carbs, protein, fat }: Props) {
  const rows: Macro[] = [
    { label: "Carbs", eaten: carbs.eaten, target: carbs.target, color: "#fbbf24" },
    { label: "Protein", eaten: protein.eaten, target: protein.target, color: "#34d399" },
    { label: "Fat", eaten: fat.eaten, target: fat.target, color: "#a78bfa" },
  ];

  return (
    <div className="flex flex-col gap-2 mt-4">
      {rows.map((r) => {
        const over = r.target > 0 && r.eaten > r.target;
        const overBy = over ? r.eaten - r.target : 0;
        const pct = r.target > 0 ? Math.min(1, r.eaten / r.target) : 0;
        const barColor = over ? OVER_TARGET_COLOR : r.color;
        return (
          <div key={r.label}>
            <div className="flex justify-between text-[11px] uppercase tracking-wider" style={{ color: COLOR.textMuted }}>
              <span>{r.label}</span>
              <span className="tabular-nums" style={over ? { color: OVER_TARGET_COLOR } : undefined}>
                {fmtNum(r.eaten)} / {fmtNum(r.target)} g
                {over ? ` (+${fmtNum(overBy)})` : ""}
              </span>
            </div>
            <div className="h-1.5 rounded-full mt-1 overflow-hidden" style={{ background: COLOR.divider }}>
              <div className="h-full rounded-full" style={{ width: `${pct * 100}%`, background: barColor }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
