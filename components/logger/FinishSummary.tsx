"use client";

import type { LoggerDraft } from "@/lib/logger/types";
import { fmtNum } from "@/lib/ui/score";

type Props = {
  draft: LoggerDraft;
  durationMin: number;
  onConfirm: () => void;
  onCancel: () => void;
  saving: boolean;
};

export function FinishSummary({ draft, durationMin, onConfirm, onCancel, saving }: Props) {
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

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 max-w-sm w-full">
        <h3 className="text-base font-semibold text-zinc-50 mb-3">{draft.session_type} · {Math.round(durationMin)} min</h3>
        <ul className="text-sm text-zinc-300 space-y-1 mb-4">
          <li>{draft.exercises.length} {draft.exercises.length === 1 ? "exercise" : "exercises"}</li>
          <li>{totalSets} {totalSets === 1 ? "set" : "sets"}</li>
          <li>Total volume: {fmtNum(totalVolume)} kg</li>
        </ul>
        <div className="flex gap-2">
          <button onClick={onConfirm} disabled={saving} className="flex-1 bg-green-600 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50">
            {saving ? "Saving…" : "Finish & save"}
          </button>
          <button onClick={onCancel} disabled={saving} className="flex-1 bg-zinc-800 text-zinc-300 rounded-lg py-2 text-sm">Back</button>
        </div>
      </div>
    </div>
  );
}
