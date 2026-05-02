"use client";

import { useState } from "react";
import type { ImpactSegment } from "@/lib/coach/impact";
import { scoreColor, scoreLabel } from "@/lib/ui/colors";
import { fmtNum } from "@/lib/ui/score";

type Props = {
  segments: ImpactSegment[];
  /** Composite readiness score 0-100 (or null if today has no data). */
  score: number | null;
  /** Outer SVG dimension in CSS pixels. Default 260. */
  size?: number;
};

const TAU = Math.PI * 2;

/** Per-metric ring chart for the V3 dashboard. Each segment is one slice;
 *  positive segments use the metric's vivid color + a glow, negative segments
 *  go red and dashed, neutral segments are dim grey. Magnitude (0..1) drives
 *  stroke opacity so a strong positive shows brighter than a weak one.
 *
 *  Tap a slice or a legend chip to focus that metric — its label, raw value
 *  and reason are surfaced in a detail panel above the legend. */
export function ImpactDonut({ segments, score, size = 260 }: Props) {
  // `selected` (click) drives the focus panel — separate from `hovered` so
  // the layout doesn't shift when the cursor moves over the donut.
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const active = hovered ?? selected;

  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 18;
  const gap = 0.04;

  const sliceArc = TAU / segments.length;
  const start0 = -Math.PI / 2;

  const sc = scoreColor(score);
  const sl = scoreLabel(score);

  const positive = segments.filter((s) => s.sign === "positive");
  const negative = segments.filter((s) => s.sign === "negative");

  // Focus panel only follows `selected` (click). Hover changes the visible
  // highlight but never the panel — keeps the dashboard layout stable.
  const focused = selected ? segments.find((s) => s.key === selected) ?? null : null;
  const toggle = (key: string) =>
    setSelected((cur) => (cur === key ? null : key));

  const focusColor = focused
    ? focused.sign === "positive"
      ? focused.color
      : focused.sign === "negative"
        ? "#ff453a"
        : "rgba(255,255,255,0.55)"
    : null;

  return (
    <div className="flex flex-col items-center gap-3 w-full">
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          style={{ display: "block", overflow: "visible" }}
        >
          {segments.map((s, i) => {
            const a0 = start0 + i * sliceArc + gap / 2;
            const a1 = start0 + (i + 1) * sliceArc - gap / 2;
            // Round to 3dp so the SVG path string is byte-identical between
            // server render and client hydration (raw float→string differs).
            const f = (n: number) => n.toFixed(3);
            const x0 = cx + radius * Math.cos(a0);
            const y0 = cy + radius * Math.sin(a0);
            const x1 = cx + radius * Math.cos(a1);
            const y1 = cy + radius * Math.sin(a1);
            const large = a1 - a0 > Math.PI ? 1 : 0;
            const d = `M ${f(x0)} ${f(y0)} A ${f(radius)} ${f(radius)} 0 ${large} 1 ${f(x1)} ${f(y1)}`;

            const isPositive = s.sign === "positive";
            const isNegative = s.sign === "negative";
            const isActive = active === s.key;
            const baseStroke = isPositive ? 16 : isNegative ? 12 : 10;
            const strokeWidth = isActive ? baseStroke + 4 : baseStroke;
            const baseOpacity = s.sign === "neutral" ? 0.35 : 0.4 + s.magnitude * 0.6;
            const opacity = active === null
              ? baseOpacity
              : isActive
                ? Math.min(1, baseOpacity + 0.25)
                : baseOpacity * 0.45;

            return (
              <g
                key={s.key}
                style={{ cursor: "pointer" }}
                onPointerEnter={() => setHovered(s.key)}
                onPointerLeave={() =>
                  setHovered((cur) => (cur === s.key ? null : cur))
                }
                onClick={() => toggle(s.key)}
              >
                {/* Wide invisible hit path on top of the visible stroke */}
                <path
                  d={d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={Math.max(strokeWidth + 14, 22)}
                  strokeLinecap="round"
                />
                <path
                  d={d}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={strokeWidth}
                  strokeLinecap="round"
                  strokeDasharray={isNegative ? "6 4" : undefined}
                  opacity={opacity}
                  style={
                    isPositive
                      ? { filter: `drop-shadow(0 0 8px ${s.color}66)` }
                      : undefined
                  }
                />
              </g>
            );
          })}
        </svg>

        {/* Center: composite score + label + dot row */}
        <div
          className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none"
        >
          <div
            className="font-mono font-bold leading-none"
            style={{ fontSize: size * 0.22, color: sc }}
          >
            {score !== null ? Math.round(score) : "—"}
          </div>
          <div
            className="text-[10px] uppercase tracking-[0.12em] mt-1"
            style={{ color: score !== null ? sc : "rgba(255,255,255,0.3)" }}
          >
            {score !== null ? sl : "no data"}
          </div>
          <div className="flex items-center gap-1 mt-2">
            {Array.from({ length: positive.length }).map((_, i) => (
              <span
                key={`p${i}`}
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: "#30d158", boxShadow: "0 0 4px #30d158" }}
                aria-hidden
              />
            ))}
            {Array.from({ length: negative.length }).map((_, i) => (
              <span
                key={`n${i}`}
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: "#ff453a" }}
                aria-hidden
              />
            ))}
          </div>
        </div>
      </div>

      {/* Focused detail panel — visible when a slice or chip is active. */}
      {focused && focusColor && (
        <div
          className="rounded-[12px] px-3 py-2 w-full"
          style={{
            background: "rgba(255,255,255,0.04)",
            border: `1px solid ${
              focused.sign === "positive"
                ? `${focused.color}66`
                : focused.sign === "negative"
                  ? "rgba(255,69,58,0.5)"
                  : "rgba(255,255,255,0.1)"
            }`,
          }}
        >
          <div className="flex items-baseline justify-between gap-2">
            <div className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{
                  background: focused.color,
                  boxShadow:
                    focused.sign === "positive"
                      ? `0 0 6px ${focused.color}`
                      : "none",
                }}
                aria-hidden
              />
              <span className="text-[11px] uppercase tracking-[0.1em] text-white/70">
                {focused.label}
              </span>
              <span
                className="text-[9px] uppercase tracking-[0.08em]"
                style={{ color: focusColor }}
              >
                {focused.sign === "positive"
                  ? "helping"
                  : focused.sign === "negative"
                    ? "dragging"
                    : "neutral"}
              </span>
            </div>
            <span
              className="text-[16px] font-mono font-semibold"
              style={{ color: focusColor }}
            >
              {focused.value !== null ? fmtNum(focused.value) : "—"}
            </span>
          </div>
          <div className="text-[11px] text-white/60 mt-1">{focused.reason}</div>
        </div>
      )}

      {/* Legend — six metric chips, color-coded by sign, with raw value */}
      <div className="grid grid-cols-3 gap-1.5 w-full">
        {segments.map((s) => {
          const isActive = active === s.key;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => toggle(s.key)}
              onPointerEnter={() => setHovered(s.key)}
              onPointerLeave={() =>
                setHovered((cur) => (cur === s.key ? null : cur))
              }
              className="rounded-lg px-2 py-1.5 text-left transition-opacity"
              style={{
                background: isActive
                  ? "rgba(255,255,255,0.06)"
                  : "rgba(255,255,255,0.025)",
                border: `1px solid ${
                  s.sign === "positive"
                    ? `${s.color}55`
                    : s.sign === "negative"
                      ? "rgba(255,69,58,0.4)"
                      : "rgba(255,255,255,0.06)"
                }`,
                opacity: active === null || isActive ? 1 : 0.55,
                cursor: "pointer",
              }}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{
                    background: s.color,
                    boxShadow: s.sign === "positive" ? `0 0 4px ${s.color}` : "none",
                    opacity: s.sign === "neutral" ? 0.5 : 1,
                  }}
                  aria-hidden
                />
                <span className="text-[9px] uppercase tracking-[0.08em] text-white/55">
                  {s.label}
                </span>
              </div>
              <div
                className="text-[12px] font-mono font-semibold mt-0.5"
                style={{
                  color:
                    s.sign === "positive"
                      ? s.color
                      : s.sign === "negative"
                        ? "#ff453a"
                        : "rgba(255,255,255,0.55)",
                }}
              >
                {s.value !== null ? fmtNum(s.value) : "—"}
              </div>
              <div className="text-[9px] text-white/35 mt-0.5 leading-tight">
                {s.reason}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
