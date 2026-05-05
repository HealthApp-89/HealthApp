"use client";

import { useId, useMemo, useState } from "react";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";

export type LinePoint = {
  /** X-axis label (date string, e.g. "2026-04-25"). Optional for `mini`. */
  x?: string;
  /** Numeric value. `null` = no data (gap rendered as a thin dot). */
  y: number | null;
};

type LineChartProps = {
  data: LinePoint[];
  color: string;
  /** `mini` for compact metric cards; `detail` for /trends/[metric]. */
  variant?: "mini" | "detail";
  /** Override SVG width. Defaults to fluid (100% via viewBox). */
  width?: number;
  /** SVG height in px. Defaults: mini 80, detail 140. */
  height?: number;
  /** Show 4 date x-axis labels under detail charts. */
  xAxisLabels?: [string, string, string, string];
};

/**
 * Smooth cubic-Bézier line chart with gradient area fill.
 * Smoothing uses horizontal-control approximation (a.k.a. "monotone-x"):
 * for each segment from P0 to P1, control points sit half-way along x at
 * the y of P0 and P1 respectively. Cheap, looks like proper monotone.
 */
export function LineChart({
  data,
  color,
  variant = "mini",
  width = 280,
  height,
  xAxisLabels,
}: LineChartProps) {
  const h = height ?? (variant === "mini" ? 80 : 140);
  const w = width;
  const pad = variant === "mini" ? 6 : 10;
  const gradId = useId();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const { linePath, areaPath, points, valMin, valMax } = useMemo(() => {
    const present = data.filter((d): d is LinePoint & { y: number } => d.y !== null);
    if (present.length === 0) {
      return { linePath: "", areaPath: "", points: [], valMin: 0, valMax: 1 };
    }
    const ys = present.map((d) => d.y);
    const valMin = Math.min(...ys);
    const valMax = Math.max(...ys);
    const range = valMax - valMin || 1;

    const usableW = w;
    const usableH = h - pad * 2;
    const dx = data.length > 1 ? usableW / (data.length - 1) : 0;

    const points: { x: number; y: number; raw: number | null }[] = data.map((d, i) => {
      const x = i * dx;
      const y =
        d.y === null
          ? h / 2 // skipped during path build
          : pad + (1 - (d.y - valMin) / range) * usableH;
      return { x, y, raw: d.y };
    });

    // Build cubic-Bezier path skipping null gaps.
    let line = "";
    let area = "";
    let started = false;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.raw === null) {
        started = false;
        continue;
      }
      if (!started) {
        line += `M ${p.x} ${p.y}`;
        area += `M ${p.x} ${p.y}`;
        started = true;
        continue;
      }
      const prev = points[i - 1];
      // horizontal-control bezier
      const cx = (p.x - prev.x) / 2;
      line += ` C ${prev.x + cx} ${prev.y} ${p.x - cx} ${p.y} ${p.x} ${p.y}`;
      area += ` C ${prev.x + cx} ${prev.y} ${p.x - cx} ${p.y} ${p.x} ${p.y}`;
    }
    if (started) {
      const last = [...points].reverse().find((p) => p.raw !== null);
      if (last) {
        const first = points.find((p) => p.raw !== null)!;
        area += ` L ${last.x} ${h} L ${first.x} ${h} Z`;
      }
    }

    return { linePath: line, areaPath: area, points, valMin, valMax };
  }, [data, h, w, pad]);

  const lastPoint = useMemo(() => {
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].raw !== null) return points[i];
    }
    return null;
  }, [points]);

  if (linePath === "") {
    return (
      <div
        style={{
          width: "100%",
          height: h,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: COLOR.textFaint,
          fontSize: "11px",
          fontWeight: 500,
        }}
      >
        No data
      </div>
    );
  }

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * w;
    let nearest = -1;
    let nearestDist = Infinity;
    for (let i = 0; i < points.length; i++) {
      if (points[i].raw === null) continue;
      const d = Math.abs(points[i].x - x);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = i;
      }
    }
    setHoverIndex(nearest >= 0 ? nearest : null);
  };

  const hover = hoverIndex !== null ? points[hoverIndex] : null;

  return (
    <div style={{ width: "100%" }}>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        width="100%"
        height={h}
        style={{ display: "block", touchAction: "none" }}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHoverIndex(null)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={variant === "detail" ? 0.28 : 0.22} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>

        {variant === "detail" && (
          <>
            <line x1="0" y1={h * 0.25} x2={w} y2={h * 0.25} stroke={COLOR.divider} strokeDasharray="2,3" strokeWidth="1" />
            <line x1="0" y1={h * 0.5} x2={w} y2={h * 0.5} stroke={COLOR.divider} strokeDasharray="2,3" strokeWidth="1" />
            <line x1="0" y1={h * 0.75} x2={w} y2={h * 0.75} stroke={COLOR.divider} strokeDasharray="2,3" strokeWidth="1" />
          </>
        )}

        <path d={areaPath} fill={`url(#${gradId})`} />
        <path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth={variant === "detail" ? 2.5 : 2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {lastPoint && (
          <circle
            cx={lastPoint.x}
            cy={lastPoint.y}
            r={variant === "detail" ? 4 : 3}
            fill="#fff"
            stroke={color}
            strokeWidth={2.5}
          />
        )}

        {hover && hover.raw !== null && (
          <>
            <line
              x1={hover.x}
              y1="0"
              x2={hover.x}
              y2={h}
              stroke={COLOR.textStrong}
              strokeOpacity={0.18}
              strokeDasharray="3,3"
              strokeWidth="1"
            />
            <circle cx={hover.x} cy={hover.y} r={5} fill="#fff" stroke={color} strokeWidth={2.5} />
            <g transform={`translate(${Math.min(Math.max(hover.x - 46, 4), w - 96)}, 4)`}>
              <rect width="92" height="34" rx="8" fill={COLOR.textStrong} />
              <text x="46" y="14" textAnchor="middle" fontSize="9" fill={COLOR.textFaint} fontWeight="600">
                {data[hoverIndex!].x ?? ""}
              </text>
              <text x="46" y="27" textAnchor="middle" fontSize="13" fill="#fff" fontWeight="700">
                {fmtNum(hover.raw)}
              </text>
            </g>
          </>
        )}
      </svg>

      {variant === "detail" && xAxisLabels && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "6px 2px 2px",
            fontSize: "10px",
            color: COLOR.textFaint,
            fontWeight: 500,
          }}
        >
          {xAxisLabels.map((l, i) => (
            <span key={i}>{l}</span>
          ))}
        </div>
      )}
    </div>
  );
}
