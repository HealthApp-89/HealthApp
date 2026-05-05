"use client";

import { useRouter } from "next/navigation";
import { COLOR } from "@/lib/ui/theme";

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
      style={{ background: COLOR.surface, border: `1px solid ${COLOR.divider}`, boxShadow: "0 2px 8px rgba(20,30,80,0.05)" }}
    >
      <div className="flex flex-col gap-1">
        <label className="text-[10px] uppercase tracking-[0.12em]" style={{ color: COLOR.textMuted }}>
          Workout date
        </label>
        <input
          type="date"
          value={date}
          min={min}
          max={max}
          onChange={(e) => onChange(e.target.value)}
          className="rounded-lg px-2.5 py-1.5 text-sm font-mono outline-none"
          style={{
            background: COLOR.surfaceAlt,
            border: `1px solid ${COLOR.divider}`,
            color: COLOR.textStrong,
          }}
        />
      </div>
    </div>
  );
}
