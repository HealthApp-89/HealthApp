import Link from "next/link";
import { SparkLine } from "@/components/ui/SparkLine";
import type { ExerciseTrendPoint } from "@/lib/data/workouts";

type Props = {
  name: string;
  points: ExerciseTrendPoint[];
};

export function ExerciseTrendCard({ name, points }: Props) {
  const last = points[points.length - 1];
  const display = name.split("(")[0].trim();
  return (
    <div
      className="rounded-[14px] px-4 py-3.5"
      style={{ background: "rgba(255,159,67,0.07)", border: "1px solid rgba(255,159,67,0.2)" }}
    >
      <div className="flex justify-between items-center mb-2.5">
        <span className="text-[10px] uppercase tracking-[0.1em]" style={{ color: "rgba(255,159,67,0.8)" }}>
          📈 {display}
        </span>
        <Link
          href="/strength"
          scroll={false}
          aria-label="Close exercise trend"
          className="p-2 -m-2 rounded-full text-lg leading-none text-white/35 hover:text-white touch-manipulation select-none active:bg-white/10"
        >
          ×
        </Link>
      </div>
      {points.length >= 2 ? (
        <div>
          <SparkLine
            values={points.map((p) => p.est1rm)}
            labels={points.map((p) => p.date.slice(5))}
            unit="kg 1RM"
            color="#ff9f43"
            height={48}
            chartId="extrend"
          />
          <div className="flex justify-between mt-1.5 mb-3">
            {points.map((p) => (
              <div key={p.date} className="text-center">
                <div className="text-[8px] text-white/20">{p.date.slice(5)}</div>
                <div className="text-[10px] font-mono" style={{ color: "#ff9f43" }}>
                  {p.est1rm}
                </div>
              </div>
            ))}
          </div>
          {last && (
            <div className="flex gap-2.5">
              <div className="flex-1 rounded-[10px] px-3 py-2.5" style={{ background: "rgba(0,0,0,0.2)" }}>
                <div className="text-[9px] text-white/30 mb-0.5">BEST SET</div>
                <div className="text-lg font-bold font-mono" style={{ color: "#ff9f43" }}>
                  {last.kg}kg × {last.reps}
                </div>
              </div>
              <div className="flex-1 rounded-[10px] px-3 py-2.5" style={{ background: "rgba(0,0,0,0.2)" }}>
                <div className="text-[9px] text-white/30 mb-0.5">EST. 1RM</div>
                <div className="text-lg font-bold font-mono" style={{ color: "#ff9f43" }}>
                  {last.est1rm} kg
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="text-xs text-white/30 text-center py-3">
          Only 1 session — log more to see progression
        </div>
      )}
    </div>
  );
}
