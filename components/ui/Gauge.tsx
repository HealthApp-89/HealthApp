type GaugeProps = {
  value: number | null;
  max?: number;
  size?: number;
  color: string;
  label: string;
  sub?: string;
};

/** Circular progress gauge — server-safe SVG. */
export function Gauge({ value, max = 100, size = 76, color, label, sub }: GaugeProps) {
  const pct = Math.min((value ?? 0) / max, 1);
  const r = (size - 10) / 2;
  const circ = 2 * Math.PI * r;
  const cx = size / 2;
  return (
    <div className="flex flex-col items-center gap-[3px]">
      <svg width={size} height={size}>
        <circle cx={cx} cy={cx} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="7" />
        <circle
          cx={cx}
          cy={cx}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="7"
          strokeDasharray={`${circ * pct} ${circ}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${cx} ${cx})`}
          style={{ filter: `drop-shadow(0 0 5px ${color}88)` }}
        />
        <text
          x={cx}
          y={cx - 2}
          textAnchor="middle"
          fill="white"
          fontSize="15"
          fontWeight="700"
          fontFamily="var(--font-mono)"
        >
          {value ?? "–"}
        </text>
        {sub && (
          <text
            x={cx}
            y={cx + 12}
            textAnchor="middle"
            fill="rgba(255,255,255,0.4)"
            fontSize="8"
            fontFamily="var(--font-sans)"
          >
            {sub}
          </text>
        )}
      </svg>
      <span className="text-[9px] tracking-[0.08em] uppercase text-white/40">{label}</span>
    </div>
  );
}
