import type { ReactNode } from "react";
import { COLOR } from "@/lib/ui/theme";

type PillTone = "accent" | "success" | "warning" | "danger" | "neutral";

type PillProps = {
  tone?: PillTone;
  children: ReactNode;
  /** Optional left-side glyph or emoji. */
  leading?: ReactNode;
};

const TONE_BG: Record<PillTone, string> = {
  accent:  COLOR.accentSoft,
  success: COLOR.successSoft,
  warning: COLOR.warningSoft,
  danger:  COLOR.dangerSoft,
  neutral: COLOR.surfaceAlt,
};

const TONE_FG: Record<PillTone, string> = {
  accent:  COLOR.accent,
  success: COLOR.success,
  warning: COLOR.warning,
  danger:  COLOR.danger,
  neutral: COLOR.textMid,
};

export function Pill({ tone = "neutral", children, leading }: PillProps) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "3px 8px",
        borderRadius: "9999px",
        background: TONE_BG[tone],
        color: TONE_FG[tone],
        fontSize: "11px",
        fontWeight: 700,
        letterSpacing: "0.02em",
      }}
    >
      {leading ? <span style={{ fontSize: "10px" }}>{leading}</span> : null}
      {children}
    </span>
  );
}
