"use client";

import type { CSSProperties } from "react";
import { COLOR } from "@/lib/ui/theme";

export function ToolRow({
  title,
  subtitle,
  disabled,
  onClick,
}: {
  title: string;
  subtitle?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  const rowStyle: CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    width: "100%",
    padding: "10px 0",
    borderBottom: `1px solid ${COLOR.divider}`,
    background: "transparent",
    border: "none",
    borderTop: "none",
    borderLeft: "none",
    borderRight: "none",
    textAlign: "left",
    fontFamily: "inherit",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
  // Note: we deliberately do NOT pass HTML `disabled` to the button. Disabled
  // rows still need to fire onClick so the parent can surface a tap-to-explain
  // toast ("Why is this disabled?"). `aria-disabled` carries the semantics for
  // assistive tech; visual affordance comes from the opacity + cursor styles.
  return (
    <button
      type="button"
      style={rowStyle}
      aria-disabled={disabled || undefined}
      onClick={onClick}
    >
      <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 13, color: COLOR.textStrong }}>{title}</span>
        {subtitle && (
          <span style={{ fontSize: 11, color: COLOR.textMuted }}>{subtitle}</span>
        )}
      </span>
      <span style={{ color: COLOR.textFaint, fontSize: 12 }}>→</span>
    </button>
  );
}
