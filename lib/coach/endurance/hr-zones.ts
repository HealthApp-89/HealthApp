// lib/coach/endurance/hr-zones.ts — derive zone boundaries from threshold HR
// (Coggan model) and bucket a per-second HR stream into zone-seconds.

import type { HrZoneDistribution } from "@/lib/data/types";
import type { HrZoneRanges } from "./types";

/**
 * Coggan HR zones, expressed as % of lactate-threshold HR (LTHR).
 * Boundaries are inclusive of the lower bound and exclusive of the upper.
 * Z5 is open-ended on the high side.
 */
const COGGAN_PCT_LTHR: Readonly<HrZoneRanges> = {
  z1: [0, 0.81],
  z2: [0.81, 0.89],
  z3: [0.89, 0.94],
  z4: [0.94, 1.05],
  z5: [1.05, 99],
};

/** Derive bpm zones from threshold HR. */
export function derivedHrZones(thresholdHr: number): HrZoneRanges {
  const r = (lo: number, hi: number): [number, number] => [
    Math.round(thresholdHr * lo),
    Math.round(thresholdHr * hi),
  ];
  return {
    z1: r(COGGAN_PCT_LTHR.z1[0], COGGAN_PCT_LTHR.z1[1]),
    z2: r(COGGAN_PCT_LTHR.z2[0], COGGAN_PCT_LTHR.z2[1]),
    z3: r(COGGAN_PCT_LTHR.z3[0], COGGAN_PCT_LTHR.z3[1]),
    z4: r(COGGAN_PCT_LTHR.z4[0], COGGAN_PCT_LTHR.z4[1]),
    z5: r(COGGAN_PCT_LTHR.z5[0], COGGAN_PCT_LTHR.z5[1]),
  };
}

/**
 * Bucket a per-second HR stream into per-zone second counts.
 * Boundaries: [lo, hi) — Z5 covers everything >= z5_lo. Samples <= 0 are dropped.
 *
 * @param hrStream  array of bpm samples, sampling rate assumed 1 Hz
 * @param thresholdHr  LTHR
 */
export function bucketZones(hrStream: readonly number[], thresholdHr: number): HrZoneDistribution {
  const z = derivedHrZones(thresholdHr);
  const out: HrZoneDistribution = { z1_s: 0, z2_s: 0, z3_s: 0, z4_s: 0, z5_s: 0 };
  for (const bpm of hrStream) {
    if (!Number.isFinite(bpm) || bpm <= 0) continue;
    if (bpm < z.z2[0]) out.z1_s += 1;
    else if (bpm < z.z3[0]) out.z2_s += 1;
    else if (bpm < z.z4[0]) out.z3_s += 1;
    else if (bpm < z.z5[0]) out.z4_s += 1;
    else out.z5_s += 1;
  }
  return out;
}

/** Default HR cap for Z2 work — Coggan Z2 upper boundary as bpm. */
export function defaultZ2Cap(thresholdHr: number): number {
  return derivedHrZones(thresholdHr).z2[1];
}
