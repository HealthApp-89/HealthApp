"use client";

import { useRouter } from "next/navigation";

type Props = {
  /** Currently selected ISO date (YYYY-MM-DD). */
  date: string;
  /** Earliest workout in the user's history, capped low end of the picker. */
  min?: string;
  /** Latest workout date — usually today. */
  max?: string;
};

/** Date picker for /strength?view=date — pushes a new URL on change so the
 *  server re-renders with that day's workouts. Same pattern as LogForm's picker. */
export function DateNavigator({ date, min, max }: Props) {
  const router = useRouter();

  function onChange(next: string) {
    if (!next || next === date) return;
    router.push(`/strength?view=date&date=${next}`);
  }

  return (
    <div
      className="rounded-[14px] px-4 py-3 flex items-center justify-between gap-3"
      style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.07)" }}
    >
      <div className="flex flex-col gap-1">
        <label className="text-[10px] uppercase tracking-[0.12em] text-white/40">
          Workout date
        </label>
        <input
          type="date"
          value={date}
          min={min}
          max={max}
          onChange={(e) => onChange(e.target.value)}
          className="bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-sm font-mono outline-none focus:border-white/30 text-white"
        />
      </div>
    </div>
  );
}
