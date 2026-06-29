import type { SupabaseClient } from "@supabase/supabase-js";
import { SESSION_PLANS, applyOrderingOverride, type PlannedExercise } from "@/lib/coach/sessionPlans";
import type { ExerciseOverrides, SessionPrescriptions } from "@/lib/data/types";
import { discoverEffectiveExercises } from "@/lib/coach/prescription/recent-workouts-discovery";

/**
 * Resolution chain at logger open (mirrors client-side getEffectiveSessionPlan,
 * with an extra recent-workouts-discovery step before SESSION_PLANS):
 *   1. training_weeks.session_prescriptions[weekdayLong]  (Sunday prescription)
 *   2. training_weeks.exercise_overrides[weekdayLong]     (permutation-only)
 *   3. user_session_templates[session_type]               (per-user persistent)
 *   4. discoverEffectiveExercises(...)                    (recent-workouts pattern)
 *   5. SESSION_PLANS[session_type]                        (code default)
 *
 * Pass null `weekPrescriptions` / `weekOverrides` if no committed training_week
 * exists for the date (or the caller hasn't fetched those columns).
 *
 * `weekdayLong` is the full weekday name ("Monday", "Tuesday", ...) — matches
 * how exercise_overrides / session_prescriptions are keyed (see migrations
 * 0022 and the prescription-system arc).
 */
export async function resolveSessionPlan(args: {
  supabase: SupabaseClient;
  userId: string;
  sessionType: string;
  weekdayLong: string;
  weekOverrides: ExerciseOverrides | null;
  weekPrescriptions?: SessionPrescriptions | null;
}): Promise<{
  exercises: PlannedExercise[];
  source: "week_prescription" | "week_override" | "user_template" | "recent_discovery" | "code_default";
}> {
  const { supabase, userId, sessionType, weekdayLong, weekOverrides, weekPrescriptions } = args;

  // 1. session_prescriptions (NEW TOP — Sunday-prescription system). When an
  //    exercise_override also exists for the day, it layers ordering on top of
  //    the prescription (engine owns loads, user owns order) — mirrors
  //    getEffectiveSessionPlan.
  const presc = weekPrescriptions?.[weekdayLong as keyof SessionPrescriptions];
  const weekOverride = weekOverrides?.[weekdayLong];
  if (presc && presc.length > 0) {
    if (weekOverride && weekOverride.length > 0) {
      return {
        exercises: applyOrderingOverride(presc, weekOverride.map((e) => e.name)),
        source: "week_prescription",
      };
    }
    return { exercises: presc, source: "week_prescription" };
  }

  // 2. exercise_overrides (existing — permutation-only)
  if (weekOverride && weekOverride.length > 0) {
    return { exercises: weekOverride, source: "week_override" };
  }

  // 3. user_session_templates (existing — per-user persistent)
  const { data, error } = await supabase
    .from("user_session_templates")
    .select("exercises")
    .eq("user_id", userId)
    .eq("session_type", sessionType)
    .maybeSingle();

  if (error) throw error;

  if (data?.exercises && Array.isArray(data.exercises) && data.exercises.length > 0) {
    return { exercises: data.exercises as PlannedExercise[], source: "user_template" };
  }

  // 4. recent_workouts discovery (NEW — learned from last 4-8 sessions)
  const discovered = await discoverEffectiveExercises({ supabase, userId, sessionType });
  if (discovered && discovered.length > 0) {
    return { exercises: discovered, source: "recent_discovery" };
  }

  // 5. SESSION_PLANS (existing fallback — code default)
  return {
    exercises: SESSION_PLANS[sessionType] ?? [],
    source: "code_default",
  };
}
