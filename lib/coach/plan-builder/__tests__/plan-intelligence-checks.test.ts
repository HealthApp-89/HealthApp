// lib/coach/plan-builder/__tests__/plan-intelligence-checks.test.ts
//
// Tests for the pure planIntelligenceChecks() function.
//
// Each flag has three test axes:
//   1. Fires on trigger (conclusive data + no prior resolution)
//   2. Silent on clean/establishing/sparse data
//   3. Already-resolved flags are NOT re-emitted
//
// Plus cross-cutting:
//   - intelligence: null → []
//   - responsiveness present → responsiveness_note attached
//   - responsiveness absent (null) → flag still fires, no note

import { describe, it, expect } from "vitest";
import {
  planIntelligenceChecks,
  type PlanIntelligenceChecksArgs,
} from "@/lib/coach/plan-builder/plan-intelligence-checks";
import type { IntakePayload } from "@/lib/data/types";
import type { AthleteIntelligencePayload } from "@/lib/coach/intelligence/types";
import type { ResponsivenessRollup } from "@/lib/coach/interventions/responsiveness";

// ─────────────────────────────────────────────────────────────────────────────
// Base fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal clean IntakePayload — strength goal, cut phase, no resolutions. */
function makeIntake(overrides: Partial<IntakePayload> = {}): IntakePayload {
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
      years_lifting: 5,
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
      current_e1rm: { squat: 120, bench: 90, deadlift: 140, ohp: 55 },
      best_ever_pr: { squat: 125, bench: 95, deadlift: 150, ohp: 60 },
      previous_programs: "",
      recent_plateaus: "",
    },
    lifestyle: {
      job_demands: "sedentary",
      commute_minutes: 20,
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
      current_phase: "cut",
      current_kcal: 2000,
      current_macros: { protein_g: 160, carb_g: 180, fat_g: 60 },
      tracking_experience: "consistent",
      restrictions: "",
      alcohol_drinks_per_week: 1,
      caffeine_mg_per_day: 200,
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
      primary_metric: "Deadlift E1RM",
      target_value: 180,
      target_unit: "kg",
      target_date: "2026-12-31",
      why_narrative: "Get stronger",
    },
  };
  return { ...base, ...overrides };
}

/** Minimal clean AthleteIntelligencePayload — all clear / "none" signals. */
function makeIntelligence(
  overrides: Partial<AthleteIntelligencePayload> = {},
): AthleteIntelligencePayload {
  const base: AthleteIntelligencePayload = {
    generated_on: "2026-06-27T00:00:00.000Z",
    identity: {
      top_exercises: {
        lower: ["Squat (Barbell)"],
        upper: ["Decline Bench Press (Barbell)"],
        pulls: ["Deadlift (Barbell)"],
        isolation: ["Arnold Press (Dumbbell)"],
      },
      eating_identity: {
        top_proteins: ["Chicken Breast"],
        top_carbs: ["White Rice"],
        top_fats: ["Olive Oil"],
        cuisines: ["Mediterranean"],
        monotone_flags: [],
      },
      training_style_signature: {
        volume_preference: "moderate",
        intensity_distribution_percent: null,
        recovery_speed_days: null,
        session_duration_preference_min: null,
      },
    },
    constraints: {
      active_injuries: [],
      exercise_exclusions: [],
      equipment_access: "commercial_gym",
      schedule_constraints: [],
    },
    history: {
      recent_deloads: [],
      exercise_swaps_8w: [],
      nutrition_interventions: [],
    },
    // ── Layer 2 — all-clear defaults ─────────────────────────────────────────
    recovery_readiness: {
      status: "recovering_well",
      confidence: 0.8,
      drivers: [],
      recommendation: "continue_training",
      narrative: "Recovery is on track; continue planned training.",
    },
    nutrition_performance: {
      protein_status: "adequate",
      carb_timing_suboptimal: false,
      deficit_severity: "appropriate",
      predicted_muscle_loss_risk: "low",
      drivers: [],
      narrative: "Nutrition on track.",
    },
    interference: {
      interference_level: "none",
      tss_ratio_7d_28d: null,
      lift_trend: "progressing",
      action: null,
      drivers: [],
      narrative: "No interference.",
    },
    body_comp_direction: {
      direction: "losing_fat",
      confidence: 0.7,
      weeks_of_data: 4,
      weight_trend_kg_per_week: -0.3,
      bodyfat_trend_pct_per_week: -0.1,
      lift_trend: "flat",
      drivers: [],
      narrative: "Losing fat while preserving muscle.",
    },
  };

  return { ...base, ...overrides };
}

/** Clean ResponsivenessRollup — empty buckets. */
function makeResponsiveness(
  overrides: Partial<ResponsivenessRollup> = {},
): ResponsivenessRollup {
  return {
    high_roi: [],
    low_signal: [],
    recent_wins: [],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────────

function run(
  intakeOverrides: Partial<IntakePayload> = {},
  intelligenceOverrides: Partial<AthleteIntelligencePayload> = {},
  responsiveness: ResponsivenessRollup | null = null,
) {
  return planIntelligenceChecks({
    intake: makeIntake(intakeOverrides),
    intelligence: makeIntelligence(intelligenceOverrides),
    responsiveness,
  });
}

function types(findings: ReturnType<typeof planIntelligenceChecks>) {
  return findings.map((f) => f.type);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test: intelligence null → []
// ─────────────────────────────────────────────────────────────────────────────

describe("planIntelligenceChecks", () => {
  describe("null intelligence", () => {
    it("returns [] when intelligence is null", () => {
      const args: PlanIntelligenceChecksArgs = {
        intake: makeIntake(),
        intelligence: null,
        responsiveness: null,
      };
      expect(planIntelligenceChecks(args)).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // goal_vs_recovery
  // ─────────────────────────────────────────────────────────────────────────

  describe("goal_vs_recovery", () => {
    it("fires when recovery_readiness.status === 'warning_overreach'", () => {
      const findings = run(
        {},
        {
          recovery_readiness: {
            status: "warning_overreach",
            confidence: 0.75,
            drivers: ["HRV -8% vs baseline (3 of 5 days)"],
            recommendation: "consider_deload",
            narrative: "HRV down 8% from baseline — overreach pattern; a deload is warranted.",
          },
        },
      );
      expect(types(findings)).toContain("goal_vs_recovery");
    });

    it("is silent when recovery_readiness.status === 'recovering_well'", () => {
      const findings = run({}, { recovery_readiness: { status: "recovering_well", confidence: 0.8, drivers: [], recommendation: "continue_training", narrative: "All clear." } });
      expect(types(findings)).not.toContain("goal_vs_recovery");
    });

    it("is silent when recovery_readiness.status === 'stalled'", () => {
      const findings = run({}, { recovery_readiness: { status: "stalled", confidence: 0.6, drivers: [], recommendation: "continue_training", narrative: "Metrics flat." } });
      expect(types(findings)).not.toContain("goal_vs_recovery");
    });

    it("fired finding has proposed_opening_volume_pct = 0.8", () => {
      const findings = run(
        {},
        { recovery_readiness: { status: "warning_overreach", confidence: 0.75, drivers: [], recommendation: "consider_deload", narrative: "Overreach." } },
      );
      const flag = findings.find((f) => f.type === "goal_vs_recovery");
      expect(flag).toBeDefined();
      if (flag?.type === "goal_vs_recovery") {
        expect(flag.proposed_opening_volume_pct).toBe(0.8);
        expect(flag.recovery_status).toBe("warning_overreach");
      }
    });

    it("is NOT re-emitted when already in plan_flag_resolutions", () => {
      const findings = run(
        { plan_flag_resolutions: { goal_vs_recovery: "accept" } },
        { recovery_readiness: { status: "warning_overreach", confidence: 0.75, drivers: [], recommendation: "consider_deload", narrative: "Overreach." } },
      );
      expect(types(findings)).not.toContain("goal_vs_recovery");
    });

    it("includes responsiveness_note when rollup has reactive deload high_roi", () => {
      const responsiveness = makeResponsiveness({
        high_roi: ["reactive deloads: 3/3 recovered"],
      });
      const findings = run(
        {},
        { recovery_readiness: { status: "warning_overreach", confidence: 0.75, drivers: [], recommendation: "consider_deload", narrative: "Overreach." } },
        responsiveness,
      );
      const flag = findings.find((f) => f.type === "goal_vs_recovery");
      expect(flag).toBeDefined();
      if (flag?.type === "goal_vs_recovery") {
        expect(flag.responsiveness_note).toBeDefined();
        expect(flag.responsiveness_note).toContain("reactive deload");
      }
    });

    it("does NOT include responsiveness_note when rollup is empty", () => {
      const findings = run(
        {},
        { recovery_readiness: { status: "warning_overreach", confidence: 0.75, drivers: [], recommendation: "consider_deload", narrative: "Overreach." } },
        makeResponsiveness(), // empty rollup
      );
      const flag = findings.find((f) => f.type === "goal_vs_recovery");
      expect(flag).toBeDefined();
      if (flag?.type === "goal_vs_recovery") {
        expect(flag.responsiveness_note).toBeUndefined();
      }
    });

    it("fires even when responsiveness is null (null does not suppress)", () => {
      const findings = run(
        {},
        { recovery_readiness: { status: "warning_overreach", confidence: 0.75, drivers: [], recommendation: "consider_deload", narrative: "Overreach." } },
        null, // no responsiveness data
      );
      expect(types(findings)).toContain("goal_vs_recovery");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // deficit_vs_muscle_loss
  // ─────────────────────────────────────────────────────────────────────────

  describe("deficit_vs_muscle_loss", () => {
    it("fires when phase=cut AND predicted_muscle_loss_risk=high", () => {
      const findings = run(
        { nutrition: { current_phase: "cut", current_kcal: 2000, current_macros: { protein_g: 100, carb_g: 200, fat_g: 60 }, tracking_experience: "consistent", restrictions: "", alcohol_drinks_per_week: 1, caffeine_mg_per_day: 200, supplements: "" } },
        {
          nutrition_performance: {
            protein_status: "critically_low",
            carb_timing_suboptimal: false,
            deficit_severity: "unsustainable",
            predicted_muscle_loss_risk: "high",
            drivers: ["Protein critically low"],
            narrative: "High muscle-loss risk.",
          },
        },
      );
      expect(types(findings)).toContain("deficit_vs_muscle_loss");
    });

    it("fires when phase=cut AND body_comp_direction=losing_muscle", () => {
      const findings = run(
        { nutrition: { current_phase: "cut", current_kcal: 2000, current_macros: { protein_g: 130, carb_g: 200, fat_g: 60 }, tracking_experience: "consistent", restrictions: "", alcohol_drinks_per_week: 1, caffeine_mg_per_day: 200, supplements: "" } },
        {
          nutrition_performance: {
            protein_status: "marginally_short",
            carb_timing_suboptimal: false,
            deficit_severity: "aggressive_sustainable",
            predicted_muscle_loss_risk: "moderate", // not "high"
            drivers: [],
            narrative: "Moderate risk.",
          },
          body_comp_direction: {
            direction: "losing_muscle", // conclusive
            confidence: 0.75,
            weeks_of_data: 4,
            weight_trend_kg_per_week: -0.4,
            bodyfat_trend_pct_per_week: 0.0,
            lift_trend: "declining",
            drivers: ["Lift e1RM declining"],
            narrative: "Losing muscle.",
          },
        },
      );
      expect(types(findings)).toContain("deficit_vs_muscle_loss");
    });

    it("is silent when phase is not cut (maintain)", () => {
      const findings = run(
        { nutrition: { current_phase: "maintain", current_kcal: 2200, current_macros: { protein_g: 100, carb_g: 220, fat_g: 70 }, tracking_experience: "consistent", restrictions: "", alcohol_drinks_per_week: 1, caffeine_mg_per_day: 200, supplements: "" } },
        {
          nutrition_performance: {
            protein_status: "critically_low",
            carb_timing_suboptimal: false,
            deficit_severity: "not_in_deficit",
            predicted_muscle_loss_risk: "high",
            drivers: [],
            narrative: "High risk.",
          },
        },
      );
      expect(types(findings)).not.toContain("deficit_vs_muscle_loss");
    });

    it("is silent when predicted_muscle_loss_risk is only moderate AND direction is not losing_muscle", () => {
      const findings = run(
        {},
        {
          nutrition_performance: {
            protein_status: "marginally_short",
            carb_timing_suboptimal: false,
            deficit_severity: "aggressive_sustainable",
            predicted_muscle_loss_risk: "moderate",
            drivers: [],
            narrative: "Moderate risk.",
          },
          body_comp_direction: {
            direction: "neutral",
            confidence: 0.5,
            weeks_of_data: 2,
            weight_trend_kg_per_week: 0,
            bodyfat_trend_pct_per_week: 0,
            lift_trend: "flat",
            drivers: [],
            narrative: "Neutral.",
          },
        },
      );
      expect(types(findings)).not.toContain("deficit_vs_muscle_loss");
    });

    it("is silent when body_comp_direction is unknown (not conclusive)", () => {
      const findings = run(
        {},
        {
          nutrition_performance: {
            protein_status: "adequate",
            carb_timing_suboptimal: false,
            deficit_severity: "appropriate",
            predicted_muscle_loss_risk: "low",
            drivers: [],
            narrative: "Low risk.",
          },
          body_comp_direction: {
            direction: "unknown",
            confidence: 0.2,
            weeks_of_data: 0,
            weight_trend_kg_per_week: null,
            bodyfat_trend_pct_per_week: null,
            lift_trend: "insufficient_data",
            drivers: [],
            narrative: "Unknown.",
          },
        },
      );
      expect(types(findings)).not.toContain("deficit_vs_muscle_loss");
    });

    it("is NOT re-emitted when already resolved", () => {
      const findings = run(
        {
          nutrition: { current_phase: "cut", current_kcal: 2000, current_macros: { protein_g: 100, carb_g: 200, fat_g: 60 }, tracking_experience: "consistent", restrictions: "", alcohol_drinks_per_week: 1, caffeine_mg_per_day: 200, supplements: "" },
          plan_flag_resolutions: { deficit_vs_muscle_loss: "override" },
        },
        {
          nutrition_performance: {
            protein_status: "critically_low",
            carb_timing_suboptimal: false,
            deficit_severity: "unsustainable",
            predicted_muscle_loss_risk: "high",
            drivers: [],
            narrative: "High risk.",
          },
        },
      );
      expect(types(findings)).not.toContain("deficit_vs_muscle_loss");
    });

    it("proposed_protein_floor_g_per_kg is 1.8", () => {
      const findings = run(
        { nutrition: { current_phase: "cut", current_kcal: 2000, current_macros: { protein_g: 100, carb_g: 200, fat_g: 60 }, tracking_experience: "consistent", restrictions: "", alcohol_drinks_per_week: 1, caffeine_mg_per_day: 200, supplements: "" } },
        {
          nutrition_performance: {
            protein_status: "critically_low",
            carb_timing_suboptimal: false,
            deficit_severity: "unsustainable",
            predicted_muscle_loss_risk: "high",
            drivers: [],
            narrative: "High risk.",
          },
        },
      );
      const flag = findings.find((f) => f.type === "deficit_vs_muscle_loss");
      if (flag?.type === "deficit_vs_muscle_loss") {
        expect(flag.proposed_protein_floor_g_per_kg).toBe(1.8);
      }
    });

    it("includes responsiveness_note when nutrition_change high_roi present", () => {
      const responsiveness = makeResponsiveness({
        high_roi: ["nutrition changes: 2/2 recovered"],
      });
      const findings = run(
        { nutrition: { current_phase: "cut", current_kcal: 2000, current_macros: { protein_g: 100, carb_g: 200, fat_g: 60 }, tracking_experience: "consistent", restrictions: "", alcohol_drinks_per_week: 1, caffeine_mg_per_day: 200, supplements: "" } },
        {
          nutrition_performance: {
            protein_status: "critically_low",
            carb_timing_suboptimal: false,
            deficit_severity: "unsustainable",
            predicted_muscle_loss_risk: "high",
            drivers: [],
            narrative: "High risk.",
          },
        },
        responsiveness,
      );
      const flag = findings.find((f) => f.type === "deficit_vs_muscle_loss");
      expect(flag).toBeDefined();
      if (flag?.type === "deficit_vs_muscle_loss") {
        expect(flag.responsiveness_note).toBeDefined();
        expect(flag.responsiveness_note).toContain("nutrition change");
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // target_vs_adherence
  // ─────────────────────────────────────────────────────────────────────────

  describe("target_vs_adherence", () => {
    it("fires when protein_status === 'critically_low'", () => {
      const findings = run(
        {},
        {
          nutrition_performance: {
            protein_status: "critically_low",
            carb_timing_suboptimal: false,
            deficit_severity: "appropriate",
            predicted_muscle_loss_risk: "moderate",
            drivers: ["Protein critically low"],
            narrative: "Critically low protein.",
          },
        },
      );
      expect(types(findings)).toContain("target_vs_adherence");
    });

    it("fires when protein_status === 'marginally_short'", () => {
      const findings = run(
        {},
        {
          nutrition_performance: {
            protein_status: "marginally_short",
            carb_timing_suboptimal: false,
            deficit_severity: "appropriate",
            predicted_muscle_loss_risk: "low",
            drivers: [],
            narrative: "Marginally short protein.",
          },
        },
      );
      expect(types(findings)).toContain("target_vs_adherence");
    });

    it("is silent when protein_status === 'adequate'", () => {
      const findings = run(
        {},
        {
          nutrition_performance: {
            protein_status: "adequate",
            carb_timing_suboptimal: false,
            deficit_severity: "appropriate",
            predicted_muscle_loss_risk: "low",
            drivers: [],
            narrative: "Protein adequate.",
          },
        },
      );
      expect(types(findings)).not.toContain("target_vs_adherence");
    });

    it("is NOT re-emitted when already resolved", () => {
      const findings = run(
        { plan_flag_resolutions: { target_vs_adherence: "accept" } },
        {
          nutrition_performance: {
            protein_status: "critically_low",
            carb_timing_suboptimal: false,
            deficit_severity: "appropriate",
            predicted_muscle_loss_risk: "moderate",
            drivers: [],
            narrative: "Low protein.",
          },
        },
      );
      expect(types(findings)).not.toContain("target_vs_adherence");
    });

    it("target_field is 'protein_g'", () => {
      const findings = run(
        {},
        {
          nutrition_performance: {
            protein_status: "critically_low",
            carb_timing_suboptimal: false,
            deficit_severity: "appropriate",
            predicted_muscle_loss_risk: "moderate",
            drivers: [],
            narrative: "Low protein.",
          },
        },
      );
      const flag = findings.find((f) => f.type === "target_vs_adherence");
      if (flag?.type === "target_vs_adherence") {
        expect(flag.target_field).toBe("protein_g");
        expect(flag.proposed_ramp_weeks).toBe(3);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // strength_endurance_interference
  // ─────────────────────────────────────────────────────────────────────────

  describe("strength_endurance_interference", () => {
    it("fires when interference_level === 'high'", () => {
      const findings = run(
        {},
        {
          interference: {
            interference_level: "high",
            tss_ratio_7d_28d: 1.6,
            lift_trend: "flat",
            action: "reduce_endurance_volume",
            drivers: ["Endurance load up 60%"],
            narrative: "High interference — reduce Z2 volume.",
          },
        },
      );
      expect(types(findings)).toContain("strength_endurance_interference");
    });

    it("fires when interference_level === 'mild'", () => {
      const findings = run(
        {},
        {
          interference: {
            interference_level: "mild",
            tss_ratio_7d_28d: 1.3,
            lift_trend: "flat",
            action: "monitor",
            drivers: ["Endurance load up 30%"],
            narrative: "Mild interference — monitor.",
          },
        },
      );
      expect(types(findings)).toContain("strength_endurance_interference");
    });

    it("is silent when interference_level === 'none'", () => {
      const findings = run(
        {},
        {
          interference: {
            interference_level: "none",
            tss_ratio_7d_28d: 0.9,
            lift_trend: "progressing",
            action: null,
            drivers: [],
            narrative: "No interference.",
          },
        },
      );
      expect(types(findings)).not.toContain("strength_endurance_interference");
    });

    it("proposed_strength_volume_pct is 0.85 for high interference", () => {
      const findings = run(
        {},
        {
          interference: {
            interference_level: "high",
            tss_ratio_7d_28d: 1.6,
            lift_trend: "flat",
            action: "reduce_endurance_volume",
            drivers: [],
            narrative: "High interference.",
          },
        },
      );
      const flag = findings.find((f) => f.type === "strength_endurance_interference");
      if (flag?.type === "strength_endurance_interference") {
        expect(flag.proposed_strength_volume_pct).toBe(0.85);
        expect(flag.interference_level).toBe("high");
      }
    });

    it("proposed_strength_volume_pct is 0.9 for mild interference", () => {
      const findings = run(
        {},
        {
          interference: {
            interference_level: "mild",
            tss_ratio_7d_28d: 1.3,
            lift_trend: "flat",
            action: "monitor",
            drivers: [],
            narrative: "Mild interference.",
          },
        },
      );
      const flag = findings.find((f) => f.type === "strength_endurance_interference");
      if (flag?.type === "strength_endurance_interference") {
        expect(flag.proposed_strength_volume_pct).toBe(0.9);
        expect(flag.interference_level).toBe("mild");
      }
    });

    it("is NOT re-emitted when already resolved", () => {
      const findings = run(
        { plan_flag_resolutions: { strength_endurance_interference: "override" } },
        {
          interference: {
            interference_level: "high",
            tss_ratio_7d_28d: 1.6,
            lift_trend: "flat",
            action: "reduce_endurance_volume",
            drivers: [],
            narrative: "High interference.",
          },
        },
      );
      expect(types(findings)).not.toContain("strength_endurance_interference");
    });

    it("includes responsiveness_note when exercise_swap high_roi present", () => {
      const responsiveness = makeResponsiveness({
        high_roi: ["exercise swaps: 3/3 recovered"],
      });
      const findings = run(
        {},
        {
          interference: {
            interference_level: "mild",
            tss_ratio_7d_28d: 1.3,
            lift_trend: "flat",
            action: "monitor",
            drivers: [],
            narrative: "Mild interference.",
          },
        },
        responsiveness,
      );
      const flag = findings.find((f) => f.type === "strength_endurance_interference");
      expect(flag).toBeDefined();
      if (flag?.type === "strength_endurance_interference") {
        expect(flag.responsiveness_note).toBeDefined();
        expect(flag.responsiveness_note).toContain("exercise swap");
      }
    });

    it("does NOT include responsiveness_note when rollup is empty", () => {
      const findings = run(
        {},
        {
          interference: {
            interference_level: "mild",
            tss_ratio_7d_28d: 1.3,
            lift_trend: "flat",
            action: "monitor",
            drivers: [],
            narrative: "Mild interference.",
          },
        },
        makeResponsiveness(),
      );
      const flag = findings.find((f) => f.type === "strength_endurance_interference");
      if (flag?.type === "strength_endurance_interference") {
        expect(flag.responsiveness_note).toBeUndefined();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Multiple flags can fire simultaneously
  // ─────────────────────────────────────────────────────────────────────────

  describe("multiple flags", () => {
    it("can fire all four flags simultaneously when all conditions are met", () => {
      const findings = run(
        {
          nutrition: {
            current_phase: "cut",
            current_kcal: 2000,
            current_macros: { protein_g: 100, carb_g: 200, fat_g: 60 },
            tracking_experience: "consistent",
            restrictions: "",
            alcohol_drinks_per_week: 1,
            caffeine_mg_per_day: 200,
            supplements: "",
          },
        },
        {
          recovery_readiness: {
            status: "warning_overreach",
            confidence: 0.8,
            drivers: [],
            recommendation: "consider_deload",
            narrative: "Overreach.",
          },
          nutrition_performance: {
            protein_status: "critically_low",
            carb_timing_suboptimal: false,
            deficit_severity: "unsustainable",
            predicted_muscle_loss_risk: "high",
            drivers: [],
            narrative: "High risk.",
          },
          interference: {
            interference_level: "high",
            tss_ratio_7d_28d: 1.7,
            lift_trend: "declining",
            action: "reduce_endurance_volume",
            drivers: [],
            narrative: "High interference.",
          },
          body_comp_direction: {
            direction: "neutral",
            confidence: 0.5,
            weeks_of_data: 3,
            weight_trend_kg_per_week: -0.1,
            bodyfat_trend_pct_per_week: 0.0,
            lift_trend: "flat",
            drivers: [],
            narrative: "Neutral.",
          },
        },
      );
      expect(types(findings)).toContain("goal_vs_recovery");
      expect(types(findings)).toContain("deficit_vs_muscle_loss");
      expect(types(findings)).toContain("target_vs_adherence");
      expect(types(findings)).toContain("strength_endurance_interference");
    });

    it("only fires unresolved flags when some are already resolved", () => {
      const findings = run(
        {
          nutrition: {
            current_phase: "cut",
            current_kcal: 2000,
            current_macros: { protein_g: 100, carb_g: 200, fat_g: 60 },
            tracking_experience: "consistent",
            restrictions: "",
            alcohol_drinks_per_week: 1,
            caffeine_mg_per_day: 200,
            supplements: "",
          },
          plan_flag_resolutions: {
            goal_vs_recovery: "accept",
            deficit_vs_muscle_loss: "override",
          },
        },
        {
          recovery_readiness: { status: "warning_overreach", confidence: 0.8, drivers: [], recommendation: "consider_deload", narrative: "Overreach." },
          nutrition_performance: { protein_status: "critically_low", carb_timing_suboptimal: false, deficit_severity: "unsustainable", predicted_muscle_loss_risk: "high", drivers: [], narrative: "High risk." },
          interference: { interference_level: "high", tss_ratio_7d_28d: 1.7, lift_trend: "declining", action: "reduce_endurance_volume", drivers: [], narrative: "High interference." },
        },
      );
      const flagTypes = types(findings);
      expect(flagTypes).not.toContain("goal_vs_recovery");
      expect(flagTypes).not.toContain("deficit_vs_muscle_loss");
      expect(flagTypes).toContain("target_vs_adherence");
      expect(flagTypes).toContain("strength_endurance_interference");
    });

    it("returns [] when all conditions are clean (all-clear intelligence)", () => {
      const findings = run();
      // Default intake has current_phase=cut but nutrition_performance has risk=low
      // and protein_status=adequate, interference=none, recovery=recovering_well
      // Only deficit_vs_muscle_loss depends on phase=cut AND high risk/losing_muscle
      // → with all-clear intelligence, no flags should fire
      expect(types(findings)).not.toContain("goal_vs_recovery");
      expect(types(findings)).not.toContain("deficit_vs_muscle_loss");
      expect(types(findings)).not.toContain("target_vs_adherence");
      expect(types(findings)).not.toContain("strength_endurance_interference");
    });
  });
});
