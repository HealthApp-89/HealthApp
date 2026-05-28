// lib/coach/prescription/volume-balance-rule.ts
//
// Prescribes an accessory exercise's sets per the muscle's MEV/MAV/MRV
// band position. Load progression is via autoregulation (handled in
// autoregulation-rule.ts) — this module decides sets only.

import type { PlannedExercise } from "@/lib/coach/sessionPlans";

export type VolumeBandPosition = "below_mev" | "at_mev" | "in_band" | "near_mrv" | "above_mrv";

export type VolumeBalanceInput = {
  baseExercise: PlannedExercise;
  currentSets: number;
  bandPosition: VolumeBandPosition;
};

export function prescribeAccessoryFromVolumeBand(input: VolumeBalanceInput): PlannedExercise {
  const { baseExercise: ex, currentSets, bandPosition } = input;

  let nextSets = currentSets;
  switch (bandPosition) {
    case "below_mev":
      nextSets = currentSets + 1;
      break;
    case "at_mev":
      nextSets = currentSets + 1; // push toward MAV
      break;
    case "in_band":
      nextSets = currentSets; // hold
      break;
    case "near_mrv":
      nextSets = Math.max(1, currentSets); // hold; coach narrates "no more pushing"
      break;
    case "above_mrv":
      nextSets = Math.max(1, currentSets - 1); // drop a set
      break;
  }

  return {
    ...ex,
    sets: nextSets,
  };
}

/** Maps a muscle's actual weekly sets vs landmarks to a VolumeBandPosition. */
export function classifyVolumeBand(opts: {
  actualWeeklySets: number;
  mev: number;
  mav: number;
  mrv: number;
}): VolumeBandPosition {
  if (opts.actualWeeklySets < opts.mev) return "below_mev";
  if (opts.actualWeeklySets === opts.mev) return "at_mev";
  if (opts.actualWeeklySets >= opts.mrv) return "above_mrv";
  if (opts.actualWeeklySets >= Math.floor(opts.mrv * 0.9)) return "near_mrv";
  return "in_band";
}
