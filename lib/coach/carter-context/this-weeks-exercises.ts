// lib/coach/carter-context/this-weeks-exercises.ts
//
// Builds the "This week's exercises" context block appended to Carter's
// system prompt. Mirrors the same resolution chain the logger uses
// (lib/logger/resolve-plan.ts) so Carter sees the same exercise list the
// athlete will see on next logger open.
//
// Goal: structurally prevent the 2026-05-26 "17 kg DB" off-grid weight bug
// by putting `increment.step` + `pairedDb` directly in Carter's context.
// He can still call query_exercise_library if he wants more (substitutes,
// muscle metadata) — but for any weight he proposes inside this week's
// scope, the data is already in his prompt.

import type { SupabaseClient } from "@supabase/supabase-js";
import { SESSION_PLANS, type PlannedExercise } from "@/lib/coach/sessionPlans";
import { resolveExercise } from "@/lib/coach/exercise-library";
import { fetchUserSessionTemplateServer } from "@/lib/query/fetchers/userSessionTemplates";
import { currentWeekMonday } from "@/lib/coach/week";

type WeeklyExerciseRow = {
  sessionType: string;
  weekday: string;
  name: string;
  step: number | null;
  pairedDb: boolean | null;
  baseKg: number | null;
  source: "week_override" | "user_template" | "code_default";
};

/**
 * Pure assembly — no Anthropic call. Returns null if no training_weeks row
 * exists for the current week (Carter falls back to query_exercise_library
 * the way he does today; no context block injected).
 */
export async function buildThisWeeksExercisesBlock(args: {
  supabase: SupabaseClient;
  userId: string;
}): Promise<string | null> {
  const { supabase, userId } = args;
  const weekStart = currentWeekMonday();

  const { data: tw, error } = await supabase
    .from("training_weeks")
    .select("session_plan, exercise_overrides")
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (error) throw error;
  if (!tw) return null;

  const sessionPlan = (tw.session_plan ?? {}) as Record<string, string>;
  const overrides = (tw.exercise_overrides ?? {}) as Record<string, PlannedExercise[]>;

  const rows: WeeklyExerciseRow[] = [];
  const weekdays = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
  for (const weekday of weekdays) {
    const sessionType = sessionPlan[weekday];
    if (!sessionType || sessionType === "REST") continue;

    let exercises: PlannedExercise[];
    let source: WeeklyExerciseRow["source"];
    if (overrides[weekday]?.length) {
      exercises = overrides[weekday];
      source = "week_override";
    } else {
      const template = await fetchUserSessionTemplateServer(supabase, userId, sessionType);
      if (template?.exercises?.length) {
        exercises = template.exercises;
        source = "user_template";
      } else {
        exercises = SESSION_PLANS[sessionType] ?? [];
        source = "code_default";
      }
    }

    for (const ex of exercises) {
      const lib = resolveExercise(ex.name);
      rows.push({
        sessionType,
        weekday,
        name: ex.name,
        step: lib?.increment?.step ?? ex.increment?.step ?? null,
        pairedDb: lib?.pairedDb ?? null,
        baseKg: ex.baseKg ?? null,
        source,
      });
    }
  }

  if (rows.length === 0) return null;

  const lines = rows.map((r) => {
    const baseKgStr = r.baseKg == null ? "—" : `${r.baseKg} kg`;
    const stepStr = r.step == null ? "n/a (bodyweight/duration)" : `${r.step} kg`;
    const pairedStr =
      r.pairedDb === true ? " paired DB" :
      r.pairedDb === false ? " single DB" :
      "";
    return `- ${r.weekday} · ${r.sessionType} · ${r.name} — step=${stepStr}${pairedStr}, current baseKg=${baseKgStr} (${r.source})`;
  });

  return [
    "<this_weeks_exercises>",
    "This week's planned exercises with their library-grounded load increments. Ground every weight you propose in these rows; never quote a kg value that isn't a multiple of the listed step. For dumbbells, step is PER DB (paired = +step per hand). Bodyweight / duration entries (step=n/a) are progressed via reps, tempo, or external load, not kg.",
    "",
    ...lines,
    "</this_weeks_exercises>",
  ].join("\n");
}
