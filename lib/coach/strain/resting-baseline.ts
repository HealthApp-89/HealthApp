/** Window over which the resting-heart-rate baseline is taken, in days. */
export const RESTING_BASELINE_DAYS = 90;

/** Below this many real readings the window is too thin to trust; the caller's
 *  fallback is used instead. */
export const MIN_BASELINE_SAMPLES = 10;

/** The resting heart rate the strain model scores against.
 *
 *  Deliberately NOT the day's own reading. Banister TRIMP scores heart-rate
 *  RESERVE, so a lower resting HR converts identical activity into more load —
 *  measured on this athlete, a rest day scored 3.46 at RHR 50 against 0.95 at
 *  60.7, purely because his resting rate had fallen. Feeding the daily value in
 *  therefore makes the whole scale drift upward as fitness improves, and makes a
 *  strain history incomparable across exactly the change it should be measuring.
 *
 *  A 90-day median re-bases slowly and visibly instead: day-to-day RHR noise
 *  (itself a recovery signal, not a load one) cannot reach strain at all, while a
 *  genuine sustained drop still moves the baseline over a quarter. */
export function restingBaseline(values: Array<number | null>, fallback: number): number {
  const real = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
  if (real.length < MIN_BASELINE_SAMPLES) return fallback;
  real.sort((a, b) => a - b);
  return real[Math.floor(real.length / 2)];
}
