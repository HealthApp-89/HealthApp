"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { LineChart, type LinePoint } from "@/components/charts/LineChart";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { DailyLogKey } from "@/lib/ui/colors";

type MetricCardProps = {
  /** Per-metric color from METRIC_COLOR. Tints the icon chip and chart line. */
  color: string;
  /** Glyph or emoji rendered inside the icon chip. */
  icon: ReactNode;
  label: string;
  value: number | string | null;
  unit?: string;
  /** Numeric delta vs prior; sign drives color. */
  delta?: number | null;
  deltaUnit?: string;
  /** Reverse semantic — for resting HR, lower is better. Affects delta color. */
  inverted?: boolean;
  /** Compact card variant (16px radius, tighter). */
  compact?: boolean;
  /** Optional sparkline. Renders a `mini` LineChart below value. When present
   *  AND a hover is active, the header value is overridden with the hovered
   *  point's value (and the delta slot shows the hovered date instead). */
  trend?: LinePoint[];
  /** Optional href — wraps in a Link with chevron affordance. */
  href?: string;
  /** Optional — drives sparkline interpolation lookup. */
  metricKey?: DailyLogKey;
};

export function MetricCard({
  color,
  icon,
  label,
  value,
  unit,
  delta,
  deltaUnit,
  inverted,
  compact,
  trend,
  href,
  metricKey,
}: MetricCardProps) {
  // Hover swap-in: when the user is dragging across the trend, surface the
  // hovered point's value and date in the header. Falls back to the normal
  // value + delta when not hovering.
  const [hover, setHover] = useState<LinePoint | null>(null);
  const isHovering = hover !== null && hover.y !== null;

  const goodWhenPositive = !inverted;
  const deltaColor =
    delta == null
      ? COLOR.textFaint
      : delta === 0
      ? COLOR.textFaint
      : (delta > 0) === goodWhenPositive
      ? COLOR.success
      : COLOR.danger;

  const displayValue: number | string | null = isHovering ? hover!.y : value;
  const valueDisplay =
    displayValue == null
      ? "—"
      : typeof displayValue === "number"
      ? fmtNum(displayValue)
      : displayValue;

  const inner = (
    <Card variant={compact ? "compact" : "standard"}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <div
            style={{
              width: compact ? "24px" : "28px",
              height: compact ? "24px" : "28px",
              borderRadius: compact ? "7px" : "8px",
              background: hexToBgChip(color),
              color,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: compact ? "12px" : "14px",
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            {icon}
          </div>
          <span
            style={{
              fontSize: compact ? "12px" : "11px",
              fontWeight: 600,
              color: COLOR.textMid,
              letterSpacing: "0.02em",
            }}
          >
            {label}
          </span>
        </div>
        {isHovering && hover!.x ? (
          <span
            data-tnum
            style={{
              fontSize: "11px",
              fontWeight: 600,
              color: COLOR.textFaint,
              letterSpacing: "0.02em",
            }}
          >
            {formatHoverDate(hover!.x)}
          </span>
        ) : delta != null ? (
          <span
            data-tnum
            style={{
              fontSize: "11px",
              fontWeight: 700,
              color: deltaColor,
            }}
          >
            {delta > 0 ? "+" : ""}
            {fmtNum(delta)}
            {deltaUnit ? ` ${deltaUnit}` : ""}
          </span>
        ) : null}
      </div>

      <div
        data-tnum
        style={{
          fontSize: compact ? "20px" : "24px",
          fontWeight: 800,
          letterSpacing: "-0.02em",
          marginTop: "4px",
          color: COLOR.textStrong,
        }}
      >
        {valueDisplay}
        {unit ? (
          <span
            style={{
              fontSize: "11px",
              fontWeight: 500,
              color: COLOR.textFaint,
              marginLeft: "4px",
            }}
          >
            {unit}
          </span>
        ) : null}
      </div>

      {trend && trend.length > 0 && (
        <div style={{ marginTop: "6px" }}>
          <LineChart
            data={trend}
            color={color}
            variant="mini"
            metricKey={metricKey}
            onHoverChange={setHover}
          />
        </div>
      )}
    </Card>
  );

  if (href) {
    return (
      <Link href={href} style={{ display: "block", textDecoration: "none", color: "inherit" }}>
        {inner}
      </Link>
    );
  }
  return inner;
}

/**
 * Lighten a #rrggbb to a soft chip background. Linearly mixes 18% color into
 * white. Ad-hoc but keeps the chip in the same hue family as the icon.
 */
function hexToBgChip(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return "#f5f6fa";
  const [r, g, b] = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  const blend = 0.82; // 82% white, 18% color
  const mix = (v: number) => Math.round(v * (1 - blend) + 255 * blend);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

/** ISO date → "May 4". Returns the input as-is if not a parseable ISO date. */
function formatHoverDate(x: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(x)) return x;
  const [y, m, d] = x.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
