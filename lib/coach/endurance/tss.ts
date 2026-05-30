// lib/coach/endurance/tss.ts — HR-based TSS computation.
//
// hrTSS reference: a 1-hour effort at threshold HR = 100 TSS.
// formula: durationH * (avgHr / thresholdHr)^2 * 100
//
// Phase 2 will add powerTSS for activities with avg_power_w + ftp_watts.
// The branching wrapper (computeTssForActivity) picks the best estimate.

export function computeHrTss(durationS: number, avgHr: number, thresholdHr: number): number {
  if (durationS <= 0 || avgHr <= 0 || thresholdHr <= 0) return 0;
  const durationH = durationS / 3600;
  const intensity = avgHr / thresholdHr;
  return Math.round(durationH * intensity * intensity * 100 * 10) / 10; // 1 dp
}

/**
 * Pick the best available TSS estimate.
 *  - Power-based when avg_power_w + ftp_watts present (Phase 2)
 *  - Otherwise HR-based when avg_hr + threshold_hr present
 *  - Otherwise null (caller surfaces "calibrate threshold HR" CTA)
 */
export function computeTssForActivity(args: {
  durationS: number;
  avgHr: number | null;
  thresholdHr: number | null;
  avgPowerW?: number | null;
  ftpWatts?: number | null;
}): number | null {
  // Power path (Phase 2). Same column, different formula; included now so the
  // resolution chain is fixed and Phase 2 only fills in the power branch.
  if (args.avgPowerW && args.ftpWatts && args.avgPowerW > 0 && args.ftpWatts > 0) {
    const durationH = args.durationS / 3600;
    const intensity = args.avgPowerW / args.ftpWatts;
    return Math.round(durationH * intensity * intensity * 100 * 10) / 10;
  }
  // HR path (Phase 1)
  if (args.avgHr && args.thresholdHr && args.avgHr > 0 && args.thresholdHr > 0) {
    return computeHrTss(args.durationS, args.avgHr, args.thresholdHr);
  }
  return null;
}
