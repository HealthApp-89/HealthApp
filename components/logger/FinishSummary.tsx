"use client";

import type { LoggerDraft } from "@/lib/logger/types";
import { totalWorkSeconds } from "@/lib/logger/set-timer";
import { fmtNum } from "@/lib/ui/score";

type Props = {
  draft: LoggerDraft;
  durationMin: number;
  onConfirm: () => void;
  onCancel: () => void;
  saving: boolean;
  confirmLabel?: string;          // default: "Finish & save"
};

/** m:ss for a non-negative second count. Matches the local formatter every
 *  other logger component keeps for clock strings (SetTimerDock, SetEntryRow,
 *  RestTimeDialog, ExerciseCard) — a repo-wide convention, not something to
 *  centralize here. */
function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

export function FinishSummary({ draft, durationMin, onConfirm, onCancel, saving, confirmLabel }: Props) {
  let totalSets = 0;
  let totalVolume = 0;
  for (const ex of draft.exercises) {
    for (const s of ex.sets) {
      if (s.committed_at && s.kg !== null && s.reps !== null) {
        totalSets++;
        totalVolume += s.kg * s.reps;
      }
    }
  }

  // Work seconds: same filter as the dock's live WORK counter
  // (lib/logger/set-timer.ts:totalWorkSeconds) — committed sets with a
  // non-null work_seconds, regardless of whether they also carry kg/reps.
  // Deliberately NOT the totalSets/totalVolume filter above: a timed
  // bodyweight hold (plank, etc.) has neither kg nor reps but still has
  // honest work time, and this ratio is about time under load, not volume.
  //
  // Session length reuses the already-resolved `durationMin` prop rather
  // than recomputing from draft.started_at/paused_at here. The caller
  // branches on edit mode (stored draft.duration_min vs. live getElapsedMs) —
  // duplicating that branch inside this component would silently diverge in
  // edit mode, where the draft's timer anchors describe the ORIGINAL session,
  // not "now".
  const workSeconds = totalWorkSeconds(draft.exercises);
  const sessionSeconds = Math.max(1, Math.round(durationMin * 60));
  const restSeconds = Math.max(0, sessionSeconds - workSeconds);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 max-w-sm w-full">
        <h3 className="text-base font-semibold text-zinc-50 mb-3">{draft.session_type} · {Math.round(durationMin)} min</h3>
        <ul className="text-sm text-zinc-300 space-y-1 mb-4">
          <li>{draft.exercises.length} {draft.exercises.length === 1 ? "exercise" : "exercises"}</li>
          <li>{totalSets} {totalSets === 1 ? "set" : "sets"}</li>
          <li>Total volume: {fmtNum(totalVolume)} kg</li>
        </ul>
        {workSeconds > 0 && (
          // Hidden entirely when nothing was timed — a hand-logged session
          // has zero work seconds, and a 1:Infinity ratio is worse than no
          // line at all.
          <div className="text-[11px] text-zinc-400 font-mono tabular-nums mb-4 -mt-2">
            Work {formatClock(workSeconds)}
            {" · rest "}
            {formatClock(restSeconds)}
            {" · ratio 1:"}
            {fmtNum(restSeconds / workSeconds)}
          </div>
        )}
        <div className="flex gap-2">
          <button onClick={onConfirm} disabled={saving} className="flex-1 bg-green-600 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50">
            {saving ? "Saving…" : (confirmLabel ?? "Finish & save")}
          </button>
          <button onClick={onCancel} disabled={saving} className="flex-1 bg-zinc-800 text-zinc-300 rounded-lg py-2 text-sm">Back</button>
        </div>
      </div>
    </div>
  );
}
