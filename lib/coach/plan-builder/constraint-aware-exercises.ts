// lib/coach/plan-builder/constraint-aware-exercises.ts
//
// Pure function: applyConstraintAwareSelection
//
// Given a list of PlannedExercise entries and athlete intelligence (constraints +
// identity), returns a new exercise list with two types of adjustments:
//
//   1. Hard constraints — excluded / injury-conflicting / equipment-unavailable
//      exercises are replaced via getSubstitute() and logged in `adjustments`.
//
//   2. Soft identity — accessory exercises with latitude (role !== "main" in the
//      library) whose name is NOT already a top_exercise preference are swapped
//      to the best matching top_exercise from identity.top_exercises when one
//      fits the same movement pattern + primaryMuscle. Recorded in `adjustments`.
//
// When constraints and identity are absent, returns the original exercises
// unchanged with adjustments: [].
//
// The real getSubstitute wraps findSubstitutes() from lib/coach/exercise-library.
// Tests pass a stub getSubstitute for determinism.

import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import type { ConstraintPayload, IdentityPayload } from "@/lib/coach/intelligence/types";
import {
  resolveExercise,
  findSubstitutes,
  EXERCISE_LIBRARY,
} from "@/lib/coach/exercise-library";
import type { JointStress } from "@/lib/coach/exercise-library";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type ExerciseAdjustment = {
  from: string;
  to: string;
  reason: string;
};

export type SelectionResult = {
  exercises: PlannedExercise[];
  adjustments: ExerciseAdjustment[];
};

export type GetSubstituteFn = (
  exerciseName: string,
  options?: { excludeJoint?: JointStress; equipmentAccess?: string },
) => string | null;

export type ConstraintAwareSelectionArgs = {
  exercises: PlannedExercise[];
  constraints?: ConstraintPayload | null;
  identity?: IdentityPayload | null;
  getSubstitute?: GetSubstituteFn;
};

// ─────────────────────────────────────────────────────────────────────────────
// Equipment access → equipment types that require a full commercial gym.
// "home_gym" lacks barbells (most people) and large cable stacks.
// ─────────────────────────────────────────────────────────────────────────────

const COMMERCIAL_ONLY_EQUIPMENT = new Set(["cable", "machine", "smith"]);
const HOME_AVAILABLE_EQUIPMENT = new Set(["dumbbell", "barbell", "bodyweight", "kettlebell"]);

/** Returns true if the exercise requires equipment not available given
 *  the athlete's equipment_access level. */
function isEquipmentUnavailable(
  exerciseName: string,
  equipmentAccess: ConstraintPayload["equipment_access"],
): boolean {
  if (equipmentAccess === "commercial_gym" || equipmentAccess === "mixed") {
    // Commercial gym and mixed access — all equipment available.
    return false;
  }
  // home_gym — only bodyweight, dumbbell, barbell, kettlebell.
  const libEntry = resolveExercise(exerciseName);
  if (!libEntry) return false; // Unknown exercise — can't determine, don't block.
  const hasAvailableEquipment = libEntry.equipment.some((eq) =>
    HOME_AVAILABLE_EQUIPMENT.has(eq),
  );
  const requiresCommercialOnly = libEntry.equipment.every((eq) =>
    COMMERCIAL_ONLY_EQUIPMENT.has(eq),
  );
  return requiresCommercialOnly && !hasAvailableEquipment;
}

/** Returns the joint stress category for an injury area string.
 *  Maps common injury area names to JointStress values. */
function injuryAreaToJoint(area: string): JointStress | null {
  const lower = area.toLowerCase();
  if (lower.includes("shoulder") || lower.includes("rotator")) return "shoulder";
  if (lower.includes("lumbar") || lower.includes("lower back") || lower.includes("spine")) return "lumbar";
  if (lower.includes("knee") || lower.includes("patellar")) return "knee";
  if (lower.includes("elbow") || lower.includes("bicep") || lower.includes("tricep")) return "elbow";
  if (lower.includes("wrist") || lower.includes("forearm")) return "wrist";
  if (lower.includes("hip") || lower.includes("groin") || lower.includes("glute")) return "hip";
  return null;
}

/** Check whether an exercise conflicts with any active injury.
 *  Returns the joint that is conflicted, or null. */
function injuryConflictedJoint(
  exerciseName: string,
  activeInjuries: ConstraintPayload["active_injuries"],
): JointStress | null {
  const libEntry = resolveExercise(exerciseName);
  if (!libEntry) return null;
  for (const injury of activeInjuries) {
    if (injury.status === "recovered") continue;
    const joint = injuryAreaToJoint(injury.area);
    if (!joint) continue;
    if ((libEntry.jointStress as readonly string[]).includes(joint)) {
      return joint;
    }
  }
  return null;
}

/** Returns true if the exercise name appears in any injury's exercises_to_avoid list.
 *  Compares case-insensitively. */
function isExplicitlyExcluded(
  exerciseName: string,
  exclusions: string[],
): boolean {
  const lower = exerciseName.toLowerCase();
  return exclusions.some((ex) => ex.toLowerCase() === lower);
}

/** Check if an exercise is a "latitude accessory" — one that is not a main
 *  lift in the library and whose name is not already a top_exercise preference.
 *  Returns true when the exercise is a candidate for identity substitution. */
function isLatitudeAccessory(exerciseName: string, identity: IdentityPayload): boolean {
  const libEntry = resolveExercise(exerciseName);
  if (!libEntry || libEntry.role === "main") return false;

  // Flatten all top exercises across all categories
  const allTopExercises = new Set([
    ...identity.top_exercises.lower,
    ...identity.top_exercises.upper,
    ...identity.top_exercises.pulls,
    ...identity.top_exercises.isolation,
  ].map((n) => n.toLowerCase()));

  // Already a preferred exercise — no swap needed
  if (allTopExercises.has(exerciseName.toLowerCase())) return false;

  return true;
}

/** Try to find an identity-preferred substitute for a latitude accessory.
 *  Returns the top_exercise name if one matches the same pattern+primaryMuscle,
 *  otherwise null. */
function findIdentitySubstitute(
  exerciseName: string,
  identity: IdentityPayload,
): string | null {
  const libEntry = resolveExercise(exerciseName);
  if (!libEntry) return null;

  const allTopExercises = [
    ...identity.top_exercises.lower,
    ...identity.top_exercises.upper,
    ...identity.top_exercises.pulls,
    ...identity.top_exercises.isolation,
  ];

  for (const topName of allTopExercises) {
    const topEntry = resolveExercise(topName);
    if (!topEntry) continue;
    if (topEntry.pattern !== libEntry.pattern) continue;
    if (topEntry.primaryMuscle !== libEntry.primaryMuscle) continue;
    if (topEntry.id === libEntry.id) continue; // same exercise, already handled above
    return topEntry.name;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Real getSubstitute implementation wrapping findSubstitutes()
// ─────────────────────────────────────────────────────────────────────────────

/** Default getSubstitute wrapping the exercise library's findSubstitutes().
 *  Returns the best substitute name, or null when none found. */
export function defaultGetSubstitute(
  exerciseName: string,
  options?: { excludeJoint?: JointStress; equipmentAccess?: string },
): string | null {
  const target = resolveExercise(exerciseName);
  if (!target) return null;

  const subs = findSubstitutes(target, EXERCISE_LIBRARY, {
    count: 1,
    excludeJoint: options?.excludeJoint,
  });
  return subs.length > 0 ? subs[0].name : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * applyConstraintAwareSelection — pure, deterministic exercise selection.
 *
 * For each planned exercise:
 *
 *   Hard constraints (evaluated in priority order):
 *     1. Exercise is on constraints.exercise_exclusions → substitute.
 *     2. Exercise conflicts with an active injury's jointStress → substitute
 *        with excludeJoint hint so the sub avoids the same stress.
 *     3. Exercise requires equipment not available → substitute.
 *
 *   Soft identity (evaluated only when no hard constraint fires):
 *     4. Exercise is a latitude accessory AND an identity top_exercise matches
 *        the same pattern + primaryMuscle → swap to the preferred name.
 *
 *   Warmup exercises are skipped — they are rarely in the library and should
 *   not be substituted programmatically.
 *
 * Returns { exercises, adjustments }. When constraints + identity are both
 * absent, returns { exercises, adjustments: [] } — byte-identical to input.
 */
export function applyConstraintAwareSelection({
  exercises,
  constraints,
  identity,
  getSubstitute = defaultGetSubstitute,
}: ConstraintAwareSelectionArgs): SelectionResult {
  // Fast path: nothing to apply
  if (!constraints && !identity) {
    return { exercises, adjustments: [] };
  }

  const adjustments: ExerciseAdjustment[] = [];
  const result: PlannedExercise[] = [];

  for (const ex of exercises) {
    // Skip warmup exercises — they are mobility/prep movements, not substitutable.
    if (ex.warmup) {
      result.push(ex);
      continue;
    }

    let adjusted = false;

    // ── Hard constraints ─────────────────────────────────────────────────────
    if (constraints) {
      // 1. Explicit exclusion
      if (isExplicitlyExcluded(ex.name, constraints.exercise_exclusions)) {
        const subName = getSubstitute(ex.name);
        if (subName) {
          adjustments.push({
            from: ex.name,
            to: subName,
            reason: `Exercise excluded by athlete constraints.`,
          });
          result.push({ ...ex, name: subName });
          adjusted = true;
        } else {
          // No substitute found — keep original (better than removing the slot)
          result.push(ex);
          adjusted = true;
        }
      }

      // 2. Injury conflict
      if (!adjusted) {
        const conflictJoint = injuryConflictedJoint(ex.name, constraints.active_injuries);
        if (conflictJoint) {
          const subName = getSubstitute(ex.name, { excludeJoint: conflictJoint });
          if (subName) {
            adjustments.push({
              from: ex.name,
              to: subName,
              reason: `Conflicts with active ${conflictJoint} injury — substituted with a lower-stress alternative.`,
            });
            result.push({ ...ex, name: subName });
            adjusted = true;
          } else {
            result.push(ex);
            adjusted = true;
          }
        }
      }

      // 3. Equipment unavailable
      if (!adjusted) {
        if (isEquipmentUnavailable(ex.name, constraints.equipment_access)) {
          const subName = getSubstitute(ex.name, {
            equipmentAccess: constraints.equipment_access,
          });
          if (subName) {
            adjustments.push({
              from: ex.name,
              to: subName,
              reason: `Requires equipment not available (${constraints.equipment_access}) — substituted with an accessible alternative.`,
            });
            result.push({ ...ex, name: subName });
            adjusted = true;
          } else {
            result.push(ex);
            adjusted = true;
          }
        }
      }
    }

    // ── Soft identity ────────────────────────────────────────────────────────
    if (!adjusted && identity) {
      if (isLatitudeAccessory(ex.name, identity)) {
        const identitySub = findIdentitySubstitute(ex.name, identity);
        if (identitySub) {
          adjustments.push({
            from: ex.name,
            to: identitySub,
            reason: `Identity-preferred exercise selected for accessory slot.`,
          });
          result.push({ ...ex, name: identitySub });
          adjusted = true;
        }
      }
    }

    if (!adjusted) {
      result.push(ex);
    }
  }

  return { exercises: result, adjustments };
}
