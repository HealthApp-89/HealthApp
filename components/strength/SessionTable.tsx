import type { WorkoutSession } from "@/lib/data/workouts";
import { est1rm } from "@/lib/ui/score";
import { WCOLORS } from "@/lib/ui/colors";
import { Card } from "@/components/ui/Card";
import { fmtNum } from "@/lib/ui/score";

type Props = {
  session: WorkoutSession;
};

/** Render one workout as a table: exercise headings + per-set rows.
 *  Warmup sets render dim, failure sets get a flame tag. */
export function SessionTable({ session }: Props) {
  const wc = WCOLORS[session.type ?? "Other"] ?? "#888";
  const workingSets = session.sets;

  return (
    <Card tintColor={wc}>
      {/* Session header — type pill + date + volume + working set count */}
      <div className="flex justify-between items-baseline mb-3 flex-wrap gap-2">
        <div className="flex gap-2 items-center">
          <span
            className="rounded-full"
            style={{ width: 8, height: 8, background: wc, boxShadow: `0 0 6px ${wc}` }}
          />
          <span className="text-sm font-semibold text-white/90">{session.type ?? "Workout"}</span>
          <span className="text-[10px] text-white/30">{session.date}</span>
        </div>
        <div className="flex gap-3 text-[10px] text-white/40 font-mono">
          {session.duration_min != null && <span>{session.duration_min} min</span>}
          <span>
            {workingSets} working {workingSets === 1 ? "set" : "sets"}
          </span>
          {session.vol > 0 && (
            <span style={{ color: wc }}>{(session.vol / 1000).toFixed(1)}k kg vol</span>
          )}
        </div>
      </div>

      {session.exercises.length === 0 ? (
        <div className="text-xs text-white/40 italic py-6 text-center">No exercises in this session.</div>
      ) : (
        <div className="flex flex-col gap-3">
          {session.exercises.map((e) => {
            const working = e.sets.filter((s) => !s.warmup && s.kg && s.reps);
            const top = working.length
              ? working.reduce((a, b) => (est1rm(b.kg!, b.reps!) > est1rm(a.kg!, a.reps!) ? b : a))
              : null;
            const exVol = working.reduce((acc, s) => acc + (s.kg ?? 0) * (s.reps ?? 0), 0);
            return (
              <div key={`${e.name}-${e.position}`}>
                <div className="flex justify-between items-baseline mb-1.5 gap-2">
                  <span className="text-[12px] font-semibold text-white/85">{e.name}</span>
                  {top && (
                    <span className="text-[10px] text-white/40 font-mono whitespace-nowrap">
                      top {fmtNum(top.kg!)}×{top.reps} · {fmtNum(exVol)} kg vol
                    </span>
                  )}
                </div>
                <div className="rounded-lg overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.06)" }}>
                  <table className="w-full text-[11px] font-mono">
                    <thead>
                      <tr className="text-white/35" style={{ background: "rgba(255,255,255,0.02)" }}>
                        <th className="text-left px-2.5 py-1 w-12 font-normal">Set</th>
                        <th className="text-right px-2.5 py-1 font-normal">Weight</th>
                        <th className="text-right px-2.5 py-1 font-normal">Reps</th>
                        <th className="text-right px-2.5 py-1 font-normal">est 1RM</th>
                        <th className="text-right px-2.5 py-1 w-14 font-normal">Flag</th>
                      </tr>
                    </thead>
                    <tbody>
                      {e.sets.map((s, i) => {
                        const r1 = s.kg && s.reps ? est1rm(s.kg, s.reps) : null;
                        const isCardio = s.duration_seconds != null && !s.kg && !s.reps;
                        return (
                          <tr
                            key={i}
                            className="border-t"
                            style={{
                              borderColor: "rgba(255,255,255,0.04)",
                              opacity: s.warmup ? 0.45 : 1,
                            }}
                          >
                            <td className="px-2.5 py-1 text-white/55">{i + 1}</td>
                            <td className="px-2.5 py-1 text-right text-white/85">
                              {s.kg != null ? fmtNum(s.kg) : "—"}
                            </td>
                            <td className="px-2.5 py-1 text-right text-white/85">
                              {s.reps != null ? s.reps : "—"}
                            </td>
                            <td className="px-2.5 py-1 text-right text-white/65">
                              {r1 != null ? fmtNum(r1) : isCardio ? `${s.duration_seconds}s` : "—"}
                            </td>
                            <td className="px-2.5 py-1 text-right">
                              {s.warmup && (
                                <span
                                  className="text-[9px] px-1 rounded"
                                  style={{ background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.5)" }}
                                >
                                  W
                                </span>
                              )}
                              {s.failure && (
                                <span
                                  className="text-[9px] px-1 rounded ml-1"
                                  style={{ background: "rgba(255,107,107,0.12)", color: "#ff6b6b" }}
                                  title="trained to failure"
                                >
                                  F
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
