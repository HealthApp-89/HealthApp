// lib/coach/prescription/volume-adherence.ts
//
// Was the prescribed set count actually performed? The volume-band rule adds
// +1 set to a below-MEV muscle, but the rolling volume it measures is built
// from REALIZED sets — so a bump that is never performed leaves the muscle
// below MEV forever and the bump repeats indefinitely. This module detects
// that state so the engine can stop re-issuing a futile bump and surface the
// real (frequency) recommendation instead.

import type { WorkoutSetSample } from "@/lib/coach/prescription/types";

const LOOKBACK_DAYS = 28; // matches maintenance-baseline.ts and effort-quality.ts

/** Consecutive short exposures after which the engine stops bumping sets and
 *  emits a VolumeFrequencySignal instead. */
export const IGNORED_EXPOSURES_LIMIT = 2;

export type SetAdherence = {
  /** What last week's stored prescription asked for; null when unknown. */
  prescribed: number | null;
  /** Median realized non-warmup set count per session; null when no data. */
  realizedMedian: number | null;
  /** Consecutive recent sessions (newest first) whose realized set count fell
   *  short of `prescribed`. 0 when `prescribed` is null. */
  ignoredExposures: number;
};

export function setAdherenceFor(
  exerciseName: string,
  priorPrescribedSets: number | null,
  recentSets: WorkoutSetSample[],
  todayIso: string,
): SetAdherence {
  const cutoff = subtractDaysIso(todayIso, LOOKBACK_DAYS);
  const target = exerciseName.toLowerCase();

  // Group realized non-warmup sets into per-session counts. Grouping by date
  // (not array order) keeps this independent of PostgREST's embed ordering.
  const perSession = new Map<string, number>();
  for (const s of recentSets) {
    if (s.warmup) continue;
    if (s.performed_on < cutoff) continue;
    if (s.exercise_name.toLowerCase() !== target) continue;
    perSession.set(s.performed_on, (perSession.get(s.performed_on) ?? 0) + 1);
  }

  if (perSession.size === 0) {
    return { prescribed: priorPrescribedSets, realizedMedian: null, ignoredExposures: 0 };
  }

  const dates = [...perSession.keys()].sort((a, b) => b.localeCompare(a)); // newest first
  const counts = dates.map((d) => perSession.get(d)!);
  const realizedMedian = Math.round(median(counts));

  let ignoredExposures = 0;
  if (priorPrescribedSets != null) {
    for (const c of counts) {
      if (c >= priorPrescribedSets) break;
      ignoredExposures++;
    }
  }

  return { prescribed: priorPrescribedSets, realizedMedian, ignoredExposures };
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

function subtractDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
