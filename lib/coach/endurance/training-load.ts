// lib/coach/endurance/training-load.ts — exponentially-weighted training load.
//
// Phase 1 ships the math even though the chart is deferred — composers /
// dashboard rules use CTL/ATL/TSB as numeric inputs.
//
// Standard convention (TrainingPeaks / WKO):
//   CTL = 42-day exponentially-weighted average of daily TSS (fitness)
//   ATL = 7-day  exponentially-weighted average of daily TSS (fatigue)
//   TSB = CTL - ATL (form)
//
// Implemented as a straight pass over a contiguous daily TSS series
// (zero-fill missing days before calling).

const CTL_DAYS = 42;
const ATL_DAYS = 7;

function ewma(series: readonly number[], days: number): number {
  if (series.length === 0) return 0;
  const alpha = 2 / (days + 1);
  let prev = series[0];
  for (let i = 1; i < series.length; i += 1) {
    prev = alpha * series[i] + (1 - alpha) * prev;
  }
  return Math.round(prev * 10) / 10;
}

export type TrainingLoad = { ctl: number; atl: number; tsb: number };

export function computeTrainingLoad(dailyTss: readonly number[]): TrainingLoad {
  const ctl = ewma(dailyTss, CTL_DAYS);
  const atl = ewma(dailyTss, ATL_DAYS);
  return { ctl, atl, tsb: Math.round((ctl - atl) * 10) / 10 };
}

/** Convenience: ramp rate is delta CTL over the last 7 days. */
export function computeRampRate(dailyTss: readonly number[]): number {
  if (dailyTss.length < 8) return 0;
  const today = ewma(dailyTss, CTL_DAYS);
  const weekAgo = ewma(dailyTss.slice(0, -7), CTL_DAYS);
  return Math.round((today - weekAgo) * 10) / 10;
}
