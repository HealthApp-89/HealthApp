// lib/coach/session-debrief/next-session-prescription.ts
//
// Finds the next session of a given type and returns the prescription the
// ENGINE wrote for it. The debrief must never compute its own loads — that
// second implementation is what let the card display a weight the plan did
// not contain (see docs/superpowers/specs/2026-08-03-debrief-reads-stored-prescription-design.md).
//
// Two-tier read, mirroring lib/coach/weekly-review/read-prescription.ts:
//   1. training_weeks.session_prescriptions[weekday]  → source "row"
//   2. prescribeWeek() inline when that is missing    → source "inline"
// Read-only: never writes training_weeks.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  SessionPrescriptions,
  TrainingBlock,
  TrainingWeek,
  WeekdayLong,
} from "@/lib/data/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import { prescribeWeek } from "@/lib/coach/prescription/prescribe-week";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import { mondayOfIso } from "@/lib/time/dates";
import { WEEKDAY_LONG_ORDER } from "@/lib/coach/prescription/upsert-week-prescription";

/** How far forward to look for the next session of this type. Two weeks
 *  covers any weekly split; beyond that the session type has been dropped. */
const SEARCH_DAYS = 14;

export type NextSessionPrescription = {
  /** ISO date of the next session of this type. */
  date: string;
  weekday: WeekdayLong;
  /** Non-warmup prescribed entries for that day. */
  exercises: PlannedExercise[];
  /** "row" when read from training_weeks.session_prescriptions, "inline"
   *  when prescribeWeek was called as the fallback. */
  source: "row" | "inline";
};

export async function readNextSessionPrescription(opts: {
  supabase: SupabaseClient;
  userId: string;
  sessionType: string;
  /** Workout date — the search starts the day AFTER this. */
  afterIso: string;
  block: TrainingBlock | null;
  todayIso: string;
}): Promise<NextSessionPrescription | null> {
  const { supabase, userId, sessionType, afterIso, block, todayIso } = opts;

  // At most two week rows are ever touched; cache so a 14-day walk does not
  // re-query the same week seven times.
  const weekCache = new Map<string, TrainingWeek | null>();
  async function weekRow(weekStart: string): Promise<TrainingWeek | null> {
    if (weekCache.has(weekStart)) return weekCache.get(weekStart)!;
    const { data } = await supabase
      .from("training_weeks")
      .select("*")
      .eq("user_id", userId)
      .eq("week_start", weekStart)
      .maybeSingle();
    const row = (data as TrainingWeek | null) ?? null;
    weekCache.set(weekStart, row);
    return row;
  }

  for (let offset = 1; offset <= SEARCH_DAYS; offset++) {
    const date = addDaysIso(afterIso, offset);
    const weekStart = mondayOfIso(date);
    const row = await weekRow(weekStart);
    if (!row) continue;

    const weekday = weekdayLongForIso(date, weekStart);
    if (weekday == null) continue;
    // SessionPlan keys may be short ("Mon") or long ("Monday") — never index
    // directly; readSessionForDay normalises both forms.
    if (readSessionForDay(row.session_plan as Record<string, string>, weekday) !== sessionType) {
      continue;
    }

    const stored = (row.session_prescriptions as SessionPrescriptions | null) ?? null;
    const storedDay = stored?.[weekday];
    if (storedDay && storedDay.length > 0) {
      return { date, weekday, exercises: storedDay.filter((e) => !e.warmup), source: "row" };
    }

    // Fall-through: compute inline with the SAME engine, read-only.
    const computed = await prescribeWeek({
      supabase,
      userId,
      block,
      week: row,
      todayIso,
    });
    const computedDay = computed[weekday];
    if (computedDay && computedDay.length > 0) {
      return { date, weekday, exercises: computedDay.filter((e) => !e.warmup), source: "inline" };
    }
    // Matched the weekday but neither source produced exercises — keep looking.
  }

  return null;
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** WEEKDAY_LONG_ORDER is Monday-first, matching mondayOfIso. */
function weekdayLongForIso(iso: string, weekStart: string): WeekdayLong | null {
  const a = new Date(weekStart + "T00:00:00Z").getTime();
  const b = new Date(iso + "T00:00:00Z").getTime();
  const idx = Math.round((b - a) / 86_400_000);
  return WEEKDAY_LONG_ORDER[idx] ?? null;
}
