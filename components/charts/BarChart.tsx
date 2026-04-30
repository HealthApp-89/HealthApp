type Props = {
  data: (number | null)[];
  color?: string;
  height?: number;
  goalLine?: number | null;
  colorFn?: (v: number) => string;
};

export function BarChart({ data, color = "#00f5c4", height = 60, goalLine = null, colorFn }: Props) {
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
  return (
    <svg
      viewBox={`0 0 ${W} ${height}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height, overflow: "visible" }}
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
      {data.map((v, i) => {
        if (!v) return null;
        const bh = (v / max) * height * 0.9;
        const x = i * gap + (gap - bw) / 2;
        const c = colorFn ? colorFn(v) : color;
        return (
          <rect key={i} x={x} y={height - bh} width={bw} height={bh} rx="1" fill={c} opacity="0.85" />
        );
      })}
    </svg>
  );
}
