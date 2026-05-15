// lib/coach/weekly-review/date-utils.ts
//
// Shared date helpers for the weekly-review composers. All dates use YYYY-MM-DD
// strings in UTC; date math anchors at 12:00:00Z to avoid DST/midnight edge cases.

export function addDays(yyyyMmDd: string, days: number): string {
  const d = new Date(yyyyMmDd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Alias for addDays — kept for call-site readability where the intent is shifting. */
export const shiftDays = addDays;

/** UTC weekday-index difference: how many days from `base` (Monday) to `d`. */
export function dayIndex(d: string, base: string): number {
  return Math.round(
    (new Date(d + "T12:00:00Z").getTime() - new Date(base + "T12:00:00Z").getTime()) /
      (24 * 3600 * 1000)
  );
}

/** Monday (UTC) of the week containing the given date. */
export function mondayOf(yyyyMmDd: string): string {
  const d = new Date(yyyyMmDd + "T12:00:00Z");
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (dow - 1));
  return d.toISOString().slice(0, 10);
}
