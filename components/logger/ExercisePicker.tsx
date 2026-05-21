"use client";

import { useMemo, useState } from "react";
import { EXERCISE_MUSCLES } from "@/lib/coach/exercise-muscles";

type Props = {
  onPick: (name: string) => void;
  onClose: () => void;
};

export function ExercisePicker({ onPick, onClose }: Props) {
  const [q, setQ] = useState("");

  const candidates = useMemo(() => {
    const all = Object.keys(EXERCISE_MUSCLES);
    if (!q.trim()) return all.slice(0, 30);
    const lower = q.trim().toLowerCase();
    return all.filter((n) => n.toLowerCase().includes(lower)).slice(0, 30);
  }, [q]);

  const showFreeText = q.trim().length > 0 &&
    !candidates.some((n) => n.toLowerCase() === q.trim().toLowerCase());

  return (
    <div className="fixed inset-0 bg-black/60 flex items-end z-50">
      <div className="bg-zinc-950 border-t border-zinc-800 rounded-t-2xl w-full max-h-[80vh] flex flex-col">
        <div className="p-3 border-b border-zinc-800 flex items-center gap-2">
          <input
            autoFocus
            placeholder="Search exercises…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close exercise picker"
            className="w-9 h-9 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 flex items-center justify-center text-lg leading-none flex-shrink-0"
          >
            ×
          </button>
        </div>
        <div className="overflow-y-auto flex-1">
          {showFreeText && (
            <button
              onClick={() => onPick(q.trim())}
              className="w-full text-left px-3 py-2.5 text-sm text-blue-400 border-b border-zinc-800 hover:bg-zinc-900"
            >
              Use &ldquo;{q.trim()}&rdquo; (new exercise)
            </button>
          )}
          {candidates.map((name) => (
            <button
              key={name}
              onClick={() => onPick(name)}
              className="w-full text-left px-3 py-2.5 text-sm text-zinc-200 hover:bg-zinc-900 border-b border-zinc-900"
            >
              {name}
            </button>
          ))}
        </div>
        <button onClick={onClose} className="p-3 text-center text-zinc-500 text-sm border-t border-zinc-800">
          Cancel
        </button>
      </div>
    </div>
  );
}
