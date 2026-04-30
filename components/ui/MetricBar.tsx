type MetricBarProps = {
  label: string;
  value: number | string | null | undefined;
  unit: string;
  max: number;
  color: string;
};

/** Labelled horizontal progress bar with monospace value on the right. */
export function MetricBar({ label, value, unit, max, color }: MetricBarProps) {
  const num = typeof value === "string" ? parseFloat(value) : value ?? 0;
  const pct = Math.min((Number.isFinite(num) ? num : 0) / max * 100, 100);
  const display = value === null || value === undefined || value === "" ? null : value;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between">
        <span className="text-[10px] uppercase tracking-[0.06em] text-white/45">{label}</span>
        <span className="text-xs font-bold text-white font-mono">
          {display ?? "—"}
          {display !== null && unit && <span className="text-[9px] text-white/35 ml-0.5">{unit}</span>}
        </span>
      </div>
      <div className="h-[3px] bg-white/[0.07] rounded-[2px] overflow-hidden">
        <div
          className="h-full rounded-[2px] transition-[width] duration-700"
          style={{ width: `${pct}%`, background: color, boxShadow: `0 0 8px ${color}55` }}
        />
      </div>
    </div>
  );
}
