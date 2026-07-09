// lib/coach/prescription/double-progression-rule.ts
//
// Double progression for ACCESSORY lifts: reps climb a loadability-derived
// range at fixed load; when every working set tops the range cleanly, load
// takes one equipment-grid step and reps reset to the range bottom. Stateless
// — the rung is re-derived every run from the 28-day set history (per-set RIR
// aware; null RIR degrades to reps-only, matching lastWeekClean's convention).
//
// Ladder rules:
//   Step up  — ≥2 working sets at kg ≥ effL, ALL clean at the range top.
//              Load advances one grid step (nextUpKg), reps reset to bottom.
//   Rep up   — top set clean at the range bottom (reps ≥ bottom, rir ok,
//              no failure) AND top-set kg ≥ effL → prescribe lastReps + 1,
//              capped at range top.
//   Step down — last TWO sessions' top sets each have reps < bottom, each
//              at kg ≥ effL, AND each shows strain evidence (failure or
//              rir < prescribed). Compliant lighten weeks (reps-short with
//              high / null RIR and no failure) count as hold.
//   Hold     — anything else: one dirty session, or load frozen, or no
//              strain evidence. Reps clamped into range.
//
// effL (effective anchor): when the athlete last trained clean exactly one
// grid step below the 28d-max L (the post-step-down case), adopt that lower
// load as the ladder anchor. Sessions more than one step below L are anomalies
// (variation / mobility day): keep L, and the rep-up guard (top-set kg ≥ effL)
// prevents the anomaly from setting the rung.
//
// Grid-aware neighbors: nextUpKg / nextDownKg handle micro-pin machines
// (step + intermediate offset) so the effective jump alternates between
// the offset and (step − offset), giving fine grids their narrower steps.
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

type Increment = PlannedExercise["increment"];

/** Next valid load UP on the equipment grid. Plain grids step by `step`;
 *  micro-pin grids (step + intermediate offset) alternate offset/plain, so the
 *  effective jump is `intermediate` or `step - intermediate`. Off-grid loads
 *  are snapped to the nearest grid value first; the neighbor is then computed
 *  from the grid context, ensuring monotonicity. */
export function nextUpKg(L: number, inc: Increment): number {
  const step = inc?.step ?? 2.5;
  const im = inc?.intermediate;
  if (im == null) return roundToStep(L + step, step);
  // Micro-pin: snap first to ensure we're on the grid, then move to the next up.
  const base = Math.floor(L / step + 1e-6) * step;
  const candidates = [base, base + im, base + step];
  // Find the smallest candidate > L (next up). If none exist in this octave,
  // move to the next octave.
  for (const c of candidates) if (c > L + 1e-6) return c;
  // All candidates <= L; move to next octave.
  return base + step + im;
}

/** Next valid load DOWN on the grid (mirror of nextUpKg); floors at the
 *  smallest positive grid value. Off-grid loads snap first. */
export function nextDownKg(L: number, inc: Increment): number {
  const step = inc?.step ?? 2.5;
  const im = inc?.intermediate;
  if (im == null) return Math.max(step, roundToStep(L - step, step));
  // Micro-pin: find the largest candidate < L (next down).
  const base = Math.floor(L / step + 1e-6) * step;
  const candidates = [base + step, base + im, base];
  for (const c of candidates) if (c < L - 1e-6 && c > 0) return c;
  // No candidate found in current octave; move to previous octave.
  const down = base - step + im;
  return down > 0 ? down : Math.min(im, step);
}

type SessionSets = { date: string; sets: WorkoutSetSample[] };

/** Non-warmup samples for the exercise, grouped per session date, newest first.
 *
 *  NOTE — dual-slot exercises (e.g. Lateral Raise appears on both Chest and
 *  Arms days): history is name-keyed, so sets from both days merge into the
 *  same session window. This is an ACCEPTED limitation: the worst-case outcome
 *  is a spurious hold (two slots with different rep anchors may dilute the
 *  "all-clean-at-top" gate), not a phantom step-up or step-down. Hold-biased
 *  behaviour is safe after the strain gate, so no per-slot partitioning is
 *  needed in v1. If rep anchors diverge significantly between slots in the
 *  future, partition by session_type key instead. */
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

/** Strain evidence: the set was genuinely hard — taken to failure or ground
 *  below the prescribed RIR. Reps-short with high (or unrecorded) RIR means
 *  the athlete CHOSE to stop (lighten compliance, time cap) — that holds, it
 *  never descends. Null-RIR history can therefore only descend via failure. */
function isStrained(s: WorkoutSetSample, prescribedRir: number): boolean {
  return s.failure || (s.rir != null && s.rir < prescribedRir);
}

function topSet(sets: WorkoutSetSample[]): WorkoutSetSample {
  return [...sets].sort((a, b) => b.kg - a.kg || b.reps - a.reps)[0];
}

export function prescribeAccessoryDoubleProgression(
  input: DoubleProgressionInput,
): PlannedExercise {
  const { baseExercise: ex, currentWorkingKg: L, blockPhase } = input;
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

  // Descent stickiness: when the athlete trained one grid step below L (the
  // post-step-down case), adopt the performed load as the ladder anchor —
  // otherwise the 28d-max baseline snaps back to the load they just failed.
  // The session may be CLEAN (normal case) OR STRAINED (rir < prescribed or
  // failure): a strained session at the stepped-down load is still confirmation
  // that the athlete is training at that rung, so adopt it; without this the
  // rung bounces back to L → strained-10 → snap to 12 → strained-10 again
  // (ping-pong). Sessions more than one step below L are anomalies (variation
  // day): the one-step gate nextUpKg(lastTop.kg) >= L keeps L, and the rep-up
  // rung below requires lastTop.kg ≥ effL so the anomalous session can't set
  // the rung either.
  let effL = L;
  if (
    lastTop.kg < L &&
    (isClean(lastTop, bottom, prescribedRir) || isStrained(lastTop, prescribedRir)) &&
    nextUpKg(lastTop.kg, ex.increment) >= L
  ) {
    effL = lastTop.kg;
  }

  // 1) Step up: ≥2 working sets at kg ≥ effL, ALL clean at the range top.
  const setsAtL = last.sets.filter((s) => s.kg >= effL);
  const allTopClean =
    setsAtL.length >= 2 && setsAtL.every((s) => isClean(s, top, prescribedRir));
  if (allTopClean && !loadFrozen) {
    const nextKg = nextUpKg(effL, ex.increment);
    if (input.focusClampCeilingKg != null && nextKg > input.focusClampCeilingKg) {
      // Park at the clamp: hold load, prescribe the range top.
      return { ...ex, baseKg: effL, baseReps: top };
    }
    return { ...ex, baseKg: nextKg, baseReps: bottom };
  }

  // 2) Rep up (also how consolidation parks at the top): top set clean at the
  //    range bottom AND top-set kg ≥ effL (anomalous light sessions can't
  //    set the rung) → +1 rep, capped at top. off_pace never progresses.
  if (
    blockPhase !== "off_pace" &&
    lastTop.kg >= effL &&
    isClean(lastTop, bottom, prescribedRir)
  ) {
    return { ...ex, baseKg: effL, baseReps: Math.min(top, lastTop.reps + 1) };
  }

  // 3) Step down: the last TWO sessions' top sets both dirty at the bottom AND
  //    both at kg ≥ effL AND both show strain evidence (failure or rir <
  //    prescribed). Compliant lighten weeks (reps-short with high/null RIR, no
  //    failure) and anomalous light sessions (below effL) do NOT count.
  const prev = sessions[1] ?? null;
  const lastTopAtEffL = lastTop.kg >= effL;
  const lastDirtyStrained =
    lastTopAtEffL &&
    !isClean(lastTop, bottom, prescribedRir) &&
    isStrained(lastTop, prescribedRir);

  const prevTop = prev != null ? topSet(prev.sets) : null;
  const prevDirtyStrained =
    prevTop != null &&
    prevTop.kg >= effL &&
    !isClean(prevTop, bottom, prescribedRir) &&
    isStrained(prevTop, prescribedRir);

  if (!loadFrozen && lastDirtyStrained && prevDirtyStrained) {
    return { ...ex, baseKg: nextDownKg(effL, ex.increment), baseReps: bottom };
  }

  // 4) Hold: one dirty session (or frozen load, or anomalous top set below effL)
  //    — reps clamped into range. Anomalous sessions (top-set kg < effL) pin
  //    to bottom rather than carrying through an unrepresentative reps count.
  const holdReps =
    lastTop.kg >= effL ? Math.max(bottom, Math.min(top, lastTop.reps)) : bottom;
  return { ...ex, baseKg: effL, baseReps: holdReps };
}
