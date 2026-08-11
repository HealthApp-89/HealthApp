// lib/coach/schedule/classify-day.ts
//
// Which badge and footer a row of the week schedule gets.
//
// This lived inline in a useMemo inside StrengthScheduleClient.tsx, where the
// repo's node-environment vitest could not reach it, and it was wrong: the
// `isToday` branch was evaluated before the `isPast && isLogged` branch, and
// `isPast` is `date < todayIso` — which excludes today by construction. So
// `past_logged` was unreachable for today, `isLogged` was computed and never
// consulted for the one day it mattered, and a session logged today rendered
// an amber "Today" pill with a "Start session" button on a day already
// trained. Tapping that opens a fresh draft for a date that already has a
// committed workout, and nothing dedupes the second row.
//
// Pure, so the ordering can be pinned by tests.

export type DayClass =
  | "today"
  | "today_logged"
  | "past_logged"
  | "past_unlogged"
  | "future"
  | "rest";

export function classifyScheduleDay(args: {
  /** YYYY-MM-DD of the row. */
  date: string;
  /** YYYY-MM-DD of today in the athlete's timezone. */
  todayIso: string;
  /** Resolved session type for the row; "REST" short-circuits. */
  sessionType: string;
  /** Whether a committed workout exists for this date. */
  isLogged: boolean;
}): DayClass {
  const { date, todayIso, sessionType, isLogged } = args;

  if (sessionType === "REST") return "rest";
  // Today consults isLogged FIRST. Everything below is strictly past or
  // strictly future — today never reaches them.
  if (date === todayIso) return isLogged ? "today_logged" : "today";
  if (date < todayIso) return isLogged ? "past_logged" : "past_unlogged";
  return "future";
}
