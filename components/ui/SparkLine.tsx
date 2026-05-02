"use client";

import { useState } from "react";

type SparkLineProps = {
  values: (number | null)[];
  color: string;
  height?: number;
  chartId: string;
  /** Optional labels parallel to values — shown in the tap/hover tooltip. */
  labels?: string[];
  /** Unit shown in the tooltip (e.g. "kg", "kcal"). */
  unit?: string;
  /** Format the tooltip number. */
  valueFormat?: (v: number) => string;
};

function defaultFormat(v: number): string {
  if (Math.abs(v) >= 100 || Number.isInteger(v)) return Math.round(v).toLocaleString();
  return v.toFixed(1);
}

/** Filled-area sparkline with a dot at the latest point. Skips render if <2 points.
 *  When `labels` are passed, the chart becomes interactive — tap or hover to see
 *  the value and label for each point. */
export function SparkLine({
  values,
  color,
  height = 44,
  chartId,
  labels,
  unit = "",
  valueFormat,
}: SparkLineProps) {
  const [active, setActive] = useState<number | null>(null);

  const nums = values.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0));
  const present = nums.filter((_, i) => values[i] !== null && values[i] !== undefined);
  if (present.length < 2) return null;
  const mx = Math.max(...nums);
  const mn = Math.min(...nums);
  const rng = mx - mn || 1;
  const w = 100;
  const toX = (i: number) => (i / Math.max(nums.length - 1, 1)) * w;
  const toY = (v: number) => height - ((v - mn) / rng) * (height - 6) - 3;
  const pts = nums.map((v, i) => `${toX(i)},${toY(v)}`).join(" ");
  const gid = `g${chartId}`;
  const lastIdx = nums.length - 1;
  const lastX = toX(lastIdx);
  const lastY = toY(nums[lastIdx]);

  const fmt = valueFormat ?? defaultFormat;
  const activeRaw = active != null ? values[active] : null;
  const activeLabel = active != null && labels ? labels[active] : null;
  const hitW = w / nums.length;

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <svg
        width="100%"
        viewBox={`0 0 ${w} ${height}`}
        preserveAspectRatio="none"
        style={{ overflow: "visible", display: "block", height }}
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.25" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={`0,${height} ${pts} ${w},${height}`} fill={`url(#${gid})`} />
        <polyline
          points={pts}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx={lastX} cy={lastY} r="2.5" fill={color} />

        {active !== null && values[active] !== null && (
          <>
            <line
              x1={toX(active)}
              y1={0}
              x2={toX(active)}
              y2={height}
              stroke={color}
              strokeWidth="0.4"
              opacity="0.4"
            />
            <circle cx={toX(active)} cy={toY(nums[active])} r="2.8" fill={color} />
          </>
        )}

        {/* Invisible tap targets — only when interactivity is enabled (labels present). */}
        {labels &&
          values.map((_, i) => (
            <rect
              key={`hit-${i}`}
              x={i * hitW - hitW / 2}
              y={0}
              width={hitW}
              height={height}
              fill="transparent"
              style={{ cursor: "pointer" }}
              onPointerEnter={() => setActive(i)}
              onPointerLeave={() => setActive((cur) => (cur === i ? null : cur))}
              onClick={() => setActive((cur) => (cur === i ? null : i))}
            />
          ))}
      </svg>

      {active !== null && activeRaw !== null && activeRaw !== undefined && (
        <div
          className="pointer-events-none absolute z-10"
          style={{
            left: `${(active / Math.max(values.length - 1, 1)) * 100}%`,
            top: -28,
            transform: "translateX(-50%)",
          }}
        >
          <div
            className="rounded-md px-2 py-1 text-[10px] font-mono whitespace-nowrap"
            style={{
              background: "rgba(13, 22, 40, 0.95)",
              border: `1px solid ${color}55`,
              color: "white",
              boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
            }}
          >
            {activeLabel && (
              <span className="text-white/50 mr-1.5">{activeLabel}</span>
            )}
            <span style={{ color }}>
              {fmt(activeRaw)}
              {unit && <span className="text-white/40 ml-0.5">{unit}</span>}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
