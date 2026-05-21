"use client";

import { useState } from "react";

const PRESETS = [30, 60, 90, 120, 150, 180, 240, 300];

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type Props = {
  initialSeconds: number;
  exerciseName: string;
  onConfirm: (seconds: number) => void;
  onCancel: () => void;
};

export function RestTimeDialog({ initialSeconds, exerciseName, onConfirm, onCancel }: Props) {
  const [seconds, setSeconds] = useState(initialSeconds);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 max-w-sm w-full">
        <h3 className="text-base font-semibold text-zinc-50 mb-1">Rest time</h3>
        <p className="text-xs text-zinc-500 mb-4">{exerciseName}</p>

        <div className="grid grid-cols-4 gap-2 mb-4">
          {PRESETS.map((p) => {
            const active = seconds === p;
            return (
              <button
                key={p}
                type="button"
                onClick={() => setSeconds(p)}
                className={`py-2 rounded-lg text-sm font-mono tabular-nums ${
                  active
                    ? "bg-blue-500 text-white"
                    : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                }`}
              >
                {fmt(p)}
              </button>
            );
          })}
        </div>

        <label className="block mb-4">
          <span className="text-xs text-zinc-500">Custom (seconds)</span>
          <input
            type="number"
            inputMode="numeric"
            min={10}
            max={900}
            value={seconds}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (Number.isFinite(n) && n >= 10 && n <= 900) setSeconds(n);
            }}
            onFocus={(e) => e.currentTarget.select()}
            className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded-md px-2 py-1.5 text-sm text-zinc-100 font-mono tabular-nums"
          />
        </label>

        <div className="flex gap-2">
          <button
            onClick={() => onConfirm(seconds)}
            className="flex-1 bg-green-600 text-white rounded-lg py-2 text-sm font-medium"
          >
            Use {fmt(seconds)}
          </button>
          <button
            onClick={onCancel}
            className="flex-1 bg-zinc-800 text-zinc-300 rounded-lg py-2 text-sm"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
