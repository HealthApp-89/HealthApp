// lib/health/measurements.ts
//
// Pure functions for derived measurement metrics. Inputs that include null
// produce null outputs — UI renders "—" rather than synthetic zeros.
import type { BodyMeasurement, BodyMeasurementField } from "@/lib/data/types";
import { BODY_MEASUREMENT_FIELDS } from "@/lib/data/types";

/** Waist–hip ratio: mid_waist_cm / hips_cm. */
export function whr(m: BodyMeasurement): number | null {
  if (m.mid_waist_cm == null || m.hips_cm == null || m.hips_cm === 0) return null;
  return m.mid_waist_cm / m.hips_cm;
}

/** Waist–chest ratio: mid_waist_cm / chest_cm (V-taper proxy). */
export function waistChest(m: BodyMeasurement): number | null {
  if (m.mid_waist_cm == null || m.chest_cm == null || m.chest_cm === 0) return null;
  return m.mid_waist_cm / m.chest_cm;
}

/** Average upper-arm circumference. */
export function armAvg(m: BodyMeasurement): number | null {
  return avg2(m.left_upper_arm_cm, m.right_upper_arm_cm);
}

/** Average thigh circumference (max girth, not min). */
export function thighAvg(m: BodyMeasurement): number | null {
  return avg2(m.left_thigh_cm, m.right_thigh_cm);
}

/** Average calf circumference. */
export function calfAvg(m: BodyMeasurement): number | null {
  return avg2(m.left_calf_cm, m.right_calf_cm);
}

/** Symmetry as a percentage: |L−R| / ((L+R)/2) * 100. 0 = perfect symmetry. */
export function symmetryPct(l: number | null, r: number | null): number | null {
  if (l == null || r == null) return null;
  const mean = (l + r) / 2;
  if (mean === 0) return null;
  return (Math.abs(l - r) / mean) * 100;
}

/** Per-field delta vs prior measurement. abs is `curr − prev`; pct is the
 *  percentage change (null when prev is 0 or either side is null). */
export function delta(
  curr: BodyMeasurement,
  prev: BodyMeasurement | null,
): Record<BodyMeasurementField, { abs: number; pct: number | null } | null> {
  const out = {} as Record<
    BodyMeasurementField,
    { abs: number; pct: number | null } | null
  >;
  for (const k of BODY_MEASUREMENT_FIELDS) {
    const a = curr[k];
    const b = prev?.[k] ?? null;
    if (a == null || b == null) {
      out[k] = null;
      continue;
    }
    const abs = a - b;
    const pct = b === 0 ? null : (abs / b) * 100;
    out[k] = { abs, pct };
  }
  return out;
}

function avg2(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  return (a + b) / 2;
}
