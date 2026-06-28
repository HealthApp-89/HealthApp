/**
 * lib/coach/activity/read-planned.ts
 *
 * Normalizes three activity sources into a single `PlannedActivity[]` for the
 * current week:
 *
 *   1. **Recurring** — `Profile.recurring_activities`: weekday templates expanded
 *      into concrete dates for the target week.
 *   2. **Declared (manual)** — `TrainingWeek.planned_activities`: explicit per-day
 *      entries entered by the athlete or committed through coach tools.
 *   3. **Detected** — `endurance_activities` rows ingested from Strava +
 *      `daily_logs.strain` spikes with no corresponding Strava activity.
 *
 * Merge precedence (highest → lowest): declared > recurring > detected.
 * "Same slot" is defined by (date, type) — an activity on the same day of a
 * different type is *not* a duplicate and is kept.
 *
 * Week convention: `training_weeks.week_start` is Monday-keyed.
 * Weekday 0=Sun..6=Sat; within a Monday-keyed week:
 *   weekday 1 (Mon) → week_start + 0 days
 *   weekday 2 (Tue) → week_start + 1 days
 *   weekday 3 (Wed) → week_start + 2 days
 *   weekday 4 (Thu) → week_start + 3 days
 *   weekday 5 (Fri) → week_start + 4 days
 *   weekday 6 (Sat) → week_start + 5 days
 *   weekday 0 (Sun) → week_start + 6 days  ← Sunday is at the END of the week
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlannedActivity, RecurringActivity, ActivityType, ActivityIntensity } from "./types";
import type { TrainingWeek } from "@/lib/data/types";

// ── Sport → ActivityType mapping ────────────────────────────────────────────
// EnduranceSport ("cycling"|"running"|"swimming"|"other") maps 1-to-1 to
// ActivityType. Strava sport names are already normalized to EnduranceSport by
// the ingest layer before they reach endurance_activities.sport.

const SPORT_TO_ACTIVITY_TYPE: Record<string, ActivityType> = {
  cycling: "cycling",
  running: "running",
  swimming: "swimming",
  other: "other",
};

function mapSport(sport: string): ActivityType {
  return SPORT_TO_ACTIVITY_TYPE[sport] ?? "other";
}

// ── TSS → intensity bucket ───────────────────────────────────────────────────
// Thresholds chosen to reflect physiological load from hrTSS / powerTSS:
//   < 40  TSS  → light    (easy Z1-Z2 session, ~60-90 min easy effort)
//   40-79 TSS  → moderate (solid aerobic session, ~90-120 min or threshold intervals)
//   ≥ 80  TSS  → hard     (long ride/run or high-intensity work)
const TSS_MODERATE_THRESHOLD = 40;
const TSS_HARD_THRESHOLD = 80;

function tssToIntensity(tss: number | null): ActivityIntensity {
  if (tss == null) return "moderate"; // fallback when TSS is unknown
  if (tss < TSS_MODERATE_THRESHOLD) return "light";
  if (tss < TSS_HARD_THRESHOLD) return "moderate";
  return "hard";
}

// ── WHOOP strain → intensity bucket ─────────────────────────────────────────
// WHOOP Day Strain is on a 0-21 scale.
//   < 10  → light   (maintenance / easy day)
//   10-15 → moderate
//   > 15  → hard
const STRAIN_MODERATE_THRESHOLD = 10;
const STRAIN_HARD_THRESHOLD = 15;

function strainToIntensity(strain: number): ActivityIntensity {
  if (strain < STRAIN_MODERATE_THRESHOLD) return "light";
  if (strain < STRAIN_HARD_THRESHOLD) return "moderate";
  return "hard";
}

// ── Week date helpers ────────────────────────────────────────────────────────

/**
 * Resolve a weekday number (0=Sun..6=Sat) to an ISO date string within a
 * Monday-keyed week.
 *
 * Monday-keyed logic:
 *   offset = weekday === 0 ? 6 : weekday - 1
 *   date   = weekStart + offset days
 */
function weekdayToDate(weekStartIso: string, weekday: number): string {
  const base = new Date(weekStartIso + "T00:00:00Z");
  const offset = weekday === 0 ? 6 : weekday - 1;
  const d = new Date(base.getTime() + offset * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** Returns all 7 ISO dates in the week (Mon..Sun). */
function weekDates(weekStartIso: string): string[] {
  return [0, 1, 2, 3, 4, 5, 6].map((offset) => {
    const base = new Date(weekStartIso + "T00:00:00Z");
    const d = new Date(base.getTime() + offset * 86_400_000);
    return d.toISOString().slice(0, 10);
  });
}

/** Last date of the week (the Sunday). */
function weekEndDate(weekStartIso: string): string {
  const base = new Date(weekStartIso + "T00:00:00Z");
  const d = new Date(base.getTime() + 6 * 86_400_000);
  return d.toISOString().slice(0, 10);
}

// ── Duplicate key helper ─────────────────────────────────────────────────────

function slotKey(a: PlannedActivity): string {
  return `${a.date}|${a.type}`;
}

// ── Pure merge ───────────────────────────────────────────────────────────────

export interface MergePlannedActivitiesArgs {
  weekStartIso: string;
  /** Manually declared / committed activities (from TrainingWeek.planned_activities). */
  declared: PlannedActivity[];
  /** Recurring activity templates to materialize for the week. */
  recurring: RecurringActivity[];
  /** Auto-detected activities from Strava / WHOOP. */
  detected: PlannedActivity[];
}

/**
 * Pure function — no I/O. Merges the three sources into a sorted, deduplicated
 * `PlannedActivity[]` for the given week.
 *
 * Merge precedence:
 *   1. `declared` (manual / coach-committed) — always wins
 *   2. `recurring` (user-configured weekly templates) — wins over detected
 *   3. `detected` (auto-detected from Strava / WHOOP) — fills gaps only
 */
export function mergePlannedActivities({
  weekStartIso,
  declared,
  recurring,
  detected,
}: MergePlannedActivitiesArgs): PlannedActivity[] {
  // Tracks which (date, type) slots are already committed by a higher-priority source.
  const taken = new Set<string>();

  const result: PlannedActivity[] = [];

  // 1. Declared activities — highest priority.
  for (const item of declared) {
    const key = slotKey(item);
    if (!taken.has(key)) {
      taken.add(key);
      result.push(item);
    }
    // Duplicate declared entries (same date+type) are silently deduped; first wins.
  }

  // 2. Recurring — materialize into concrete dates, skip slots already taken.
  for (const template of recurring) {
    for (const weekday of template.weekdays) {
      const date = weekdayToDate(weekStartIso, weekday);
      const candidate: PlannedActivity = {
        date,
        type: template.type,
        intensity_estimate: template.typical_intensity,
        source: "recurring",
      };
      const key = slotKey(candidate);
      if (!taken.has(key)) {
        taken.add(key);
        result.push(candidate);
      }
    }
  }

  // 3. Detected — fill gaps only.
  for (const item of detected) {
    const key = slotKey(item);
    if (!taken.has(key)) {
      taken.add(key);
      result.push(item);
    }
  }

  // Sort by date (then type for stability when same date).
  result.sort((a, b) => {
    const dateCmp = a.date.localeCompare(b.date);
    if (dateCmp !== 0) return dateCmp;
    return a.type.localeCompare(b.type);
  });

  return result;
}

// ── Thin I/O layer ───────────────────────────────────────────────────────────

/**
 * Gathers the three sources for the given week and calls `mergePlannedActivities`.
 * Each source is guarded: a failure produces an empty array for that source so
 * the merge still returns useful results from the remaining sources.
 *
 * @param supabase   A Supabase client with appropriate auth (server or service role).
 * @param userId     The authenticated user's UUID.
 * @param week       The `training_weeks` row for the target week (provides
 *                   `week_start` and `planned_activities`).
 * @param todayIso   YYYY-MM-DD "today" in the user's timezone (used as an upper
 *                   bound for detected activities so future dates are excluded).
 */
export async function loadPlannedActivities(
  supabase: SupabaseClient,
  userId: string,
  week: Pick<TrainingWeek, "week_start" | "planned_activities">,
  todayIso: string,
): Promise<PlannedActivity[]> {
  const weekStartIso = week.week_start;
  const weekEnd = weekEndDate(weekStartIso);
  // Clamp the upper bound so we don't accidentally detect "future" activities.
  const detectionEnd = weekEnd < todayIso ? weekEnd : todayIso;

  // Source 1: Declared (already on the week row — trivial, no I/O needed).
  const declared: PlannedActivity[] = week.planned_activities ?? [];

  // Source 2: Recurring from profile.
  let recurring: RecurringActivity[] = [];
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("recurring_activities")
      .eq("user_id", userId)
      .single();
    if (error) throw error;
    recurring = (data?.recurring_activities as RecurringActivity[]) ?? [];
  } catch {
    // Graceful: proceed with no recurring activities.
    recurring = [];
  }

  // Source 3: Detected — endurance_activities + WHOOP strain spikes.
  const detected: PlannedActivity[] = [];

  // 3a. Strava-ingested endurance activities.
  try {
    const { data, error } = await supabase
      .from("endurance_activities")
      .select("local_date, sport, tss, deleted_at")
      .eq("user_id", userId)
      .gte("local_date", weekStartIso)
      .lte("local_date", detectionEnd)
      .is("deleted_at", null);

    if (error) throw error;

    for (const row of data ?? []) {
      detected.push({
        date: row.local_date as string,
        type: mapSport(row.sport as string),
        intensity_estimate: tssToIntensity(row.tss as number | null),
        source: "detected",
      });
    }
  } catch {
    // Graceful: Strava source contributes nothing.
  }

  // 3b. WHOOP strain spikes on days with no Strava activity.
  // A "spike" is any day in the week where strain is recorded but no
  // endurance_activities row exists. We mark these as type "other" with
  // intensity derived from strain magnitude. This catches gym sessions,
  // padel, or any high-effort day WHOOP sees but Strava doesn't.
  try {
    const stravaDetectedDates = new Set(detected.map((a) => a.date));
    const allWeekDates = weekDates(weekStartIso).filter((d) => d <= detectionEnd);

    // Only query dates not already covered by a Strava activity.
    const uncoveredDates = allWeekDates.filter((d) => !stravaDetectedDates.has(d));

    if (uncoveredDates.length > 0) {
      const { data, error } = await supabase
        .from("daily_logs")
        .select("date, strain")
        .eq("user_id", userId)
        .in("date", uncoveredDates)
        .not("strain", "is", null);

      if (error) throw error;

      for (const row of data ?? []) {
        const strain = row.strain as number;
        // Only surface strain spikes that indicate meaningful activity (≥ light threshold).
        // A strain < 10 is a recovery day; still include it (strainToIntensity returns "light").
        // We include all non-null strain days so the merge can decide whether it matters.
        detected.push({
          date: row.date as string,
          type: "other",
          intensity_estimate: strainToIntensity(strain),
          source: "detected",
        });
      }
    }
  } catch {
    // Graceful: WHOOP strain source contributes nothing.
  }

  return mergePlannedActivities({ weekStartIso, declared, recurring, detected });
}
