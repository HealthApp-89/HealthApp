import React from "react";
import { COLOR } from "@/lib/ui/theme";

type Size = 26 | 36 | 56;

type Props = { size?: Size; decorative?: boolean };

const FONT_SIZE: Record<Size, number> = { 26: 11, 36: 15, 56: 22 };

export function CoachAvatar({ size = 36, decorative = false }: Props) {
  return (
    <div
      {...(decorative
        ? { "aria-hidden": "true" as const }
        : { "aria-label": "Coach Carter" })}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: `linear-gradient(135deg, ${COLOR.accent} 0%, #7a47ff 100%)`,
        color: "white",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 700,
        fontSize: FONT_SIZE[size],
        flexShrink: 0,
        userSelect: "none",
      }}
    >
      C
    </div>
  );
}
