"use client";

import { useEffect, useRef, useState } from "react";
import type { ExerciseSetDraft } from "@/lib/logger/types";
import { usePreviousSet } from "@/lib/query/hooks/usePreviousSet";
import { VoiceMicButton } from "@/components/logger/VoiceMicButton";
import { fmtNum } from "@/lib/ui/score";
import { selectOnFocus } from "@/lib/ui/inputs";
import { formatMmSs } from "@/lib/logger/set-timer";

type Props = {
  userId: string;
  exerciseName: string;
  excludeWorkoutExternalId: string | null;
  set: ExerciseSetDraft;
  /** This set's position among non-warmup sets in the exercise (1-indexed).
   *  Computed by the parent so warmups don't consume a number — two warmups
   *  followed by a normal set show the normal one as "1", not "3". */
  workingSetNumber: number;
  isActive: boolean;
  /** True inside a hydrated historical-workout edit (EditSessionButton). Edit
   *  mode runs no live timer at all, so a time-based row has no dock and no
   *  "Start this set" affordance to reach — it needs its own hand-editable
   *  seconds field, the same way rep-based rows stay hand-editable there.
   *  Live (fresh-session) mode keeps the row dock-driven and commit-only via
   *  Save/auto-save, which is what closes the corruption path where a manual
   *  commit could stamp `committed_at` with `duration_seconds` still null. */
  editMode: boolean;
  /** When present, renders a countdown-timer set row (foam rolls, planks,
   *  dead hangs, etc.) instead of the kg/reps inputs. Counts down to 0 then
   *  continues counting up so the user can stop early or run over. */
  targetDurationSeconds: number | null;
  /** Prescribed load x reps @RIR for this exercise. Null for time-based work. */
  target: { kg: number | null; reps: number | null; rir: number | null } | null;
  /** When false, the Delete option in the badge popup is disabled — used by
   *  the parent to prevent removing the exercise's last remaining set. */
  canRemove: boolean;
  onChange: (patch: Partial<ExerciseSetDraft>) => void;
  onCommit: () => void;
  onUncommit: () => void;
  onRemove: () => void;
  onUnparsedVoice: (transcript: string) => void;
};

/**
 * Editable text for one numeric field, re-synced when the underlying value
 * changes underneath it.
 *
 * Plain `useState(initial)` is mount-only, which breaks two ways here:
 *  - an external write (ExerciseCard's coach-line apply-tap calling patchSet)
 *    never reaches the input, and a stray focus+blur then writes the stale
 *    text back over the applied value;
 *  - rows are keyed by array index, so deleting a set re-indexes the
 *    survivors and every row below it keeps the *previous* row's text while
 *    displaying a different set — one blur away from committing another
 *    set's numbers.
 *
 * The ref is what makes it safe: only a change to the PROP re-syncs, so
 * in-progress typing (which moves `text` but not `propText`) is never fought.
 */
function useSyncedDraft(propText: string) {
  const [text, setText] = useState(propText);
  const lastProp = useRef(propText);
  useEffect(() => {
    if (propText !== lastProp.current) {
      lastProp.current = propText;
      setText(propText);
    }
  }, [propText]);
  return [text, setText] as const;
}

export function SetRow({
  userId, exerciseName, excludeWorkoutExternalId, set, workingSetNumber,
  isActive, editMode, targetDurationSeconds, target, canRemove, onChange, onCommit, onUncommit, onRemove, onUnparsedVoice,
}: Props) {
  const [draftKg, setDraftKg] = useSyncedDraft(set.kg !== null ? String(set.kg) : "");
  const [draftReps, setDraftReps] = useSyncedDraft(set.reps !== null ? String(set.reps) : "");
  const [draftRir, setDraftRir] = useSyncedDraft(
    set.rir !== null && set.rir !== undefined ? String(set.rir) : "",
  );
  const [draftSeconds, setDraftSeconds] = useSyncedDraft(
    set.duration_seconds !== null ? String(set.duration_seconds) : "",
  );

  const timeBased = targetDurationSeconds != null;

  // Warmup rows don't get a "previous" hint — the column would either be
  // blank or, worse, surface last week's heavy working set as the comparison.
  // Time-based rows never show it either (their "target" cell carries the
  // held-seconds goal instead — see below), so skip the fetch entirely.
  const prev = usePreviousSet({
    userId,
    exerciseName,
    workingSetOrdinal: workingSetNumber,
    excludeWorkoutExternalId,
    enabled: !set.committed_at && !set.warmup && !timeBased,
  });

  const committed = !!set.committed_at;
  const [badgeOpen, setBadgeOpen] = useState(false);

  // Per-row work stamp for a committed, TIMED set. Rendered inside the
  // existing Target/prev cell — no extra <td>, so both the 6-column
  // (time-based) and 7-column (rep-based) variants still match their headers.
  // Null `work_seconds` renders NOTHING at all: hand-logged sets, Strong CSV
  // imports and pre-0056 rows are legitimately untimed, and a "0s" or a dashed
  // chip would assert a measurement that was never taken.
  const workStamp = committed && set.work_seconds != null
    ? `◷ ${formatMmSs(set.work_seconds)}`
    : null;

  // Badge selection owns the failure⇄RIR coupling: F means 0 reps in reserve
  // by definition, so it auto-fills rir=0 (draft synced — it's local state).
  // Leaving F undoes the auto-fill only when rir is still 0, so a hand-typed
  // value survives badge fiddling.
  const selectBadge = (next: { warmup: boolean; failure: boolean }) => {
    if (next.failure) {
      onChange({ ...next, rir: 0 });
      setDraftRir("0");
    } else if (set.failure && set.rir === 0) {
      onChange({ ...next, rir: null });
      setDraftRir("");
    } else {
      onChange(next);
    }
    setBadgeOpen(false);
  };
  const setLabel = set.warmup ? "W" : set.failure ? "F" : String(workingSetNumber);
  const setBadgeClass = set.warmup
    ? "bg-yellow-500/15 text-yellow-300"
    : set.failure
      ? "bg-red-500/15 text-red-400"
      : "bg-zinc-800 text-zinc-200";

  return (
    <tr>
      <td className="py-1 relative">
        <button
          type="button"
          onClick={() => setBadgeOpen((v) => !v)}
          className={`w-6 h-6 rounded-md text-[11px] font-semibold ${setBadgeClass}`}
          aria-label="Change set type"
          aria-haspopup="menu"
          aria-expanded={badgeOpen}
        >
          {setLabel}
        </button>
        {badgeOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setBadgeOpen(false)} aria-hidden />
            <div className="absolute left-0 top-7 z-20 bg-zinc-800 border border-zinc-700 rounded-lg p-1 flex flex-col gap-0.5 min-w-[44px]" role="menu">
              <button
                type="button"
                onClick={() => selectBadge({ warmup: false, failure: false })}
                className="w-9 h-7 rounded text-[11px] font-semibold bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
                role="menuitem"
              >
                {workingSetNumber}
              </button>
              <button
                type="button"
                onClick={() => selectBadge({ warmup: true, failure: false })}
                className="w-9 h-7 rounded text-[11px] font-semibold bg-yellow-500/15 text-yellow-300 hover:bg-yellow-500/25"
                role="menuitem"
              >
                W
              </button>
              <button
                type="button"
                onClick={() => selectBadge({ warmup: false, failure: true })}
                className="w-9 h-7 rounded text-[11px] font-semibold bg-red-500/15 text-red-400 hover:bg-red-500/25"
                role="menuitem"
              >
                F
              </button>
              <button
                type="button"
                onClick={() => { onRemove(); setBadgeOpen(false); }}
                disabled={!canRemove}
                className="w-9 h-7 rounded text-[11px] font-semibold bg-zinc-900 text-zinc-400 hover:bg-red-500/20 hover:text-red-300 disabled:opacity-30 disabled:cursor-not-allowed border-t border-zinc-700 mt-0.5"
                role="menuitem"
                aria-label="Delete set"
                title={canRemove ? "Delete this set" : "Can't delete the last remaining set — remove the exercise instead"}
              >
                ✕
              </button>
            </div>
          </>
        )}
      </td>
      {timeBased ? (
        // Time-based row. Live mode: no per-row start/stop control — the
        // docked session-level circle drives it (see SetTimerDock /
        // LoggerSheet's handleStart/handleStop), this row only shows the
        // target and, once the dock's zoom (SetEntryRow) has saved a value,
        // the result. Committing there deliberately requires going through
        // the dock — typing straight into this row is not offered, which is
        // what keeps a manual commit from ever stamping `committed_at` with
        // `duration_seconds` still null.
        //
        // Edit mode: there IS no dock (edit mode runs no live timer at all —
        // see LoggerSheet's `!props.editMode &&` guards around both the dock
        // and onTimerStart), so that affordance does not exist to fall back
        // to. This row is the only commit path a hydrated time-based set has,
        // so it gets its own hand-editable seconds field here, matching how
        // the rep-based row below stays hand-editable in edit mode too.
        <>
          <td className="py-1 text-[10.5px] text-zinc-600 leading-tight">
            <div>{targetDurationSeconds}s target</div>
            {workStamp && (
              <div className="font-mono tabular-nums" title="Time under load">{workStamp}</div>
            )}
          </td>
          <td className="py-1"></td>
          <td className="py-1">
            {editMode ? (
              // Same disabled-on-commit treatment as the kg/reps/rir inputs
              // below, not a mount/unmount swap — consistent with how every
              // other hand-editable field in this row behaves once committed.
              <input
                inputMode="numeric"
                value={draftSeconds}
                onChange={(e) => { setDraftSeconds(e.target.value); }}
                onFocus={selectOnFocus}
                onBlur={() => {
                  const n = draftSeconds === "" ? null : parseInt(draftSeconds, 10);
                  onChange({ duration_seconds: Number.isFinite(n as number) ? (n as number) : null });
                }}
                disabled={committed}
                aria-label="Seconds held"
                placeholder="secs"
                className={`bg-zinc-800 border-none rounded-md px-1.5 py-1 w-14 text-center font-medium font-mono tabular-nums ${
                  committed ? "text-green-400 bg-green-500/10" : "text-zinc-100"
                }`}
              />
            ) : (
              <span className={`font-mono tabular-nums text-[12px] ${
                committed ? "text-green-400" : "text-zinc-500"
              }`}>
                {/* An em dash, not "0s". A committed hold with no recorded
                    duration (hand-logged, Strong CSV import, pre-0056 row)
                    genuinely has no value — printing 0s asserts the athlete
                    held it for zero seconds. */}
                {committed ? (set.duration_seconds != null ? `${set.duration_seconds}s` : "—") : "—"}
              </span>
            )}
          </td>
          <td className="py-1">
            <button
              type="button"
              onClick={committed ? onUncommit : editMode ? onCommit : undefined}
              disabled={committed ? false : editMode ? set.duration_seconds === null : true}
              className={`w-6 h-6 rounded-md flex items-center justify-center text-[12px] ${
                committed
                  ? "bg-green-500 text-green-950"
                  : editMode && set.duration_seconds !== null
                    ? "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                    : "bg-zinc-800 text-zinc-600"
              }`}
              aria-label={
                committed
                  ? "Uncommit set"
                  : editMode
                    ? "Commit set"
                    : "Use the timer below to log this set"
              }
            >
              {committed ? "✓" : "○"}
            </button>
          </td>
          <td className="py-1"></td>
        </>
      ) : (
        <>
          <td className="py-1 text-[10.5px] leading-tight">
            {target && (target.kg != null || target.reps != null) && (
              <div className="text-zinc-300 font-mono tabular-nums">
                {target.kg != null ? fmtNum(target.kg) : "BW"}
                {target.reps != null ? ` × ${target.reps}` : ""}
                {target.rir != null ? ` @${target.rir}` : ""}
              </div>
            )}
            <div className="text-zinc-600">
              {/* Second line of the cell, one thing at a time. The previous-set
                  hint is a pre-set aid — `usePreviousSet` is disabled once the
                  row commits — so on a committed timed row the work stamp
                  takes the slot rather than adding a third line and breaking
                  the table's density. A committed UNTIMED row keeps whatever
                  it showed before. */}
              {workStamp ? (
                <span className="font-mono tabular-nums" title="Time under load">{workStamp}</span>
              ) : prev.data ? (
                <span title={prev.data.fallback ? `Last available set on ${prev.data.workout_date}` : prev.data.workout_date}>
                  {prev.data.kg === null ? "BW" : fmtNum(prev.data.kg)} × {prev.data.reps ?? "—"}
                  {prev.data.fallback && <span className="text-zinc-700">·</span>}
                </span>
              ) : "—"}
            </div>
          </td>
          <td className="py-1">
            <input
              inputMode="decimal"
              value={draftKg}
              onChange={(e) => { setDraftKg(e.target.value); }}
              onFocus={selectOnFocus}
              onBlur={() => {
                const n = draftKg === "" ? null : parseFloat(draftKg);
                onChange({ kg: Number.isFinite(n as number) ? (n as number) : null });
              }}
              disabled={committed}
              className={`bg-zinc-800 border-none rounded-md px-1.5 py-1 w-14 text-center font-medium font-mono tabular-nums ${
                committed ? "text-green-400 bg-green-500/10" : "text-zinc-100"
              }`}
            />
          </td>
          <td className="py-1">
            <input
              inputMode="numeric"
              value={draftReps}
              onChange={(e) => { setDraftReps(e.target.value); }}
              onFocus={selectOnFocus}
              onBlur={() => {
                const n = draftReps === "" ? null : parseInt(draftReps, 10);
                onChange({ reps: Number.isFinite(n as number) ? (n as number) : null });
              }}
              disabled={committed}
              className={`bg-zinc-800 border-none rounded-md px-1.5 py-1 w-12 text-center font-medium font-mono tabular-nums ${
                committed ? "text-green-400 bg-green-500/10" : "text-zinc-100"
              }`}
            />
          </td>
          <td className="py-1">
            <input
              inputMode="numeric"
              value={draftRir}
              onChange={(e) => { setDraftRir(e.target.value); }}
              onFocus={selectOnFocus}
              onBlur={() => {
                const n = draftRir === "" ? null : parseInt(draftRir, 10);
                const clamped = n === null || !Number.isFinite(n) ? null : Math.max(0, Math.min(10, n));
                onChange({ rir: clamped });
              }}
              disabled={committed}
              aria-label="Reps in reserve"
              placeholder="RIR"
              className={`bg-zinc-800 border-none rounded-md px-1.5 py-1 w-12 text-center font-medium font-mono tabular-nums ${
                committed ? "text-green-400 bg-green-500/10" : "text-zinc-100"
              }`}
            />
          </td>
          <td className="py-1">
            <button
              type="button"
              onClick={committed ? onUncommit : onCommit}
              disabled={(!committed && (set.kg === null && !set.warmup)) || (!committed && set.reps === null)}
              className={`w-6 h-6 rounded-md flex items-center justify-center text-[12px] ${
                committed
                  ? "bg-green-500 text-green-950"
                  : isActive
                    ? "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                    : "bg-zinc-800 text-zinc-500"
              }`}
              aria-label={committed ? "Uncommit set" : "Commit set"}
            >
              {committed ? "✓" : "○"}
            </button>
          </td>
          <td className="py-1">
            <VoiceMicButton
              disabled={committed}
              onParsed={(p) => {
                setDraftKg(p.kg !== null ? String(p.kg) : "");
                setDraftReps(String(p.reps));
                onChange({ kg: p.kg, reps: p.reps });
                onCommit();
              }}
              onUnparsed={onUnparsedVoice}
            />
          </td>
        </>
      )}
    </tr>
  );
}
