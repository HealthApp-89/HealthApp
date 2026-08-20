// lib/coach/prescription/session-grouping.ts
//
// Shared session model for the prescription engine. Effort verdicts are a
// SESSION-level question ("did the athlete own this load last time?"), not a
// single-set one — and the payload from fetchRecentSets cannot reliably
// express "the most recent set" anyway (PostgREST returns embedded
// exercise_sets set_index ASCENDING while workouts come back newest-first).
// Grouping by date and reducing with every/some makes every consumer
// order-independent.
//
// Extracted from double-progression-rule.ts so accessories and
// primaries/secondaries share one definition of clean vs strained.

import type { WorkoutSetSample } from "@/lib/coach/prescription/types";

export type ExerciseSession = { date: string; sets: WorkoutSetSample[] };

/** Non-warmup samples for the exercise, grouped per session date, newest first.
 *
 *  NOTE — dual-slot exercises (e.g. Lateral Raise appears on both Chest and
 *  Arms days): history is name-keyed, so sets from both days merge into the
 *  same session window only when they share a date. This is an ACCEPTED
 *  limitation carried over from the accessory rule; the worst case is a
 *  hold-biased verdict, never a phantom step-up. */
export function sessionsForExercise(
  recentSets: WorkoutSetSample[],
  exerciseName: string,
): ExerciseSession[] {
  const needle = exerciseName.trim().toLowerCase();
  const byDate = new Map<string, WorkoutSetSample[]>();
  for (const s of recentSets) {
    if (s.warmup) continue;
    // Heavy top set (migration 0059). Excluded because every verdict built on
    // these sessions is about the WORKING sets: isCleanSet checks reps against
    // the prescribed target, and a top set is deliberately below it — leaving
    // it in reads as a missed rep target and triggers a back-off on an
    // exercise that actually performed as prescribed.
    if (s.is_top_set) continue;
    if (s.exercise_name.trim().toLowerCase() !== needle) continue;
    const list = byDate.get(s.performed_on) ?? [];
    list.push(s);
    byDate.set(s.performed_on, list);
  }
  return [...byDate.entries()]
    .map(([date, sets]) => ({ date, sets }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** Clean = completed (not failure), hit the reps threshold, and — when RIR
 *  was recorded — met the prescribed RIR. Null/absent RIR degrades to
 *  reps-only (legacy rows predate migration 0045). */
export function isCleanSet(
  s: WorkoutSetSample,
  repsThreshold: number,
  prescribedRir: number,
): boolean {
  if (s.failure) return false;
  if (s.reps < repsThreshold) return false;
  if (s.rir != null && s.rir < prescribedRir) return false;
  return true;
}

/** Strain evidence: the set was genuinely hard — taken to failure or ground
 *  below the prescribed RIR. Reps-short with high (or unrecorded) RIR means
 *  the athlete CHOSE to stop (lighten compliance, time cap) — that holds, it
 *  never descends. Null-RIR history can therefore only descend via failure. */
export function isStrainedSet(s: WorkoutSetSample, prescribedRir: number): boolean {
  return s.failure || (s.rir != null && s.rir < prescribedRir);
}
