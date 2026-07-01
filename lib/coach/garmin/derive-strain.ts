// Derive a WHOOP-parity 0-21 daily strain from a Garmin all-day HR stream.
// Two TRIMP methods (Edwards, Banister-men) → saturating log map. Pure; no DB.
// Spec: docs/superpowers/specs/2026-07-01-garmin-fenix-ingest-design.md §5

export type HrSample = { ts: number; bpm: number }; // ts = epoch ms
export type StrainCalibration = { A: number; k: number };

/** Calibrated against WHOOP strain over the June 2026 parallel-run window
 *  (scripts/audit-garmin-vs-whoop.mjs grid-search fit). RMSE 1.89 over 27 days. */
export const DEFAULT_STRAIN_CALIBRATION: StrainCalibration = { A: 5, k: 0.04 };

/** Half-open zone bands on %HRmax: Z1 50-59, Z2 60-69, Z3 70-79, Z4 80-89,
 *  Z5 90+. Below 50% → 0 (no strain contribution). */
export function hrZone(bpm: number, hrMax: number): 0 | 1 | 2 | 3 | 4 | 5 {
  const pct = (bpm / hrMax) * 100;
  if (pct < 50) return 0;
  if (pct < 60) return 1;
  if (pct < 70) return 2;
  if (pct < 80) return 3;
  if (pct < 90) return 4;
  return 5;
}

/** Median gap between consecutive samples, in minutes. Fallback 2 min for a
 *  single sample (Garmin all-day HR is 2-min-sampled). Used to give each
 *  sample a duration weight. */
function sampleMinutes(samples: HrSample[]): number {
  if (samples.length < 2) return 2;
  const gaps: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const g = (samples[i].ts - samples[i - 1].ts) / 60_000;
    if (g > 0 && g < 60) gaps.push(g); // ignore gaps/outliers (device off-wrist)
  }
  if (gaps.length === 0) return 2;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/** Edwards TRIMP: Σ (minutes-per-sample × zone weight 1..5). Needs only hrMax.
 *  Each sample is assigned the median gap duration (including the final sample). */
export function edwardsTrimp(samples: HrSample[], hrMax: number): number {
  const mins = sampleMinutes(samples);
  let trimp = 0;
  for (const s of samples) {
    trimp += mins * hrZone(s.bpm, hrMax);
  }
  return trimp;
}

/** Banister TRIMP (men's coefficients): Σ over consecutive intervals of
 *  duration(min) × HRr × 0.64·e^(1.92·HRr),
 *  HRr = (bpm - hrRest) / (hrMax - hrRest), clamped to [0, 1].
 *  Each interval represents the gap between two consecutive samples; the
 *  HR of the leading sample is used. Off-wrist gaps (≥ 60 min) use the
 *  median gap duration instead. */
export function banisterTrimp(
  samples: HrSample[],
  hrRest: number,
  hrMax: number,
): number {
  if (samples.length < 2) return 0;
  const median = sampleMinutes(samples);
  const reserve = hrMax - hrRest;
  if (reserve <= 0) return 0;
  let trimp = 0;
  for (let i = 0; i < samples.length - 1; i++) {
    const g = (samples[i + 1].ts - samples[i].ts) / 60_000;
    const mins = g > 0 && g < 60 ? g : median;
    let hrr = (samples[i].bpm - hrRest) / reserve;
    if (hrr < 0) hrr = 0;
    if (hrr > 1) hrr = 1;
    trimp += mins * hrr * (0.64 * Math.exp(1.92 * hrr));
  }
  return trimp;
}

/** Map a raw TRIMP to a bounded 0-21 strain via a saturating log transform. */
export function trimpToStrain(
  trimp: number,
  cal: StrainCalibration = DEFAULT_STRAIN_CALIBRATION,
): number {
  if (trimp <= 0) return 0;
  return Math.min(21, cal.A * Math.log(1 + cal.k * trimp));
}
