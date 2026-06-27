// lib/coach/plan-builder/__tests__/composer-scalar-threading.test.ts
//
// End-to-end tests proving that accepted flag-resolution scalars actually reach
// the composers and change their output. These tests target the threading layer
// specifically (Task 3 carry-forward from Task 2).
//
// Test axes:
//   A. strengthVolumeMultiplier → composeStrengthTemplate → weekly_volume_targets
//      - multiplier = 1.0 (default) → targets unchanged
//      - multiplier = 0.8 (accepted goal_vs_recovery) → targets reduced 20%
//      - multiplier = 0.68 (both strength flags accepted) → targets reduced 32%
//
//   B. nutritionProteinFloorGPerKg → composeNutrition → protein_g_per_kg_bw + protein_g
//      - floor = 1.6 (default) → classical protein unchanged
//      - floor = 1.8 (accepted deficit_vs_muscle_loss) → protein raised
//
//   C. nutritionRampWeeks → composeNutrition / composePhaseSequence → rationale note
//      - ramp_weeks = 0 (default) → no ramp note in rationale
//      - ramp_weeks = 3 (accepted target_vs_adherence) → ramp note in first cut rationale
//
//   D. All defaults → both composers produce today's baseline numbers
//      (confirms that not accepting any flags leaves output unchanged)

import { describe, it, expect } from "vitest";
import { composeStrengthTemplate } from "@/lib/coach/plan-builder/compose-strength";
import {
  composeNutrition,
  composePhaseSequence,
} from "@/lib/coach/plan-builder/compose-nutrition";
import { composeGoal } from "@/lib/coach/plan-builder/compose-goal";
import type { IntakePayload, PlanPayload } from "@/lib/data/types";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal fixture: enough for both composers to produce deterministic output.
// ─────────────────────────────────────────────────────────────────────────────

const MINIMAL_INTAKE: IntakePayload = {
  training: {
    primary_goal: "strength",
    sessions_per_week: 4,
    training_age: "intermediate",
  },
  lifestyle: {
    days_available: {
      mon: true,
      tue: false,
      wed: true,
      thu: false,
      fri: true,
      sat: true,
      sun: false,
    },
  },
  nutrition: {
    current_phase: "cut",
    alcohol_drinks_per_week: 0,
    caffeine_mg_per_day: 200,
    goal: "lose_fat",
    goal_target_weight_kg: 85,
    goal_target_date: "2027-01-01",
    tracking_consistency: "consistent",
  },
  health: {
    glp1_status: null,
  },
  sleep: {
    chronotype: "neutral",
    typical_sleep_hours: 7.5,
    typical_wake_time: "07:00",
    sleep_issues: [],
  },
  recovery: {
    mobility_minutes_per_week: 30,
    stress_level: "moderate",
  },
  coaching: {
    preferred_cadence: "daily",
    directness: "balanced",
  },
} as unknown as IntakePayload;

// Build goal from intake (needed for composeNutrition)
const GOAL: PlanPayload["goal"] = {
  type: "body_comp",
  primary_metric: "weight_kg",
  target_value: 85,
  target_unit: "kg",
  target_date: "2027-01-01",
  narrative_summary: "",
  feasibility_note: null,
};

const BW_KG = 103;

// ─────────────────────────────────────────────────────────────────────────────
// A. strengthVolumeMultiplier threading
// ─────────────────────────────────────────────────────────────────────────────

describe("Scalar threading: strengthVolumeMultiplier → composeStrengthTemplate", () => {
  it("A1: default multiplier (1.0) → intermediate volume targets unchanged", () => {
    const { strength } = composeStrengthTemplate(
      MINIMAL_INTAKE,
      null,
      { squat: null, bench: null, deadlift: null, ohp: null },
      [],
      // No options → default 1.0
    );

    // intermediate: reps_per_week = 70, sets_per_week = 14
    for (const target of Object.values(strength.weekly_volume_targets)) {
      expect(target.reps_per_week).toBe(70);
      expect(target.sets_per_week).toBe(14);
    }
  });

  it("A2: multiplier = 0.8 (accepted goal_vs_recovery) → volume reduced 20%", () => {
    const { strength } = composeStrengthTemplate(
      MINIMAL_INTAKE,
      null,
      { squat: null, bench: null, deadlift: null, ohp: null },
      [],
      { strengthVolumeMultiplier: 0.8 },
    );

    // 70 × 0.8 = 56; 14 × 0.8 = 11.2 → rounds to 11
    for (const target of Object.values(strength.weekly_volume_targets)) {
      expect(target.reps_per_week).toBe(Math.round(70 * 0.8));
      expect(target.sets_per_week).toBe(Math.round(14 * 0.8));
    }
  });

  it("A3: multiplier = 0.68 (both strength flags accepted) → volume reduced 32%", () => {
    const { strength } = composeStrengthTemplate(
      MINIMAL_INTAKE,
      null,
      { squat: null, bench: null, deadlift: null, ohp: null },
      [],
      { strengthVolumeMultiplier: 0.68 },
    );

    for (const target of Object.values(strength.weekly_volume_targets)) {
      expect(target.reps_per_week).toBe(Math.round(70 * 0.68));
      expect(target.sets_per_week).toBe(Math.round(14 * 0.68));
    }
  });

  it("A4: multiplier = 1.0 produces identical output to no options (default = today's behavior)", () => {
    const defaultResult = composeStrengthTemplate(
      MINIMAL_INTAKE, null,
      { squat: null, bench: null, deadlift: null, ohp: null },
      [],
    );
    const explicitResult = composeStrengthTemplate(
      MINIMAL_INTAKE, null,
      { squat: null, bench: null, deadlift: null, ohp: null },
      [],
      { strengthVolumeMultiplier: 1.0 },
    );

    expect(defaultResult.strength.weekly_volume_targets).toEqual(
      explicitResult.strength.weekly_volume_targets,
    );
  });

  it("A5: no options → adjustments array is empty (no intelligence, no constraint swaps)", () => {
    const { adjustments } = composeStrengthTemplate(
      MINIMAL_INTAKE, null,
      { squat: null, bench: null, deadlift: null, ohp: null },
      [],
    );
    expect(adjustments).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. nutritionProteinFloorGPerKg threading
// ─────────────────────────────────────────────────────────────────────────────

describe("Scalar threading: nutritionProteinFloorGPerKg → composeNutrition", () => {
  it("B1: default floor (1.6) → protein_g_per_kg_bw = 1.6", () => {
    const nutrition = composeNutrition({
      intake: MINIMAL_INTAKE,
      goal: GOAL,
      bodyweight_kg: BW_KG,
      acknowledged_on: null,
      // No nutritionProteinFloorGPerKg → defaults to 1.6
    });

    expect(nutrition.protein_g_per_kg_bw).toBe(1.6);
    expect(nutrition.protein_g).toBe(Math.round(BW_KG * 1.6));
  });

  it("B2: floor = 1.8 (accepted deficit_vs_muscle_loss) → protein raised", () => {
    const nutrition = composeNutrition({
      intake: MINIMAL_INTAKE,
      goal: GOAL,
      bodyweight_kg: BW_KG,
      acknowledged_on: null,
      nutritionProteinFloorGPerKg: 1.8,
    });

    expect(nutrition.protein_g_per_kg_bw).toBe(1.8);
    expect(nutrition.protein_g).toBe(Math.round(BW_KG * 1.8));
    // Must be strictly greater than the 1.6 default
    const defaultNutrition = composeNutrition({
      intake: MINIMAL_INTAKE,
      goal: GOAL,
      bodyweight_kg: BW_KG,
      acknowledged_on: null,
    });
    expect(nutrition.protein_g).toBeGreaterThan(defaultNutrition.protein_g);
  });

  it("B3: floor lower than 1.6 → clamped to 1.6 (raise-only)", () => {
    // A floor of 1.2 (lower than 1.6) should not lower protein below classical minimum
    const nutrition = composeNutrition({
      intake: MINIMAL_INTAKE,
      goal: GOAL,
      bodyweight_kg: BW_KG,
      acknowledged_on: null,
      nutritionProteinFloorGPerKg: 1.2,
    });

    // Raise-only: floor is clamped to max(1.6, 1.2) = 1.6
    expect(nutrition.protein_g_per_kg_bw).toBe(1.6);
  });

  it("B4: no nutritionProteinFloorGPerKg produces identical output to explicit 1.6 (default = today's behavior)", () => {
    const defaultResult = composeNutrition({
      intake: MINIMAL_INTAKE,
      goal: GOAL,
      bodyweight_kg: BW_KG,
      acknowledged_on: null,
    });
    const explicitResult = composeNutrition({
      intake: MINIMAL_INTAKE,
      goal: GOAL,
      bodyweight_kg: BW_KG,
      acknowledged_on: null,
      nutritionProteinFloorGPerKg: 1.6,
    });

    expect(defaultResult.protein_g_per_kg_bw).toBe(explicitResult.protein_g_per_kg_bw);
    expect(defaultResult.protein_g).toBe(explicitResult.protein_g);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. nutritionRampWeeks threading
// ─────────────────────────────────────────────────────────────────────────────

describe("Scalar threading: nutritionRampWeeks → composePhaseSequence", () => {
  const CUT_PHASE_ARGS = {
    current_phase: "cut" as const,
    goal_target_date: "2027-06-01",
    acknowledged_on: "2026-06-27",
    bodyweight_kg: BW_KG,
    bodyweight_kg_protein_factor: 1.6,
  };

  it("C1: ramp_weeks = 0 (default) → no ramp note in first cut phase rationale", () => {
    const phases = composePhaseSequence({ ...CUT_PHASE_ARGS, ramp_weeks: 0 });
    expect(phases).not.toBeNull();
    const firstCut = phases!.find((p) => p.mode === "cut");
    expect(firstCut).toBeDefined();
    expect(firstCut!.rationale).not.toMatch(/ramp/i);
  });

  it("C2: ramp_weeks = 3 (accepted target_vs_adherence) → ramp note in first cut rationale", () => {
    const phases = composePhaseSequence({ ...CUT_PHASE_ARGS, ramp_weeks: 3 });
    expect(phases).not.toBeNull();
    const firstCut = phases!.find((p) => p.mode === "cut");
    expect(firstCut).toBeDefined();
    expect(firstCut!.rationale).toMatch(/3-week.*ramp/i);
  });

  it("C3: absent ramp_weeks produces identical sequence to ramp_weeks = 0", () => {
    const withDefault = composePhaseSequence(CUT_PHASE_ARGS);
    const withZero = composePhaseSequence({ ...CUT_PHASE_ARGS, ramp_weeks: 0 });
    expect(withDefault).toEqual(withZero);
  });

  it("C4: nutritionRampWeeks threaded through composeNutrition → ramp note in classical_phases", () => {
    const noRamp = composeNutrition({
      intake: MINIMAL_INTAKE,
      goal: GOAL,
      bodyweight_kg: BW_KG,
      acknowledged_on: "2026-06-27",
      nutritionRampWeeks: 0,
    });
    const withRamp = composeNutrition({
      intake: MINIMAL_INTAKE,
      goal: GOAL,
      bodyweight_kg: BW_KG,
      acknowledged_on: "2026-06-27",
      nutritionRampWeeks: 4,
    });

    const noRampFirstCut = noRamp.classical_phases?.find((p) => p.mode === "cut");
    const withRampFirstCut = withRamp.classical_phases?.find((p) => p.mode === "cut");

    expect(noRampFirstCut?.rationale).not.toMatch(/ramp/i);
    expect(withRampFirstCut?.rationale).toMatch(/4-week.*ramp/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. All defaults → today's baseline (no regression)
// ─────────────────────────────────────────────────────────────────────────────

describe("Scalar threading: defaults preserve today's behavior", () => {
  it("D1: composeStrengthTemplate with no options returns same volume targets as before Task 3", () => {
    const { strength } = composeStrengthTemplate(
      MINIMAL_INTAKE, null,
      { squat: null, bench: null, deadlift: null, ohp: null },
      [],
    );
    // intermediate lifter: 70 reps/wk, 14 sets/wk — the pre-Task-3 values
    for (const target of Object.values(strength.weekly_volume_targets)) {
      expect(target.reps_per_week).toBe(70);
      expect(target.sets_per_week).toBe(14);
    }
  });

  it("D2: composeNutrition with no extra params returns 1.6 protein factor and no ramp note", () => {
    const nutrition = composeNutrition({
      intake: MINIMAL_INTAKE,
      goal: GOAL,
      bodyweight_kg: BW_KG,
      acknowledged_on: null,
    });

    expect(nutrition.protein_g_per_kg_bw).toBe(1.6);
    const firstCut = nutrition.classical_phases?.find((p) => p.mode === "cut");
    if (firstCut) {
      expect(firstCut.rationale).not.toMatch(/ramp/i);
    }
  });
});
