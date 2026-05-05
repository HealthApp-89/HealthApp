import type { DailyPlan } from "@/lib/coach/readiness";

type Props = {
  plan: DailyPlan;
};

/** Read-only relocation of the dashboard's old session plan card.
 *  Drop the prior 6-exercise cap; show the full session. */
export function TodayPlanCard({ plan }: Props) {
  const { readiness, mode, sessionType, exercises } = plan;

  return (
    <div
      className="rounded-[14px] p-4"
      style={{
        background: `linear-gradient(135deg, ${mode.color}12, rgba(0,0,0,0.3))`,
        border: `1px solid ${mode.color}30`,
      }}
    >
      <div className="flex justify-between items-center mb-2">
        <div>
          <div className="text-[10px] uppercase tracking-[0.1em] text-white/40">
            Today&apos;s Session
          </div>
          <div className="text-lg font-bold text-white mt-0.5">
            {sessionType === "REST" ? "Rest Day 🏠" : `💪 ${sessionType}`}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[11px] font-bold" style={{ color: mode.color }}>
            {mode.label}
          </div>
          <div className="text-[10px] text-white/35 mt-0.5">
            Readiness {readiness.score}/100
          </div>
        </div>
      </div>
      <div className="text-[11px] text-white/50 leading-relaxed">{mode.desc}</div>

      {sessionType !== "REST" && exercises.length > 0 && (
        <div className="mt-3 grid grid-cols-1 gap-1.5">
          {exercises.map((ex) => (
            <div key={ex.name} className="flex justify-between text-[11px]">
              <span className="text-white/55">{ex.name.split("(")[0].trim()}</span>
              <span className="font-mono" style={{ color: mode.color }}>
                {ex.target}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
