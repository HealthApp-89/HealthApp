// lib/coach/prescription/effort-quality.ts
//
// How hard were this exercise's recent working sets? Used to gate the
// volume-band set bump: MEV/MAV/MRV landmarks assume sets taken at roughly
// 0-4 RIR WITHOUT systematic failure, so "below MEV" on a muscle being
// trained past failure is a signal to fix effort, not to add a set.
//
// Deliberately ORDER-INDEPENDENT — a proportion over a window, not a walk
// from the most recent set. fetchRecentSets places no explicit order on the
// embedded exercise_sets and PostgREST returns them set_index ASCENDING, so
// "the most recent set" is not reliably addressable from that payload. See
// docs/superpowers/specs/2026-08-03-volume-set-count-engine-design.md.

import type { WorkoutSetSample } from "@/lib/coach/prescription/types";

const LOOKBACK_DAYS = 28; // matches maintenance-baseline.ts

export type EffortQuality = {
  totalSets: number;
  hardSets: number;
  /** hardSets / totalSets; 0 when no sets were observed. */
  hardRate: number;
};

/** A set is "hard" when it was taken to failure or logged at RIR 0. A null
 *  rir means "not recorded" and never counts as hard (legacy rows). */
function isHard(s: WorkoutSetSample): boolean {
  return s.failure || s.rir === 0;
}

export function recentEffortQuality(
  exerciseName: string,
  recentSets: WorkoutSetSample[],
  todayIso: string,
): EffortQuality {
  const cutoff = subtractDaysIso(todayIso, LOOKBACK_DAYS);
  const target = exerciseName.toLowerCase();
  const matching = recentSets.filter(
    (s) =>
      !s.warmup &&
      s.performed_on >= cutoff &&
      s.exercise_name.toLowerCase() === target,
  );
  const totalSets = matching.length;
  const hardSets = matching.filter(isHard).length;
  return { totalSets, hardSets, hardRate: totalSets === 0 ? 0 : hardSets / totalSets };
}

function subtractDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
