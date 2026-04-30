type Props = {
  data: (number | null)[];
  color?: string;
  height?: number;
  refLine?: number | null;
  refLabel?: string;
  showDots?: boolean;
};

/** Server-safe SVG line chart with optional dashed reference line and gradient fill. */
export function LineChart({
  data,
  color = "#00f5c4",
  height = 60,
  refLine = null,
  refLabel = "",
  showDots = true,
}: Props) {
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

  return (
    <svg
      viewBox={`0 0 ${W} ${height}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height, overflow: "visible" }}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {fillD && <path d={fillD} fill={`url(#${gid})`} />}
      {refY !== null && (
        <>
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
          {refLabel && (
            <text x="1" y={refY - 1.5} fontSize="3.5" fill={color} opacity="0.6">
              {refLabel}
            </text>
          )}
        </>
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
          v !== null ? <circle key={i} cx={toX(i)} cy={toY(v)} r="1.8" fill={color} opacity="0.9" /> : null,
        )}
    </svg>
  );
}
