"use client";

import type { WorkoutSession, WorkoutExercise } from "@/lib/data/workouts";
import { est1rm } from "@/lib/ui/score";
import { WCOLORS } from "@/lib/ui/colors";
import { Card } from "@/components/ui/Card";
import { fmtNum } from "@/lib/ui/score";
import { COLOR } from "@/lib/ui/theme";
import { EditSessionButton } from "@/components/logger/EditSessionButton";
import { useMemo, useState } from "react";
import {
  aggregateSessionMuscles,
  getExerciseMuscles,
  type AggregatedMuscles,
} from "@/lib/coach/exercise-muscles";
import { MuscleMap } from "@/components/strength/anatomy/MuscleMap";
import { MuscleLegendPills } from "@/components/strength/anatomy/MuscleLegendPills";

type Props = {
  session: WorkoutSession;
};

/** Render one workout as a table: exercise headings + per-set rows.
 *  Warmup sets render dim. Failure sets get a flame tag. Bodyweight sets
 *  (kg falsy with reps present) render "BW" in the Weight column. */
export function SessionTable({ session }: Props) {
  const wc = WCOLORS[session.type ?? "Other"] ?? "#888";
  const workingSets = session.sets;
  const allBodyweight = session.vol === 0 && session.bwReps > 0;
  const [expanded, setExpanded] = useState(false);
  const [selectedExerciseName, setSelectedExerciseName] = useState<string | null>(null);

  const displayedMuscles = useMemo<AggregatedMuscles>(() => {
    if (selectedExerciseName) {
      const m = getExerciseMuscles(selectedExerciseName);
      if (m) return { primary: m.primary, secondary: m.secondary };
    }
    return aggregateSessionMuscles(session.exercises, session.type);
  }, [selectedExerciseName, session.exercises, session.type]);

  const handleToggleExpanded = () => {
    setExpanded((prev) => {
      if (prev) setSelectedExerciseName(null);
      return !prev;
    });
  };

  const handleSelectExercise = (name: string) => {
    setSelectedExerciseName((prev) => (prev === name ? null : name));
  };

  return (
    <Card tintColor={wc}>
      {/* Session header — type pill + date + volume + working set count */}
      <div className="flex justify-between items-baseline mb-3 flex-wrap gap-2">
        <div className="flex gap-2 items-center">
          <span
            className="rounded-full"
            style={{ width: 8, height: 8, background: wc, boxShadow: `0 0 6px ${wc}` }}
          />
          <span className="text-sm font-semibold" style={{ color: COLOR.textStrong }}>
            {session.type ?? "Workout"}
          </span>
          <span className="text-[10px]" style={{ color: COLOR.textFaint }}>{session.date}</span>
        </div>
        <div className="flex gap-3 text-[10px] font-mono" style={{ color: COLOR.textMuted }}>
          {session.duration_min != null && <span>{session.duration_min} min</span>}
          <span>
            {workingSets} working {workingSets === 1 ? "set" : "sets"}
          </span>
          {session.vol > 0 && (
            <span style={{ color: wc }}>{(session.vol / 1000).toFixed(1)}k kg vol</span>
          )}
          {allBodyweight && (
            <span style={{ color: wc }}>{session.bwReps} reps total</span>
          )}
          <EditSessionButton
            workoutId={session.id}
            eligible={session.source === "logger"}
            className="text-[10px] font-mono uppercase tracking-wide hover:opacity-80 disabled:opacity-50"
          />
        </div>
      </div>

      <MuscleMap
        primary={displayedMuscles.primary}
        secondary={displayedMuscles.secondary}
        highlighted={selectedExerciseName != null}
      />
      <MuscleLegendPills primary={displayedMuscles.primary} secondary={displayedMuscles.secondary} />

      {selectedExerciseName && (
        <div
          className="mt-2 text-center text-[10px] font-mono"
          style={{ color: COLOR.textFaint }}
        >
          Showing muscles for{" "}
          <span style={{ color: COLOR.textMid }}>{selectedExerciseName}</span>
        </div>
      )}

      <button
        type="button"
        onClick={handleToggleExpanded}
        aria-expanded={expanded}
        className="mt-2.5 flex w-full items-center justify-center gap-1.5 border-t border-dashed pt-2.5 text-[11px] transition-colors hover:opacity-80"
        style={{ borderColor: COLOR.divider, color: COLOR.textMuted }}
      >
        <svg
          className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
        {expanded ? "Hide exercises" : "Tap for exercises"}
      </button>

      {expanded && (
        session.exercises.length === 0 ? (
          <div className="mt-3 text-xs italic py-6 text-center" style={{ color: COLOR.textMuted }}>
            No exercises in this session.
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            {session.exercises.map((e) => {
              const isMapped = getExerciseMuscles(e.name) !== null;
              return (
                <ExerciseBlock
                  key={`${e.name}-${e.position}`}
                  exercise={e}
                  isSelected={selectedExerciseName === e.name}
                  isMapped={isMapped}
                  accent={wc}
                  onSelect={() => handleSelectExercise(e.name)}
                />
              );
            })}
          </div>
        )
      )}
    </Card>
  );
}

function ExerciseBlock({
  exercise: e,
  isSelected,
  isMapped,
  accent,
  onSelect,
}: {
  exercise: WorkoutExercise;
  isSelected: boolean;
  isMapped: boolean;
  accent: string;
  onSelect: () => void;
}) {
  // Per-exercise summary line. Weighted exercises show top weighted set + kg vol;
  // bodyweight exercises show top reps in a single set + total reps for the day.
  let summary: string | null = null;
  if (e.kind === "weighted") {
    const working = e.sets.filter((s) => !s.warmup && s.kg && s.reps);
    const top = working.length
      ? working.reduce((a, b) => (est1rm(b.kg!, b.reps!) > est1rm(a.kg!, a.reps!) ? b : a))
      : null;
    const exVol = working.reduce((acc, s) => acc + (s.kg ?? 0) * (s.reps ?? 0), 0);
    if (top) summary = `top ${fmtNum(top.kg!)}×${top.reps} · ${fmtNum(exVol)} kg vol`;
  } else {
    let topReps = 0;
    let totalReps = 0;
    for (const s of e.sets) {
      if (s.warmup || s.kg || !s.reps) continue;
      totalReps += s.reps;
      if (s.reps > topReps) topReps = s.reps;
    }
    if (totalReps > 0) summary = `top ${topReps} reps · ${totalReps} reps total`;
  }

  const interactive = isMapped;
  const bgColor = isSelected
    ? `color-mix(in srgb, ${accent} 14%, transparent)`
    : "transparent";
  const nameOpacity = isMapped ? 1 : 0.55;

  const inner = (
    <div className="p-2 rounded-md transition-colors" style={{ background: bgColor }}>
      <div className="flex justify-between items-baseline mb-1.5 gap-2">
        <span
          className="text-[12px] font-semibold"
          style={{ color: COLOR.textStrong, opacity: nameOpacity }}
        >
          {e.name}
        </span>
        {summary && (
          <span className="text-[10px] font-mono whitespace-nowrap" style={{ color: COLOR.textMuted }}>
            {summary}
          </span>
        )}
      </div>
      <div className="rounded-lg overflow-hidden" style={{ border: `1px solid ${COLOR.divider}` }}>
        <table className="w-full text-[11px] font-mono">
          <thead>
            <tr style={{ color: COLOR.textMuted, background: COLOR.surfaceAlt }}>
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
              const isBodyweight = !s.kg && s.reps != null;
              const isCardio = s.duration_seconds != null && !s.kg && !s.reps;
              return (
                <tr
                  key={i}
                  className="border-t"
                  style={{
                    borderColor: COLOR.divider,
                    opacity: s.warmup ? 0.45 : 1,
                  }}
                >
                  <td className="px-2.5 py-1" style={{ color: COLOR.textMid }}>{i + 1}</td>
                  <td className="px-2.5 py-1 text-right" style={{ color: COLOR.textStrong }}>
                    {isBodyweight ? "BW" : s.kg != null ? fmtNum(s.kg) : "—"}
                  </td>
                  <td className="px-2.5 py-1 text-right" style={{ color: COLOR.textStrong }}>
                    {s.reps != null ? s.reps : "—"}
                  </td>
                  <td className="px-2.5 py-1 text-right" style={{ color: COLOR.textMid }}>
                    {r1 != null ? fmtNum(r1) : isCardio ? `${s.duration_seconds}s` : "—"}
                  </td>
                  <td className="px-2.5 py-1 text-right">
                    {s.warmup && (
                      <span
                        className="text-[9px] px-1 rounded"
                        style={{ background: COLOR.surfaceAlt, color: COLOR.textMid }}
                      >
                        W
                      </span>
                    )}
                    {s.failure && (
                      <span
                        className="text-[9px] px-1 rounded ml-1"
                        style={{ background: COLOR.dangerSoft, color: COLOR.danger }}
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

  if (!interactive) return inner;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={isSelected}
      className="block w-full text-left cursor-pointer hover:opacity-95 transition-opacity"
    >
      {inner}
    </button>
  );
}
