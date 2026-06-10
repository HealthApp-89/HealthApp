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
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import { getUserTimezone } from "@/lib/time/get-user-tz";

type WeeklyExerciseRow = {
  sessionType: string;
  weekday: string;
  name: string;
  step: number | null;
  intermediate: number | null;
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
  const tz = await getUserTimezone(userId);
  const weekStart = currentWeekMonday(new Date(), tz);

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

  const weekdays = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];

  // Issue 1: use readSessionForDay to handle both 3-letter and full-name keys.
  // Issue 2: pre-resolve distinct session types in parallel before the loop
  //          to avoid N+1 sequential fetches (dedup covers Fri/Sat same type).
  const distinctSessionTypes = Array.from(new Set(
    weekdays
      .map((d) => readSessionForDay(sessionPlan, d))
      .filter((t): t is string => !!t && t !== "REST"),
  ));

  const templates = new Map<string, PlannedExercise[] | null>();
  await Promise.all(distinctSessionTypes.map(async (st) => {
    const t = await fetchUserSessionTemplateServer(supabase, userId, st);
    templates.set(st, t?.exercises && t.exercises.length > 0 ? t.exercises : null);
  }));

  const rows: WeeklyExerciseRow[] = [];
  for (const weekday of weekdays) {
    // Issue 1 fix applied: readSessionForDay handles 3-letter and full-name keys.
    const sessionType = readSessionForDay(sessionPlan, weekday);
    if (!sessionType || sessionType === "REST") continue;

    let exercises: PlannedExercise[];
    let source: WeeklyExerciseRow["source"];
    if (overrides[weekday]?.length) {
      exercises = overrides[weekday];
      source = "week_override";
    } else {
      // Issue 2 fix applied: read from pre-resolved map, no await in the loop.
      const templateExercises = templates.get(sessionType);
      if (templateExercises) {
        exercises = templateExercises;
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
        // Issue 3 fix applied: carry intermediate micro-pin through so Carter
        // never rejects valid loads like 22.3 kg on a Chest Fly.
        intermediate: lib?.increment?.intermediate ?? ex.increment?.intermediate ?? null,
        pairedDb: lib?.pairedDb ?? null,
        baseKg: ex.baseKg ?? null,
        source,
      });
    }
  }

  if (rows.length === 0) return null;

  const lines = rows.map((r) => {
    const baseKgStr = r.baseKg == null ? "—" : `${r.baseKg} kg`;
    // Issue 3 fix applied: render intermediate pin when present.
    const stepStr = r.step == null
      ? "n/a (bodyweight/duration)"
      : r.intermediate != null
        ? `${r.step} kg (intermediate pin: ${r.intermediate} kg)`
        : `${r.step} kg`;
    const pairedStr =
      r.pairedDb === true ? " paired DB" :
      r.pairedDb === false ? " single DB" :
      "";
    return `- ${r.weekday} · ${r.sessionType} · ${r.name} — step=${stepStr}${pairedStr}, current baseKg=${baseKgStr} (${r.source})`;
  });

  return [
    "<this_weeks_exercises>",
    "This week's planned exercises with their library-grounded load increments. Ground every weight you propose in these rows. For standard steps use the listed kg value; for machines with an intermediate micro-pin, valid loads are multiples of the step PLUS the intermediate offset (e.g. step=5, intermediate=2.3 → valid loads include 22.3 kg, 27.3 kg). For dumbbells, step is PER DB (paired = +step per hand). Bodyweight / duration entries (step=n/a) are progressed via reps, tempo, or external load, not kg.",
    "",
    ...lines,
    "</this_weeks_exercises>",
  ].join("\n");
}
