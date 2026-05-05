import type { ReactNode } from "react";
import Link from "next/link";
import { COLOR } from "@/lib/ui/theme";

type StatusRowProps = {
  label: string;
  value?: ReactNode;
  /** When true, render the label in danger color. Used for "Sign out". */
  danger?: boolean;
  /** When set, the row is a link to this href. */
  href?: string;
  /** When set (and no href), the row is a button. */
  onClick?: () => void;
  /** Show a trailing chevron. Default true when href or onClick is set. */
  chevron?: boolean;
};

export function StatusRow({
  label,
  value,
  danger,
  href,
  onClick,
  chevron,
}: StatusRowProps) {
  const showChevron = chevron ?? Boolean(href || onClick);

  const inner = (
    <>
      <span
        style={{
          fontSize: "13px",
          fontWeight: 500,
          color: danger ? COLOR.danger : COLOR.textStrong,
        }}
      >
        {label}
      </span>
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          fontSize: "12px",
          color: COLOR.textMuted,
          fontWeight: 500,
        }}
      >
        {value}
        {showChevron && <span style={{ fontSize: "16px", color: COLOR.textFaint }}>›</span>}
      </span>
    </>
  );

  const baseStyle = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "13px 16px",
    background: COLOR.surface,
    width: "100%",
    border: "none",
    textAlign: "left" as const,
    cursor: href || onClick ? "pointer" : "default",
  };

  if (href) {
    return (
      <Link href={href} style={baseStyle}>
        {inner}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button onClick={onClick} style={baseStyle}>
        {inner}
      </button>
    );
  }
  return <div style={baseStyle}>{inner}</div>;
}
