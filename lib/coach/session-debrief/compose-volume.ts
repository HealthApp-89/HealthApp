// lib/coach/session-debrief/compose-volume.ts
//
// Per-muscle volume rollup for the current week (Mon→today), compared
// against literature MEV/MAV/MRV bands. Working sets only (warmups excluded).
// Secondary muscle hits count at 0.5× (DEFAULT_COUNTING_RULES.secondary_set_factor).
//
// Output status:
//   below_mev          — under minimum effective volume
//   in_mav             — inside the sweet-spot band
//   approaching_mrv    — above MAV-high but ≤ MRV
//   over_mrv           — above MRV; recovery debt likely

import type { SupabaseClient } from "@supabase/supabase-js";
import { weekStart } from "@/lib/coach/derived";
import { getExerciseMuscles, TARGET_GROUP_FOR_MUSCLE } from "@/lib/coach/exercise-muscles";
import { literatureBand, DEFAULT_COUNTING_RULES } from "@/lib/coach/volume-landmarks";
import type { TargetedMuscleGroup } from "@/lib/data/types";
import type { WorkoutDebriefPayload } from "@/lib/coach/session-debrief/payload";

type ExerciseWithSets = {
  name: string;
  sets: Array<{ warmup: boolean }>;
};

type ComposeVolumeInput = {
  supabase: SupabaseClient;
  userId: string;
  workoutId: string;
  workoutDate: string; // YYYY-MM-DD
  todayExercises: ExerciseWithSets[];
  tier?: "beginner" | "intermediate" | "advanced"; // default "intermediate"
};

/** Convert exercise + working-set-count into a per-target-group set contribution
 *  using the EXERCISE_MUSCLES map + TARGET_GROUP_FOR_MUSCLE collapse. Off-library
 *  exercises (free-form names from Carter session-write tools) skip volume
 *  rollup. */
function attribute(name: string, workingSets: number): Map<TargetedMuscleGroup, number> {
  const result = new Map<TargetedMuscleGroup, number>();
  const mapping = getExerciseMuscles(name);
  if (!mapping) return result;
  const k = DEFAULT_COUNTING_RULES.secondary_set_factor;

  for (const mid of mapping.primary) {
    const grp = TARGET_GROUP_FOR_MUSCLE[mid];
    if (!grp) continue;
    result.set(grp, (result.get(grp) ?? 0) + workingSets);
  }
  for (const mid of mapping.secondary) {
    const grp = TARGET_GROUP_FOR_MUSCLE[mid];
    if (!grp) continue;
    result.set(grp, (result.get(grp) ?? 0) + workingSets * k);
  }
  return result;
}

export async function composeVolume(
  input: ComposeVolumeInput,
): Promise<WorkoutDebriefPayload["volume"]> {
  const { supabase, userId, workoutId, workoutDate, todayExercises, tier = "intermediate" } = input;

  // 1. Sum today's contribution per muscle group.
  const todayByMuscle = new Map<TargetedMuscleGroup, number>();
  for (const ex of todayExercises) {
    const workingCount = ex.sets.filter((s) => !s.warmup).length;
    if (workingCount === 0) continue;
    const contrib = attribute(ex.name, workingCount);
    for (const [g, v] of contrib) {
      todayByMuscle.set(g, (todayByMuscle.get(g) ?? 0) + v);
    }
  }

  // 2. Sum this week's prior workouts (Mon→day-before-today) per muscle group.
  const monday = weekStart(workoutDate);
  const { data: weekWorkouts, error: wwErr } = await supabase
    .from("workouts")
    .select("id, date")
    .eq("user_id", userId)
    .gte("date", monday)
    .lte("date", workoutDate)
    .neq("id", workoutId); // exclude today's workout (we add it separately)
  if (wwErr) throw new Error(`week workouts lookup failed: ${wwErr.message}`);

  const priorWorkoutIds = (weekWorkouts ?? []).map((w) => w.id as string);
  const priorByMuscle = new Map<TargetedMuscleGroup, number>();

  if (priorWorkoutIds.length > 0) {
    const { data: exs, error: exErr } = await supabase
      .from("exercises")
      .select("id, name")
      .in("workout_id", priorWorkoutIds);
    if (exErr) throw new Error(`week exercises lookup failed: ${exErr.message}`);
    const exsById = new Map(((exs as Array<{ id: string; name: string }>) ?? []).map((e) => [e.id, e]));

    const exIds = Array.from(exsById.keys());
    if (exIds.length > 0) {
      const { data: sets, error: setsErr } = await supabase
        .from("exercise_sets")
        .select("exercise_id, warmup")
        .in("exercise_id", exIds);
      if (setsErr) throw new Error(`week sets lookup failed: ${setsErr.message}`);

      const workingByExercise = new Map<string, number>();
      for (const s of (sets as Array<{ exercise_id: string; warmup: boolean }>) ?? []) {
        if (s.warmup) continue;
        workingByExercise.set(s.exercise_id, (workingByExercise.get(s.exercise_id) ?? 0) + 1);
      }
      for (const [exId, count] of workingByExercise) {
        const ex = exsById.get(exId);
        if (!ex) continue;
        const contrib = attribute(ex.name, count);
        for (const [g, v] of contrib) {
          priorByMuscle.set(g, (priorByMuscle.get(g) ?? 0) + v);
        }
      }
    }
  }

  // 3. Combine + classify against literature band.
  const allMuscles = new Set<TargetedMuscleGroup>([
    ...todayByMuscle.keys(),
    ...priorByMuscle.keys(),
  ]);
  const out: WorkoutDebriefPayload["volume"] = [];
  for (const muscle of allMuscles) {
    const sets_today = Math.round((todayByMuscle.get(muscle) ?? 0) * 10) / 10;
    const sets_this_week = Math.round(((todayByMuscle.get(muscle) ?? 0) + (priorByMuscle.get(muscle) ?? 0)) * 10) / 10;
    const band = literatureBand(muscle, tier);
    const mavHigh = band.mav[1];
    const mavLow = band.mav[0];
    let status: WorkoutDebriefPayload["volume"][number]["status"];
    if (sets_this_week < band.mev) status = "below_mev";
    else if (sets_this_week <= mavHigh) status = "in_mav";
    else if (sets_this_week <= band.mrv) status = "approaching_mrv";
    else status = "over_mrv";

    out.push({
      muscle,
      sets_today,
      sets_this_week,
      band: { mev: band.mev, mav_low: mavLow, mav_high: mavHigh, mrv: band.mrv },
      status,
    });
  }
  return out.sort((a, b) => b.sets_today - a.sets_today);
}
