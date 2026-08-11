"use client";

import { Fragment, memo, useCallback, useMemo, useState } from "react";
import type { ExerciseDraft, ExerciseSetDraft } from "@/lib/logger/types";
import { SetRow } from "@/components/logger/SetRow";
import { SetEntryRow } from "@/components/logger/SetEntryRow";
import { RestTimeDialog } from "@/components/logger/RestTimeDialog";
import type { TimerState, SetRef } from "@/lib/logger/set-timer";
import { annotateSession } from "@/lib/coach/session-structure/annotate";
import type { CoachLine } from "@/lib/coach/live-session";
import { CoachLineRow } from "@/components/logger/CoachLine";
import { findApplyTargetSetIndex } from "@/lib/logger/apply-target";
import { propagateLoad } from "@/lib/logger/propagate-load";
import { seedRir } from "@/lib/logger/seed-rir";
import { seedReps } from "@/lib/logger/seed-reps";

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
  /** Session-wide timer state, read-only here. Only ever changes on a phase
   *  transition — no ticking value is passed down, so memo still pays. */
  timer: TimerState;
  /** Athlete tapped START on a specific set row. Names THIS set only — the card
   *  knows nothing about supersets; LoggerSheet owns the draft and expands the
   *  ref into the whole round (see `roundForSet`), so a row-level tap can never
   *  begin half a pair. Undefined in edit mode, where no live timer runs and the
   *  affordance must not be offered. */
  onTimerStart?: (set: SetRef) => void;
  /** True inside a hydrated historical-workout edit. Edit mode has no dock and
   *  no `onTimerStart`, so a time-based row's ONLY commit path is its own
   *  hand-editable seconds field — see SetRow. Threaded explicitly rather than
   *  inferred from `onTimerStart == null` so the intent reads at the call
   *  site instead of being reconstructed from an unrelated prop's absence. */
  editMode: boolean;
  /** Manual ○ commit. Owned by LoggerSheet so the between-sets coaching line
   *  has ONE evaluation site shared with the timer-driven commit paths. */
  onSetCommit: (exerciseIndex: number, setIndex: number) => void;
  /** Save the zoomed entry row's values and close it. Touches no clock —
   *  rest keeps running underneath. */
  onEntrySave: (set: SetRef) => void;
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
  /** RestTimeDialog is rendered by this card but is a full-screen modal, so
   *  LoggerSheet has to know it is up: the SetTimerDock portals to <body> and
   *  would otherwise paint — and stay tappable — above the dialog's backdrop.
   *  Same lifting pattern as onRestOverrideChange. */
  onRestDialogOpenChange: (exerciseIndex: number, open: boolean) => void;
  /** Between-sets coaching line for THIS exercise, already filtered by
   *  LoggerSheet. Held there, not here, so both commit paths feed one state. */
  coachLine: CoachLine | null;
  coachLineSetIndex: number | null;
  /** Take the line down — applied a load, or dismissed it. */
  onCoachLineDismiss: () => void;
  /** Present only for a member of a real group (2+ exercises sharing a tag).
   *  The sheet owns the mutation because it owns the draft. */
  onUngroup?: (index: number) => void;
};

function ExerciseCardInner({
  userId, externalId, exercise, exerciseIndex, allExercises, onExerciseChange, onReplace, onRemove, onReorderAll,
  timer, onTimerStart, editMode, onSetCommit, onEntrySave, onSetCleared, onSetRemove, onRestOverrideChange,
  onRestDialogOpenChange, coachLine, coachLineSetIndex, onCoachLineDismiss, onUngroup,
}: Props) {
  // Tier + rest prescription from session-structure annotation.
  const annotated = useMemo(() => {
    const list = allExercises.map((e) => e.prescribed);
    const s = annotateSession(list);
    return s.exercises[exerciseIndex];
  }, [allExercises, exerciseIndex]);

  const prescribedRestMin = annotated?.rest_seconds ?? 120;
  const [restOverrideSeconds, setRestOverrideSeconds] = useState<number | null>(null);
  const effectiveRest = restOverrideSeconds ?? prescribedRestMin;
  const [menuOpen, setMenuOpen] = useState(false);
  const [restDialogOpen, setRestDialogOpen] = useState(false);

  // Commit is LoggerSheet's job on both paths — the manual ○ here and the
  // timer's Save / auto-save-on-START. It owns the draft, so it is the only
  // place that can hand the between-sets rules a post-commit session view
  // without a second copy of the set-collection logic.
  const commitSet = useCallback((setIndex: number) => {
    onSetCommit(exerciseIndex, setIndex);
  }, [exerciseIndex, onSetCommit]);

  const uncommitSet = useCallback((setIndex: number) => {
    const nextSets = exercise.sets.map((s, i) =>
      i === setIndex ? { ...s, committed_at: null } : s,
    );
    onExerciseChange(exerciseIndex, { ...exercise, sets: nextSets });
    // The verdict was about a set that no longer counts as committed, and the
    // rest timer it triggered points at it too. LoggerSheet takes down both.
    onSetCleared({ exerciseIndex, setIndex });
  }, [exercise, exerciseIndex, onExerciseChange, onSetCleared]);

  // THE kg write seam. Every load the athlete enters comes through here — the
  // SetRow field's blur, the zoomed SetEntryRow's Save, and the coach line's
  // one-tap apply — which is why load propagation hangs off it rather than off
  // each surface: one call site, no chance of a surface being forgotten.
  //
  // `propagateLoad` runs against the PRE-patch sets, because it needs this
  // set's previous kg to decide which sets below still agreed with it. The
  // patch is then spread on top, so the edited set's other fields (reps, RIR,
  // the failure/warmup badge) land exactly as before.
  const patchSet = useCallback((setIndex: number, patch: Partial<ExerciseSetDraft>) => {
    const base = "kg" in patch
      ? propagateLoad(exercise.sets, setIndex, patch.kg ?? null)
      : exercise.sets;
    const nextSets = base.map((s, i) => (i === setIndex ? { ...s, ...patch } : s));
    onExerciseChange(exerciseIndex, { ...exercise, sets: nextSets });
  }, [exercise, exerciseIndex, onExerciseChange]);

  const removeSet = useCallback((setIndex: number) => {
    onSetRemove(exerciseIndex, setIndex);
  }, [exerciseIndex, onSetRemove]);

  const addSet = useCallback(() => {
    const last = exercise.sets[exercise.sets.length - 1];
    const isTimeBased = exercise.prescribed.duration_seconds != null;
    const next: ExerciseSetDraft = {
      set_index: exercise.sets.length,
      kg: isTimeBased ? null : (last?.kg ?? exercise.prescribed.baseKg ?? null),
      reps: seedReps(exercise.prescribed),
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

  const setRestDialog = useCallback((open: boolean) => {
    setRestDialogOpen(open);
    onRestDialogOpenChange(exerciseIndex, open);
  }, [exerciseIndex, onRestDialogOpenChange]);

  // A set of THIS exercise is counting down or under load right now.
  const midSet = timer.phase === "countdown" || timer.phase === "running";
  const liveHere = midSet && timer.activeSets.some((s) => s.exerciseIndex === exerciseIndex);

  const timeBased = exercise.prescribed.duration_seconds != null;
  // Table has 5 columns for a time-based exercise (no RIR header) vs 6 for a
  // rep-based one — see the <thead> below. Full-width rows spanning the whole
  // table (the zoom, the coach line, "Start this set") need to match, or the
  // browser silently clips/pads rather than erroring.
  const columnCount = timeBased ? 5 : 6;
  /** The zoomed entry row, when an open one belongs to this exercise. */
  const pendingEntry =
    timer.pendingEntries.find((e) => e.exerciseIndex === exerciseIndex) ?? null;
  // The set with the zoom open is still uncommitted — commit now happens on
  // Save, not on stop. It must NOT also read as the row awaiting entry, or
  // "Start this set" would appear beneath the zoom and offer to re-run the set
  // just finished. Skipping it hands the affordance to the genuine next set.
  const activeSetIndex = exercise.sets.findIndex(
    (x, i) => !x.committed_at && i !== (pendingEntry?.setIndex ?? -1),
  );

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
              <button onClick={() => { setMenuOpen(false); setRestDialog(true); }} className="block w-full text-left px-2 py-1.5 hover:bg-zinc-700 rounded text-zinc-200">Edit rest time</button>
              {onUngroup && (
                <button onClick={() => { setMenuOpen(false); onUngroup(exerciseIndex); }} className="block w-full text-left px-2 py-1.5 hover:bg-zinc-700 rounded text-zinc-200">Ungroup superset</button>
              )}
              <button onClick={() => { setMenuOpen(false); onRemove(exerciseIndex); }} className="block w-full text-left px-2 py-1.5 hover:bg-zinc-700 rounded text-red-400">Remove</button>
            </div>
          )}
        </div>
      </div>

      <table className="w-full text-[11.5px]">
        <thead>
          <tr className="text-zinc-500 text-[10px]">
            <th className="text-left font-normal py-1">Set</th>
            <th className="text-left font-normal py-1">Target / prev</th>
            <th className="text-left font-normal py-1">
              {/* Time-based: this column has no per-row control any more —
                  the dock (live mode) or the seconds field itself (edit mode,
                  one column over) drive it. Left blank rather than "Timer",
                  which stopped being true when the inline play/stop button
                  was removed. */}
              {exercise.prescribed.duration_seconds != null ? "" : "kg"}
            </th>
            <th className="text-left font-normal py-1">
              {exercise.prescribed.duration_seconds != null ? "Seconds" : "Reps"}
            </th>
            {exercise.prescribed.duration_seconds == null && (
              <th className="text-left font-normal py-1">RIR</th>
            )}
            {/* The ✓ / ○ commit button. There used to be a second blank header
                here for the per-row 🎤 — removed with voice entry, along with
                the matching <td> in both SetRow variants. */}
            <th></th>
          </tr>
        </thead>
        <tbody>
          {exercise.sets.map((s, i) => {
            const isActiveRow = activeSetIndex === i;
            const workingSetNumber =
              exercise.sets.slice(0, i).filter((x) => !x.warmup).length + 1;
            return (
            <Fragment key={i}>
              {pendingEntry && pendingEntry.setIndex === i ? (
                <tr><td colSpan={columnCount} className="p-0">
                  <SetEntryRow
                    set={s}
                    workingSetNumber={workingSetNumber}
                    workSeconds={pendingEntry.workSeconds}
                    timeBased={timeBased}
                    prescribedKg={exercise.prescribed.baseKg ?? null}
                    prescribedReps={exercise.prescribed.baseReps ?? null}
                    canRemove={exercise.sets.length > 1}
                    onChange={(patch) => patchSet(i, patch)}
                    onSave={() => onEntrySave({ exerciseIndex, setIndex: i })}
                    onRemove={() => removeSet(i)}
                  />
                </td></tr>
              ) : (
                <SetRow
                  userId={userId}
                  exerciseName={exercise.name}
                  excludeWorkoutExternalId={externalId}
                  set={s}
                  workingSetNumber={workingSetNumber}
                  isActive={isActiveRow}
                  editMode={editMode}
                  targetDurationSeconds={exercise.prescribed.duration_seconds ?? null}
                  target={
                    timeBased
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
                />
              )}
              {coachLineSetIndex === i && coachLine && (
                <tr><td colSpan={columnCount}>
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
                      onCoachLineDismiss();
                    }}
                  />
                </td></tr>
              )}
              {onTimerStart && isActiveRow && !midSet && (
                <tr><td colSpan={columnCount} className="pb-1">
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
            setRestDialog(false);
          }}
          onCancel={() => setRestDialog(false)}
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
