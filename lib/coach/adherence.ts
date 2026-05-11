// lib/coach/adherence.ts
//
// Computes planned-vs-actual session adherence for a Mon-Sun window plus
// per-muscle-group volume deltas vs the prior 28-day average. Pure SELECT
// against existing tables — no schema dependency beyond training_weeks +
// workouts + exercise_sets.
//
// Matching is lenient string-overlap, not strict equality, because the user's
// workouts.type values are free-form (history shows "Lower Body", "Legs And
// Arms", "Chest Triceps", etc., not always matching plan strings exactly).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Weekday } from "@/lib/data/types";
import { categorize, type ExerciseCategory } from "@/lib/coach/exercise-categories";
import { workingVolume, type SetRow } from "@/lib/coach/derived";

const WEEKDAYS: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** UTC weekday from YYYY-MM-DD. Returns one of WEEKDAYS. Mirrors the Mon-first
 *  ordering used everywhere else in the app. */
function weekdayOf(ymd: string): Weekday {
  const d = new Date(ymd + "T00:00:00Z");
  // getUTCDay: 0=Sun..6=Sat. Map to Mon-first index.
  const idx = (d.getUTCDay() + 6) % 7;
  return WEEKDAYS[idx];
}

/** Strip punctuation, lowercase, split on whitespace. */
function tokens(s: string | null | undefined): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Lenient match: planned matches actual if any token of `planned` appears as
 *  a substring of any token of `actual` (or vice-versa for plurals). Mobility
 *  / REST require exact-token match (no fuzzy). */
function matches(planned: string | null, actual: string | null): boolean {
  if (!planned || !actual) return false;
  const p = tokens(planned);
  const a = tokens(actual);
  if (p.includes("rest") || a.includes("rest")) {
    return p.includes("rest") && a.includes("rest");
  }
  if (p.includes("mobility") || a.includes("mobility")) {
    return p.includes("mobility") && a.includes("mobility");
  }
  for (const pt of p) {
    for (const at of a) {
      if (at.includes(pt) || pt.includes(at)) return true;
    }
  }
  return false;
}

/** Per-day adherence verdict.
 *  - 'rest': planned was REST AND no workout AND no swap (honored rest).
 *  - 'as_planned': workout type matches the originally-committed session.
 *  - 'swapped': mid-week edit was honored. Two sub-cases:
 *    a. swapped_to matches the actual workout (e.g., Chest → Mobility, did mobility)
 *    b. swapped_to is REST AND no workout (e.g., Chest → REST as a deliberate skip)
 *  - 'missed': nothing else — the athlete committed to something and didn't deliver. */
export type AdherenceDayStatus = "as_planned" | "swapped" | "missed" | "rest";

/** One row per day in the AdherenceResult.days array. AI consumers use this to
 *  produce prose like "you planned Chest, swapped to Mobility, did the walk"
 *  rather than just "Tuesday: planned Chest, actual nothing". */
export type AdherenceDay = {
  day: Weekday;
  /** From original_session_plan if the week has been edited; else from
   *  session_plan. Anchored to the Sunday commitment regardless of swaps. */
  planned: string;
  /** Current session_plan[day] when it differs from planned (a swap happened).
   *  Null when planned === current. */
  swapped_to: string | null;
  /** workouts[date].type for this day, or null if no workout was logged. */
  actual: string | null;
  status: AdherenceDayStatus;
};

export type AdherenceResult = {
  week_start: string;
  planned: Partial<Record<Weekday, string>>;
  actual: Partial<Record<Weekday, string>>;
  /** Per-day enriched view. AI consumers of compute_adherence use this to
   *  produce prose distinguishing swapped from missed. */
  days: AdherenceDay[];
  sessions_planned: number;
  sessions_done: number;
  sessions_on_plan: number;
  adherence_pct: number;     // sessions_on_plan / sessions_planned * 100
  done_pct: number;          // sessions_done / sessions_planned * 100
  muscle_volume_vs_4w_avg: Record<ExerciseCategory, number>; // proportional delta, e.g. -0.12 = -12%
};

/** Compute adherence for a single Mon-Sun window. */
export async function computeAdherence(
  supabase: SupabaseClient,
  userId: string,
  weekStart: string, // YYYY-MM-DD, must be a Monday
): Promise<AdherenceResult> {
  // Range bounds (Mon..Sun inclusive)
  const start = new Date(weekStart + "T00:00:00Z");
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const endStr = end.toISOString().slice(0, 10);

  // 1. Plan
  const { data: weekRow, error: weekErr } = await supabase
    .from("training_weeks")
    .select("session_plan, original_session_plan")
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (weekErr) throw weekErr;
  const originalPlan = (weekRow?.original_session_plan ?? null) as Partial<Record<Weekday, string>> | null;
  const currentPlan = (weekRow?.session_plan ?? {}) as Partial<Record<Weekday, string>>;
  /** Anchor `planned` to the original committed plan when it exists. Mid-week
   *  swaps populate original_session_plan via the /swap endpoint, so this read
   *  ensures adherence math doesn't retroactively flatter the recap. */
  const planned = (originalPlan ?? currentPlan) as Partial<Record<Weekday, string>>;

  // 2. Actual workouts in window with sets for volume math
  const { data: workouts, error: woErr } = await supabase
    .from("workouts")
    .select("date, type, exercises(name, exercise_sets(kg, reps, warmup, set_index, duration_seconds, failure))")
    .eq("user_id", userId)
    .gte("date", weekStart)
    .lte("date", endStr);
  if (woErr) throw woErr;

  // Build actual per-day map (first workout per day wins; rare edge: 2 sessions same day)
  const actual: Partial<Record<Weekday, string>> = {};
  for (const w of workouts ?? []) {
    const wd = weekdayOf(w.date);
    if (!actual[wd]) actual[wd] = w.type ?? "Workout";
  }

  // 3. Adherence counts + per-day breakdown
  let sessions_planned = 0;
  let sessions_done = 0;
  let sessions_on_plan = 0;
  const days: AdherenceDay[] = [];
  for (const wd of WEEKDAYS) {
    const p = planned[wd] ?? null;
    const c = currentPlan[wd] ?? null;
    const a = actual[wd] ?? null;
    const pIsRest = !!p && tokens(p).includes("rest");
    if (p && !pIsRest) sessions_planned += 1;
    if (a) sessions_done += 1;
    if (p && a && matches(p, a)) sessions_on_plan += 1;

    // Per-day status derivation
    const swapped_to = p && c && p !== c ? c : null;
    let status: AdherenceDayStatus;
    if (pIsRest && !a && !swapped_to) {
      status = "rest";
    } else if (p && a && matches(p, a)) {
      status = "as_planned";
    } else if (swapped_to && a && matches(swapped_to, a)) {
      status = "swapped";
    } else if (swapped_to && !a && tokens(swapped_to).includes("rest")) {
      // Planned non-rest, swapped to REST, no workout — honoring the swap, not missed.
      status = "swapped";
    } else {
      status = "missed";
    }

    days.push({
      day: wd,
      planned: p ?? "",
      swapped_to,
      actual: a,
      status,
    });
  }
  const adherence_pct = sessions_planned === 0 ? 0 : Math.round((sessions_on_plan / sessions_planned) * 100);
  const done_pct      = sessions_planned === 0 ? 0 : Math.round((sessions_done / sessions_planned) * 100);

  // 4. Volume per muscle group, this week vs prior-28d average
  const thisWeekVol = bucketVolume(workouts ?? []);

  const priorEnd = new Date(start);
  priorEnd.setUTCDate(start.getUTCDate() - 1);
  const priorStart = new Date(priorEnd);
  priorStart.setUTCDate(priorEnd.getUTCDate() - 27);
  const { data: priorWorkouts, error: pwErr } = await supabase
    .from("workouts")
    .select("date, type, exercises(name, exercise_sets(kg, reps, warmup, set_index, duration_seconds, failure))")
    .eq("user_id", userId)
    .gte("date", priorStart.toISOString().slice(0, 10))
    .lte("date", priorEnd.toISOString().slice(0, 10));
  if (pwErr) throw pwErr;
  const priorVol = bucketVolume(priorWorkouts ?? []);
  // Convert sum-over-28d to weekly average
  const priorWeeklyAvg: Record<ExerciseCategory, number> = Object.fromEntries(
    Object.entries(priorVol).map(([k, v]) => [k, v / 4]),
  ) as Record<ExerciseCategory, number>;

  const muscle_volume_vs_4w_avg = Object.fromEntries(
    Object.keys(thisWeekVol).map((cat) => {
      const c = cat as ExerciseCategory;
      const avg = priorWeeklyAvg[c] ?? 0;
      const cur = thisWeekVol[c] ?? 0;
      const delta = avg === 0 ? (cur > 0 ? 1 : 0) : (cur - avg) / avg;
      return [cat, delta];
    }),
  ) as Record<ExerciseCategory, number>;

  return {
    week_start: weekStart,
    planned,
    actual,
    days,
    sessions_planned,
    sessions_done,
    sessions_on_plan,
    adherence_pct,
    done_pct,
    muscle_volume_vs_4w_avg,
  };
}

/** Sum working volume per muscle category across a workout list. Warmups
 *  excluded by `workingVolume`. Uses categorize() for muscle-group mapping. */
function bucketVolume(
  workouts: Array<{
    type: string | null;
    exercises:
      | Array<{
          name: string;
          exercise_sets: Array<{ kg: number | null; reps: number | null; warmup: boolean; set_index: number; duration_seconds: number | null; failure: boolean }>;
        }>
      | null;
  }>,
): Record<ExerciseCategory, number> {
  const out: Record<ExerciseCategory, number> = {} as Record<ExerciseCategory, number>;
  for (const w of workouts) {
    for (const e of w.exercises ?? []) {
      const cat = categorize(e.name);
      if (cat === "uncategorized") continue;
      const vol = workingVolume((e.exercise_sets ?? []) as SetRow[]);
      out[cat] = (out[cat] ?? 0) + vol;
    }
  }
  return out;
}
