// lib/coach/manual-edits.ts
// Athlete-owned week-scope edit layer (migration 0051). Merges ABOVE
// session_prescriptions in both resolution chains, so engine repatches keep
// flowing to untouched exercises while manually edited entries hold.
//
// WARMUP SEMANTICS (load-bearing): `session_prescriptions` days carry warmup
// ramp entries as SEPARATE entries with the SAME name as the working entry
// (see augmentFirstLoadedCompoundWithWarmups in prescribe-week.ts; warmup
// entries are flagged `warmup: true`). The manual-edit layer operates on
// NON-WARMUP entries only:
//   - per-exercise deltas apply exclusively to `!e.warmup` entries;
//   - `order` is a permutation of the deduplicated non-warmup name list;
//   - on reorder, each exercise's warmup entries (matched by name +
//     warmup:true, relative order preserved) re-anchor immediately BEFORE
//     their working entry; warmup entries with no same-name working entry
//     (e.g. a static warmup movement) stay at the front of the day.
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import type { ManualSessionEdits, WeekdayLong } from "@/lib/data/types";

type DayEdits = NonNullable<ManualSessionEdits[WeekdayLong]>;

/**
 * Deduplicated names of the day's NON-WARMUP entries — the name universe the
 * manual-edit layer (validation, diffs, reorder) operates on. Warmup ramp
 * entries share their working entry's name and must never enter this list.
 */
export function nonWarmupNames(exercises: PlannedExercise[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of exercises) {
    if (e.warmup) continue;
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    out.push(e.name);
  }
  return out;
}

/**
 * Reorder a day (possibly containing warmup entries) by a permutation of its
 * non-warmup names, re-anchoring warmups before their working entries.
 *
 * Returns `null` when `order` is not a complete duplicate-free permutation of
 * the deduplicated non-warmup name list (callers treat null as "skip reorder").
 */
export function reorderWithWarmupAnchors(
  exercises: PlannedExercise[],
  order: string[],
): PlannedExercise[] | null {
  const workingByName = new Map<string, PlannedExercise>();
  for (const e of exercises) {
    if (!e.warmup && !workingByName.has(e.name)) workingByName.set(e.name, e);
  }
  if (order.length !== workingByName.size) return null;
  if (new Set(order).size !== order.length) return null;
  for (const n of order) {
    if (!workingByName.has(n)) return null;
  }

  // Group warmup entries by matching working-entry name (relative order kept);
  // warmups with no same-name working entry are orphans and stay at the front.
  const warmupsByName = new Map<string, PlannedExercise[]>();
  const orphanWarmups: PlannedExercise[] = [];
  for (const e of exercises) {
    if (!e.warmup) continue;
    if (workingByName.has(e.name)) {
      const group = warmupsByName.get(e.name) ?? [];
      group.push(e);
      warmupsByName.set(e.name, group);
    } else {
      orphanWarmups.push(e);
    }
  }

  const out: PlannedExercise[] = [...orphanWarmups];
  for (const n of order) {
    out.push(...(warmupsByName.get(n) ?? []));
    out.push(workingByName.get(n)!);
  }
  return out;
}

/**
 * Validate a day-edit payload against the day's resolved exercise list.
 *
 * Takes the full `PlannedExercise[]` (warmup entries included) and validates
 * against the DEDUPLICATED NON-WARMUP name list — warmup ramp entries share
 * their working entry's name and are not directly editable.
 *
 * Rules:
 *  - `order`: when present, must be an exact permutation of the non-warmup
 *    names (same length, same set of names, order may differ).
 *  - `exercises` entries must reference non-warmup names (unknown names →
 *    error; application is tolerant, validation is strict).
 *  - Per-field bounds:
 *    - `sets`: integer, 1–10
 *    - `kg`: 0–500, on a 0.25 grid (i.e. `kg * 4` must be an integer)
 *    - `reps`: integer, 1–30
 *
 * Returns `{ok: true}` or `{ok: false; error: string}`.
 */
export function validateDayEdits(
  edits: { order?: string[]; exercises?: Record<string, { sets?: number; kg?: number; reps?: number }> },
  dayExercises: PlannedExercise[],
): { ok: true } | { ok: false; error: string } {
  const resolvedNames = nonWarmupNames(dayExercises);

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

  // Per-exercise deltas: NON-WARMUP entries only. Warmup ramp entries share
  // the working entry's name and stay engine-owned.
  if (edits.exercises) {
    const byName = new Map<string, PlannedExercise>();
    for (const e of out) {
      if (!e.warmup && !byName.has(e.name)) byName.set(e.name, e);
    }
    for (const [name, d] of Object.entries(edits.exercises)) {
      const ex = byName.get(name);
      if (!ex) continue;
      if (d.sets != null) { ex.sets = d.sets; touched = true; }
      if (d.kg != null) { ex.baseKg = d.kg; touched = true; }
      if (d.reps != null) { ex.baseReps = d.reps; touched = true; }
    }
  }

  // Order: permutation of the deduped non-warmup names; warmups re-anchor
  // before their working entry (tolerant — invalid permutations are skipped).
  if (edits.order && edits.order.length > 0) {
    const reordered = reorderWithWarmupAnchors(out, edits.order);
    if (reordered) {
      out = reordered;
      touched = true;
    }
  }
  return { exercises: out, touched };
}
