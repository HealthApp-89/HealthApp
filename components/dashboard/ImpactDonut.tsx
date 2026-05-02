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
 *  Pure SVG, no client JS. Server-rendered. */
export function ImpactDonut({ segments, score, size = 260 }: Props) {
  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 18;
  const gap = 0.04; // radians of empty space between slices

  const sliceArc = TAU / segments.length;
  // Start at 12 o'clock (top), go clockwise.
  const start0 = -Math.PI / 2;

  const sc = scoreColor(score);
  const sl = scoreLabel(score);

  const positive = segments.filter((s) => s.sign === "positive");
  const negative = segments.filter((s) => s.sign === "negative");

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          style={{ display: "block", overflow: "visible" }}
        >
          <defs>
            {segments.map((s, i) => (
              <filter key={i} id={`donut-glow-${i}`} x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur stdDeviation="3" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            ))}
          </defs>

          {segments.map((s, i) => {
            const a0 = start0 + i * sliceArc + gap / 2;
            const a1 = start0 + (i + 1) * sliceArc - gap / 2;
            const x0 = cx + radius * Math.cos(a0);
            const y0 = cy + radius * Math.sin(a0);
            const x1 = cx + radius * Math.cos(a1);
            const y1 = cy + radius * Math.sin(a1);
            const large = a1 - a0 > Math.PI ? 1 : 0;
            const d = `M ${x0} ${y0} A ${radius} ${radius} 0 ${large} 1 ${x1} ${y1}`;

            const isPositive = s.sign === "positive";
            const isNegative = s.sign === "negative";
            const strokeWidth = isPositive ? 16 : isNegative ? 12 : 10;
            const opacity = s.sign === "neutral" ? 0.35 : 0.4 + s.magnitude * 0.6;

            return (
              <g key={s.key}>
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
                style={{ background: "#6bcb77", boxShadow: "0 0 4px #6bcb77" }}
                aria-hidden
              />
            ))}
            {Array.from({ length: negative.length }).map((_, i) => (
              <span
                key={`n${i}`}
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: "#ff6b6b" }}
                aria-hidden
              />
            ))}
          </div>
        </div>
      </div>

      {/* Legend — six metric chips, color-coded by sign, with raw value */}
      <div className="grid grid-cols-3 gap-1.5 w-full">
        {segments.map((s) => (
          <div
            key={s.key}
            className="rounded-lg px-2 py-1.5"
            style={{
              background: "rgba(255,255,255,0.025)",
              border: `1px solid ${
                s.sign === "positive"
                  ? `${s.color}55`
                  : s.sign === "negative"
                  ? "rgba(255,107,107,0.4)"
                  : "rgba(255,255,255,0.06)"
              }`,
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
                    ? "#ff6b6b"
                    : "rgba(255,255,255,0.55)",
              }}
            >
              {s.value !== null ? fmtNum(s.value) : "—"}
            </div>
            <div className="text-[9px] text-white/35 mt-0.5 leading-tight">{s.reason}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
