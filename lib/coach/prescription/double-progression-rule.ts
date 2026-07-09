// lib/coach/prescription/double-progression-rule.ts
//
// Double progression for ACCESSORY lifts: reps climb a loadability-derived
// range at fixed load; when every working set tops the range cleanly, load
// takes one equipment-grid step and reps reset to the range bottom. Stateless
// — the rung is re-derived every run from the 28-day set history (per-set RIR
// aware; null RIR degrades to reps-only, matching lastWeekClean's convention).
//
// Owns LOAD + REPS for accessories. Sets stay volume-balance-owned, EXCEPT
// deload_week where this rule's output is final: load HELD (isolation work
// carries little systemic fatigue and percentage cuts on small dumbbells
// round to meaningless loads; on a cut, retention wants intensity kept),
// sets halved. Primary/secondary deload rules are untouched.
//
// Spec: docs/superpowers/specs/2026-07-09-accessory-double-progression-design.md

import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import type { BlockPhase, WorkoutSetSample } from "@/lib/coach/prescription/types";
import { roundToStep } from "@/lib/coach/prescription/calibrate-target";

export type Loadability = "fine" | "moderate" | "coarse";

/** Rep-range width above the bottom anchor. Coarser load jumps (DB pairs)
 *  need more rep-room to absorb one step. */
export const REP_RANGE_WIDTH: Record<Loadability, number> = {
  fine: 2,
  moderate: 3,
  coarse: 4,
};

export type DoubleProgressionInput = {
  baseExercise: PlannedExercise;
  /** maintenanceLoadFor(...) ?? baseKg ?? 0 — the current working load L. */
  currentWorkingKg: number;
  recentSets: WorkoutSetSample[];
  rirTarget: number;
  blockPhase: BlockPhase;
  loadability: Loadability;
  /** roundToStep(maintenance × 0.92) during a focus block, else null. */
  focusClampCeilingKg: number | null;
  /** Stable range anchor: static SESSION_PLANS baseReps when available. */
  bottomReps: number;
};

type SessionSets = { date: string; sets: WorkoutSetSample[] };

/** Non-warmup samples for the exercise, grouped per session date, newest first. */
function sessionsFor(recentSets: WorkoutSetSample[], name: string): SessionSets[] {
  const needle = name.trim().toLowerCase();
  const byDate = new Map<string, WorkoutSetSample[]>();
  for (const s of recentSets) {
    if (s.warmup) continue;
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
 *  was recorded — met the prescribed RIR. Null RIR degrades to reps-only. */
function isClean(s: WorkoutSetSample, repsThreshold: number, prescribedRir: number): boolean {
  if (s.failure) return false;
  if (s.reps < repsThreshold) return false;
  if (s.rir != null && s.rir < prescribedRir) return false;
  return true;
}

function topSet(sets: WorkoutSetSample[]): WorkoutSetSample {
  return [...sets].sort((a, b) => b.kg - a.kg || b.reps - a.reps)[0];
}

export function prescribeAccessoryDoubleProgression(
  input: DoubleProgressionInput,
): PlannedExercise {
  const { baseExercise: ex, currentWorkingKg: L, blockPhase } = input;
  const step = ex.increment?.step ?? 2.5;
  const bottom = input.bottomReps;
  const top = bottom + REP_RANGE_WIDTH[input.loadability];
  const prescribedRir = ex.rir ?? input.rirTarget;

  // Deload: hold load, halve sets. Caller skips volume-balance this week so
  // "deload = volume −50%" finally holds for accessories too.
  if (blockPhase === "deload_week") {
    return {
      ...ex,
      baseKg: L,
      baseReps: bottom,
      sets: Math.max(1, Math.ceil((ex.sets ?? 3) / 2)),
    };
  }

  const sessions = sessionsFor(input.recentSets, ex.name);
  const last = sessions[0] ?? null;
  if (!last) return { ...ex, baseKg: L, baseReps: bottom };

  const lastTop = topSet(last.sets);
  const loadFrozen = blockPhase === "consolidation" || blockPhase === "off_pace";

  // 1) Step up: ≥2 working sets at kg ≥ L, ALL clean at the range top.
  const setsAtL = last.sets.filter((s) => s.kg >= L);
  const allTopClean =
    setsAtL.length >= 2 && setsAtL.every((s) => isClean(s, top, prescribedRir));
  if (allTopClean && !loadFrozen) {
    const nextKg = roundToStep(L + step, step);
    if (input.focusClampCeilingKg != null && nextKg > input.focusClampCeilingKg) {
      // Park at the clamp: hold load, prescribe the range top.
      return { ...ex, baseKg: L, baseReps: top };
    }
    return { ...ex, baseKg: nextKg, baseReps: bottom };
  }

  // 2) Rep up (also how consolidation parks at the top): top set clean at the
  //    range bottom → +1 rep, capped at top. off_pace never progresses.
  if (blockPhase !== "off_pace" && isClean(lastTop, bottom, prescribedRir)) {
    return { ...ex, baseKg: L, baseReps: Math.min(top, lastTop.reps + 1) };
  }

  // 3) Step down: the last TWO sessions' top sets both dirty at the bottom —
  //    grid-native descent (never below one step); the climb restarts.
  const prev = sessions[1] ?? null;
  const prevDirty = prev != null && !isClean(topSet(prev.sets), bottom, prescribedRir);
  if (!loadFrozen && !isClean(lastTop, bottom, prescribedRir) && prevDirty) {
    return { ...ex, baseKg: Math.max(step, roundToStep(L - step, step)), baseReps: bottom };
  }

  // 4) Hold: one dirty session (or frozen load) — reps clamped into range.
  return { ...ex, baseKg: L, baseReps: Math.max(bottom, Math.min(top, lastTop.reps)) };
}
