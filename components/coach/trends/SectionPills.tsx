"use client";

import { COLOR } from "@/lib/ui/theme";

export type TrendsSection = "performance" | "composition" | "cross";

export function SectionPills({
  active,
  onChange,
}: {
  active: TrendsSection;
  onChange: (s: TrendsSection) => void;
}) {
  const items: { id: TrendsSection; label: string }[] = [
    { id: "performance", label: "Performance" },
    { id: "composition", label: "Composition" },
    { id: "cross", label: "Cross" },
  ];
  return (
    <div style={{ display: "flex", gap: 6, padding: "8px 12px" }}>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          onClick={() => onChange(it.id)}
          style={{
            background: active === it.id ? COLOR.accent : COLOR.surfaceAlt,
            color: active === it.id ? "#fff" : COLOR.textStrong,
            border: "none",
            borderRadius: 9999,
            padding: "6px 12px",
            fontSize: 12,
            fontWeight: active === it.id ? 700 : 500,
            cursor: "pointer",
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
