// lib/coach/weekly-review/compose-volume.ts
//
// §6 of the weekly review. Per-muscle last-week sets/wk + next-week
// targets. Composes via the existing muscle-volume + volume-landmarks
// helpers (signatures verified against lib/coach/muscle-volume.ts and
// lib/coach/volume-landmarks.ts).
//
// Reads bands + ramp_recipe from the user's active athlete_profile_documents
// row's plan_payload.strength.muscle_volume when one exists; falls back to
// literature defaults (intermediate tier, default ramp recipe) when the
// user hasn't generated a plan yet.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeWeeklyMuscleVolume,
  type Workout,
} from "@/lib/coach/muscle-volume";
import {
  targetSetsForWeek,
  literatureBand,
  DEFAULT_RAMP_RECIPE,
} from "@/lib/coach/volume-landmarks";
import { blockWeekForPhase } from "@/lib/coach/weekly-review/phase-mapping";
import { addDays } from "./date-utils";
import {
  TARGETED_MUSCLE_GROUPS,
  type MuscleVolumeBand,
  type PlanPayload,
  type TargetedMuscleGroup,
  type VolumeRampRecipe,
  type WeeklyPhase,
  type WeeklyReviewPayload,
} from "@/lib/data/types";

type VolumeOutput = WeeklyReviewPayload["volume"];
type PerMuscleEntry = VolumeOutput["per_muscle"][number];

const WORKOUT_SELECT =
  "date, exercises (name, sets:exercise_sets (kg, reps, warmup))";

export async function composeVolume(args: {
  supabase: SupabaseClient;
  userId: string;
  /** Monday YYYY-MM-DD of the recap week. */
  weekStart: string;
  /** The WeeklyPhase the next week will run in. Determines next-week targets
   *  (mev/mav/mrv/deload) via blockWeekForPhase + targetSetsForWeek. */
  nextPhase: WeeklyPhase;
}): Promise<VolumeOutput> {
  const { supabase, userId, weekStart, nextPhase } = args;
  const weekEnd = addDays(weekStart, 6);

  // 1. Fetch last week's workouts and compute per-muscle sets.
  const { data: rawWorkouts, error: wErr } = await supabase
    .from("workouts")
    .select(WORKOUT_SELECT)
    .eq("user_id", userId)
    .gte("date", weekStart)
    .lte("date", weekEnd)
    .order("date", { ascending: true });
  if (wErr) throw wErr;

  const workouts: Workout[] = (rawWorkouts ?? []).map((w) => {
    const exercises =
      (w.exercises as Array<{
        name: string;
        sets: Array<{
          kg: number | null;
          reps: number | null;
          warmup: boolean;
        }>;
      }> | null) ?? [];
    return {
      date: w.date,
      exercises: exercises.map((e) => ({
        name: e.name,
        sets: (e.sets ?? []).map((s) => ({
          kg: s.kg,
          reps: s.reps,
          warmup: s.warmup,
        })),
      })),
    };
  });

  const { volumes: lastWeekSetsByMuscle } = computeWeeklyMuscleVolume(
    workouts,
    7,
  );

  // 2. Resolve per-muscle bands + ramp_recipe from the active plan if one
  //    exists; otherwise fall back to literature defaults at the intermediate
  //    tier. We only need MEV + ramp recipe for targetSetsForWeek; that
  //    matches the helper's `Pick<MuscleVolumeBand, "mev">` shape.
  const { bands, rampRecipe } = await resolvePlanLandmarks(supabase, userId);
  const blockWeek = blockWeekForPhase(nextPhase);
  const tier = phaseToTier(nextPhase);

  const perMuscle: PerMuscleEntry[] = TARGETED_MUSCLE_GROUPS.map((muscle) => {
    const band = bands[muscle];
    const nextTargetSets = targetSetsForWeek(band, rampRecipe, blockWeek);
    return {
      muscle,
      last_week_sets: lastWeekSetsByMuscle[muscle],
      next_week_sets: nextTargetSets,
      tier,
    };
  });

  return { per_muscle: perMuscle };
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** WeeklyPhase → tier on the output payload.
 *  WeeklyReviewPayload.volume.per_muscle.tier is `"mev" | "mav" | "mrv"` —
 *  no `"deload"`. Deload weeks map to the lowest tier (mev) since the
 *  set target collapses to ramp_recipe.deload_pct × MEV.
 *  v2 BlockPhase labels are not consumed by this v1 volume-ramp path;
 *  they fall back to "mev" (the safest/lowest tier). */
function phaseToTier(
  phase: WeeklyPhase,
): PerMuscleEntry["tier"] {
  if (phase === "mav" || phase === "mrv") return phase;
  return "mev";
}

async function resolvePlanLandmarks(
  supabase: SupabaseClient,
  userId: string,
): Promise<{
  bands: Record<TargetedMuscleGroup, MuscleVolumeBand>;
  rampRecipe: VolumeRampRecipe;
}> {
  const { data, error } = await supabase
    .from("athlete_profile_documents")
    .select("plan_payload")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;

  const plan = data?.plan_payload as PlanPayload | null;
  const mv = plan?.strength.muscle_volume ?? null;
  if (mv) {
    return { bands: mv.bands, rampRecipe: mv.ramp_recipe };
  }

  // Fallback: literature defaults at intermediate tier with the default ramp.
  const bands = Object.fromEntries(
    TARGETED_MUSCLE_GROUPS.map((g) => {
      const lit = literatureBand(g, "intermediate");
      const band: MuscleVolumeBand = {
        mev: lit.mev,
        mav: lit.mav,
        mrv: lit.mrv,
        history_8wk_avg: 0,
        source: "literature_default",
        rationale: "literature_default (no active plan)",
      };
      return [g, band];
    }),
  ) as Record<TargetedMuscleGroup, MuscleVolumeBand>;

  return { bands, rampRecipe: DEFAULT_RAMP_RECIPE };
}
