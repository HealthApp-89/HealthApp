"use client";

import { COLOR } from "@/lib/ui/theme";
import type { TrendWindow } from "@/lib/data/types";

export function WindowToggle({
  value,
  onChange,
}: {
  value: TrendWindow;
  onChange: (w: TrendWindow) => void;
}) {
  return (
    <div style={{ display: "inline-flex", gap: 2, fontSize: 10 }}>
      {(["4w", "12w"] as const).map((w) => (
        <button
          key={w}
          type="button"
          onClick={() => onChange(w)}
          style={{
            background: value === w ? COLOR.textStrong : "transparent",
            color: value === w ? COLOR.surface : COLOR.textMuted,
            border: `1px solid ${value === w ? COLOR.textStrong : COLOR.divider}`,
            borderRadius: 9999,
            padding: "2px 8px",
            fontSize: 10,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {w}
        </button>
      ))}
    </div>
  );
}
