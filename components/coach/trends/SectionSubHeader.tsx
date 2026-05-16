"use client";

import { COLOR } from "@/lib/ui/theme";

export function SectionSubHeader({ label }: { label: string }) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 700,
        color: COLOR.textFaint,
        letterSpacing: "0.5px",
        textTransform: "uppercase",
        marginTop: 14,
        marginBottom: 6,
        paddingLeft: 12,
      }}
    >
      {label}
    </div>
  );
}
