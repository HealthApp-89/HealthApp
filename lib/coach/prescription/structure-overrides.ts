// lib/coach/prescription/structure-overrides.ts
//
// Applies athlete-owned block-scope structure overrides to a finalized
// exercise list BEFORE warmup post-processing runs (so warmups derive from
// the post-override structure — new first exercise, overridden set counts).
//
// Mirrors `applyManualSessionEdits` (lib/coach/manual-edits.ts) but is
// restricted to `order` and `sets` only.  Load/reps stay engine-evolved per
// RIR/intensity for the week.

import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import type { SessionStructureOverrides } from "@/lib/data/types";

/**
 * Apply a single session-type's structure override to `exercises`.
 *
 * - `overrides` null → identity (returns `exercises` unchanged, same reference).
 * - Session type not present in overrides → identity.
 * - `order` permutation-only: only reorders when every name in `order` exists
 *   in `exercises` and the lengths match (same tolerance as
 *   `applyManualSessionEdits`).
 * - `sets` per-exercise override: applied to whatever name matches; order
 *   override is applied after sets so the mutated entries follow the new order.
 */
export function applyStructureOverrides(
  exercises: PlannedExercise[],
  sessionType: string,
  overrides: SessionStructureOverrides | null,
): PlannedExercise[] {
  if (!overrides) return exercises;
  const slot = overrides[sessionType];
  if (!slot) return exercises;
  if (!slot.order && !slot.sets) return exercises;

  // Shallow-clone each entry so we never mutate the source array.
  let out = exercises.map((e) => ({ ...e }));

  // Apply set-count overrides.
  if (slot.sets) {
    const byName = new Map(out.map((e) => [e.name, e]));
    for (const [name, count] of Object.entries(slot.sets)) {
      const ex = byName.get(name);
      if (ex) ex.sets = count;
    }
  }

  // Apply order permutation (permutation-only: same name set, different order).
  if (slot.order && slot.order.length > 0) {
    const byName = new Map(out.map((e) => [e.name, e]));
    const wanted = slot.order.filter((n) => byName.has(n));
    if (wanted.length === out.length) {
      out = wanted.map((n) => byName.get(n)!);
    }
  }

  return out;
}
