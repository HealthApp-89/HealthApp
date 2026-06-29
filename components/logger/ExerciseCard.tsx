"use client";

import { Fragment, memo, useCallback, useMemo, useState } from "react";
import type { ExerciseDraft, ExerciseSetDraft } from "@/lib/logger/types";
import { SetRow } from "@/components/logger/SetRow";
import { RestBar } from "@/components/logger/RestBar";
import { RestTimeDialog } from "@/components/logger/RestTimeDialog";
import { annotateSession } from "@/lib/coach/session-structure/annotate";

type Props = {
  userId: string;
  externalId: string;
  exercise: ExerciseDraft;
  exerciseIndex: number;
  allExercises: ExerciseDraft[];
  /** Mutate exercise's sets/name; caller persists the new draft. */
  onExerciseChange: (index: number, next: ExerciseDraft) => void;
  onReplace: (index: number) => void;
  onRemove: (index: number) => void;
  onReorderAll: () => void;
};

function ExerciseCardInner({
  userId, externalId, exercise, exerciseIndex, allExercises, onExerciseChange, onReplace, onRemove, onReorderAll,
}: Props) {
  // Tier + rest prescription from session-structure annotation.
  const annotated = useMemo(() => {
    const list = allExercises.map((e) => e.prescribed);
    const s = annotateSession(list);
    return s.exercises[exerciseIndex];
  }, [allExercises, exerciseIndex]);

  const prescribedRestMin = annotated?.rest_seconds.min ?? 120;
  const [restOverrideSeconds, setRestOverrideSeconds] = useState<number | null>(null);
  const effectiveRest = restOverrideSeconds ?? prescribedRestMin;
  const [activeRestStartedAt, setActiveRestStartedAt] = useState<number | null>(null);
  const [activeRestSeconds, setActiveRestSeconds] = useState<number>(effectiveRest);
  const [restAfterSetIndex, setRestAfterSetIndex] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [restDialogOpen, setRestDialogOpen] = useState(false);
  const [unparsedBanner, setUnparsedBanner] = useState<string | null>(null);

  const commitSet = useCallback((setIndex: number) => {
    const nowIso = new Date().toISOString();
    const now = Date.now();
    const nextSets = exercise.sets.map((s, i) => {
      if (i !== setIndex) return s;
      return { ...s, committed_at: nowIso };
    });

    // rest_seconds_actual on the NEXT pending set is captured at its own commit time.
    onExerciseChange(exerciseIndex, { ...exercise, sets: nextSets });
    setRestAfterSetIndex(setIndex);
    setActiveRestSeconds(effectiveRest);
    setActiveRestStartedAt(now);
  }, [exercise, exerciseIndex, onExerciseChange, effectiveRest]);

  const uncommitSet = useCallback((setIndex: number) => {
    const nextSets = exercise.sets.map((s, i) =>
      i === setIndex ? { ...s, committed_at: null } : s,
    );
    onExerciseChange(exerciseIndex, { ...exercise, sets: nextSets });
  }, [exercise, exerciseIndex, onExerciseChange]);

  const patchSet = useCallback((setIndex: number, patch: Partial<ExerciseSetDraft>) => {
    const nextSets = exercise.sets.map((s, i) => (i === setIndex ? { ...s, ...patch } : s));
    onExerciseChange(exerciseIndex, { ...exercise, sets: nextSets });
  }, [exercise, exerciseIndex, onExerciseChange]);

  const removeSet = useCallback((setIndex: number) => {
    // Re-index remaining sets so set_index stays contiguous (the RPC writes
    // the payload's set_index verbatim — gaps would persist in the DB).
    const nextSets = exercise.sets
      .filter((_, i) => i !== setIndex)
      .map((s, i) => ({ ...s, set_index: i }));
    onExerciseChange(exerciseIndex, { ...exercise, sets: nextSets });
  }, [exercise, exerciseIndex, onExerciseChange]);

  const addSet = useCallback(() => {
    const last = exercise.sets[exercise.sets.length - 1];
    const isTimeBased = exercise.prescribed.duration_seconds != null;
    const next: ExerciseSetDraft = {
      set_index: exercise.sets.length,
      kg: isTimeBased ? null : (last?.kg ?? exercise.prescribed.baseKg ?? null),
      reps: null,
      duration_seconds: null,
      warmup: false,
      failure: false,
      rir: isTimeBased ? null : (last?.rir ?? null),
      committed_at: null,
    };
    onExerciseChange(exerciseIndex, { ...exercise, sets: [...exercise.sets, next] });
  }, [exercise, exerciseIndex, onExerciseChange]);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-3 mb-3">
      <div className="flex items-center justify-between mb-1">
        <h4 className="text-sm font-semibold text-zinc-50">{exercise.name}</h4>
        <div className="flex gap-1.5 items-center relative">
          {annotated && (
            <span className="text-[9px] px-1.5 py-0.5 bg-zinc-800 text-zinc-400 rounded uppercase tracking-wider">
              T{annotated.fatigue_tier} · RPE {annotated.rpe_target}
            </span>
          )}
          <button onClick={() => setMenuOpen((v) => !v)} className="text-zinc-500 text-base" aria-label="Exercise menu">⋯</button>
          {menuOpen && (
            <div className="absolute right-0 top-6 bg-zinc-800 border border-zinc-700 rounded-lg p-1 text-xs z-10 min-w-[160px]">
              <button onClick={() => { setMenuOpen(false); onReplace(exerciseIndex); }} className="block w-full text-left px-2 py-1.5 hover:bg-zinc-700 rounded text-zinc-200">Replace</button>
              <button onClick={() => { setMenuOpen(false); onReorderAll(); }} className="block w-full text-left px-2 py-1.5 hover:bg-zinc-700 rounded text-zinc-200">Reorder exercises</button>
              <button onClick={() => { setMenuOpen(false); setRestDialogOpen(true); }} className="block w-full text-left px-2 py-1.5 hover:bg-zinc-700 rounded text-zinc-200">Edit rest time</button>
              <button onClick={() => { setMenuOpen(false); onRemove(exerciseIndex); }} className="block w-full text-left px-2 py-1.5 hover:bg-zinc-700 rounded text-red-400">Remove</button>
            </div>
          )}
        </div>
      </div>

      {unparsedBanner && (
        <div className="text-[11px] text-amber-400 bg-amber-500/10 rounded px-2 py-1 mb-2">
          Heard &ldquo;{unparsedBanner}&rdquo; — type it instead?
          <button onClick={() => setUnparsedBanner(null)} className="ml-2 text-amber-300 underline">dismiss</button>
        </div>
      )}

      <table className="w-full text-[11.5px]">
        <thead>
          <tr className="text-zinc-500 text-[10px]">
            <th className="text-left font-normal py-1">Set</th>
            <th className="text-left font-normal py-1">Previous</th>
            <th className="text-left font-normal py-1">
              {exercise.prescribed.duration_seconds != null ? "Timer" : "kg"}
            </th>
            <th className="text-left font-normal py-1">
              {exercise.prescribed.duration_seconds != null ? "Seconds" : "Reps"}
            </th>
            {exercise.prescribed.duration_seconds == null && (
              <th className="text-left font-normal py-1">RIR</th>
            )}
            <th></th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {exercise.sets.map((s, i) => (
            <Fragment key={i}>
              <SetRow
                userId={userId}
                exerciseName={exercise.name}
                excludeWorkoutExternalId={externalId}
                set={s}
                workingSetNumber={
                  exercise.sets.slice(0, i).filter((x) => !x.warmup).length + 1
                }
                isActive={!s.committed_at && exercise.sets.findIndex((x) => !x.committed_at) === i}
                targetDurationSeconds={exercise.prescribed.duration_seconds ?? null}
                canRemove={exercise.sets.length > 1}
                onChange={(patch) => patchSet(i, patch)}
                onCommit={() => commitSet(i)}
                onUncommit={() => uncommitSet(i)}
                onRemove={() => removeSet(i)}
                onUnparsedVoice={setUnparsedBanner}
              />
              {restAfterSetIndex === i && (
                <tr><td colSpan={7}>
                  <RestBar
                    duration_seconds={activeRestSeconds}
                    started_at={activeRestStartedAt}
                    onDone={() => { /* visual cue only — bar stays until next set commit */ }}
                    onSkip={() => { setActiveRestStartedAt(null); setRestAfterSetIndex(null); }}
                  />
                </td></tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>

      <button
        type="button"
        onClick={addSet}
        className="bg-zinc-800 text-zinc-300 border-none w-full py-2 rounded-lg text-[11px] mt-1"
      >
        + Add set ({Math.floor(effectiveRest / 60)}:{(effectiveRest % 60).toString().padStart(2, "0")})
      </button>

      {restDialogOpen && (
        <RestTimeDialog
          initialSeconds={effectiveRest}
          exerciseName={exercise.name}
          onConfirm={(seconds) => { setRestOverrideSeconds(seconds); setRestDialogOpen(false); }}
          onCancel={() => setRestDialogOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * Memoized export. Re-renders only when the exercise data or its position in
 * allExercises changes. The stable `onExerciseChange` / `onReplace` / `onRemove`
 * callbacks from LoggerSheet (wrapped in useCallback with functional setDraft)
 * ensure memo is not defeated on each parent render.
 */
export const ExerciseCard = memo(ExerciseCardInner);
