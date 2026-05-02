"use client";

import { useState } from "react";

type Props = {
  data: (number | null)[];
  /** Optional ISO dates (YYYY-MM-DD) parallel to data — enables x-axis labels + tooltip. */
  dates?: string[];
  color?: string;
  height?: number;
  goalLine?: number | null;
  colorFn?: (v: number) => string;
  /** Unit shown in the tooltip (e.g. "kg", "kcal", "/21"). */
  unit?: string;
  /** Format the tooltip number (default: round to 1 decimal, locale-grouped if integer-ish). */
  valueFormat?: (v: number) => string;
};

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDateShort(iso: string): string {
  // "2026-04-30" → "30 Apr"
  const [, m, d] = iso.split("-");
  if (!m || !d) return iso;
  const monthIdx = parseInt(m, 10) - 1;
  return `${parseInt(d, 10)} ${MONTHS_SHORT[monthIdx] ?? m}`;
}

function defaultFormat(v: number): string {
  if (Math.abs(v) >= 100 || Number.isInteger(v)) return Math.round(v).toLocaleString();
  return v.toFixed(1);
}

export function BarChart({
  data,
  dates,
  color = "#00f5c4",
  height = 60,
  goalLine = null,
  colorFn,
  unit = "",
  valueFormat,
}: Props) {
  const [active, setActive] = useState<number | null>(null);

  const pts = data.filter((d): d is number => d !== null && d > 0);
  if (!pts.length) {
    return (
      <div className="flex items-center justify-center text-xs text-white/15" style={{ height }}>
        No data
      </div>
    );
  }

  const max = Math.max(...pts, goalLine ?? 0) * 1.1;
  const W = 100;
  const bw = (W / data.length) * 0.6;
  const gap = W / data.length;
  // Width for invisible touch targets (full slot — easier tap on mobile).
  const hitW = gap;

  const fmt = valueFormat ?? defaultFormat;

  // Sparse axis labels: first, middle, last (only if dates provided and ≥3 points).
  const labelIdx: number[] = [];
  if (dates && dates.length >= 3) {
    labelIdx.push(0, Math.floor(data.length / 2), data.length - 1);
  } else if (dates && dates.length >= 1) {
    labelIdx.push(data.length - 1);
  }

  const activeDate = active != null && dates ? dates[active] : null;
  const activeValue = active != null ? data[active] : null;

  return (
    <div className="relative" style={{ width: "100%" }}>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height, overflow: "visible", display: "block" }}
      >
        {goalLine && (
          <line
            x1="0"
            y1={height - (goalLine / max) * height * 0.9}
            x2={W}
            y2={height - (goalLine / max) * height * 0.9}
            stroke="#fbbf24"
            strokeWidth="0.5"
            strokeDasharray="2,2"
            opacity="0.6"
          />
        )}

        {/* Visible bars */}
        {data.map((v, i) => {
          if (!v) return null;
          const bh = (v / max) * height * 0.9;
          const x = i * gap + (gap - bw) / 2;
          const c = colorFn ? colorFn(v) : color;
          const isActive = active === i;
          return (
            <rect
              key={`b-${i}`}
              x={x}
              y={height - bh}
              width={bw}
              height={bh}
              rx="1"
              fill={c}
              opacity={active === null || isActive ? 0.85 : 0.4}
            />
          );
        })}

        {/* Invisible tap targets — full slot width, full chart height */}
        {data.map((_, i) => (
          <rect
            key={`hit-${i}`}
            x={i * gap}
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

      {/* X-axis date labels */}
      {dates && labelIdx.length > 0 && (
        <div className="relative mt-1 text-[9px] text-white/30 font-mono select-none" style={{ height: 12 }}>
          {labelIdx.map((i) => {
            const pct = ((i + 0.5) / data.length) * 100;
            const align =
              i === 0 ? "left" : i === data.length - 1 ? "right" : "center";
            const transform =
              align === "left" ? "translateX(0)" : align === "right" ? "translateX(-100%)" : "translateX(-50%)";
            return (
              <span
                key={`lbl-${i}`}
                style={{
                  position: "absolute",
                  left: `${pct}%`,
                  top: 0,
                  transform,
                  whiteSpace: "nowrap",
                }}
              >
                {formatDateShort(dates[i])}
              </span>
            );
          })}
        </div>
      )}

      {/* Tooltip overlay */}
      {active !== null && activeValue !== null && (
        <div
          className="pointer-events-none absolute z-10"
          style={{
            left: `${((active + 0.5) / data.length) * 100}%`,
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
            {activeDate && (
              <span className="text-white/50 mr-1.5">{formatDateShort(activeDate)}</span>
            )}
            <span style={{ color }}>
              {fmt(activeValue)}
              {unit && <span className="text-white/40 ml-0.5">{unit}</span>}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
