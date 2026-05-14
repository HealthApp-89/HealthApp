// lib/coach/volume-landmarks.ts
//
// Literature default MEV/MAV/MRV per targeted muscle group + tier scaling.
//
// Source: Renaissance Periodization Hypertrophy Volume Landmarks
// (Israetel et al.), cross-referenced against Schoenfeld 2017 & 2022
// meta-analyses for chest, back, quads dose-response data. These are
// field-best-practice consensus, NOT clinical-trial-validated thresholds.

import type {
  TargetedMuscleGroup,
  MuscleVolumeBand,
  VolumeRampRecipe,
  VolumeCountingRules,
} from "@/lib/data/types";

type LiteratureBand = Pick<MuscleVolumeBand, "mev" | "mav" | "mrv">;

const INTERMEDIATE: Record<TargetedMuscleGroup, LiteratureBand> = {
  Chest: { mev: 10, mav: [12, 20], mrv: 22 },
  Lats: { mev: 10, mav: [14, 22], mrv: 25 },
  Traps: { mev: 4, mav: [6, 12], mrv: 16 },
  RearDelts: { mev: 8, mav: [10, 20], mrv: 26 },
  Quads: { mev: 8, mav: [12, 18], mrv: 20 },
  Hams: { mev: 6, mav: [10, 16], mrv: 20 },
  Glutes: { mev: 4, mav: [6, 12], mrv: 16 },
  Biceps: { mev: 8, mav: [14, 20], mrv: 26 },
  Triceps: { mev: 6, mav: [10, 14], mrv: 18 },
  Calves: { mev: 8, mav: [12, 16], mrv: 20 },
};

const TIER_SCALAR: Record<"beginner" | "intermediate" | "advanced", number> = {
  beginner: 0.7,
  intermediate: 1.0,
  advanced: 1.2,
};

export const DEFAULT_RAMP_RECIPE: VolumeRampRecipe = {
  start_pct: 1.0,
  peak_pct: 1.4,
  deload_pct: 0.5,
};

export const DEFAULT_COUNTING_RULES: VolumeCountingRules = {
  secondary_set_factor: 0.5,
  warmup_excluded: true,
  window_weeks: 8,
};

/** Resolve the literature-default band for a muscle + training-age tier.
 *  Pre-history-adjustment: composeMuscleVolume applies the history rule
 *  on top of this. */
export function literatureBand(
  group: TargetedMuscleGroup,
  tier: "beginner" | "intermediate" | "advanced",
): LiteratureBand {
  const k = TIER_SCALAR[tier];
  const b = INTERMEDIATE[group];
  return {
    mev: Math.round(b.mev * k),
    mav: [Math.round(b.mav[0] * k), Math.round(b.mav[1] * k)],
    mrv: Math.round(b.mrv * k),
  };
}

/** Interpolate the per-week target as MEV × ramp_recipe(week).
 *  Weeks 1-4 linearly ramp from start_pct → peak_pct; week 5 is deload_pct.
 *  Weeks outside 1-5 (defensive: blocks may run longer) clamp to peak_pct. */
export function targetSetsForWeek(
  band: Pick<MuscleVolumeBand, "mev">,
  recipe: VolumeRampRecipe,
  weekOfBlock: number,
): number {
  if (weekOfBlock <= 0) return Math.round(band.mev * recipe.start_pct);
  if (weekOfBlock > 5) return Math.round(band.mev * recipe.peak_pct); // clamp extended blocks
  if (weekOfBlock === 5) return Math.round(band.mev * recipe.deload_pct);
  // Linear interpolation across weeks 1-4
  const t = (weekOfBlock - 1) / 3; // 0..1
  const pct = recipe.start_pct + (recipe.peak_pct - recipe.start_pct) * t;
  return Math.round(band.mev * pct);
}
