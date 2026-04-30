import type { ReactNode } from "react";

type Props = {
  title: string;
  current: number | string | null;
  unit: string;
  delta?: number | null;
  deltaLabel?: string;
  /** Whether a positive delta is "good" (default true). RHR and weight invert this. */
  positiveIsGood?: boolean;
  color: string;
  note?: string;
  children?: ReactNode;
};

export function MetricCard({
  title,
  current,
  unit,
  delta,
  deltaLabel,
  positiveIsGood = true,
  color,
  note,
  children,
}: Props) {
  const arrow = !delta ? "→" : delta > 0 ? "↑" : "↓";
  const dc =
    delta === undefined || delta === null || delta === 0
      ? "rgba(255,255,255,0.3)"
      : positiveIsGood
        ? delta > 0
          ? "#4ade80"
          : "#f87171"
        : delta < 0
          ? "#4ade80"
          : "#f87171";
  return (
    <div
      className="rounded-[14px] px-4 py-3.5 mb-3"
      style={{
        background: "rgba(255,255,255,0.025)",
        border: "1px solid rgba(255,255,255,0.07)",
      }}
    >
      <div className="flex justify-between items-start mb-2.5">
        <div>
          <div className="text-[9px] uppercase tracking-[0.12em] text-white/35 mb-1">{title}</div>
          <div className="flex items-baseline gap-1">
            <span className="text-[26px] font-bold font-mono" style={{ color }}>
              {current ?? "—"}
            </span>
            <span className="text-[11px] text-white/30">{unit}</span>
          </div>
        </div>
        {delta !== undefined && delta !== null && (
          <div className="text-right">
            <div className="text-[13px] font-bold" style={{ color: dc }}>
              {arrow} {Math.abs(delta)}
              {unit}
            </div>
            {deltaLabel && (
              <div className="text-[9px] text-white/25 mt-0.5">{deltaLabel}</div>
            )}
          </div>
        )}
      </div>
      {children}
      {note && (
        <div
          className="text-[10px] text-white/25 italic mt-2 pt-2"
          style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}
        >
          {note}
        </div>
      )}
    </div>
  );
}
