"use client";

import { useEffect, useState } from "react";
import type { LoggerDraft } from "@/lib/logger/types";

type Props = {
  draft: LoggerDraft;
  onResume: () => void;
  onDiscard: () => void;
};

export function ResumeDraftPrompt({ draft, onResume, onDiscard }: Props) {
  const [committedCount, setCommittedCount] = useState(0);
  const [ageMin, setAgeMin] = useState(0);

  useEffect(() => {
    let n = 0;
    for (const ex of draft.exercises) {
      for (const s of ex.sets) {
        if (s.committed_at) n++;
      }
    }
    setCommittedCount(n);
    setAgeMin(Math.max(1, Math.round((Date.now() - new Date(draft.updated_at).getTime()) / 60000)));
  }, [draft]);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 max-w-sm w-full">
        <h3 className="text-base font-semibold text-zinc-50 mb-1">Resume {draft.session_type} session?</h3>
        <p className="text-sm text-zinc-400 mb-4">Started {ageMin} minutes ago — {committedCount} {committedCount === 1 ? "set" : "sets"} logged.</p>
        <div className="flex gap-2">
          <button onClick={onResume} className="flex-1 bg-green-600 text-white rounded-lg py-2 text-sm font-medium">Resume</button>
          <button onClick={onDiscard} className="flex-1 bg-zinc-800 text-zinc-300 rounded-lg py-2 text-sm">Discard</button>
        </div>
      </div>
    </div>
  );
}
