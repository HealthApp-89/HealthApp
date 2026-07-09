// lib/coach/prescription/patch-today.ts
//
// Morning-ladder prescription patches: converts the reactive ladder's graded
// rungs (load_down / volume_down) into real, revertible changes on TODAY's
// session_prescriptions entry. Escalation rungs (swap_exercise / swap_day)
// stay with the BriefCoachSuggestion chip — numbers are not the remedy there.
// Load (baseKg) is NEVER touched — volume + RIR are the levers, matching
// lightenExercise's evidence-based design.
//
// Pure helpers live at the top (fixture-audited); the async apply primitive
// applyMorningPatch and revert plumbing are below (route-consumed).
//
// Spec: docs/superpowers/specs/2026-07-09-morning-ladder-prescription-patches-design.md

import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import type { RepatchChange, RepatchLogEntry } from "@/lib/data/types";
import type { ReactiveRung } from "@/lib/coach/activity/reactive-ladder";
import type { MuscleRegion } from "@/lib/coach/activity/types";
import { SESSION_REGION_MAP } from "@/lib/coach/activity/sequence-week";
import { lightenExercise, exerciseRegion } from "@/lib/coach/prescription/prescribe-week";

/** True when the exercise is region-gated INTO the patch: its own region is
 *  affected, or (unknown region) its session's regions overlap the affected
 *  set. Mirrors lightenExercise's gating exactly. */
function isAffected(ex: PlannedExercise, sessionType: string, regions: MuscleRegion[]): boolean {
  const exReg = exerciseRegion(ex.name);
  if (exReg !== null) return regions.includes(exReg);
  const sessionRegs = SESSION_REGION_MAP[sessionType] ?? [];
  return sessionRegs.some((r) => regions.includes(r));
}

/** Map a reactive-ladder rung to a transform of today's exercise list.
 *   load_down   → RIR +1 (cap 5) on affected working exercises; all else held.
 *   volume_down → lightenExercise tiering (sets/reps cuts + RIR bumps).
 *   none / swap_exercise / swap_day → identity (returns the input array). */
export function patchExercisesForRung(
  exercises: PlannedExercise[],
  rung: ReactiveRung,
  sessionType: string,
  regions: MuscleRegion[],
): PlannedExercise[] {
  if (rung === "volume_down") {
    return exercises.map((ex) => lightenExercise(ex, sessionType, regions));
  }
  if (rung !== "load_down") return exercises;
  return exercises.map((ex) => {
    if (ex.warmup) return ex;
    if (ex.sets == null && ex.baseReps == null) return ex;
    if (!isAffected(ex, sessionType, regions)) return ex;
    return { ...ex, rir: Math.min(5, (ex.rir ?? 2) + 1) };
  });
}

// Client-safe log guards live in patch-log.ts (types-only imports);
// re-exported here so server-side consumers can import everything from one place.
export { hasMorningPatchEntry, hasMorningRevertEntry } from "@/lib/coach/prescription/patch-log";

const REVERTIBLE_FIELDS = new Set(["baseKg", "baseReps", "sets", "rir"]);

/** Restore the `from` values of a morning patch onto today's exercise list.
 *  Only numeric fields are revertible — the morning patch never adds or
 *  removes exercises, so `added`/`removed` changes are skipped defensively.
 *  Exercises matched by name on non-warmup rows (diffDay's convention). */
export function revertDayExercises(
  exercises: PlannedExercise[],
  changes: RepatchChange[],
): PlannedExercise[] {
  return exercises.map((ex) => {
    if (ex.warmup) return ex;
    const mine = changes.filter(
      (c) => c.exercise === ex.name && REVERTIBLE_FIELDS.has(c.field),
    );
    if (mine.length === 0) return ex;
    const out = { ...ex };
    for (const c of mine) {
      const field = c.field as "baseKg" | "baseReps" | "sets" | "rir";
      if (c.from == null) delete out[field];
      else out[field] = c.from as number;
    }
    return out;
  });
}
