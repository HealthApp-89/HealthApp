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

/** Three review rhythms keyed off day-of-week. */
export type ReviewMode = "monday-recap" | "in-progress" | "sunday-full";

/** The window the weekly review should analyse, depending on day-of-week.
 *  - Monday  → previous full Mon-Sun ("recap last week, set up this week")
 *  - Tue-Sat → current Mon → today (week-to-date)
 *  - Sunday  → current full Mon-Sun (thorough end-of-week review) */
export function reviewWindow(today: Date = new Date()): {
  start: string;
  end: string;
  mode: ReviewMode;
  /** Days remaining in the current calendar week including today's leftover. 0 on Sunday, 6 on Monday. */
  daysRemaining: number;
} {
  const t = utc(today);
  const dow = t.getUTCDay(); // 0=Sun, 1=Mon, … 6=Sat

  if (dow === 1) {
    const lastSun = new Date(t);
    lastSun.setUTCDate(t.getUTCDate() - 1);
    const lastMon = new Date(lastSun);
    lastMon.setUTCDate(lastSun.getUTCDate() - 6);
    return { start: fmt(lastMon), end: fmt(lastSun), mode: "monday-recap", daysRemaining: 6 };
  }

  if (dow === 0) {
    const mon = new Date(t);
    mon.setUTCDate(t.getUTCDate() - 6);
    return { start: fmt(mon), end: fmt(t), mode: "sunday-full", daysRemaining: 0 };
  }

  const mon = startOfWeekMonday(t);
  return {
    start: fmt(mon),
    end: fmt(t),
    mode: "in-progress",
    daysRemaining: 7 - dow, // Tue=2 → 5 days, Sat=6 → 1 day
  };
}

/** The week_start that recommendations should target.
 *  Monday + Tue-Sat → current Monday (this calendar week).
 *  Sunday → next Monday (the upcoming week). */
export function recommendationWeekStart(today: Date = new Date()): string {
  const t = utc(today);
  const monday = startOfWeekMonday(t);
  if (t.getUTCDay() === 0) {
    const nextMon = new Date(monday);
    nextMon.setUTCDate(monday.getUTCDate() + 7);
    return fmt(nextMon);
  }
  return fmt(monday);
}
