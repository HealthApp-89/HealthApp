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

export function MacroBars({ carbs, protein, fat }: Props) {
  const rows: Macro[] = [
    { label: "Carbs", eaten: carbs.eaten, target: carbs.target, color: "#fbbf24" },
    { label: "Protein", eaten: protein.eaten, target: protein.target, color: "#34d399" },
    { label: "Fat", eaten: fat.eaten, target: fat.target, color: "#a78bfa" },
  ];

  return (
    <div className="flex flex-col gap-2 mt-4">
      {rows.map((r) => {
        const pct = r.target > 0 ? Math.min(1, r.eaten / r.target) : 0;
        return (
          <div key={r.label}>
            <div className="flex justify-between text-[11px] uppercase tracking-wider" style={{ color: COLOR.textMuted }}>
              <span>{r.label}</span>
              <span className="tabular-nums">{fmtNum(r.eaten)} / {fmtNum(r.target)} g</span>
            </div>
            <div className="h-1.5 rounded-full mt-1 overflow-hidden" style={{ background: COLOR.divider }}>
              <div className="h-full rounded-full" style={{ width: `${pct * 100}%`, background: r.color }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
