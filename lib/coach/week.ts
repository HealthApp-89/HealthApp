/** Week boundaries for the coach's weekly review.
 *  Weeks are Monday → Sunday in the user's timezone (was UTC pre-0042). */

import { ymdInUserTz, USER_TIMEZONE } from "@/lib/time";

/** "YYYY-MM-DD" for a Date in the given tz. */
function fmt(d: Date, tz: string): string {
  return ymdInUserTz(d, tz);
}

/** Monday of the week containing `d`, in the given tz. Returns YYYY-MM-DD. */
function startOfWeekMondayLocal(d: Date, tz: string): string {
  // Compute weekday in tz, then walk back N days. The walk is in UTC ms
  // (safe because we only care about day-count), then format in tz.
  const wd = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: tz }).format(d);
  const longToIdx: Record<string, number> = {
    Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4,
    Friday: 5, Saturday: 6, Sunday: 7,
  };
  const idx = longToIdx[wd] ?? 1;
  const monday = new Date(d.getTime() - (idx - 1) * 86_400_000);
  return fmt(monday, tz);
}

/** Add N calendar days to a YYYY-MM-DD by parsing as UTC noon (DST-safe). */
function addDays(ymd: string, n: number): string {
  const dt = new Date(`${ymd}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** Three review rhythms keyed off day-of-week. */
export type ReviewMode = "monday-recap" | "in-progress" | "sunday-full";

/** The window the weekly review should analyse, depending on day-of-week.
 *  - Monday  → previous full Mon-Sun ("recap last week, set up this week")
 *  - Tue-Sat → current Mon → today (week-to-date)
 *  - Sunday  → current full Mon-Sun (thorough end-of-week review) */
export function reviewWindow(today: Date = new Date(), tz: string = USER_TIMEZONE): {
  start: string;
  end: string;
  mode: ReviewMode;
  /** Days remaining in the current calendar week including today's leftover. 0 on Sunday, 6 on Monday. */
  daysRemaining: number;
} {
  const todayYmd = fmt(today, tz);
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: tz }).format(today);
  const dowMap: Record<string, number> = {
    Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
    Thursday: 4, Friday: 5, Saturday: 6,
  };
  const dow = dowMap[weekday] ?? 1;

  if (dow === 1) {
    const lastSun = addDays(todayYmd, -1);
    const lastMon = addDays(lastSun, -6);
    return { start: lastMon, end: lastSun, mode: "monday-recap", daysRemaining: 6 };
  }
  if (dow === 0) {
    const mon = addDays(todayYmd, -6);
    return { start: mon, end: todayYmd, mode: "sunday-full", daysRemaining: 0 };
  }
  const mon = startOfWeekMondayLocal(today, tz);
  return {
    start: mon,
    end: todayYmd,
    mode: "in-progress",
    daysRemaining: 7 - dow, // Tue=2 → 5 days, Sat=6 → 1 day
  };
}

/** The week_start that recommendations should target.
 *  Monday + Tue-Sat → current Monday (this calendar week).
 *  Sunday → next Monday (the upcoming week). */
export function recommendationWeekStart(today: Date = new Date(), tz: string = USER_TIMEZONE): string {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: tz }).format(today);
  const mon = startOfWeekMondayLocal(today, tz);
  if (weekday === "Sunday") return addDays(mon, 7);
  return mon;
}

/** Monday that the planning CTA targets when the user opens /coach.
 *
 *  Mon-Sat → the most recent Monday on or before today (current calendar week).
 *  Sun     → next Monday (the upcoming calendar week).
 *
 *  Distinct from `recommendationWeekStart` (which has identical semantics today
 *  but is a separate concept — recommendations vs. plan targeting; keeping them
 *  separate avoids accidental coupling when one's policy changes).
 *
 *  Distinct from `currentWeekMonday(today)` (used by the strength tab) which
 *  always returns the most recent Monday on or before today regardless of
 *  weekday — strength reads "this week's plan", not "next week's". */
export function planningTargetMonday(today: Date = new Date(), tz: string = USER_TIMEZONE): string {
  return recommendationWeekStart(today, tz);
}

/** Monday of the week containing today (no Sunday flip). Used by the strength
 *  tab to look up the *current* week's training_weeks row. */
export function currentWeekMonday(today: Date = new Date(), tz: string = USER_TIMEZONE): string {
  return startOfWeekMondayLocal(today, tz);
}
