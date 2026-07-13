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
import { reorderWithWarmupAnchors } from "@/lib/coach/manual-edits";

/**
 * Apply a single session-type's structure override to `exercises`.
 *
 * - `overrides` null → identity (returns `exercises` unchanged, same reference).
 * - Session type not present in overrides → identity.
 * - `order` permutation-only over the deduplicated NON-WARMUP names: only
 *   reorders when `order` is a complete duplicate-free permutation (same
 *   tolerance as `applyManualSessionEdits`); warmup ramp entries re-anchor
 *   immediately before their working entry via `reorderWithWarmupAnchors`.
 * - `sets` per-exercise override: applied to NON-WARMUP entries only (warmup
 *   ramp entries share the working entry's name and stay engine-owned); order
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

  // Apply set-count overrides (non-warmup entries only).
  if (slot.sets) {
    const byName = new Map<string, PlannedExercise>();
    for (const e of out) {
      if (!e.warmup && !byName.has(e.name)) byName.set(e.name, e);
    }
    for (const [name, count] of Object.entries(slot.sets)) {
      const ex = byName.get(name);
      if (ex) ex.sets = count;
    }
  }

  // Apply order permutation (non-warmup names; warmups re-anchor).
  if (slot.order && slot.order.length > 0) {
    const reordered = reorderWithWarmupAnchors(out, slot.order);
    if (reordered) out = reordered;
  }

  return out;
}
