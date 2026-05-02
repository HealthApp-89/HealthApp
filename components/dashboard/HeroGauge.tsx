import { fmtNum } from "@/lib/ui/score";

type HeroGaugeProps = {
  value: number | null;
  max?: number;
  label: string;
  unit?: string;
  color: string;
  size?: number;
  caption?: string | null;
};

/** Large circular ring gauge — single number + label, used as a top-of-dashboard hero tile. */
export function HeroGauge({
  value,
  max = 100,
  label,
  unit,
  color,
  size = 124,
  caption,
}: HeroGaugeProps) {
  const hasValue = value !== null && value !== undefined && Number.isFinite(value);
  const pct = hasValue ? Math.max(0, Math.min((value as number) / max, 1)) : 0;
  const stroke = 10;
  const r = (size - stroke - 2) / 2;
  const circ = 2 * Math.PI * r;
  const cx = size / 2;
  const dash = circ * pct;
  const trackColor = "rgba(255,255,255,0.06)";

  return (
    <div className="flex flex-col items-center gap-2 select-none">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="block">
          <circle cx={cx} cy={cx} r={r} fill="none" stroke={trackColor} strokeWidth={stroke} />
          {hasValue && (
            <circle
              cx={cx}
              cy={cx}
              r={r}
              fill="none"
              stroke={color}
              strokeWidth={stroke}
              strokeDasharray={`${dash} ${circ - dash}`}
              strokeLinecap="round"
              transform={`rotate(-90 ${cx} ${cx})`}
              style={{ filter: `drop-shadow(0 0 8px ${color}66)` }}
            />
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            className="font-mono font-bold leading-none tabular-nums"
            style={{ color: hasValue ? color : "rgba(255,255,255,0.35)", fontSize: size * 0.32 }}
          >
            {hasValue ? fmtNum(value) : "—"}
          </span>
          {unit && (
            <span className="text-[9px] tracking-[0.1em] uppercase text-white/35 mt-1">{unit}</span>
          )}
        </div>
      </div>
      <div className="text-center">
        <div className="text-[10px] uppercase tracking-[0.16em] text-white/55 font-medium">
          {label}
        </div>
        {caption && (
          <div className="text-[9px] text-white/30 mt-0.5 tracking-[0.04em]">{caption}</div>
        )}
      </div>
    </div>
  );
}
