// lib/coach/plan-builder/__tests__/graceful-degradation.test.ts
//
// Regression test: intelligence-absent = today's plan (the load-bearing safety rule).
//
// Proves that when all intelligence data is absent (null / empty), the three
// plan-shaping functions return the identity/no-op result — i.e. the plan is
// byte-identical to the no-intelligence baseline (today's behaviour).
//
//   1. planIntelligenceChecks({ ..., intelligence: null, responsiveness: null }) → []
//   2. applyConstraintAwareSelection with constraints: null + identity: null (or undefined)
//      → exercises unchanged, adjustments: []
//   3. applyFlagResolutions with empty plan_flag_resolutions
//      → ComposerInputScalars === DEFAULT_COMPOSER_INPUTS
//
// This file intentionally uses MINIMAL fixtures. The goal is not to test every
// branch (those live in the per-function test files) but to verify that the
// *combination* of all-absent intelligence produces the same plan the app
// generates today — no unexpected modifications.

import { describe, it, expect } from "vitest";

import {
  planIntelligenceChecks,
  type PlanIntelligenceChecksArgs,
} from "@/lib/coach/plan-builder/plan-intelligence-checks";

import {
  applyConstraintAwareSelection,
} from "@/lib/coach/plan-builder/constraint-aware-exercises";

import {
  applyFlagResolutions,
  DEFAULT_COMPOSER_INPUTS,
} from "@/lib/coach/plan-builder/apply-flag-resolutions";

import type { IntakePayload } from "@/lib/data/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal IntakePayload — clean state, no flag resolutions. */
function makeMinimalIntake(
  overrides: Partial<IntakePayload> = {},
): IntakePayload {
  const base: IntakePayload = {
    schema_version: 1,
    health: {
      conditions: {
        cardiac: false,
        hypertension: false,
        diabetes: "none",
        autoimmune: false,
        joint_surgeries: [],
        other: "",
      },
      medications: "",
      recent_illness_injury: "",
      active_injuries: [],
      allergies: "",
    },
    training: {
      years_lifting: 3,
      training_age: "intermediate",
      sessions_per_week: 4,
      typical_session_minutes: 60,
      equipment: {
        barbell: true,
        rack: true,
        bench: true,
        dumbbells: true,
        cables: true,
        machines: true,
        platform: false,
        ghd: false,
        sled: false,
        treadmill: false,
        rower: false,
        bike: false,
        kettlebells: false,
        bands: false,
        other: "",
      },
      current_e1rm: { squat: 100, bench: 80, deadlift: 120, ohp: 50 },
      best_ever_pr: { squat: 105, bench: 85, deadlift: 130, ohp: 55 },
      previous_programs: "",
      recent_plateaus: "",
    },
    lifestyle: {
      job_demands: "sedentary",
      commute_minutes: 15,
      has_dependents: false,
      dependent_notes: "",
      stress_self_rating: 3,
      days_available: {
        mon: true, tue: true, wed: false, thu: true, fri: true, sat: false, sun: false,
      },
      earliest_session_time: "17:00",
      latest_session_time: "20:00",
      travel_frequency: "none",
    },
    nutrition: {
      current_phase: "maintain",
      current_kcal: 2400,
      current_macros: { protein_g: 180, carb_g: 240, fat_g: 70 },
      tracking_experience: "consistent",
      restrictions: "",
      alcohol_drinks_per_week: 0,
      caffeine_mg_per_day: 150,
      supplements: "",
    },
    sleep_recovery: {
      avg_sleep_hours: 7.5,
      typical_bedtime: "22:30",
      typical_wake_time: "06:00",
      sleep_latency_minutes: 10,
      awakenings: "none",
      mobility_work: "Yes",
      soreness_frequency: "common",
    },
    goals: {
      primary_type: "strength",
      primary_metric: "Squat e1RM",
      target_value: 140,
      target_unit: "kg",
      target_date: "2026-12-31",
      why_narrative: "Get stronger",
    },
    // No plan_flag_resolutions — clean state
  };
  return { ...base, ...overrides };
}

/** A small representative exercise list (the kind compose-strength produces). */
function makeExercises(): PlannedExercise[] {
  return [
    { name: "Squat (Barbell)", baseKg: 100, baseReps: 5, sets: 4 },
    { name: "Romanian Deadlift (Barbell)", baseKg: 80, baseReps: 8, sets: 3 },
    { name: "Leg Press (Machine)", baseKg: 120, baseReps: 10, sets: 3 },
    { name: "Leg Curl (Machine)", baseKg: 40, baseReps: 12, sets: 3 },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. planIntelligenceChecks — null intelligence → []
// ─────────────────────────────────────────────────────────────────────────────

describe("graceful degradation — planIntelligenceChecks", () => {
  it("returns [] when intelligence is null and responsiveness is null", () => {
    const args: PlanIntelligenceChecksArgs = {
      intake: makeMinimalIntake(),
      intelligence: null,
      responsiveness: null,
    };
    expect(planIntelligenceChecks(args)).toEqual([]);
    expect(planIntelligenceChecks(args)).toHaveLength(0);
  });

  it("returns [] when intelligence is null regardless of intake state", () => {
    // Even with a 'cut' phase that would normally be a candidate for flags,
    // null intelligence means zero flags — plan is unmodified.
    const args: PlanIntelligenceChecksArgs = {
      intake: makeMinimalIntake({
        nutrition: {
          current_phase: "cut",
          current_kcal: 1800,
          current_macros: { protein_g: 120, carb_g: 160, fat_g: 50 },
          tracking_experience: "consistent",
          restrictions: "",
          alcohol_drinks_per_week: 0,
          caffeine_mg_per_day: 150,
          supplements: "",
        },
      }),
      intelligence: null,
      responsiveness: null,
    };
    expect(planIntelligenceChecks(args)).toEqual([]);
  });

  it("zero flags means no plan-shaping signals — baseline preserved", () => {
    // This is the invariant: if planIntelligenceChecks returns [], then
    // applyFlagResolutions will have no intelligence-derived findings to
    // process, and the plan inputs stay at DEFAULT_COMPOSER_INPUTS.
    const flags = planIntelligenceChecks({
      intake: makeMinimalIntake(),
      intelligence: null,
      responsiveness: null,
    });
    // Confirm zero flags, then confirm applyFlagResolutions is a no-op.
    expect(flags).toHaveLength(0);
    const result = applyFlagResolutions(DEFAULT_COMPOSER_INPUTS, flags, undefined);
    expect(result).toEqual(DEFAULT_COMPOSER_INPUTS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. applyConstraintAwareSelection — absent / empty → exercises unchanged
// ─────────────────────────────────────────────────────────────────────────────

describe("graceful degradation — applyConstraintAwareSelection", () => {
  it("exercises unchanged and adjustments: [] when constraints and identity are both absent (undefined)", () => {
    const exercises = makeExercises();
    const result = applyConstraintAwareSelection({ exercises });
    expect(result.exercises).toEqual(exercises);
    expect(result.adjustments).toEqual([]);
  });

  it("exercises unchanged and adjustments: [] when constraints and identity are both null", () => {
    const exercises = makeExercises();
    const result = applyConstraintAwareSelection({
      exercises,
      constraints: null,
      identity: null,
    });
    expect(result.exercises).toEqual(exercises);
    expect(result.adjustments).toEqual([]);
  });

  it("exercises unchanged and adjustments: [] when constraints are null and identity is undefined", () => {
    const exercises = makeExercises();
    const result = applyConstraintAwareSelection({
      exercises,
      constraints: null,
    });
    expect(result.exercises).toEqual(exercises);
    expect(result.adjustments).toEqual([]);
  });

  it("exercises unchanged and adjustments: [] when constraints are undefined and identity is null", () => {
    const exercises = makeExercises();
    const result = applyConstraintAwareSelection({
      exercises,
      identity: null,
    });
    expect(result.exercises).toEqual(exercises);
    expect(result.adjustments).toEqual([]);
  });

  it("result exercises are reference-equal to input when no constraints/identity (fast path)", () => {
    // The fast path in the implementation returns { exercises, adjustments: [] }
    // directly — the exact same array reference, not a copy.
    const exercises = makeExercises();
    const result = applyConstraintAwareSelection({ exercises });
    expect(result.exercises).toBe(exercises); // reference equality — no copy made
  });

  it("empty exercise list with absent constraints/identity → empty list, no adjustments", () => {
    const result = applyConstraintAwareSelection({ exercises: [] });
    expect(result.exercises).toEqual([]);
    expect(result.adjustments).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. applyFlagResolutions — empty resolutions → DEFAULT_COMPOSER_INPUTS
// ─────────────────────────────────────────────────────────────────────────────

describe("graceful degradation — applyFlagResolutions", () => {
  it("returns DEFAULT_COMPOSER_INPUTS unchanged when plan_flag_resolutions is undefined", () => {
    const result = applyFlagResolutions(DEFAULT_COMPOSER_INPUTS, [], undefined);
    expect(result).toEqual(DEFAULT_COMPOSER_INPUTS);
  });

  it("returns DEFAULT_COMPOSER_INPUTS unchanged when plan_flag_resolutions is undefined (null-like)", () => {
    // null is not assignable to the resolutions type — undefined is the JS-idiomatic
    // representation of "absent". Both branches in the fast-path guard:
    //   if (!resolutions || Object.keys(resolutions).length === 0) return baseInputs;
    // are covered by the undefined + empty-object tests above.
    const result = applyFlagResolutions(DEFAULT_COMPOSER_INPUTS, [], undefined);
    expect(result).toEqual(DEFAULT_COMPOSER_INPUTS);
  });

  it("returns DEFAULT_COMPOSER_INPUTS unchanged when plan_flag_resolutions is an empty object", () => {
    const result = applyFlagResolutions(DEFAULT_COMPOSER_INPUTS, [], {});
    expect(result).toEqual(DEFAULT_COMPOSER_INPUTS);
  });

  it("strengthVolumeMultiplier is exactly 1.0 (full prescribed volume, no trim)", () => {
    const result = applyFlagResolutions(DEFAULT_COMPOSER_INPUTS, [], undefined);
    expect(result.strengthVolumeMultiplier).toBe(1.0);
  });

  it("nutritionProteinFloorGPerKg is exactly 1.6 (classical minimum, no raise)", () => {
    const result = applyFlagResolutions(DEFAULT_COMPOSER_INPUTS, [], undefined);
    expect(result.nutritionProteinFloorGPerKg).toBe(1.6);
  });

  it("nutritionRampWeeks is exactly 0 (no ramp — full target from day 1)", () => {
    const result = applyFlagResolutions(DEFAULT_COMPOSER_INPUTS, [], undefined);
    expect(result.nutritionRampWeeks).toBe(0);
  });

  it("result is reference-equal to baseInputs when resolutions is empty (fast path)", () => {
    // The fast path returns baseInputs directly when resolutions is empty.
    const result = applyFlagResolutions(DEFAULT_COMPOSER_INPUTS, [], {});
    expect(result).toBe(DEFAULT_COMPOSER_INPUTS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. End-to-end: all intelligence absent → plan shaping inputs === no-intelligence baseline
// ─────────────────────────────────────────────────────────────────────────────

describe("graceful degradation — end-to-end: intelligence absent = today's plan", () => {
  it("the pipeline produces exactly DEFAULT_COMPOSER_INPUTS when intelligence is null", () => {
    const intake = makeMinimalIntake();

    // Step 1: intelligence checks — returns [] because intelligence is null
    const flags = planIntelligenceChecks({
      intake,
      intelligence: null,
      responsiveness: null,
    });

    // Step 2: apply flag resolutions — no flags in intake either
    const composerInputs = applyFlagResolutions(
      DEFAULT_COMPOSER_INPUTS,
      flags,
      intake.plan_flag_resolutions,
    );

    // Result must be identical to today's baseline
    expect(composerInputs).toEqual(DEFAULT_COMPOSER_INPUTS);
    expect(composerInputs.strengthVolumeMultiplier).toBe(1.0);
    expect(composerInputs.nutritionProteinFloorGPerKg).toBe(1.6);
    expect(composerInputs.nutritionRampWeeks).toBe(0);
  });

  it("the pipeline produces exercises unchanged when intelligence is null (no constraints, no identity)", () => {
    const exercises = makeExercises();

    // Step 2: constraint-aware selection — no constraints or identity
    const { exercises: out, adjustments } = applyConstraintAwareSelection({
      exercises,
      constraints: null,
      identity: null,
    });

    expect(out).toEqual(exercises);
    expect(adjustments).toEqual([]);
  });

  it("all three functions compose to a no-op when intelligence is fully absent", () => {
    const intake = makeMinimalIntake();
    const exercises = makeExercises();

    // 1. No intelligence flags
    const flags = planIntelligenceChecks({
      intake,
      intelligence: null,
      responsiveness: null,
    });
    expect(flags).toHaveLength(0);

    // 2. No exercise modifications
    const { exercises: selectedExercises, adjustments } = applyConstraintAwareSelection({
      exercises,
      constraints: null,
      identity: null,
    });
    expect(selectedExercises).toEqual(exercises);
    expect(adjustments).toEqual([]);

    // 3. No composer scalar changes
    const composerInputs = applyFlagResolutions(
      DEFAULT_COMPOSER_INPUTS,
      flags,
      intake.plan_flag_resolutions,
    );
    expect(composerInputs).toEqual(DEFAULT_COMPOSER_INPUTS);

    // Invariant: nothing was touched — plan is identical to the no-intelligence baseline
    expect(flags).toEqual([]);
    expect(adjustments).toEqual([]);
    expect(composerInputs).toEqual({
      strengthVolumeMultiplier: 1.0,
      nutritionProteinFloorGPerKg: 1.6,
      nutritionRampWeeks: 0,
    });
  });
});
