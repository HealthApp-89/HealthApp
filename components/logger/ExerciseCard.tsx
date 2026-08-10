"use client";

import { Fragment, memo, useCallback, useMemo, useState } from "react";
import type { ExerciseDraft, ExerciseSetDraft } from "@/lib/logger/types";
import { SetRow } from "@/components/logger/SetRow";
import { RestTimeDialog } from "@/components/logger/RestTimeDialog";
import type { TimerState, SetRef } from "@/lib/logger/set-timer";
import { annotateSession } from "@/lib/coach/session-structure/annotate";
import { evaluateSet, type CoachLine, type LiveSessionContext, type SessionSetRef } from "@/lib/coach/live-session";
import { CoachLineRow } from "@/components/logger/CoachLine";
import { findApplyTargetSetIndex } from "@/lib/logger/apply-target";
import { seedRir } from "@/lib/logger/seed-rir";

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
  /** Snapshot fetched at logger open. Undefined while loading or on fetch
   *  failure — the coaching line then degrades to silence. */
  liveContext?: LiveSessionContext;
  /** Session-wide timer state, read-only here. Only ever changes on a phase
   *  transition — no ticking value is passed down, so memo still pays. */
  timer: TimerState;
  /** Athlete tapped START on a specific set row. Undefined in edit mode, where
   *  no live timer runs and the affordance must not be offered. */
  onTimerStart?: (set: SetRef) => void;
  /** A set was uncommitted — clears timer state pointing at it. */
  onSetCleared: (set: SetRef) => void;
  /** Delete a set. Owned by LoggerSheet, NOT applied locally: the filter, the
   *  `set_index` re-index and the timer-ref remap have to land in one atomic
   *  draft update or the timer ends up naming the row that slid up into the
   *  deleted slot. See remapTimerSets. */
  onSetRemove: (exerciseIndex: number, setIndex: number) => void;
  /** Rest override chosen in this card's dialog, lifted so LoggerSheet can seed
   *  the rest countdown when it dispatches `press_stop`. */
  onRestOverrideChange: (exerciseIndex: number, seconds: number) => void;
};

function ExerciseCardInner({
  userId, externalId, exercise, exerciseIndex, allExercises, onExerciseChange, onReplace, onRemove, onReorderAll, liveContext,
  timer, onTimerStart, onSetCleared, onSetRemove, onRestOverrideChange,
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [restDialogOpen, setRestDialogOpen] = useState(false);
  const [unparsedBanner, setUnparsedBanner] = useState<string | null>(null);
  const [coachLine, setCoachLine] = useState<CoachLine | null>(null);
  // Tracked separately from restAfterSetIndex so that skipping the rest timer
  // takes down the timer and NOT the verdict — the load call is still
  // actionable after the athlete decides to start the next set early.
  const [coachLineSetIndex, setCoachLineSetIndex] = useState<number | null>(null);

  const commitSet = useCallback((setIndex: number) => {
    const nowIso = new Date().toISOString();
    const nextSets = exercise.sets.map((s, i) => {
      if (i !== setIndex) return s;
      return { ...s, committed_at: nowIso };
    });
    const nextExercise = { ...exercise, sets: nextSets };

    // rest_seconds_actual on the NEXT pending set is captured at its own commit time.
    // Rest itself is session-level now — LoggerSheet owns it (see SetTimerDock).
    onExerciseChange(exerciseIndex, nextExercise);

    // Between-sets coaching. Silent by design on an on-plan set, and silent
    // whenever the context snapshot is unavailable. Runs against nextSets
    // (post-commit) so the just-committed set is visible to the rules, and
    // sessionSets spans ALL exercises so the failure budget counts session-wide.
    //
    // The line is ALWAYS replaced, never merely overwritten-when-present: with
    // no `else`, a set committed while liveContext was undefined (the query key
    // hashes the exercise-name list, so Add/Remove/Replace mints a new key and
    // `data` goes undefined until the refetch lands — permanently, if offline)
    // left the PREVIOUS set's line on screen underneath the new one.
    let line: CoachLine | null = null;
    if (liveContext) {
      const committedSet = nextSets[setIndex];
      const sessionSets: SessionSetRef[] = allExercises.flatMap((ex, i) =>
        (i === exerciseIndex ? nextSets : ex.sets)
          .filter((s) => !s.warmup && s.committed_at != null)
          .map((s) => ({ exerciseName: ex.name, set: s })),
      );
      line = evaluateSet({
        set: committedSet,
        exercise: nextExercise,
        sessionSets,
        context: liveContext,
      });
    }
    setCoachLine(line);
    setCoachLineSetIndex(line ? setIndex : null);
  }, [exercise, exerciseIndex, onExerciseChange, liveContext, allExercises]);

  const uncommitSet = useCallback((setIndex: number) => {
    const nextSets = exercise.sets.map((s, i) =>
      i === setIndex ? { ...s, committed_at: null } : s,
    );
    onExerciseChange(exerciseIndex, { ...exercise, sets: nextSets });
    // The verdict was about a set that no longer counts as committed. Take it
    // down. The rest timer it triggered is session-level now, so LoggerSheet
    // clears that half via onSetCleared.
    if (coachLineSetIndex === setIndex) {
      setCoachLine(null);
      setCoachLineSetIndex(null);
    }
    onSetCleared({ exerciseIndex, setIndex });
  }, [exercise, exerciseIndex, onExerciseChange, coachLineSetIndex, onSetCleared]);

  const patchSet = useCallback((setIndex: number, patch: Partial<ExerciseSetDraft>) => {
    const nextSets = exercise.sets.map((s, i) => (i === setIndex ? { ...s, ...patch } : s));
    onExerciseChange(exerciseIndex, { ...exercise, sets: nextSets });
  }, [exercise, exerciseIndex, onExerciseChange]);

  const removeSet = useCallback((setIndex: number) => {
    // The verdict is anchored to a positional index; the delete shifts every
    // row below it. Taking it down is cheaper and safer than remapping a piece
    // of transient UI.
    setCoachLine(null);
    setCoachLineSetIndex(null);
    onSetRemove(exerciseIndex, setIndex);
  }, [exerciseIndex, onSetRemove]);

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
      // Seeded from the PRESCRIBED effort target (seedRir), not inherited from
      // the last set. A seeded RIR is read by the live-session load call as if
      // it were an athlete observation, so it has to be the number the plan
      // expects — which is also what the Target column shows. Inheriting the
      // previous set's value would carry a real observation (e.g. RIR 0) onto
      // a set that has not happened yet and fire a guardrail on commit.
      rir: isTimeBased ? null : seedRir(exercise.prescribed, last?.rir ?? null),
      committed_at: null,
    };
    onExerciseChange(exerciseIndex, { ...exercise, sets: [...exercise.sets, next] });
  }, [exercise, exerciseIndex, onExerciseChange]);

  // A set of THIS exercise is counting down or under load right now.
  const midSet = timer.phase === "countdown" || timer.phase === "running";
  const liveHere = midSet && timer.activeSet?.exerciseIndex === exerciseIndex;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-3 mb-3">
      <div className="flex items-center justify-between mb-1">
        <h4 className="text-sm font-semibold text-zinc-50">{exercise.name}</h4>
        <div className="flex gap-1.5 items-center relative">
          {liveHere && (
            <span className="text-[9px] px-1.5 py-0.5 bg-green-500/15 text-green-400 rounded uppercase tracking-wider">
              Live
            </span>
          )}
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
            <th className="text-left font-normal py-1">Target / prev</th>
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
          {exercise.sets.map((s, i) => {
            const isActiveRow =
              !s.committed_at && exercise.sets.findIndex((x) => !x.committed_at) === i;
            return (
            <Fragment key={i}>
              <SetRow
                userId={userId}
                exerciseName={exercise.name}
                excludeWorkoutExternalId={externalId}
                set={s}
                workingSetNumber={
                  exercise.sets.slice(0, i).filter((x) => !x.warmup).length + 1
                }
                isActive={isActiveRow}
                targetDurationSeconds={exercise.prescribed.duration_seconds ?? null}
                target={
                  exercise.prescribed.duration_seconds != null
                    ? null
                    : {
                        kg: exercise.prescribed.baseKg ?? null,
                        reps: exercise.prescribed.baseReps ?? null,
                        rir: exercise.prescribed.rir ?? null,
                      }
                }
                canRemove={exercise.sets.length > 1}
                onChange={(patch) => patchSet(i, patch)}
                onCommit={() => commitSet(i)}
                onUncommit={() => uncommitSet(i)}
                onRemove={() => removeSet(i)}
                onUnparsedVoice={setUnparsedBanner}
              />
              {coachLineSetIndex === i && coachLine && (
                <tr><td colSpan={7}>
                  <CoachLineRow
                    line={coachLine}
                    onApply={(kg) => {
                      // First uncommitted set after this one. See
                      // lib/logger/apply-target.ts for exactly what is and is
                      // not guarded here — notably NOT "kg must be empty",
                      // which never matched because pending sets are
                      // pre-filled with the prescribed baseKg.
                      const target = findApplyTargetSetIndex(exercise.sets, i);
                      if (target >= 0) patchSet(target, { kg });
                      setCoachLine(null);
                      setCoachLineSetIndex(null);
                    }}
                  />
                </td></tr>
              )}
              {onTimerStart && isActiveRow && !midSet && (
                <tr><td colSpan={7} className="pb-1">
                  <button
                    type="button"
                    onClick={() => onTimerStart({ exerciseIndex, setIndex: i })}
                    className="w-full text-[9px] font-bold uppercase tracking-widest text-green-400 bg-green-500/10 border border-green-500/25 rounded-md py-1"
                  >
                    Start this set
                  </button>
                </td></tr>
              )}
            </Fragment>
            );
          })}
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
          onConfirm={(seconds) => {
            // Both halves: the local copy drives this card's "+ Add set" label,
            // the lifted copy is what LoggerSheet reads when it seeds rest on
            // `press_stop`. Dropping either one desyncs the two.
            setRestOverrideSeconds(seconds);
            onRestOverrideChange(exerciseIndex, seconds);
            setRestDialogOpen(false);
          }}
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
