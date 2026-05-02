"use client";

import { useState } from "react";

type Props = {
  data: (number | null)[];
  /** Optional ISO dates parallel to data — enables tooltip on tap/hover. */
  dates?: string[];
  color?: string;
  height?: number;
  refLine?: number | null;
  refLabel?: string;
  showDots?: boolean;
  /** Unit shown in the tooltip (e.g. "ms", "bpm"). */
  unit?: string;
  /** Format the tooltip number. */
  valueFormat?: (v: number) => string;
};

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDateShort(iso: string): string {
  const [, m, d] = iso.split("-");
  if (!m || !d) return iso;
  const monthIdx = parseInt(m, 10) - 1;
  return `${parseInt(d, 10)} ${MONTHS_SHORT[monthIdx] ?? m}`;
}

function defaultFormat(v: number): string {
  if (Math.abs(v) >= 100 || Number.isInteger(v)) return Math.round(v).toLocaleString();
  return v.toFixed(1);
}

/** SVG line chart with gradient fill, optional reference line, and a
 *  tap/hover tooltip when `dates` are provided. */
export function LineChart({
  data,
  dates,
  color = "#00f5c4",
  height = 60,
  refLine = null,
  refLabel = "",
  showDots = true,
  unit = "",
  valueFormat,
}: Props) {
  const [active, setActive] = useState<number | null>(null);

  const pts = data.filter((d): d is number => d !== null && Number.isFinite(d));
  if (pts.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-xs text-white/15"
        style={{ height }}
      >
        Not enough data
      </div>
    );
  }
  const min = Math.min(...pts) * 0.95;
  const max = Math.max(...pts) * 1.05;
  const range = max - min || 1;
  const W = 100;
  const step = W / (data.length - 1);
  const toY = (v: number) => height - ((v - min) / range) * height * 0.85 - height * 0.075;
  const toX = (i: number) => i * step;

  const pathParts: string[] = [];
  data.forEach((v, i) => {
    if (v === null) return;
    const x = toX(i);
    const y = toY(v);
    const prevAllNull = i === 0 || data.slice(0, i).every((d) => d === null);
    pathParts.push(`${prevAllNull ? "M" : "L"} ${x} ${y}`);
  });
  const pathD = pathParts.join(" ");

  const firstI = data.findIndex((v) => v !== null);
  const lastI = data.length - 1 - [...data].reverse().findIndex((v) => v !== null);
  const fillD =
    firstI >= 0 ? `${pathParts.join(" ")} L ${toX(lastI)} ${height} L ${toX(firstI)} ${height} Z` : "";
  const refY = refLine !== null && refLine !== undefined ? toY(refLine) : null;
  const gid = `grad-${color.replace("#", "")}`;

  const fmt = valueFormat ?? defaultFormat;
  const activeValue = active != null ? data[active] : null;
  const activeDate = active != null && dates ? dates[active] : null;
  // Width of each invisible hit slot (full width / number of data points).
  const hitW = W / data.length;

  return (
    <div style={{ position: "relative", width: "100%", height }}>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height, overflow: "visible", display: "block" }}
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.25" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {fillD && <path d={fillD} fill={`url(#${gid})`} />}
        {refY !== null && (
          <line
            x1="0"
            y1={refY}
            x2={W}
            y2={refY}
            stroke={color}
            strokeWidth="0.5"
            strokeDasharray="2,2"
            opacity="0.4"
          />
        )}
        <path
          d={pathD}
          stroke={color}
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {showDots &&
          data.map((v, i) =>
            v !== null ? (
              <circle
                key={i}
                cx={toX(i)}
                cy={toY(v)}
                r={active === i ? 2.6 : 1.8}
                fill={color}
                opacity={active === null || active === i ? 0.95 : 0.5}
              />
            ) : null,
          )}

        {/* Vertical guide on the active slot */}
        {active !== null && data[active] !== null && (
          <line
            x1={toX(active)}
            y1={0}
            x2={toX(active)}
            y2={height}
            stroke={color}
            strokeWidth="0.4"
            opacity="0.4"
          />
        )}

        {/* Invisible tap targets — full slot width, full chart height */}
        {data.map((_, i) => (
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
      {refY !== null && refLabel && (
        <span
          style={{
            position: "absolute",
            left: 4,
            top: Math.max(0, refY - 12),
            fontSize: 10,
            lineHeight: 1,
            color,
            opacity: 0.6,
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          {refLabel}
        </span>
      )}

      {/* Tooltip overlay */}
      {active !== null && activeValue !== null && (
        <div
          className="pointer-events-none absolute z-10"
          style={{
            left: `${(active / Math.max(data.length - 1, 1)) * 100}%`,
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
