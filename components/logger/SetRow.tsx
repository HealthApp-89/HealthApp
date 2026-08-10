"use client";

import { useEffect, useRef, useState } from "react";
import type { ExerciseSetDraft } from "@/lib/logger/types";
import { usePreviousSet } from "@/lib/query/hooks/usePreviousSet";
import { VoiceMicButton } from "@/components/logger/VoiceMicButton";
import { fmtNum } from "@/lib/ui/score";
import { selectOnFocus } from "@/lib/ui/inputs";

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

export function SetRow({
  userId, exerciseName, excludeWorkoutExternalId, set, workingSetNumber,
  isActive, targetDurationSeconds, target, canRemove, onChange, onCommit, onUncommit, onRemove, onUnparsedVoice,
}: Props) {
  const [draftKg, setDraftKg] = useState<string>(set.kg !== null ? String(set.kg) : "");
  const [draftReps, setDraftReps] = useState<string>(set.reps !== null ? String(set.reps) : "");
  const [draftRir, setDraftRir] = useState<string>(set.rir !== null && set.rir !== undefined ? String(set.rir) : "");

  // draftKg is otherwise mount-only local state, so an external write to
  // set.kg (the apply-tap in ExerciseCard calling patchSet directly) would
  // never reach this input — the box would keep showing stale/blank text,
  // and a stray focus+blur with no typing would then overwrite the applied
  // value back to null via the onBlur handler below. Re-sync draftKg only
  // when the PROP itself changes (tracked via a ref so in-progress typing,
  // which changes draftKg but not set.kg, is never fought).
  const lastKgProp = useRef(set.kg);
  useEffect(() => {
    if (set.kg !== lastKgProp.current) {
      lastKgProp.current = set.kg;
      setDraftKg(set.kg !== null ? String(set.kg) : "");
    }
  }, [set.kg]);

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
        // Time-based row: no per-row start/stop control anymore — the docked
        // session-level circle drives it (see SetTimerDock / LoggerSheet's
        // handleStart/handleStop). This row only ever shows the target and,
        // once the dock's zoom (SetEntryRow) has saved a value, the result.
        // There is deliberately no way to type a duration here: committing
        // one requires going through the dock, the same as every other
        // exercise type now that the old inline timer is gone.
        <>
          <td className="py-1 text-[10.5px] text-zinc-600">
            {targetDurationSeconds}s target
          </td>
          <td className="py-1"></td>
          <td className="py-1">
            <span className={`font-mono tabular-nums text-[12px] ${
              committed ? "text-green-400" : "text-zinc-500"
            }`}>
              {committed ? `${set.duration_seconds ?? 0}s` : "—"}
            </span>
          </td>
          <td className="py-1">
            <button
              type="button"
              onClick={committed ? onUncommit : undefined}
              disabled={!committed}
              className={`w-6 h-6 rounded-md flex items-center justify-center text-[12px] ${
                committed ? "bg-green-500 text-green-950" : "bg-zinc-800 text-zinc-600"
              }`}
              aria-label={committed ? "Uncommit set" : "Use the timer below to log this set"}
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
              {prev.data ? (
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
