import type { HrSource } from "./types";

/** Fitted strain constants.
 *
 *  PROVISIONAL — fitted 2026-08-12 under a TWO-term form in which baseline was a
 *  fixed +3.5 strain constant rather than a load term:
 *
 *    strain = 3.5 + 4.5·ln(1 + 0.0706·(activity_trimp + 0.00795·mechanical))
 *
 *  RMSE 1.56 over 61 labelled April–May 2026 days. Superseded by
 *  scripts/fit-strain-constants.mjs once scripts/fixtures/strain-calibration-2026.json
 *  carries baseline HR for the calibration window (see the plan's Task 13).
 *
 *  `w` converts tonnage-equivalent kilograms into TRIMP units: 1 TRIMP ≈ 126 kg.
 *  `mechanicalNorm` rescales the muscle/intensity/RIR-weighted sum back onto the
 *  raw-tonnage scale the fit was performed on. 1 until the refit computes it. */
export const STRAIN_CALIBRATION = {
  A: 4.5,
  k: 0.0706,
  w: 0.00795,
  mechanicalNorm: 1,
} as const;

/** Longest interval a single pair of HR samples may contribute, in minutes.
 *  Guards against off-wrist gaps being scored at the last-seen heart rate. */
export const MAX_INTERVAL_MIN = 10;

/** Hand-maintained device → sensor map. Garmin does not report sensor type on
 *  the activity record, so this is edited when hardware changes rather than
 *  inferred from HR characteristics — an inferred value would be a guess
 *  presented as a measurement.
 *
 *  3491966227 — Fenix 8. Currently wrist optical; becomes 'chest' when the
 *  HRM strap is paired for cardio. A CIRQA arm band gets its own entry ('arm')
 *  when its deviceId is first seen in ingest. */
export const DEVICE_HR_SOURCE: Record<string, HrSource> = {
  "3491966227": "wrist",
};

/** Preference order for cross-device dedup: a better sensor wins. */
export const HR_SOURCE_RANK: Record<HrSource, number> = {
  chest: 0,
  arm: 1,
  wrist: 2,
  unknown: 3,
};
