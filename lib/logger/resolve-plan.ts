import type { SupabaseClient } from "@supabase/supabase-js";
import { SESSION_PLANS, type PlannedExercise } from "@/lib/coach/sessionPlans";
import type { ExerciseOverrides } from "@/lib/data/types";

/**
 * Resolution chain at logger open:
 *   1. training_weeks.exercise_overrides[weekdayLong]  (permutation-only)
 *   2. user_session_templates[session_type]            (per-user persistent)
 *   3. SESSION_PLANS[session_type]                     (code default)
 *
 * Pass null `weekOverrides` if no committed training_week exists for the date.
 *
 * `weekdayLong` is the full weekday name ("Monday", "Tuesday", ...) — matches
 * how exercise_overrides is keyed (see migration 0022).
 */
export async function resolveSessionPlan(args: {
  supabase: SupabaseClient;
  userId: string;
  sessionType: string;
  weekdayLong: string;
  weekOverrides: ExerciseOverrides | null;
}): Promise<{
  exercises: PlannedExercise[];
  source: "week_override" | "user_template" | "code_default";
}> {
  const { supabase, userId, sessionType, weekdayLong, weekOverrides } = args;

  const weekOverride = weekOverrides?.[weekdayLong];
  if (weekOverride && weekOverride.length > 0) {
    return { exercises: weekOverride, source: "week_override" };
  }

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

  return {
    exercises: SESSION_PLANS[sessionType] ?? [],
    source: "code_default",
  };
}
