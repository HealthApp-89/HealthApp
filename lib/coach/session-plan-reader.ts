// lib/coach/session-plan-reader.ts
//
// Defensive reader for training_weeks.session_plan jsonb. The migration spec
// (supabase/migrations/0008_weekly_planning.sql) says keys should be 3-letter
// abbreviations ("Mon", "Tue", ...) and lib/data/types.ts:Weekday matches that.
// But the live data committed by the AI planning bot uses full weekday names
// ("Monday", "Tuesday", ...). Until we normalize the data + migration, all
// readers must try both forms.
//
// Long-term: normalize on full weekday names (what the AI naturally outputs),
// migrate existing rows, deprecate the Weekday short-form type.

import type { Weekday } from "@/lib/data/types";

/** Maps short weekday → full weekday name. The reverse map is also useful but
 *  not needed since `weekdayInUserTz()` already returns full names. */
const SHORT_TO_FULL: Record<Weekday, string> = {
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
  Sat: "Saturday",
  Sun: "Sunday",
};

const FULL_TO_SHORT: Record<string, Weekday> = {
  Monday: "Mon",
  Tuesday: "Tue",
  Wednesday: "Wed",
  Thursday: "Thu",
  Friday: "Fri",
  Saturday: "Sat",
  Sunday: "Sun",
};

/** Read session_plan[weekday] handling both 3-letter and full-name key
 *  conventions. Accepts either form for `weekday`. Returns undefined when
 *  neither lookup matches. */
export function readSessionForDay(
  plan: Record<string, string> | null | undefined,
  weekday: string,
): string | undefined {
  if (!plan) return undefined;
  // Try direct lookup first (whatever shape was passed)
  if (plan[weekday] !== undefined) return plan[weekday];
  // Try the alternate form
  const alternate =
    weekday.length === 3 ? SHORT_TO_FULL[weekday as Weekday] : FULL_TO_SHORT[weekday];
  if (alternate && plan[alternate] !== undefined) return plan[alternate];
  return undefined;
}
