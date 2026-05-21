"use client";

import { useState } from "react";
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
  isActive: boolean;
  onChange: (patch: Partial<ExerciseSetDraft>) => void;
  onCommit: () => void;
  onUncommit: () => void;
  onUnparsedVoice: (transcript: string) => void;
};

export function SetRow({
  userId, exerciseName, excludeWorkoutExternalId, set,
  isActive, onChange, onCommit, onUncommit, onUnparsedVoice,
}: Props) {
  const [draftKg, setDraftKg] = useState<string>(set.kg !== null ? String(set.kg) : "");
  const [draftReps, setDraftReps] = useState<string>(set.reps !== null ? String(set.reps) : "");

  const prev = usePreviousSet({
    userId,
    exerciseName,
    setIndex: set.set_index,
    excludeWorkoutExternalId,
    enabled: !set.committed_at,
  });

  const committed = !!set.committed_at;
  const [badgeOpen, setBadgeOpen] = useState(false);
  const setLabel = set.warmup ? "W" : set.failure ? "F" : String(set.set_index + 1);
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
                onClick={() => { onChange({ warmup: false, failure: false }); setBadgeOpen(false); }}
                className="w-9 h-7 rounded text-[11px] font-semibold bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
                role="menuitem"
              >
                {set.set_index + 1}
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
          className={`bg-zinc-800 border-none rounded-md px-1.5 py-1 w-10 text-center text-[12px] font-medium font-mono tabular-nums ${
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
          className={`bg-zinc-800 border-none rounded-md px-1.5 py-1 w-10 text-center text-[12px] font-medium font-mono tabular-nums ${
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
