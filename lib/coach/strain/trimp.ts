import { MAX_INTERVAL_MIN } from "./constants";
import type { HrSample, TimeWindow } from "./types";

/** Banister TRIMP (men's coefficients) walked over consecutive sample pairs.
 *
 *  Σ minutes × HRr × 0.64·e^(1.92·HRr),  HRr = (bpm − hrRest)/(hrMax − hrRest)
 *
 *  Two behaviours the plain `banisterTrimp` in lib/coach/garmin/derive-strain.ts
 *  cannot provide, and the reason this function exists:
 *
 *  1. `skipWindows` drops an interval whose span overlaps an excluded window
 *     rather than filtering the samples. Filtering would leave one long gap
 *     that scores the whole excluded span at the pre-window heart rate — a
 *     50-minute session credited at desk-work HR on top of its own activity
 *     stream, which is exactly the double-count this guards.
 *  2. Long intervals are CLAMPED to MAX_INTERVAL_MIN rather than replaced with
 *     a median. An off-wrist gap is unknown time, not typical time.
 *
 *  With no windows and no long gaps it is arithmetically identical to
 *  `banisterTrimp`. Samples must be sorted by `ts`. */
export function banisterOverIntervals(
  samples: HrSample[],
  hrRest: number,
  hrMax: number,
  skipWindows: TimeWindow[] = [],
): number {
  if (samples.length < 2) return 0;
  const reserve = hrMax - hrRest;
  if (reserve <= 0) return 0;

  let trimp = 0;
  for (let i = 0; i < samples.length - 1; i++) {
    const startMs = samples[i].ts;
    const endMs = samples[i + 1].ts;
    if (endMs <= startMs) continue;
    if (skipWindows.some((wnd) => startMs < wnd.endMs && endMs > wnd.startMs)) continue;

    const minutes = Math.min((endMs - startMs) / 60_000, MAX_INTERVAL_MIN);
    let hrr = (samples[i].bpm - hrRest) / reserve;
    if (hrr < 0) hrr = 0;
    if (hrr > 1) hrr = 1;
    trimp += minutes * hrr * (0.64 * Math.exp(1.92 * hrr));
  }
  return trimp;
}

/** Median gap between consecutive samples, in seconds. Null for a stream too
 *  short to have one. Reported to daily_logs.hr_sample_density so a device swap
 *  is recorded rather than inferred. Median, not mean, so overnight charging
 *  gaps do not move it. */
export function medianGapSeconds(samples: HrSample[]): number | null {
  if (samples.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const g = (samples[i].ts - samples[i - 1].ts) / 1000;
    if (g > 0) gaps.push(g);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}
