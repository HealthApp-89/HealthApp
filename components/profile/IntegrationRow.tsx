import type { ReactNode } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";

type IntegrationRowProps = {
  /** Brand background color for the chip. */
  brandColor: string;
  /** Brand foreground (text on the chip). */
  brandFg?: string;
  /** Chip content — usually the brand initial. */
  chip: ReactNode;
  name: string;
  /** Status text — e.g. "Connected · synced 8 min ago". */
  status: string;
  /** Status dot color — `success` for OK, `muted` for off, etc. */
  statusTone?: "success" | "muted" | "danger";
  /** CTA label — defaults to "Manage". */
  ctaLabel?: string;
  /** Where the CTA routes. */
  ctaHref: string;
};

const TONE_DOT: Record<"success" | "muted" | "danger", string> = {
  success: COLOR.success,
  muted:   COLOR.textFaint,
  danger:  COLOR.danger,
};

export function IntegrationRow({
  brandColor,
  brandFg = "#fff",
  chip,
  name,
  status,
  statusTone = "success",
  ctaLabel = "Manage",
  ctaHref,
}: IntegrationRowProps) {
  return (
    <Card variant="compact" style={{ display: "flex", alignItems: "center", gap: "12px", padding: "12px 14px" }}>
      <div
        style={{
          width: "36px",
          height: "36px",
          borderRadius: "10px",
          background: brandColor,
          color: brandFg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "16px",
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        {chip}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "13px", fontWeight: 700, color: COLOR.textStrong }}>{name}</div>
        <div style={{ fontSize: "11px", color: COLOR.textMuted, marginTop: "1px" }}>
          <span style={{ color: TONE_DOT[statusTone], fontWeight: 600 }}>● </span>
          {status}
        </div>
      </div>
      <Link href={ctaHref} style={{ fontSize: "11px", color: COLOR.accent, fontWeight: 700, textDecoration: "none" }}>
        {ctaLabel} ›
      </Link>
    </Card>
  );
}
