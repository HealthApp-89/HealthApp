"use client";

import { COLOR, RADIUS } from "@/lib/ui/theme";

export function HistoryPickerDateBar({
  date,
  onChange,
  minDate,
  maxDate,
}: {
  date: string;
  onChange: (date: string) => void;
  minDate: string;
  maxDate: string;
}) {
  const dt = new Date(`${date}T00:00:00Z`);
  const prev = new Date(dt);
  prev.setUTCDate(prev.getUTCDate() - 1);
  const next = new Date(dt);
  next.setUTCDate(next.getUTCDate() + 1);
  const prevIso = prev.toISOString().slice(0, 10);
  const nextIso = next.toISOString().slice(0, 10);

  const canGoBack = prevIso >= minDate;
  const canGoForward = nextIso <= maxDate;

  return (
    <div
      className="flex items-center justify-between px-3 py-2"
      style={{ borderBottom: `1px solid ${COLOR.divider}` }}
    >
      <button
        type="button"
        onClick={() => canGoBack && onChange(prevIso)}
        disabled={!canGoBack}
        className="px-3 py-1 text-sm disabled:opacity-30"
        style={{ color: COLOR.textStrong }}
      >
        ◀
      </button>
      <input
        type="date"
        value={date}
        min={minDate}
        max={maxDate}
        onChange={(e) => onChange(e.target.value)}
        className="px-3 py-1 text-sm"
        style={{
          background: COLOR.surfaceAlt,
          border: `1px solid ${COLOR.divider}`,
          borderRadius: RADIUS.input,
          color: COLOR.textStrong,
        }}
      />
      <button
        type="button"
        onClick={() => canGoForward && onChange(nextIso)}
        disabled={!canGoForward}
        className="px-3 py-1 text-sm disabled:opacity-30"
        style={{ color: COLOR.textStrong }}
      >
        ▶
      </button>
    </div>
  );
}
