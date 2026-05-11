"use client";

import { COLOR } from "@/lib/ui/theme";

export function BriefRestActions({ bedtime }: { bedtime: string }) {
  const items = [
    "15 min full-body mobility",
    "8k steps / 60 min walk",
    `Sleep priority — bed by ${bedtime}`,
  ];
  return (
    <div
      style={{
        background: COLOR.surfaceAlt,
        borderRadius: 10,
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: COLOR.textStrong }}>
        Recovery focus:
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, color: COLOR.textMid, fontSize: 13, lineHeight: 1.6 }}>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
