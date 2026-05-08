// lib/coach/progress-metrics.ts
//
// Pure functions for body-composition-aware strength metrics. Used by
// /api/coach/block-progress and the coach plan_week prompt template.
//
// Per the spec (docs/superpowers/specs/2026-05-08-weekly-coach-planning-design.md
// section "Body-comp-aware metric computation"), these are the v1 set:
//
//   strengthPerLbm  — load / lean body mass; most sensitive recomp metric
//   allometric      — load / bw^0.67; surface-area-to-volume scaling (Ødland 2023)
//   ipfGl           — IPF GoodLift, official 2020 powerlifting total formula
//
// All three return null for missing/zero inputs rather than NaN/Infinity.

/** e1RM (kg) divided by lean body mass (kg). Most sensitive recomp metric:
 *  rises when load holds and LBM holds, when load rises and LBM is flat,
 *  or when load is flat and fat is lost (LBM holds while body weight drops). */
export function strengthPerLbm(
  e1rm_kg: number | null | undefined,
  lbm_kg: number | null | undefined,
): number | null {
  if (e1rm_kg == null || lbm_kg == null) return null;
  if (e1rm_kg <= 0 || lbm_kg <= 0) return null;
  return e1rm_kg / lbm_kg;
}

/** Allometric strength: load (kg) divided by bodyweight^0.67. Less sensitive
 *  to fat loss than strength-per-LBM but available whenever weight is known
 *  (LBM data from Withings is sometimes missing for days). */
export function allometric(
  load_kg: number | null | undefined,
  bw_kg: number | null | undefined,
): number | null {
  if (load_kg == null || bw_kg == null) return null;
  if (load_kg <= 0 || bw_kg <= 0) return null;
  return load_kg / Math.pow(bw_kg, 0.67);
}

/** IPF GoodLift score for a 3-lift powerlifting total. Formula:
 *
 *    GL = total × 100 / (A − B·exp(−C·BW))
 *
 *  Constants from the IPF official 2020 formula evaluation:
 *    Powerlifting Total (M): A=1199.72839, B=1025.18162, C=0.00921
 *    Powerlifting Total (F): A=610.32796,  B=1045.59282, C=0.03048
 *
 *  Returns null if any of squat/bench/dead is missing or non-positive,
 *  or if BW is missing/non-positive. */
export function ipfGl(
  squat_kg: number | null | undefined,
  bench_kg: number | null | undefined,
  dead_kg: number | null | undefined,
  bw_kg: number | null | undefined,
  sex: "M" | "F" = "M",
): number | null {
  if (squat_kg == null || bench_kg == null || dead_kg == null || bw_kg == null) return null;
  if (squat_kg <= 0 || bench_kg <= 0 || dead_kg <= 0 || bw_kg <= 0) return null;

  const total = squat_kg + bench_kg + dead_kg;
  const c = sex === "M"
    ? { A: 1199.72839, B: 1025.18162, C: 0.00921 }
    : { A: 610.32796, B: 1045.59282, C: 0.03048 };

  const denom = c.A - c.B * Math.exp(-c.C * bw_kg);
  if (denom <= 0) return null; // formula breakdown for absurd BW; defensive
  return (total * 100) / denom;
}

/** Proportional delta (e.g., 0.026 = +2.6%) between two values. Returns
 *  null when either value is null or when `from` is zero (undefined ratio). */
export function deltaPct(from: number | null, to: number | null): number | null {
  if (from == null || to == null || from === 0) return null;
  return (to - from) / from;
}
