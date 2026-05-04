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

/** Safely coerce any LLM-returned value to a renderable string. Objects /
 *  arrays get JSON-stringified so they show as text instead of crashing
 *  React with "Objects are not valid as a React child". */
function asText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

function asInt(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

export function CoachCards({ payload }: { payload: Payload }) {
  // Tolerate any shape Claude may have hallucinated. We never throw — if the
  // payload is unusable, we render a friendly placeholder instead.
  const exercisesObj =
    payload?.exercises && typeof payload.exercises === "object" && !Array.isArray(payload.exercises)
      ? (payload.exercises as Record<string, unknown>)
      : {};

  const byCat = new Map<string, [string, ExerciseAdvice][]>();
  for (const [name, raw] of Object.entries(exercisesObj)) {
    const ex = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const advice: ExerciseAdvice = {
      category: asText(ex.category) || "Other",
      priority: asText(ex.priority) || "medium",
      sessions: asInt(ex.sessions),
      next_target: asText(ex.next_target),
      recommendation: asText(ex.recommendation),
    };
    const cat = advice.category;
    const arr = byCat.get(cat) ?? [];
    arr.push([asText(name) || "Exercise", advice]);
    byCat.set(cat, arr);
  }
  const order = ["Chest", "Shoulders", "Back", "Legs", "Arms", "Core", "Cardio", "Other"];
  const cats = [...byCat.keys()].sort(
    (a, b) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)),
  );

  const totalExercises = asInt(payload?.summary?.total_exercises_tracked);
  const totalSessions = asInt(payload?.summary?.total_sessions);

  if (cats.length === 0) {
    return (
      <div className="rounded-[14px] px-4 py-3.5 border" style={tintByKey("coach")}>
        <SectionLabel color="rgba(10,132,255,0.6)">🎯 STRENGTH COACH</SectionLabel>
        <div className="text-[11px] text-white/45 leading-relaxed">
          The coach didn&apos;t return any exercise advice this run. Try{" "}
          <em>Refresh strength coach</em> in a moment — the model occasionally
          returns an unparseable response.
        </div>
      </div>
    );
  }

  return (
    <div
      className="rounded-[14px] px-4 py-3.5 border"
      style={tintByKey("coach")}
    >
      <SectionLabel color="rgba(10,132,255,0.6)">🎯 STRENGTH COACH</SectionLabel>
      <div className="text-[11px] text-white/35 mb-3 leading-relaxed">
        Based on {totalExercises} tracked exercises across {totalSessions} sessions.
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
                  <div className="text-[11px] font-semibold mb-2" style={{ color: "#30d158" }}>
                    → {ex.next_target}
                  </div>
                )}
                {ex.recommendation && (
                  <div className="text-[11px] text-white/55 leading-relaxed">
                    {ex.recommendation}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
