import Link from "next/link";
import { LineChart, type LinePoint } from "@/components/charts/LineChart";
import type { ExerciseTrendPoint } from "@/lib/data/workouts";
import { COLOR, METRIC_COLOR } from "@/lib/ui/theme";

type Props = {
  name: string;
  points: ExerciseTrendPoint[];
};

export function ExerciseTrendCard({ name, points }: Props) {
  const last = points[points.length - 1];
  const display = name.split("(")[0].trim();
  const accentColor = METRIC_COLOR.strain; // amber — fits strength/1RM trend
  const isBodyweight = points.length > 0 && points[0].kind === "bodyweight";

  const chartData: LinePoint[] = points.map((p) => ({
    x: p.date.slice(5),
    y: p.kind === "weighted" ? p.est1rm : p.totalReps,
  }));

  return (
    <div
      className="rounded-[14px] px-4 py-3.5"
      style={{
        background: COLOR.surface,
        border: `1px solid ${COLOR.divider}`,
        boxShadow: "0 2px 8px rgba(20,30,80,0.05)",
      }}
    >
      <div className="flex justify-between items-center mb-2.5">
        <span className="text-[10px] uppercase tracking-[0.1em]" style={{ color: accentColor }}>
          📈 {display}
        </span>
        <Link
          href="/strength"
          scroll={false}
          aria-label="Close exercise trend"
          className="p-2 -m-2 rounded-full text-lg leading-none touch-manipulation select-none"
          style={{ color: COLOR.textFaint }}
        >
          ×
        </Link>
      </div>
      {points.length >= 2 ? (
        <div>
          <LineChart data={chartData} color={accentColor} variant="mini" height={48} />
          <div className="flex justify-between mt-1.5 mb-3">
            {points.map((p) => (
              <div key={p.date} className="text-center">
                <div className="text-[8px]" style={{ color: COLOR.textFaint }}>
                  {p.date.slice(5)}
                </div>
                <div className="text-[10px] font-mono" style={{ color: accentColor }}>
                  {p.kind === "weighted" ? p.est1rm : p.totalReps}
                </div>
              </div>
            ))}
          </div>
          {last && last.kind === "weighted" && (
            <div className="flex gap-2.5">
              <div className="flex-1 rounded-[10px] px-3 py-2.5" style={{ background: COLOR.surfaceAlt }}>
                <div className="text-[9px] mb-0.5" style={{ color: COLOR.textFaint }}>BEST SET</div>
                <div className="text-lg font-bold font-mono" style={{ color: accentColor }}>
                  {last.kg}kg × {last.reps}
                </div>
              </div>
              <div className="flex-1 rounded-[10px] px-3 py-2.5" style={{ background: COLOR.surfaceAlt }}>
                <div className="text-[9px] mb-0.5" style={{ color: COLOR.textFaint }}>EST. 1RM</div>
                <div className="text-lg font-bold font-mono" style={{ color: accentColor }}>
                  {last.est1rm} kg
                </div>
              </div>
            </div>
          )}
          {last && last.kind === "bodyweight" && (
            <div className="flex gap-2.5">
              <div className="flex-1 rounded-[10px] px-3 py-2.5" style={{ background: COLOR.surfaceAlt }}>
                <div className="text-[9px] mb-0.5" style={{ color: COLOR.textFaint }}>BEST SET</div>
                <div className="text-lg font-bold font-mono" style={{ color: accentColor }}>
                  {last.bestSetReps} reps
                </div>
              </div>
              <div className="flex-1 rounded-[10px] px-3 py-2.5" style={{ background: COLOR.surfaceAlt }}>
                <div className="text-[9px] mb-0.5" style={{ color: COLOR.textFaint }}>TOTAL REPS</div>
                <div className="text-lg font-bold font-mono" style={{ color: accentColor }}>
                  {last.totalReps}
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="text-xs text-center py-3" style={{ color: COLOR.textFaint }}>
          {isBodyweight
            ? "Only 1 session — log more to see rep progression"
            : "Only 1 session — log more to see progression"}
        </div>
      )}
    </div>
  );
}
