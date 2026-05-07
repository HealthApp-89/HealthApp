"use client";

import { useId, useMemo, useRef, useState } from "react";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import { interpolateGaps } from "@/lib/charts/interpolate";
import { getInterpolateConfig } from "@/lib/charts/metricChartConfig";

export type LinePoint = {
  /** X-axis label (date string, e.g. "2026-04-25"). Optional for `mini`. */
  x?: string;
  /** Numeric value. `null` = no data (gap rendered as a thin dot). */
  y: number | null;
  /** Set by `interpolateGaps` — renderer treats these as dashed/hollow. */
  estimated?: boolean;
};

type LineChartProps = {
  data: LinePoint[];
  color: string;
  /** `mini` for compact metric cards; `detail` for /trends/[metric]. */
  variant?: "mini" | "detail";
  /** Override SVG width. Defaults to fluid (100% via viewBox). */
  width?: number;
  /** SVG height in px. Defaults: mini 80, detail 160. */
  height?: number;
  /** Show 4 date x-axis labels under detail charts. */
  xAxisLabels?: [string, string, string, string];
  /** Optional metric key — drives interpolation lookup in metricChartConfig. */
  metricKey?: string;
  /** Detail-only: comparison series (same length & x-alignment as `data`). */
  comparison?: LinePoint[] | null;
  /** Detail-only: render y-axis labels in a 24px left gutter. Default true. */
  yAxisLabels?: boolean;
  /** Detail-only: render filled markers on every real value. Default true. */
  pointMarkers?: boolean;
  /** Fires whenever the user hovers a point (or leaves with `null`). Lets the
   *  parent (e.g. MetricCard) display the hovered value in its own header. */
  onHoverChange?: (point: LinePoint | null) => void;
};

/**
 * Smooth cubic-Bézier line chart with gradient area fill.
 *
 * Smoothing uses horizontal-control approximation (a.k.a. "monotone-x"):
 * for each segment from P0 to P1, control points sit half-way along x at
 * the y of P0 and P1 respectively. Cheap, looks like proper monotone.
 *
 * Y-axis is padded by 12% of the data range so an extreme value never
 * slams into the top/bottom edges.
 *
 * The tooltip + y-axis labels live outside the SVG as HTML overlays so
 * their text isn't horizontally stretched by `preserveAspectRatio="none"`.
 */
export function LineChart({
  data: rawData,
  color,
  variant = "mini",
  width = 280,
  height,
  xAxisLabels,
  metricKey,
  comparison: rawComparison = null,
  yAxisLabels = true,
  pointMarkers = true,
  onHoverChange,
}: LineChartProps) {
  const isDetail = variant === "detail";
  const h = height ?? (isDetail ? 160 : 80);
  const w = width;
  const pad = isDetail ? 12 : 8;
  const gridGutter = isDetail && yAxisLabels ? 24 : 0; // px reserved on the LEFT for y-axis labels
  const gradId = useId();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Pre-pass: interpolate gaps where the metric config allows.
  const data = useMemo(() => {
    const cfg = getInterpolateConfig(metricKey);
    return interpolateGaps(rawData, cfg);
  }, [rawData, metricKey]);

  // Comparison line is detail-only and never interpolated (per spec §2).
  const comparison = isDetail ? rawComparison : null;

  const { plot, points, comparisonPoints, valMin, valMax } = useMemo(() => {
    const allYs: number[] = [];
    for (const d of data) if (d.y !== null) allYs.push(d.y);
    if (comparison) for (const d of comparison) if (d.y !== null) allYs.push(d.y);
    if (allYs.length === 0) {
      return { plot: null, points: [], comparisonPoints: [], valMin: 0, valMax: 0 };
    }
    const dataMin = Math.min(...allYs);
    const dataMax = Math.max(...allYs);
    const dataRange = dataMax - dataMin || 1;
    const yPad = dataRange * 0.12;
    const valMin = dataMin - yPad;
    const valMax = dataMax + yPad;
    const range = valMax - valMin;

    const usableW = w - gridGutter;
    const usableH = h - pad * 2;
    const dx = data.length > 1 ? usableW / (data.length - 1) : 0;

    const project = (d: LinePoint, i: number) => {
      const x = gridGutter + i * dx;
      const y =
        d.y === null
          ? h / 2
          : pad + (1 - (d.y - valMin) / range) * usableH;
      return { x, y, raw: d.y, estimated: !!d.estimated };
    };

    const points = data.map(project);
    const comparisonPoints = comparison ? comparison.map(project) : [];

    return { plot: { dx, usableW, usableH }, points, comparisonPoints, valMin, valMax };
  }, [data, comparison, w, h, pad, gridGutter]);

  // Build paths. We split the primary line into "real-only" and
  // "estimated-touching" segments so estimated stretches render dashed
  // while real-data stretches render solid.
  //
  // Critical: the area path must close EACH contiguous segment at its own
  // first/last x. A naive `M-after-gap` opens an unclosed subpath that SVG
  // fills via implicit closure (a phantom diagonal back to that subpath's
  // start), which produced the diagonal artifacts we used to see across
  // every chart with internal null gaps.
  const { realPath, estPath, areaPath } = useMemo(() => {
    if (!plot || points.length === 0) return { realPath: "", estPath: "", areaPath: "" };

    let real = "";
    let est = "";
    let area = "";
    let realStarted = false;
    let estStarted = false;
    // Track the open area segment's first/last x so we can close it explicitly
    // before starting a new one (or at the end of iteration).
    let segFirstX: number | null = null;
    let segLastX: number | null = null;
    const closeSegment = () => {
      if (segFirstX !== null && segLastX !== null) {
        area += ` L ${segLastX} ${h} L ${segFirstX} ${h} Z`;
      }
      segFirstX = null;
      segLastX = null;
    };

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.raw === null) {
        realStarted = false;
        estStarted = false;
        // Close the in-flight area segment so the gap doesn't bleed the fill
        // through implicit closure.
        closeSegment();
        continue;
      }
      const prev = points[i - 1];
      if (segFirstX === null) {
        // Start a fresh segment.
        area += `${area ? " " : ""}M ${p.x} ${p.y}`;
        segFirstX = p.x;
      } else if (prev && prev.raw !== null) {
        const cx = (p.x - prev.x) / 2;
        area += ` C ${prev.x + cx} ${prev.y} ${p.x - cx} ${p.y} ${p.x} ${p.y}`;
      }
      segLastX = p.x;

      const segIsEstimated = p.estimated || (prev && prev.raw !== null && prev.estimated);

      if (segIsEstimated) {
        // estimated segment goes onto the dashed est path
        if (!estStarted) {
          est += `M ${prev?.raw !== null && prev ? prev.x : p.x} ${prev?.raw !== null && prev ? prev.y : p.y}`;
          estStarted = true;
        }
        if (prev && prev.raw !== null) {
          const cx = (p.x - prev.x) / 2;
          est += ` C ${prev.x + cx} ${prev.y} ${p.x - cx} ${p.y} ${p.x} ${p.y}`;
        }
        realStarted = false;
      } else {
        // solid real-data segment
        if (!realStarted) {
          real += `M ${p.x} ${p.y}`;
          realStarted = true;
        } else if (prev && prev.raw !== null) {
          const cx = (p.x - prev.x) / 2;
          real += ` C ${prev.x + cx} ${prev.y} ${p.x - cx} ${p.y} ${p.x} ${p.y}`;
        }
        estStarted = false;
      }
    }
    // Close the final segment if iteration ended mid-segment.
    closeSegment();
    return { realPath: real, estPath: est, areaPath: area };
  }, [plot, points, h]);

  // Comparison line path — solid bezier through non-null points only.
  const comparisonPath = useMemo(() => {
    if (!plot || comparisonPoints.length === 0) return "";
    let out = "";
    let started = false;
    for (let i = 0; i < comparisonPoints.length; i++) {
      const p = comparisonPoints[i];
      if (p.raw === null) {
        started = false;
        continue;
      }
      if (!started) {
        out += `M ${p.x} ${p.y}`;
        started = true;
        continue;
      }
      const prev = comparisonPoints[i - 1];
      if (prev.raw === null) {
        out += ` M ${p.x} ${p.y}`;
        continue;
      }
      const cx = (p.x - prev.x) / 2;
      out += ` C ${prev.x + cx} ${prev.y} ${p.x - cx} ${p.y} ${p.x} ${p.y}`;
    }
    return out;
  }, [plot, comparisonPoints]);

  const lastRealPoint = useMemo(() => {
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].raw !== null && !points[i].estimated) return points[i];
    }
    // fallback to last non-null even if estimated
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].raw !== null) return points[i];
    }
    return null;
  }, [points]);

  // Y-axis label values: 4 evenly-spaced ticks across the padded range.
  const yTickLabels = useMemo(() => {
    if (!isDetail || !yAxisLabels || !plot) return [];
    const r = valMax - valMin;
    return [valMax, valMax - r / 3, valMax - (2 * r) / 3, valMin].map(fmtNum);
  }, [isDetail, yAxisLabels, plot, valMin, valMax]);

  if (!plot || points.every((p) => p.raw === null)) {
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
    const xInSvgUnits = ((e.clientX - rect.left) / rect.width) * w;
    let nearest = -1;
    let nearestDist = Infinity;
    for (let i = 0; i < points.length; i++) {
      if (points[i].raw === null) continue;
      const d = Math.abs(points[i].x - xInSvgUnits);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = i;
      }
    }
    const next = nearest >= 0 ? nearest : null;
    if (next !== hoverIndex) {
      setHoverIndex(next);
      onHoverChange?.(next === null ? null : data[next]);
    }
  };

  const onPointerLeave = () => {
    if (hoverIndex !== null) {
      setHoverIndex(null);
      onHoverChange?.(null);
    }
  };

  const hover = hoverIndex !== null ? points[hoverIndex] : null;
  const hoverComparison =
    comparison && hoverIndex !== null ? comparisonPoints[hoverIndex] : null;
  const hoverDate = hoverIndex !== null ? data[hoverIndex].x : undefined;
  const hoverIsEstimated = hover && hover.estimated;

  // Tooltip CSS-pixel position relative to wrapper.
  const tooltipPos = hover
    ? {
        leftPct: (hover.x / w) * 100,
        topPx: (hover.y / h) * h,
      }
    : null;

  return (
    <div ref={wrapperRef} style={{ width: "100%", position: "relative" }}>
      {/* HTML y-axis labels overlay (detail only). 24px gutter on the left. */}
      {isDetail && yAxisLabels && yTickLabels.length === 4 && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 0,
            top: pad,
            bottom: pad,
            width: gridGutter,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            alignItems: "flex-end",
            paddingRight: 4,
            pointerEvents: "none",
          }}
        >
          {yTickLabels.map((lbl, i) => (
            <span
              key={i}
              style={{
                fontSize: "9px",
                fontWeight: 600,
                color: COLOR.textFaint,
                lineHeight: 1,
              }}
            >
              {lbl}
            </span>
          ))}
        </div>
      )}

      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        width="100%"
        height={h}
        style={{ display: "block", touchAction: "none", overflow: "visible" }}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={color} stopOpacity={isDetail ? 0.32 : 0.38} />
            <stop offset="60%"  stopColor={color} stopOpacity={isDetail ? 0.08 : 0.10} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>

        {/* Detail-only gridlines aligned with the 4 y-axis ticks. */}
        {isDetail && yAxisLabels && (
          <>
            {[0, 1 / 3, 2 / 3, 1].map((t, i) => {
              const y = pad + t * (h - pad * 2);
              return (
                <line
                  key={i}
                  x1={gridGutter}
                  y1={y}
                  x2={w}
                  y2={y}
                  stroke="#eef0f6"
                  strokeWidth="1"
                />
              );
            })}
          </>
        )}

        {/* Comparison line (detail-only, no fill, no markers). */}
        {comparisonPath && (
          <path
            d={comparisonPath}
            fill="none"
            stroke="#cdd1de"
            strokeWidth={2}
            strokeDasharray="4,3"
            strokeLinecap="round"
          />
        )}

        {/* Primary area fill */}
        <path d={areaPath} fill={`url(#${gradId})`} />

        {/* Solid (real) primary line */}
        <path
          d={realPath}
          fill="none"
          stroke={color}
          strokeWidth={isDetail ? 2.5 : 2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Dashed (estimated) primary line */}
        {estPath && (
          <path
            d={estPath}
            fill="none"
            stroke={color}
            strokeWidth={isDetail ? 2.5 : 2}
            strokeDasharray="4,4"
            strokeLinecap="round"
            opacity={0.85}
          />
        )}

        {/* Point markers (detail only).
            - Real value: solid filled colored dot (2.5px). Reads as an
              accent on the line, not a punched-out ring.
            - Estimated value: NO marker. The dashed segment alone
              signals interpolation; piling a hollow marker on top
              reads busy at this scale.
            - Last real value: emphasized "now" dot (white fill,
              colored stroke). Only outlined marker on the chart, so
              it stands out as the current reading. */}
        {isDetail && pointMarkers &&
          points.map((p, i) => {
            if (p.raw === null || p.estimated) return null;
            const isLast = lastRealPoint != null && p === lastRealPoint;
            if (isLast) {
              return (
                <circle
                  key={i}
                  cx={p.x}
                  cy={p.y}
                  r={5}
                  fill="#fff"
                  stroke={color}
                  strokeWidth={2.75}
                />
              );
            }
            return (
              <circle
                key={i}
                cx={p.x}
                cy={p.y}
                r={2.5}
                fill={color}
              />
            );
          })}

        {/* Mini variant: just the last real point dot. */}
        {!isDetail && lastRealPoint && (
          <circle
            cx={lastRealPoint.x}
            cy={lastRealPoint.y}
            r={3}
            fill="#fff"
            stroke={color}
            strokeWidth={2.5}
          />
        )}

        {/* Hover guide */}
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
            <circle cx={hover.x} cy={hover.y} r={4} fill="#fff" stroke={color} strokeWidth={2.5} />
          </>
        )}
      </svg>

      {/* HTML tooltip overlay */}
      {hover && hover.raw !== null && tooltipPos && (
        <div
          style={{
            position: "absolute",
            left: `${tooltipPos.leftPct}%`,
            top: 0,
            transform: "translate(-50%, -100%)",
            marginTop: "-4px",
            background: COLOR.textStrong,
            color: "#fff",
            padding: "5px 9px",
            borderRadius: "8px",
            fontSize: "11px",
            fontWeight: 700,
            lineHeight: 1.25,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            boxShadow: "0 4px 10px rgba(20,30,80,0.18)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "1px",
            zIndex: 5,
          }}
        >
          {hoverDate && (
            <span style={{ fontSize: "9px", fontWeight: 600, color: COLOR.textFaint }}>
              {hoverDate}
            </span>
          )}
          <span data-tnum>
            {fmtNum(hover.raw)}
            {hoverIsEstimated && (
              <span style={{ marginLeft: 4, color: COLOR.textFaint, fontWeight: 500 }}>
                (est.)
              </span>
            )}
          </span>
          {hoverComparison && hoverComparison.raw !== null && (
            <span data-tnum style={{ fontSize: "10px", color: COLOR.textFaint, fontWeight: 500 }}>
              {fmtNum(hoverComparison.raw)} <span style={{ fontWeight: 400 }}>(prev)</span>
            </span>
          )}
        </div>
      )}

      {variant === "detail" && xAxisLabels && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "6px 2px 2px",
            paddingLeft: gridGutter + 2,
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
