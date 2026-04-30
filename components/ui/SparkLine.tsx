type SparkLineProps = {
  values: (number | null)[];
  color: string;
  height?: number;
  chartId: string;
};

/** Filled-area sparkline with a dot at the latest point. Skips render if <2 points. */
export function SparkLine({ values, color, height = 44, chartId }: SparkLineProps) {
  const nums = values.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0));
  const present = nums.filter((_, i) => values[i] !== null && values[i] !== undefined);
  if (present.length < 2) return null;
  const mx = Math.max(...nums);
  const mn = Math.min(...nums);
  const rng = mx - mn || 1;
  const w = 100;
  const pts = nums
    .map((v, i) => {
      const x = (i / Math.max(nums.length - 1, 1)) * w;
      const y = height - ((v - mn) / rng) * (height - 6) - 3;
      return `${x},${y}`;
    })
    .join(" ");
  const gid = `g${chartId}`;
  const lastIdx = nums.length - 1;
  const lastX = (lastIdx / Math.max(nums.length - 1, 1)) * w;
  const lastY = height - ((nums[lastIdx] - mn) / rng) * (height - 6) - 3;
  return (
    <svg
      width="100%"
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      style={{ overflow: "visible" }}
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
    </svg>
  );
}
