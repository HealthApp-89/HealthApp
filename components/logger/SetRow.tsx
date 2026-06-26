"use client";

import { useEffect, useRef, useState } from "react";
import type { ExerciseSetDraft } from "@/lib/logger/types";
import { usePreviousSet } from "@/lib/query/hooks/usePreviousSet";
import { VoiceMicButton } from "@/components/logger/VoiceMicButton";
import { fmtNum } from "@/lib/ui/score";
import { selectOnFocus } from "@/lib/ui/inputs";
import { fireRestDoneCue } from "@/lib/logger/rest-timer";

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
  onChange: (patch: Partial<ExerciseSetDraft>) => void;
  onCommit: () => void;
  onUncommit: () => void;
  onUnparsedVoice: (transcript: string) => void;
};

function fmtMmSs(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

export function SetRow({
  userId, exerciseName, excludeWorkoutExternalId, set, workingSetNumber,
  isActive, targetDurationSeconds, onChange, onCommit, onUncommit, onUnparsedVoice,
}: Props) {
  const [draftKg, setDraftKg] = useState<string>(set.kg !== null ? String(set.kg) : "");
  const [draftReps, setDraftReps] = useState<string>(set.reps !== null ? String(set.reps) : "");

  // Timer mode: local started_at (ms). Ticks every 250ms while running.
  // Resets when the set is uncommitted.
  const [timerStartedAt, setTimerStartedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const cueFiredRef = useRef(false);
  useEffect(() => {
    if (timerStartedAt == null) return;
    const id = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, [timerStartedAt]);
  const elapsedSeconds = timerStartedAt != null
    ? Math.floor((Date.now() - timerStartedAt) / 1000)
    : 0;
  useEffect(() => {
    if (timerStartedAt != null && targetDurationSeconds != null
        && elapsedSeconds >= targetDurationSeconds && !cueFiredRef.current) {
      cueFiredRef.current = true;
      fireRestDoneCue();
    }
  }, [timerStartedAt, elapsedSeconds, targetDurationSeconds]);
  // tick is read by the effects above via Date.now(); reference it so the
  // 250ms re-renders aren't dead-stripped.
  void tick;

  // Warmup rows don't get a "previous" hint — the column would either be
  // blank or, worse, surface last week's heavy working set as the comparison.
  const prev = usePreviousSet({
    userId,
    exerciseName,
    workingSetOrdinal: workingSetNumber,
    excludeWorkoutExternalId,
    enabled: !set.committed_at && !set.warmup,
  });

  const committed = !!set.committed_at;
  const [badgeOpen, setBadgeOpen] = useState(false);
  const setLabel = set.warmup ? "W" : set.failure ? "F" : String(workingSetNumber);
  const setBadgeClass = set.warmup
    ? "bg-yellow-500/15 text-yellow-300"
    : set.failure
      ? "bg-red-500/15 text-red-400"
      : "bg-zinc-800 text-zinc-200";

  // Time-based mode: replace the kg/reps inputs (and mic) with a countdown
  // timer + stop button. Tap ▶ to start, tap ⏹ to commit the elapsed time.
  // Counts down to 0 then keeps counting up so the user can run over the
  // prescribed seconds.
  if (targetDurationSeconds != null) {
    const isRunning = timerStartedAt != null && !committed;
    const targetReached = targetDurationSeconds != null
      && (isRunning ? elapsedSeconds >= targetDurationSeconds : false);
    const display = (() => {
      if (committed) {
        return `${set.duration_seconds ?? 0}s`;
      }
      if (!isRunning) return `${targetDurationSeconds}s`;
      if (targetReached) {
        return `+${fmtMmSs(elapsedSeconds - targetDurationSeconds)}`;
      }
      return fmtMmSs(targetDurationSeconds - elapsedSeconds);
    })();
    const onStart = () => {
      cueFiredRef.current = false;
      setTimerStartedAt(Date.now());
    };
    const onStop = () => {
      if (timerStartedAt == null) return;
      const actual = Math.max(0, Math.floor((Date.now() - timerStartedAt) / 1000));
      setTimerStartedAt(null);
      onChange({ duration_seconds: actual });
      // commitSet on parent reads the latest set; defer by a microtask so the
      // patch above is applied first.
      queueMicrotask(onCommit);
    };
    return (
      <tr>
        <td className="py-1 relative">
          <button
            type="button"
            onClick={() => setBadgeOpen((v) => !v)}
            className={`w-6 h-6 rounded-md text-[11px] font-semibold ${setBadgeClass}`}
            aria-label="Change set type"
          >
            {setLabel}
          </button>
          {badgeOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setBadgeOpen(false)} aria-hidden />
              <div className="absolute left-0 top-7 z-20 bg-zinc-800 border border-zinc-700 rounded-lg p-1 flex flex-col gap-0.5 min-w-[44px]" role="menu">
                <button type="button" onClick={() => { onChange({ warmup: false, failure: false }); setBadgeOpen(false); }} className="w-9 h-7 rounded text-[11px] font-semibold bg-zinc-800 text-zinc-200 hover:bg-zinc-700">{workingSetNumber}</button>
                <button type="button" onClick={() => { onChange({ warmup: true, failure: false }); setBadgeOpen(false); }} className="w-9 h-7 rounded text-[11px] font-semibold bg-yellow-500/15 text-yellow-300 hover:bg-yellow-500/25">W</button>
                <button type="button" onClick={() => { onChange({ warmup: false, failure: true }); setBadgeOpen(false); }} className="w-9 h-7 rounded text-[11px] font-semibold bg-red-500/15 text-red-400 hover:bg-red-500/25">F</button>
              </div>
            </>
          )}
        </td>
        <td className="py-1 text-[10.5px] text-zinc-600">
          {targetDurationSeconds}s target
        </td>
        <td className="py-1">
          {!committed && (
            <button
              type="button"
              onClick={isRunning ? onStop : onStart}
              className={`w-9 h-7 rounded-md text-[11px] font-semibold ${
                isRunning
                  ? "bg-red-500/20 text-red-300 hover:bg-red-500/30"
                  : "bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30"
              }`}
              aria-label={isRunning ? "Stop timer" : "Start timer"}
            >
              {isRunning ? "⏹" : "▶"}
            </button>
          )}
        </td>
        <td className="py-1">
          <span className={`font-mono tabular-nums text-[12px] ${
            committed
              ? "text-green-400"
              : targetReached
                ? "text-amber-300"
                : isRunning
                  ? "text-zinc-100"
                  : "text-zinc-500"
          }`}>
            {display}
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
            aria-label={committed ? "Uncommit set" : "Stop the timer first"}
          >
            {committed ? "✓" : "○"}
          </button>
        </td>
        <td className="py-1"></td>
      </tr>
    );
  }

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
                onClick={() => { onChange({ warmup: false, failure: false }); setBadgeOpen(false); }}
                className="w-9 h-7 rounded text-[11px] font-semibold bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
                role="menuitem"
              >
                {workingSetNumber}
              </button>
              <button
                type="button"
                onClick={() => { onChange({ warmup: true, failure: false }); setBadgeOpen(false); }}
                className="w-9 h-7 rounded text-[11px] font-semibold bg-yellow-500/15 text-yellow-300 hover:bg-yellow-500/25"
                role="menuitem"
              >
                W
              </button>
              <button
                type="button"
                onClick={() => { onChange({ warmup: false, failure: true }); setBadgeOpen(false); }}
                className="w-9 h-7 rounded text-[11px] font-semibold bg-red-500/15 text-red-400 hover:bg-red-500/25"
                role="menuitem"
              >
                F
              </button>
            </div>
          </>
        )}
      </td>
      <td className="py-1 text-[10.5px] text-zinc-600">
        {prev.data
          ? `${prev.data.kg === null ? "BW" : fmtNum(prev.data.kg)} × ${prev.data.reps ?? "—"}`
          : "—"}
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
    </tr>
  );
}
