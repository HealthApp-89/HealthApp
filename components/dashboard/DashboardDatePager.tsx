"use client";

import { useRouter } from "next/navigation";
import { useRef, useTransition } from "react";

type Props = {
  /** ISO `YYYY-MM-DD` of the day currently being viewed. */
  selectedDate: string;
  /** Real today's ISO date — anchors the "Today" label and caps the picker. */
  today: string;
  /** Earliest date the user has any logged data. Caps the picker low end. */
  minDate?: string | null;
};

function shiftIso(iso: string, deltaDays: number): string {
  const t = new Date(iso + "T00:00:00Z").getTime();
  return new Date(t + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

function humanLabel(selected: string, today: string): string {
  if (selected === today) return "Today";
  if (selected === shiftIso(today, -1)) return "Yesterday";
  // "Mon, 30 Apr 2026" — short and unambiguous.
  return new Date(selected + "T00:00:00Z").toLocaleDateString("en-US", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Chevron pager + native date input that drives the dashboard's `?date=` URL.
 *  Today renders as a clean `/`; any other day pushes `/?date=YYYY-MM-DD` so
 *  the server component re-fetches. Prev/next clamp to [minDate, today]. */
export function DashboardDatePager({ selectedDate, today, minDate }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const pickerRef = useRef<HTMLInputElement | null>(null);

  const atMin = !!minDate && selectedDate <= minDate;
  const atMax = selectedDate >= today;

  const go = (next: string) => {
    if (next === selectedDate) return;
    if (minDate && next < minDate) return;
    if (next > today) return;
    const href = next === today ? "/" : `/?date=${next}`;
    startTransition(() => router.push(href));
  };

  return (
    <div
      className="rounded-[14px] px-2.5 py-1.5 flex items-center justify-between gap-2"
      style={{
        background: "rgba(255,255,255,0.025)",
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <button
        type="button"
        aria-label="Previous day"
        disabled={atMin || isPending}
        onClick={() => go(shiftIso(selectedDate, -1))}
        className="rounded-[10px] w-9 h-9 flex items-center justify-center text-base text-white/55 disabled:opacity-30 active:scale-[0.95] active:bg-white/10 touch-manipulation select-none transition-transform"
      >
        ‹
      </button>

      <button
        type="button"
        onClick={() => pickerRef.current?.showPicker?.()}
        className="flex-1 min-w-0 text-center text-xs uppercase tracking-[0.12em] font-semibold text-white/70 active:scale-[0.97] active:bg-white/5 rounded-[10px] py-2 touch-manipulation select-none transition-transform"
      >
        {humanLabel(selectedDate, today)}
      </button>

      <input
        ref={pickerRef}
        type="date"
        value={selectedDate}
        min={minDate ?? undefined}
        max={today}
        onChange={(e) => e.target.value && go(e.target.value)}
        className="sr-only"
        aria-label="Pick a date"
      />

      <button
        type="button"
        aria-label="Next day"
        disabled={atMax || isPending}
        onClick={() => go(shiftIso(selectedDate, 1))}
        className="rounded-[10px] w-9 h-9 flex items-center justify-center text-base text-white/55 disabled:opacity-30 active:scale-[0.95] active:bg-white/10 touch-manipulation select-none transition-transform"
      >
        ›
      </button>
    </div>
  );
}
