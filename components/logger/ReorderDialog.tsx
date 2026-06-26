"use client";

import { useState } from "react";
import type { ExerciseDraft } from "@/lib/logger/types";

type Props = {
  exercises: ExerciseDraft[];
  onConfirm: (next: ExerciseDraft[]) => void;
  onCancel: () => void;
};

function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const clamped = Math.max(0, Math.min(to, list.length - 1));
  const copy = [...list];
  const [item] = copy.splice(from, 1);
  copy.splice(clamped, 0, item);
  return copy;
}

export function ReorderDialog({ exercises, onConfirm, onCancel }: Props) {
  const [local, setLocal] = useState<ExerciseDraft[]>(exercises);
  // Per-row text buffer so typing "12" on a 10-item list doesn't snap mid-type.
  const [posDraft, setPosDraft] = useState<Record<string, string>>({});

  function bump(from: number, delta: -1 | 1) {
    setLocal((prev) => moveItem(prev, from, from + delta));
    setPosDraft({});
  }

  function commitPosInput(from: number, raw: string) {
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
      setPosDraft((s) => {
        const next = { ...s };
        delete next[String(from)];
        return next;
      });
      return;
    }
    // User-facing positions are 1-based.
    const targetIdx = parsed - 1;
    setLocal((prev) => moveItem(prev, from, targetIdx));
    setPosDraft({});
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-t-2xl sm:rounded-2xl p-4 max-w-md w-full h-[100dvh] sm:h-auto sm:max-h-[85dvh] flex flex-col">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-base font-semibold text-zinc-50">Reorder exercises</h3>
          <button
            onClick={onCancel}
            className="text-zinc-500 hover:text-zinc-300 text-lg leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <p className="text-xs text-zinc-500 mb-3">
          Use ↑ ↓ to nudge, or type a position to jump. Others shift to make room.
        </p>

        <div className="overflow-y-auto -mx-1 px-1 flex-1">
          <ul className="space-y-1.5">
            {local.map((ex, i) => {
              const posKey = String(i);
              const inputValue = posDraft[posKey] ?? String(i + 1);
              return (
                <li
                  key={`${ex.name}-${i}`}
                  className="flex items-center gap-2 bg-zinc-800/60 border border-zinc-800 rounded-lg p-2"
                >
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={local.length}
                    value={inputValue}
                    onChange={(e) =>
                      setPosDraft((s) => ({ ...s, [posKey]: e.target.value }))
                    }
                    onBlur={(e) => {
                      if (e.target.value !== String(i + 1)) {
                        commitPosInput(i, e.target.value);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitPosInput(i, (e.target as HTMLInputElement).value);
                      }
                    }}
                    className="w-10 bg-zinc-900 border border-zinc-700 rounded text-center text-sm text-zinc-100 py-1 tabular-nums"
                    aria-label={`Position for ${ex.name}`}
                  />
                  <span className="flex-1 text-sm text-zinc-100 truncate">{ex.name}</span>
                  <div className="flex gap-0.5">
                    <button
                      type="button"
                      onClick={() => bump(i, -1)}
                      disabled={i === 0}
                      className="w-8 h-8 flex items-center justify-center text-zinc-300 bg-zinc-900 border border-zinc-700 rounded disabled:opacity-30 disabled:cursor-not-allowed hover:bg-zinc-700"
                      aria-label={`Move ${ex.name} up`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => bump(i, 1)}
                      disabled={i === local.length - 1}
                      className="w-8 h-8 flex items-center justify-center text-zinc-300 bg-zinc-900 border border-zinc-700 rounded disabled:opacity-30 disabled:cursor-not-allowed hover:bg-zinc-700"
                      aria-label={`Move ${ex.name} down`}
                    >
                      ↓
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="sticky bottom-0 left-0 right-0 bg-zinc-900 flex gap-2 mt-3 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))] -mx-4 px-4 border-t border-zinc-800">
          <button
            onClick={onCancel}
            className="flex-1 bg-zinc-800 text-zinc-300 rounded-lg py-2 text-sm"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(local)}
            className="flex-1 bg-green-600 text-white rounded-lg py-2 text-sm font-medium"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
