/** Week boundaries for the coach's weekly review.
 *  Weeks are Monday → Sunday (UTC), matching lib/ui/period.ts. */

function utc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Monday of the week containing `d` (UTC). */
function startOfWeekMonday(d: Date): Date {
  const day = d.getUTCDay() || 7;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - (day - 1));
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}

/** Current week so far: Monday of the current week → today (UTC). On Sunday this
 *  is a complete Mon-Sun window; mid-week it's partial. Used as the analysis
 *  window for the weekly review. */
export function thisWeekToDate(today: Date = new Date()): {
  start: string;
  end: string;
  /** True when `end` is the Sunday of the current week (full window). */
  complete: boolean;
  /** Days remaining in the current week after `end` (Sunday counted as 0). */
  daysRemaining: number;
} {
  const t = utc(today);
  const mon = startOfWeekMonday(t);
  const dayIdx = t.getUTCDay() || 7; // Mon=1 … Sun=7
  return {
    start: fmt(mon),
    end: fmt(t),
    complete: dayIdx === 7,
    daysRemaining: 7 - dayIdx,
  };
}

/** The week_start that recommendations should target.
 *  Sunday → next Monday (full upcoming week).
 *  Mon-Sat → current Monday (recs target the remaining days of this week). */
export function recommendationWeekStart(today: Date = new Date()): string {
  const t = utc(today);
  const isSunday = t.getUTCDay() === 0;
  const monday = startOfWeekMonday(t);
  if (isSunday) {
    const nextMon = new Date(monday);
    nextMon.setUTCDate(monday.getUTCDate() + 7);
    return fmt(nextMon);
  }
  return fmt(monday);
}
