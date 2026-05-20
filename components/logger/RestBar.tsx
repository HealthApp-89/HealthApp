"use client";

import { useEffect } from "react";
import { useRestCountdown, fireRestDoneCue } from "@/lib/logger/rest-timer";

type Props = {
  duration_seconds: number;
  started_at: number | null;
  onDone: () => void;
  onSkip: () => void;
};

export function RestBar({ duration_seconds, started_at, onDone, onSkip }: Props) {
  const { remaining_seconds, elapsed_seconds, isRunning } = useRestCountdown({
    duration_seconds,
    started_at,
    onDone: () => { fireRestDoneCue(); onDone(); },
  });

  // Component cleanup — no-op currently, kept for future safety.
  useEffect(() => () => {}, []);

  if (!isRunning) return null;

  const pct = Math.min(100, (elapsed_seconds / duration_seconds) * 100);
  const mins = Math.floor(remaining_seconds / 60);
  const secs = remaining_seconds % 60;
  const label = `${mins}:${secs.toString().padStart(2, "0")}`;
  const prescribedMins = Math.floor(duration_seconds / 60);
  const prescribedSecs = duration_seconds % 60;
  const prescribedLabel = `${prescribedMins}:${prescribedSecs.toString().padStart(2, "0")}`;

  return (
    <div className="flex items-center gap-2 py-1 px-1 text-blue-400 text-[10px]">
      <span className="font-medium font-mono">{prescribedLabel}</span>
      <button
        type="button"
        onClick={onSkip}
        aria-label="Skip rest"
        className="flex-1 h-[3px] bg-blue-500/15 rounded-full overflow-hidden"
      >
        <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${pct}%` }} />
      </button>
      <span className="font-mono tabular-nums">{label}</span>
    </div>
  );
}
