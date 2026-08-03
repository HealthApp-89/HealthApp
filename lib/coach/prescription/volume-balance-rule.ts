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
  /** Fraction of the exercise's recent working sets taken to failure or
   *  RIR 0 (see effort-quality.ts). Omitted → treated as 0 (no gate). */
  hardRate?: number;
  /** Size of the sample `hardRate` was computed from. Guards against a
   *  single logged set suppressing a bump. Omitted → treated as 0. */
  effortSampleSets?: number;
};

/** MEV/MAV/MRV landmarks assume sets at roughly 0-4 RIR without systematic
 *  failure. With 3-set exercises one hard finishing set is 1/3 and is
 *  accepted practice, so the gate fires strictly ABOVE one third — i.e.
 *  from two hard sets in three. */
export const HARD_RATE_SUPPRESS_THRESHOLD = 1 / 3;
export const MIN_SETS_FOR_EFFORT_GATE = 3;

/** True when a below-MEV/at-MEV bump should be withheld because the muscle
 *  is already being trained past failure. Never suppresses the above_mrv
 *  set DROP — shedding volume under high effort is always correct. */
export function isEffortSuppressed(input: VolumeBalanceInput): boolean {
  if (input.bandPosition !== "below_mev" && input.bandPosition !== "at_mev") return false;
  if ((input.effortSampleSets ?? 0) < MIN_SETS_FOR_EFFORT_GATE) return false;
  return (input.hardRate ?? 0) > HARD_RATE_SUPPRESS_THRESHOLD;
}

export function prescribeAccessoryFromVolumeBand(input: VolumeBalanceInput): PlannedExercise {
  const { baseExercise: ex, currentSets, bandPosition } = input;
  const suppressed = isEffortSuppressed(input);

  let nextSets = currentSets;
  switch (bandPosition) {
    case "below_mev":
      nextSets = suppressed ? currentSets : currentSets + 1;
      break;
    case "at_mev":
      nextSets = suppressed ? currentSets : currentSets + 1; // push toward MAV
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
