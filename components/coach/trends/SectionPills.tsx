"use client";

import { COLOR } from "@/lib/ui/theme";

export type TrendsSection = "performance" | "body" | "cross";

const SECTIONS: Array<{ key: TrendsSection; label: string }> = [
  { key: "performance", label: "Performance" },
  { key: "body",        label: "Body" },
  { key: "cross",       label: "Cross" },
];

export function SectionPills({
  active,
  onChange,
}: {
  active: TrendsSection;
  onChange: (section: TrendsSection) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 6, padding: "8px 12px", overflowX: "auto" }}>
      {SECTIONS.map((s) => (
        <button
          key={s.key}
          onClick={() => onChange(s.key)}
          style={{
            padding: "4px 10px",
            fontSize: 11,
            fontWeight: 600,
            borderRadius: 999,
            background: active === s.key ? COLOR.textStrong : "#f3f4f6",
            color:      active === s.key ? "#fff"         : COLOR.textMuted,
            border: `1px solid ${active === s.key ? COLOR.textStrong : "#d1d5db"}`,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
