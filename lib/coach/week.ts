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

/** The most recent complete Mon-Sun window relative to `today`.
 *  If today is Monday, returns the week ending yesterday. */
export function lastCompleteWeek(today: Date = new Date()): { start: string; end: string } {
  const t = utc(today);
  const thisMon = startOfWeekMonday(t);
  const lastSun = new Date(thisMon);
  lastSun.setUTCDate(thisMon.getUTCDate() - 1);
  const lastMon = new Date(lastSun);
  lastMon.setUTCDate(lastSun.getUTCDate() - 6);
  return { start: fmt(lastMon), end: fmt(lastSun) };
}

/** Monday of the week starting *after* the most recent complete week — i.e. the
 *  week the recommendations should target. If today is mid-week, that's this
 *  Monday; if today is Monday, that's today. */
export function nextWeekStart(today: Date = new Date()): string {
  const t = utc(today);
  return fmt(startOfWeekMonday(t));
}
