import { priorityColor } from "@/lib/ui/colors";
import { SectionLabel } from "@/components/ui/Card";
import { tintByKey } from "@/lib/ui/tints";

type ExerciseAdvice = {
  category: string;
  priority: "high" | "medium" | "low" | string;
  sessions: number;
  next_target: string;
  recommendation: string;
};

type Payload = {
  summary: { total_sessions: number; total_exercises_tracked: number; weeks: number };
  exercises: Record<string, ExerciseAdvice>;
};

export function CoachCards({ payload }: { payload: Payload }) {
  // Group by category
  const byCat = new Map<string, [string, ExerciseAdvice][]>();
  for (const [name, ex] of Object.entries(payload.exercises ?? {})) {
    const cat = ex.category ?? "Other";
    const arr = byCat.get(cat) ?? [];
    arr.push([name, ex]);
    byCat.set(cat, arr);
  }
  const order = ["Chest", "Shoulders", "Back", "Legs", "Arms", "Core", "Cardio", "Other"];
  const cats = [...byCat.keys()].sort(
    (a, b) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)),
  );

  return (
    <div
      className="rounded-[14px] px-4 py-3.5 border"
      style={tintByKey("coach")}
    >
      <SectionLabel color="rgba(0,245,196,0.6)">🎯 STRENGTH COACH</SectionLabel>
      <div className="text-[11px] text-white/35 mb-3 leading-relaxed">
        Based on {payload.summary?.total_exercises_tracked ?? 0} tracked exercises across{" "}
        {payload.summary?.total_sessions ?? 0} sessions.
      </div>
      {cats.map((cat) => (
        <section key={cat}>
          <div
            className="text-[11px] font-bold tracking-[0.1em] uppercase mt-3 pt-3 mb-2"
            style={{ color: "rgba(255,255,255,0.3)", borderTop: "1px solid rgba(255,255,255,0.05)" }}
          >
            {cat}
          </div>
          {byCat.get(cat)!.map(([name, ex]) => {
            const pc = priorityColor(ex.priority);
            return (
              <div
                key={name}
                className="rounded-[10px] px-3.5 py-3 mb-2"
                style={{
                  background: "rgba(0,0,0,0.3)",
                  borderLeft: `3px solid ${pc}`,
                }}
              >
                <div className="flex justify-between items-start mb-1.5">
                  <div className="text-xs font-semibold text-white flex-1">{name}</div>
                  <div className="text-[10px] text-white/30 whitespace-nowrap ml-2">
                    {ex.sessions} session{ex.sessions === 1 ? "" : "s"}
                  </div>
                </div>
                {ex.next_target && (
                  <div className="text-[11px] font-semibold mb-2" style={{ color: "#4ade80" }}>
                    → {ex.next_target}
                  </div>
                )}
                <div className="text-[11px] text-white/55 leading-relaxed">{ex.recommendation}</div>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
