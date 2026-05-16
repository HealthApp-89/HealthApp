"use client";

import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";

export function ChangeBadge({
  valuePct,
  label,
}: {
  valuePct: number | null;
  label?: string;
}) {
  if (valuePct == null) {
    return <span style={{ fontSize: 11, color: COLOR.textFaint }}>n/a</span>;
  }
  const color = valuePct > 0.005
    ? "#16a34a"
    : valuePct < -0.005
    ? "#dc2626"
    : COLOR.textMuted;
  const sign = valuePct >= 0 ? "+" : "";
  return (
    <span style={{ fontSize: 11, color, fontWeight: 700 }}>
      {sign}{fmtNum(valuePct * 100)}%{label ? ` ${label}` : ""}
    </span>
  );
}
