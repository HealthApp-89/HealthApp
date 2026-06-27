// lib/coach/plan-builder/apply-flag-resolutions.ts
//
// Pure function: applyFlagResolutions(inputs, resolutions) → adjustedInputs
//
// For each "accept"ed flag in intake.plan_flag_resolutions, applies the softer
// value from the flag finding to the composer inputs before the composer runs.
// "override" or absent → no change (pass-through).
//
// Flag → composer input mapping:
//
//   goal_vs_recovery (accept)
//     → strengthVolumeMultiplier *= proposed_opening_volume_pct
//       (opening week is lighter, protects against overreach)
//
//   strength_endurance_interference (accept)
//     → strengthVolumeMultiplier *= proposed_strength_volume_pct
//       (trims strength volume to create recovery headroom)
//
//   deficit_vs_muscle_loss (accept)
//     → nutritionProteinFloorGPerKg = max(current, proposed_protein_floor_g_per_kg)
//       (raise, never lower)
//
//   target_vs_adherence (accept)
//     → nutritionRampWeeks = proposed_ramp_weeks
//       (allow habits to catch up before full target is enforced)
//
// Note: the two strength flags (goal_vs_recovery + interference) both multiply
// the same strengthVolumeMultiplier. When both fire and both are accepted, the
// multipliers compound: e.g. 0.8 × 0.85 = 0.68. This is intentional — both
// stressors are real and additive.
//
// No AI calls — pure deterministic logic.

import type { SanityFinding, IntakePayload } from "@/lib/data/types";

// ─────────────────────────────────────────────────────────────────────────────
// Input/Output types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Composer input scalars that intelligence flags can adjust.
 *
 * Default values (no flags accepted):
 *   strengthVolumeMultiplier = 1.0  (full prescribed volume)
 *   nutritionProteinFloorGPerKg = 1.6  (classical minimum — may be raised by GLP-1 or flag)
 *   nutritionRampWeeks = 0  (no ramp — full target from day 1)
 */
export type ComposerInputScalars = {
  /** Multiplier applied to opening-week volume targets in composeStrengthTemplate.
   *  1.0 = full volume; <1.0 = trimmed. */
  strengthVolumeMultiplier: number;
  /** Protein floor in g/kg BW for composeNutrition.
   *  When a flag is accepted, we max(current_floor, proposed_floor) so we only
   *  ever raise this, never lower it. */
  nutritionProteinFloorGPerKg: number;
  /** Number of weeks to ramp protein from current intake up to target.
   *  0 = no ramp (target from day 1). Non-zero = progressive ramp. */
  nutritionRampWeeks: number;
};

export const DEFAULT_COMPOSER_INPUTS: ComposerInputScalars = {
  strengthVolumeMultiplier: 1.0,
  nutritionProteinFloorGPerKg: 1.6,
  nutritionRampWeeks: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// Resolution lookup helpers
// ─────────────────────────────────────────────────────────────────────────────

type FlagType = NonNullable<keyof NonNullable<IntakePayload["plan_flag_resolutions"]>>;

function isAccepted(flagType: FlagType, resolutions: IntakePayload["plan_flag_resolutions"]): boolean {
  return resolutions?.[flagType] === "accept";
}

function findFinding<T extends SanityFinding>(
  findings: SanityFinding[],
  type: SanityFinding["type"],
): T | null {
  return (findings.find((f) => f.type === type) ?? null) as T | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply accepted flag resolutions to composer inputs.
 *
 * @param baseInputs  Starting scalars (usually DEFAULT_COMPOSER_INPUTS).
 * @param findings    All SanityFindings (sanity check + intelligence layer).
 * @param resolutions intake.plan_flag_resolutions — may be undefined/null.
 *
 * @returns New ComposerInputScalars with accepted flags' adjustments applied.
 *          Unchanged when resolutions is nullish or all flags are "override".
 *
 * @example
 *   // Both strength flags accepted → compound multiplier
 *   const inputs = applyFlagResolutions(
 *     DEFAULT_COMPOSER_INPUTS,
 *     findings,   // includes goal_vs_recovery (0.8) + interference (0.85)
 *     intake.plan_flag_resolutions,  // { goal_vs_recovery: "accept", strength_endurance_interference: "accept" }
 *   );
 *   // inputs.strengthVolumeMultiplier === 0.68 (0.8 × 0.85)
 */
export function applyFlagResolutions(
  baseInputs: ComposerInputScalars,
  findings: SanityFinding[],
  resolutions: IntakePayload["plan_flag_resolutions"],
): ComposerInputScalars {
  // Fast path: nothing to do
  if (!resolutions || Object.keys(resolutions).length === 0) {
    return baseInputs;
  }

  let strengthVolumeMultiplier = baseInputs.strengthVolumeMultiplier;
  let nutritionProteinFloorGPerKg = baseInputs.nutritionProteinFloorGPerKg;
  let nutritionRampWeeks = baseInputs.nutritionRampWeeks;

  // ── goal_vs_recovery (accept) ─────────────────────────────────────────────
  if (isAccepted("goal_vs_recovery", resolutions)) {
    const finding = findFinding<Extract<SanityFinding, { type: "goal_vs_recovery" }>>(
      findings,
      "goal_vs_recovery",
    );
    if (finding && typeof finding.proposed_opening_volume_pct === "number") {
      strengthVolumeMultiplier *= finding.proposed_opening_volume_pct;
    }
  }

  // ── strength_endurance_interference (accept) ──────────────────────────────
  if (isAccepted("strength_endurance_interference", resolutions)) {
    const finding = findFinding<Extract<SanityFinding, { type: "strength_endurance_interference" }>>(
      findings,
      "strength_endurance_interference",
    );
    if (finding && typeof finding.proposed_strength_volume_pct === "number") {
      strengthVolumeMultiplier *= finding.proposed_strength_volume_pct;
    }
  }

  // ── deficit_vs_muscle_loss (accept) ──────────────────────────────────────
  if (isAccepted("deficit_vs_muscle_loss", resolutions)) {
    const finding = findFinding<Extract<SanityFinding, { type: "deficit_vs_muscle_loss" }>>(
      findings,
      "deficit_vs_muscle_loss",
    );
    if (finding && typeof finding.proposed_protein_floor_g_per_kg === "number") {
      // Raise, never lower
      nutritionProteinFloorGPerKg = Math.max(
        nutritionProteinFloorGPerKg,
        finding.proposed_protein_floor_g_per_kg,
      );
    }
  }

  // ── target_vs_adherence (accept) ─────────────────────────────────────────
  if (isAccepted("target_vs_adherence", resolutions)) {
    const finding = findFinding<Extract<SanityFinding, { type: "target_vs_adherence" }>>(
      findings,
      "target_vs_adherence",
    );
    if (finding && typeof finding.proposed_ramp_weeks === "number") {
      nutritionRampWeeks = Math.max(nutritionRampWeeks, finding.proposed_ramp_weeks);
    }
  }

  return { strengthVolumeMultiplier, nutritionProteinFloorGPerKg, nutritionRampWeeks };
}
