// lib/coach/muscle-volume.ts
//
// Pure compute layer for per-muscle weekly volume. Used by:
//   - plan-builder/compose-strength.ts (at compose time, 8wk baseline)
//   - lib/query/fetchers/muscleVolume.ts (read time, fresh snapshot)
//   - lib/morning/brief/flags.ts (gap evaluation for Advice prompt)

import {
  EXERCISE_MUSCLES,
  TARGET_GROUP_FOR_MUSCLE,
  normalizeExerciseName,
} from "@/lib/coach/exercise-muscles";
import { targetSetsForWeek } from "@/lib/coach/volume-landmarks";
import type {
  TargetedMuscleGroup,
  MuscleVolumeBand,
  VolumeRampRecipe,
  MuscleVolumeFlag,
} from "@/lib/data/types";
import { TARGETED_MUSCLE_GROUPS } from "@/lib/data/types";

export type WorkoutSet = {
  kg: number | null;
  reps: number | null;
  warmup: boolean;
};

export type WorkoutExercise = {
  name: string;
  sets: WorkoutSet[];
};

export type Workout = {
  date: string; // ISO YYYY-MM-DD
  exercises: WorkoutExercise[];
};

/**
 * Per-muscle weekly volume averaged over `windowDays`. Returns sets/wk.
 *
 * Counting rules (mirror DEFAULT_COUNTING_RULES):
 *   - warm-ups (set.warmup === true) excluded
 *   - sets with missing reps/kg excluded
 *   - primary muscles get 1 set per working set
 *   - secondary muscles get 0.5 set per working set
 *   - unmapped exercises silently contribute 0 (name surfaced separately)
 *   - muscles outside the 10 targeted groups contribute nothing
 *
 * @returns volumes: Map from TargetedMuscleGroup to average sets/wk (1 decimal).
 *          unmapped_exercises: deduped, sorted, names not found in EXERCISE_MUSCLES.
 */
export function computeWeeklyMuscleVolume(
  workouts: Workout[],
  windowDays: number,
): {
  volumes: Record<TargetedMuscleGroup, number>;
  unmapped_exercises: string[];
} {
  const volumes = Object.fromEntries(
    TARGETED_MUSCLE_GROUPS.map((g) => [g, 0]),
  ) as Record<TargetedMuscleGroup, number>;

  if (windowDays <= 0) {
    throw new Error(
      `computeWeeklyMuscleVolume: windowDays must be > 0 (got ${windowDays})`,
    );
  }

  const unmappedSet = new Set<string>();

  for (const w of workouts) {
    for (const ex of w.exercises) {
      const key = normalizeExerciseName(ex.name);
      const mapping = EXERCISE_MUSCLES[key];
      if (!mapping) {
        unmappedSet.add(ex.name);
        continue;
      }

      const workingSets = ex.sets.filter(
        (s) => !s.warmup && s.reps != null && s.reps > 0,
      );
      const setCount = workingSets.length;
      if (setCount === 0) continue;

      for (const muscleId of mapping.primary) {
        const group = TARGET_GROUP_FOR_MUSCLE[muscleId];
        if (group) volumes[group] += setCount;
      }
      for (const muscleId of mapping.secondary) {
        const group = TARGET_GROUP_FOR_MUSCLE[muscleId];
        if (group) volumes[group] += setCount * 0.5;
      }
    }
  }

  const weeks = windowDays / 7;
  for (const g of TARGETED_MUSCLE_GROUPS) {
    volumes[g] = Math.round((volumes[g] / weeks) * 10) / 10; // 1 decimal
  }

  return {
    volumes,
    unmapped_exercises: Array.from(unmappedSet).sort(),
  };
}

/**
 * Pure gap evaluator. Given a band + ramp + this-week-to-date + 8wk avg,
 * return any flag that fires for this muscle (or null). Caller (brief
 * composer) iterates all muscles, ranks all returned flags, truncates to
 * top-2 across the result set.
 */
export function evaluateMuscleVolumeGap(
  group: TargetedMuscleGroup,
  actual_8wk: number,
  actual_wtd: number,
  band: MuscleVolumeBand,
  ramp_recipe: VolumeRampRecipe,
  currentBlockWeek: number,
  daysLeftInWeek: number,
  isTrainingDay: boolean,
  weekdayLabel: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun",
): MuscleVolumeFlag | null {
  const target_this_week = targetSetsForWeek(band, ramp_recipe, currentBlockWeek);

  // `near_mrv` — only on training days
  if (isTrainingDay && actual_wtd > band.mrv * 0.9) {
    return {
      kind: "near_mrv",
      group,
      actual_wtd,
      mrv: band.mrv,
    };
  }

  // `below_mev_persistent` — fires every brief while history is below MEV × 0.7
  if (actual_8wk < band.mev * 0.7) {
    return {
      kind: "below_mev_persistent",
      group,
      actual_8wk,
      mev: band.mev,
    };
  }

  // `below_mev_recent` — only on training days Thu/Fri/Sat (late-week rescue window)
  const lateWeek = weekdayLabel === "Thu" || weekdayLabel === "Fri" || weekdayLabel === "Sat";
  if (isTrainingDay && lateWeek && actual_wtd < target_this_week * 0.6) {
    return {
      kind: "below_mev_recent",
      group,
      actual_wtd,
      target_this_week,
      days_left: daysLeftInWeek,
    };
  }

  return null;
}

/**
 * Rank flags by urgency. near_mrv > below_mev_persistent > below_mev_recent.
 * Caller truncates to top N (typically 2) to prevent Advice prompt noise.
 */
export function rankMuscleVolumeFlags(
  flags: MuscleVolumeFlag[],
): MuscleVolumeFlag[] {
  const priority: Record<MuscleVolumeFlag["kind"], number> = {
    near_mrv: 3,
    below_mev_persistent: 2,
    below_mev_recent: 1,
  };
  return [...flags].sort((a, b) => priority[b.kind] - priority[a.kind]);
}
