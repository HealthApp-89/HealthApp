// components/diet/KcalRing.tsx
"use client";

import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";

type Props = {
  eaten: number;
  target: number;
  burned: number | null;
};

const OVER_TARGET_COLOR = "#dc2626"; // red-600 — matches the in-band/off-band convention used elsewhere

/** Yazio-style 270° calorie ring. Eaten on the left, burned on the right,
 *  remaining in the center as the dominant number. Pure presentation —
 *  parent supplies the three values; ring fills based on (eaten / target)
 *  clamped to [0, 1.2] (overshoots show a fuller-than-full arc). When
 *  eaten > target, the ring + center value flip to red and the label
 *  switches from "Remaining" to "Over" with a signed value. */
export function KcalRing({ eaten, target, burned }: Props) {
  const safeTarget = target > 0 ? target : 2000;
  const over = eaten > safeTarget;
  const overBy = Math.max(0, eaten - safeTarget);
  const remaining = Math.max(0, safeTarget - eaten);
  const fillPct = Math.min(1.2, eaten / safeTarget);

  // 270deg arc: stroke-dasharray totals 270/360 of the circumference.
  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  const arcLength = circumference * (270 / 360);
  const filled = arcLength * fillPct;
  const ringColor = over ? OVER_TARGET_COLOR : COLOR.accent;

  return (
    <div className="flex flex-col items-center">
      <div className="relative w-[180px] h-[180px]">
        <svg
          width={180}
          height={180}
          viewBox="0 0 180 180"
          style={{ transform: "rotate(135deg)" }}
        >
          {/* Track (full 270deg) */}
          <circle
            cx={90}
            cy={90}
            r={radius}
            fill="none"
            stroke={COLOR.divider}
            strokeWidth={10}
            strokeDasharray={`${arcLength} ${circumference}`}
          />
          {/* Fill (eaten portion) */}
          <circle
            cx={90}
            cy={90}
            r={radius}
            fill="none"
            stroke={ringColor}
            strokeWidth={10}
            strokeDasharray={`${filled} ${circumference}`}
            strokeLinecap="round"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div
            className="text-3xl font-bold tabular-nums"
            style={{ color: over ? OVER_TARGET_COLOR : COLOR.textStrong }}
          >
            {over ? `+${fmtNum(overBy)}` : fmtNum(remaining)}
          </div>
          <div
            className="text-xs uppercase tracking-wider"
            style={{ color: over ? OVER_TARGET_COLOR : COLOR.textMuted }}
          >
            {over ? "Over" : "Remaining"}
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-8 text-center">
        <div>
          <div className="text-lg font-semibold tabular-nums" style={{ color: COLOR.textStrong }}>
            {fmtNum(eaten)}
          </div>
          <div className="text-[10px] uppercase tracking-wider" style={{ color: COLOR.textMuted }}>
            Eaten
          </div>
        </div>
        <div>
          <div className="text-lg font-semibold tabular-nums" style={{ color: COLOR.textStrong }}>
            {burned === null ? "—" : fmtNum(burned)}
          </div>
          <div className="text-[10px] uppercase tracking-wider" style={{ color: COLOR.textMuted }}>
            Burned
          </div>
        </div>
      </div>
    </div>
  );
}
