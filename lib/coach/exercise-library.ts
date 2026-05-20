// lib/coach/exercise-library.ts
//
// Strength exercise catalog for Coach Carter. Sub-project 1 of 2: ships the
// data shape, ~57 seed entries, and a pure `findSubstitutes` scoring function.
// Sub-project 2 will add swap-write tools and a stall detector that consume
// this library.
//
// Why a const file instead of a DB table: single-user app, no per-user
// customization in v1, and Carter's tool calls don't need SQL — they filter
// in memory. Promotable to a Postgres table if a "user adds custom exercise"
// feature ever lands.
//
// Source of truth for *which* exercises the athlete trains week-to-week is
// still `lib/coach/sessionPlans.ts`; the library is additive — it's the menu,
// not the meal plan.

import type { TargetedMuscleGroup } from "@/lib/data/types";
import type { ExerciseCategory } from "@/lib/coach/exercise-categories";

// ── Types ────────────────────────────────────────────────────────────────────

export type ExerciseRole = "main" | "accessory";

/** Stability tier: how much the athlete must stabilize the load themselves.
 *  Lower stability = more isolated muscle work, less systemic fatigue cost.
 *  high = athlete-stabilized compound (back squat, OHP, deadlift)
 *  medium = compound with external stabilization (leg press, DB bench)
 *  low = isolated, machine-stabilized (leg extension, chest fly, cable) */
export type StabilityTier = "high" | "medium" | "low";

/** Where in the ROM the exercise peaks tension.
 *  lengthened = loads the muscle in the stretched position (RDL, DB fly)
 *  shortened  = peaks at contraction (leg ext, cable pulldown)
 *  midrange   = peaks mid-ROM (barbell bench)
 *  neutral    = no clear bias */
export type ROMBias = "lengthened" | "midrange" | "shortened" | "neutral";

export type Equipment =
  | "barbell" | "dumbbell" | "machine" | "cable"
  | "bodyweight" | "kettlebell" | "smith";

export type JointStress = "shoulder" | "lumbar" | "knee" | "elbow" | "wrist" | "hip";

/** Microloadability. Drives Carter's progression suggestions.
 *  fine     = microloadable (cables, plate-loaded machines with 1.25 kg)
 *  moderate = std plates (2.5 kg increments on barbell)
 *  coarse   = big jumps only (gym DBs, stack machines at 5 kg) */
export type Loadability = "fine" | "moderate" | "coarse";

export type SkillDemand = "low" | "medium" | "high";

export type LibraryExercise = {
  /** Stable slug. Lowercase, underscore-separated. Used by get_substitutes. */
  id: string;
  /** Display name. Matches sessionPlans.ts format where overlap. */
  name: string;
  pattern: ExerciseCategory;
  primaryMuscle: TargetedMuscleGroup;
  secondaryMuscles?: readonly TargetedMuscleGroup[];
  equipment: readonly Equipment[];
  stability: StabilityTier;
  romBias: ROMBias;
  skill: SkillDemand;
  jointStress: readonly JointStress[];
  loadability: Loadability;
  role: ExerciseRole;
  increment?: { step: number; intermediate?: number };
  notes?: string;
};

// ── Seed data (populated in Task 2) ──────────────────────────────────────────

export const EXERCISE_LIBRARY: readonly LibraryExercise[] = [
  // Populated in Task 2.
];

// ── Lookup helpers ───────────────────────────────────────────────────────────

/** Resolve a library entry by id OR display name (case-insensitive). Returns
 *  null when no match. Used by get_substitutes so the chat tool accepts either
 *  the slug ("decline_bench") or the display name ("Decline Bench Press (Barbell)"). */
export function resolveExercise(idOrName: string): LibraryExercise | null {
  const needle = idOrName.trim().toLowerCase();
  for (const ex of EXERCISE_LIBRARY) {
    if (ex.id.toLowerCase() === needle) return ex;
    if (ex.name.toLowerCase() === needle) return ex;
  }
  return null;
}

// ── findSubstitutes ──────────────────────────────────────────────────────────

export type SubstituteOptions = {
  count?: number;
  excludeJoint?: JointStress;
  preferStability?: StabilityTier;
  preferRomBias?: ROMBias;
};

/** Pure scoring algorithm. Returns up to `count` substitutes (default 3) for
 *  `target`, drawn from `library`. Hard filters: same pattern, same primary
 *  muscle, exclude the target itself, exclude any candidate whose jointStress
 *  contains `excludeJoint` when provided. Soft score (higher = better):
 *    +3 if role matches target
 *    +2 if stability matches preferStability (or target's stability)
 *    +2 if romBias matches preferRomBias (or target's romBias)
 *    +1 per overlapping equipment entry
 *    +1 if loadability matches target's
 *    -1 per jointStress entry the candidate has that target lacks */
export function findSubstitutes(
  target: LibraryExercise,
  library: readonly LibraryExercise[],
  options?: SubstituteOptions,
): LibraryExercise[] {
  const count = options?.count ?? 3;
  const preferStability = options?.preferStability ?? target.stability;
  const preferRomBias = options?.preferRomBias ?? target.romBias;
  const excludeJoint = options?.excludeJoint;

  type Scored = { ex: LibraryExercise; score: number };
  const scored: Scored[] = [];

  for (const ex of library) {
    if (ex.id === target.id) continue;
    if (ex.pattern !== target.pattern) continue;
    if (ex.primaryMuscle !== target.primaryMuscle) continue;
    if (excludeJoint && ex.jointStress.includes(excludeJoint)) continue;

    let score = 0;
    if (ex.role === target.role) score += 3;
    if (ex.stability === preferStability) score += 2;
    if (ex.romBias === preferRomBias) score += 2;
    for (const eq of ex.equipment) {
      if (target.equipment.includes(eq)) score += 1;
    }
    if (ex.loadability === target.loadability) score += 1;
    for (const j of ex.jointStress) {
      if (!target.jointStress.includes(j)) score -= 1;
    }

    scored.push({ ex, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, count).map((s) => s.ex);
}
