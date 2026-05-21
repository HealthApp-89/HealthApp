"use client";

import { Fragment, useMemo, useState } from "react";
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
  onChange: (next: ExerciseDraft) => void;
  onReplace: () => void;
  onRemove: () => void;
};

export function ExerciseCard({
  userId, externalId, exercise, exerciseIndex, allExercises, onChange, onReplace, onRemove,
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

  function commitSet(setIndex: number) {
    const nowIso = new Date().toISOString();
    const now = Date.now();
    const nextSets = exercise.sets.map((s, i) => {
      if (i !== setIndex) return s;
      return { ...s, committed_at: nowIso };
    });

    // rest_seconds_actual on the NEXT pending set is captured at its own commit time.
    onChange({ ...exercise, sets: nextSets });
    setRestAfterSetIndex(setIndex);
    setActiveRestSeconds(effectiveRest);
    setActiveRestStartedAt(now);
  }

  function uncommitSet(setIndex: number) {
    const nextSets = exercise.sets.map((s, i) =>
      i === setIndex ? { ...s, committed_at: null } : s,
    );
    onChange({ ...exercise, sets: nextSets });
  }

  function patchSet(setIndex: number, patch: Partial<ExerciseSetDraft>) {
    const nextSets = exercise.sets.map((s, i) => (i === setIndex ? { ...s, ...patch } : s));
    onChange({ ...exercise, sets: nextSets });
  }

  function addSet() {
    const last = exercise.sets[exercise.sets.length - 1];
    const next: ExerciseSetDraft = {
      set_index: exercise.sets.length,
      kg: last?.kg ?? exercise.prescribed.baseKg ?? null,
      reps: null,
      warmup: false,
      failure: false,
      committed_at: null,
    };
    onChange({ ...exercise, sets: [...exercise.sets, next] });
  }

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
              <button onClick={() => { setMenuOpen(false); onReplace(); }} className="block w-full text-left px-2 py-1.5 hover:bg-zinc-700 rounded text-zinc-200">Replace</button>
              <button onClick={() => { setMenuOpen(false); setRestDialogOpen(true); }} className="block w-full text-left px-2 py-1.5 hover:bg-zinc-700 rounded text-zinc-200">Edit rest time</button>
              <button onClick={() => { setMenuOpen(false); onRemove(); }} className="block w-full text-left px-2 py-1.5 hover:bg-zinc-700 rounded text-red-400">Remove</button>
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
            <th className="text-left font-normal py-1">kg</th>
            <th className="text-left font-normal py-1">Reps</th>
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
                isActive={!s.committed_at && exercise.sets.findIndex((x) => !x.committed_at) === i}
                onChange={(patch) => patchSet(i, patch)}
                onCommit={() => commitSet(i)}
                onUncommit={() => uncommitSet(i)}
                onUnparsedVoice={setUnparsedBanner}
              />
              {restAfterSetIndex === i && (
                <tr><td colSpan={6}>
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
