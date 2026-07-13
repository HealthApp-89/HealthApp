// lib/coach/manual-edits.ts
// Athlete-owned week-scope edit layer (migration 0051). Merges ABOVE
// session_prescriptions in both resolution chains, so engine repatches keep
// flowing to untouched exercises while manually edited entries hold.
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import type { ManualSessionEdits, WeekdayLong } from "@/lib/data/types";

type DayEdits = NonNullable<ManualSessionEdits[WeekdayLong]>;

/**
 * Validate a day-edit payload against the resolved exercise names for that day.
 *
 * Rules:
 *  - `order`: when present, must be an exact permutation of `resolvedNames`
 *    (same length, same multiset of names, order may differ).
 *  - `exercises` entries must reference names that appear in `resolvedNames`
 *    (unknown names → error; application is tolerant, validation is strict).
 *  - Per-field bounds:
 *    - `sets`: integer, 1–10
 *    - `kg`: 0–500, on a 0.25 grid (i.e. `kg * 4` must be an integer)
 *    - `reps`: integer, 1–30
 *
 * Returns `{ok: true}` or `{ok: false; error: string}`.
 */
export function validateDayEdits(
  edits: { order?: string[]; exercises?: Record<string, { sets?: number; kg?: number; reps?: number }> },
  resolvedNames: string[],
): { ok: true } | { ok: false; error: string } {
  // Validate order permutation.
  if (edits.order !== undefined) {
    if (edits.order.length !== resolvedNames.length) {
      return {
        ok: false,
        error: `order must be a complete permutation of the day's exercises (expected ${resolvedNames.length} names, got ${edits.order.length})`,
      };
    }
    const expected = [...resolvedNames].sort();
    const submitted = [...edits.order].sort();
    for (let i = 0; i < expected.length; i++) {
      if (expected[i] !== submitted[i]) {
        return {
          ok: false,
          error: `order contains name "${submitted[i]}" which is not in the resolved exercise list`,
        };
      }
    }
  }

  // Validate per-exercise overrides.
  if (edits.exercises !== undefined) {
    const nameSet = new Set(resolvedNames);
    for (const [name, delta] of Object.entries(edits.exercises)) {
      if (!nameSet.has(name)) {
        return {
          ok: false,
          error: `exercise "${name}" is not in the resolved exercise list for this day`,
        };
      }
      if (delta.sets !== undefined) {
        if (!Number.isInteger(delta.sets) || delta.sets < 1 || delta.sets > 10) {
          return { ok: false, error: `sets for "${name}" must be an integer between 1 and 10` };
        }
      }
      if (delta.kg !== undefined) {
        if (
          typeof delta.kg !== "number" ||
          delta.kg < 0 ||
          delta.kg > 500 ||
          !Number.isInteger(Math.round(delta.kg * 4))  // 0.25 grid: kg*4 must be integer
          || Math.abs(delta.kg * 4 - Math.round(delta.kg * 4)) > 1e-9
        ) {
          return { ok: false, error: `kg for "${name}" must be a number between 0 and 500 on a 0.25 kg grid` };
        }
      }
      if (delta.reps !== undefined) {
        if (!Number.isInteger(delta.reps) || delta.reps < 1 || delta.reps > 30) {
          return { ok: false, error: `reps for "${name}" must be an integer between 1 and 30` };
        }
      }
    }
  }

  return { ok: true };
}

export function applyManualSessionEdits(
  exercises: PlannedExercise[],
  edits: DayEdits | null | undefined,
): { exercises: PlannedExercise[]; touched: boolean } {
  if (!edits || (!edits.order && !edits.exercises)) return { exercises, touched: false };
  let out = exercises.map((e) => ({ ...e }));
  let touched = false;

  const byName = new Map(out.map((e) => [e.name, e]));
  if (edits.exercises) {
    for (const [name, d] of Object.entries(edits.exercises)) {
      const ex = byName.get(name);
      if (!ex) continue;
      if (d.sets != null) { ex.sets = d.sets; touched = true; }
      if (d.kg != null) { ex.baseKg = d.kg; touched = true; }
      if (d.reps != null) { ex.baseReps = d.reps; touched = true; }
    }
  }
  if (edits.order && edits.order.length > 0) {
    const wanted = edits.order.filter((n) => byName.has(n));
    if (wanted.length === out.length) {
      out = wanted.map((n) => byName.get(n)!);
      touched = true;
    }
  }
  return { exercises: out, touched };
}
