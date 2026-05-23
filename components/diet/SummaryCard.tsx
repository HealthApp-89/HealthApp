// components/diet/SummaryCard.tsx
"use client";

import { COLOR, RADIUS } from "@/lib/ui/theme";
import { KcalRing } from "./KcalRing";
import { MacroBars } from "./MacroBars";

type Props = {
  eaten: number;
  target: number;
  burned: number | null;
  macros: {
    carbs: { eaten: number; target: number };
    protein: { eaten: number; target: number };
    fat: { eaten: number; target: number };
  };
};

export function SummaryCard({ eaten, target, burned, macros }: Props) {
  return (
    <div
      className="mx-4 p-5"
      style={{
        background: COLOR.surface,
        borderRadius: RADIUS.cardHero,
      }}
    >
      <div className="text-[11px] uppercase tracking-wider mb-3" style={{ color: COLOR.textMuted }}>
        Summary
      </div>
      <KcalRing eaten={eaten} target={target} burned={burned} />
      <MacroBars carbs={macros.carbs} protein={macros.protein} fat={macros.fat} />
    </div>
  );
}
