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
  /**
   * If provided, picker changes call this and DO NOT navigate. URL-mode
   * (legacy) leaves this undefined and pushes `/strength?view=date&date=...`
   * so the server re-renders with the new day.
   */
  onChange?: (date: string) => void;
};

/** Date picker for /strength?view=date. */
export function DateNavigator({ date, min, max, onChange }: Props) {
  const router = useRouter();

  function handleChange(next: string) {
    if (!next || next === date) return;
    if (onChange) {
      onChange(next);
    } else {
      router.push(`/strength?view=date&date=${next}`);
    }
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
          onChange={(e) => handleChange(e.target.value)}
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
