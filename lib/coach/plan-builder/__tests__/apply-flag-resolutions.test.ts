// lib/coach/plan-builder/__tests__/apply-flag-resolutions.test.ts
//
// Tests for the pure applyFlagResolutions() function.
//
// Test axes per flag:
//   1. "accept" → adjustment applied
//   2. "override" → no change (pass-through)
//   3. absent (not in resolutions) → no change
//   4. Finding missing from findings array → no change (safe)
//
// Cross-cutting:
//   - resolutions nullish → DEFAULT_COMPOSER_INPUTS returned unchanged
//   - Both strength flags accepted → multipliers compound
//   - Accept raises protein floor (never lowers)
//   - Ramp weeks takes max of base and proposed

import { describe, it, expect } from "vitest";
import {
  applyFlagResolutions,
  DEFAULT_COMPOSER_INPUTS,
  type ComposerInputScalars,
} from "@/lib/coach/plan-builder/apply-flag-resolutions";
import type { SanityFinding, IntakePayload } from "@/lib/data/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────────────

const GOAL_VS_RECOVERY_FINDING: Extract<SanityFinding, { type: "goal_vs_recovery" }> = {
  type: "goal_vs_recovery",
  recovery_status: "warning_overreach",
  proposed_opening_volume_pct: 0.8,
  rationale: "Recovery indicates overreach — open 20% lighter.",
};

const INTERFERENCE_FINDING: Extract<SanityFinding, { type: "strength_endurance_interference" }> = {
  type: "strength_endurance_interference",
  interference_level: "high",
  proposed_strength_volume_pct: 0.85,
  rationale: "High interference — trim strength volume 15%.",
};

const DEFICIT_MUSCLE_LOSS_FINDING: Extract<SanityFinding, { type: "deficit_vs_muscle_loss" }> = {
  type: "deficit_vs_muscle_loss",
  muscle_loss_risk: "high",
  body_comp_direction: "losing_muscle",
  proposed_protein_floor_g_per_kg: 1.8,
  rationale: "High muscle-loss risk — raise protein floor.",
};

const TARGET_ADHERENCE_FINDING: Extract<SanityFinding, { type: "target_vs_adherence" }> = {
  type: "target_vs_adherence",
  target_field: "protein_g",
  recent_avg_g_per_kg: 1.2,
  target_g_per_kg: 2.0,
  proposed_ramp_weeks: 3,
  rationale: "Chronic protein shortfall — 3-week ramp.",
};

const ALL_FINDINGS: SanityFinding[] = [
  GOAL_VS_RECOVERY_FINDING,
  INTERFERENCE_FINDING,
  DEFICIT_MUSCLE_LOSS_FINDING,
  TARGET_ADHERENCE_FINDING,
];

type Resolutions = NonNullable<IntakePayload["plan_flag_resolutions"]>;

// ─────────────────────────────────────────────────────────────────────────────
// Baseline tests
// ─────────────────────────────────────────────────────────────────────────────

describe("applyFlagResolutions — baseline", () => {
  it("returns DEFAULT_COMPOSER_INPUTS unchanged when resolutions is undefined", () => {
    const result = applyFlagResolutions(DEFAULT_COMPOSER_INPUTS, ALL_FINDINGS, undefined);
    expect(result).toEqual(DEFAULT_COMPOSER_INPUTS);
  });

  it("returns DEFAULT_COMPOSER_INPUTS unchanged when resolutions is empty object", () => {
    const result = applyFlagResolutions(DEFAULT_COMPOSER_INPUTS, ALL_FINDINGS, {});
    expect(result).toEqual(DEFAULT_COMPOSER_INPUTS);
  });

  it("returns DEFAULT_COMPOSER_INPUTS unchanged when no findings match", () => {
    const resolutions: Resolutions = { goal_vs_recovery: "accept" };
    const result = applyFlagResolutions(DEFAULT_COMPOSER_INPUTS, [], resolutions);
    expect(result).toEqual(DEFAULT_COMPOSER_INPUTS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// goal_vs_recovery
// ─────────────────────────────────────────────────────────────────────────────

describe("goal_vs_recovery flag", () => {
  it("accept → multiplies strengthVolumeMultiplier by proposed_opening_volume_pct (0.8)", () => {
    const resolutions: Resolutions = { goal_vs_recovery: "accept" };
    const result = applyFlagResolutions(DEFAULT_COMPOSER_INPUTS, ALL_FINDINGS, resolutions);
    expect(result.strengthVolumeMultiplier).toBeCloseTo(0.8);
    // other fields unchanged
    expect(result.nutritionProteinFloorGPerKg).toBe(DEFAULT_COMPOSER_INPUTS.nutritionProteinFloorGPerKg);
    expect(result.nutritionRampWeeks).toBe(DEFAULT_COMPOSER_INPUTS.nutritionRampWeeks);
  });

  it("override → no change to strengthVolumeMultiplier", () => {
    const resolutions: Resolutions = { goal_vs_recovery: "override" };
    const result = applyFlagResolutions(DEFAULT_COMPOSER_INPUTS, ALL_FINDINGS, resolutions);
    expect(result.strengthVolumeMultiplier).toBe(1.0);
  });

  it("absent → no change", () => {
    const resolutions: Resolutions = { deficit_vs_muscle_loss: "accept" };
    const result = applyFlagResolutions(DEFAULT_COMPOSER_INPUTS, ALL_FINDINGS, resolutions);
    expect(result.strengthVolumeMultiplier).toBe(1.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// strength_endurance_interference
// ─────────────────────────────────────────────────────────────────────────────

describe("strength_endurance_interference flag", () => {
  it("accept → multiplies strengthVolumeMultiplier by proposed_strength_volume_pct (0.85)", () => {
    const resolutions: Resolutions = { strength_endurance_interference: "accept" };
    const result = applyFlagResolutions(DEFAULT_COMPOSER_INPUTS, ALL_FINDINGS, resolutions);
    expect(result.strengthVolumeMultiplier).toBeCloseTo(0.85);
  });

  it("override → no change", () => {
    const resolutions: Resolutions = { strength_endurance_interference: "override" };
    const result = applyFlagResolutions(DEFAULT_COMPOSER_INPUTS, ALL_FINDINGS, resolutions);
    expect(result.strengthVolumeMultiplier).toBe(1.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Both strength flags accepted → compound multiplier
// ─────────────────────────────────────────────────────────────────────────────

describe("compound strength flags", () => {
  it("both goal_vs_recovery + interference accepted → 0.8 × 0.85 = 0.68", () => {
    const resolutions: Resolutions = {
      goal_vs_recovery: "accept",
      strength_endurance_interference: "accept",
    };
    const result = applyFlagResolutions(DEFAULT_COMPOSER_INPUTS, ALL_FINDINGS, resolutions);
    expect(result.strengthVolumeMultiplier).toBeCloseTo(0.68);
  });

  it("one accepted, one override → only accepted multiplier applied", () => {
    const resolutions: Resolutions = {
      goal_vs_recovery: "accept",
      strength_endurance_interference: "override",
    };
    const result = applyFlagResolutions(DEFAULT_COMPOSER_INPUTS, ALL_FINDINGS, resolutions);
    expect(result.strengthVolumeMultiplier).toBeCloseTo(0.8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deficit_vs_muscle_loss
// ─────────────────────────────────────────────────────────────────────────────

describe("deficit_vs_muscle_loss flag", () => {
  it("accept → raises protein floor to max(1.6, 1.8) = 1.8", () => {
    const resolutions: Resolutions = { deficit_vs_muscle_loss: "accept" };
    const result = applyFlagResolutions(DEFAULT_COMPOSER_INPUTS, ALL_FINDINGS, resolutions);
    expect(result.nutritionProteinFloorGPerKg).toBe(1.8);
  });

  it("accept when base floor is already higher than proposed → keeps higher (raise-only)", () => {
    const highBaseInputs: ComposerInputScalars = {
      ...DEFAULT_COMPOSER_INPUTS,
      nutritionProteinFloorGPerKg: 2.0,
    };
    const resolutions: Resolutions = { deficit_vs_muscle_loss: "accept" };
    const result = applyFlagResolutions(highBaseInputs, ALL_FINDINGS, resolutions);
    // 2.0 > 1.8 → stays at 2.0 (never lowered)
    expect(result.nutritionProteinFloorGPerKg).toBe(2.0);
  });

  it("override → no change to protein floor", () => {
    const resolutions: Resolutions = { deficit_vs_muscle_loss: "override" };
    const result = applyFlagResolutions(DEFAULT_COMPOSER_INPUTS, ALL_FINDINGS, resolutions);
    expect(result.nutritionProteinFloorGPerKg).toBe(1.6);
  });

  it("absent → no change", () => {
    const resolutions: Resolutions = { goal_vs_recovery: "accept" };
    const result = applyFlagResolutions(DEFAULT_COMPOSER_INPUTS, ALL_FINDINGS, resolutions);
    expect(result.nutritionProteinFloorGPerKg).toBe(1.6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// target_vs_adherence
// ─────────────────────────────────────────────────────────────────────────────

describe("target_vs_adherence flag", () => {
  it("accept → sets nutritionRampWeeks to proposed_ramp_weeks (3)", () => {
    const resolutions: Resolutions = { target_vs_adherence: "accept" };
    const result = applyFlagResolutions(DEFAULT_COMPOSER_INPUTS, ALL_FINDINGS, resolutions);
    expect(result.nutritionRampWeeks).toBe(3);
  });

  it("accept when base ramp weeks > proposed → keeps higher value", () => {
    const highRampBase: ComposerInputScalars = {
      ...DEFAULT_COMPOSER_INPUTS,
      nutritionRampWeeks: 5,
    };
    const resolutions: Resolutions = { target_vs_adherence: "accept" };
    const result = applyFlagResolutions(highRampBase, ALL_FINDINGS, resolutions);
    expect(result.nutritionRampWeeks).toBe(5);
  });

  it("override → no change to ramp weeks", () => {
    const resolutions: Resolutions = { target_vs_adherence: "override" };
    const result = applyFlagResolutions(DEFAULT_COMPOSER_INPUTS, ALL_FINDINGS, resolutions);
    expect(result.nutritionRampWeeks).toBe(0);
  });

  it("absent → no change", () => {
    const resolutions: Resolutions = {};
    const result = applyFlagResolutions(DEFAULT_COMPOSER_INPUTS, ALL_FINDINGS, resolutions);
    expect(result.nutritionRampWeeks).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-flag combinations
// ─────────────────────────────────────────────────────────────────────────────

describe("multi-flag combinations", () => {
  it("all four flags accepted → all adjustments applied", () => {
    const resolutions: Resolutions = {
      goal_vs_recovery: "accept",
      strength_endurance_interference: "accept",
      deficit_vs_muscle_loss: "accept",
      target_vs_adherence: "accept",
    };
    const result = applyFlagResolutions(DEFAULT_COMPOSER_INPUTS, ALL_FINDINGS, resolutions);
    // 1.0 × 0.8 × 0.85 = 0.68
    expect(result.strengthVolumeMultiplier).toBeCloseTo(0.68);
    expect(result.nutritionProteinFloorGPerKg).toBe(1.8);
    expect(result.nutritionRampWeeks).toBe(3);
  });

  it("all four flags overridden → DEFAULT_COMPOSER_INPUTS unchanged", () => {
    const resolutions: Resolutions = {
      goal_vs_recovery: "override",
      strength_endurance_interference: "override",
      deficit_vs_muscle_loss: "override",
      target_vs_adherence: "override",
    };
    const result = applyFlagResolutions(DEFAULT_COMPOSER_INPUTS, ALL_FINDINGS, resolutions);
    expect(result).toEqual(DEFAULT_COMPOSER_INPUTS);
  });
});
