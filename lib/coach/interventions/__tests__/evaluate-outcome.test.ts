// lib/coach/interventions/__tests__/evaluate-outcome.test.ts
//
// TDD tests for evaluate-outcome.ts — written before implementation.
// Run: npx vitest run lib/coach/interventions/__tests__/evaluate-outcome.test.ts

import { describe, it, expect } from "vitest";
import {
  OUTCOME_WINDOWS,
  windowClosed,
  evaluateDeloadOutcome,
  evaluateSwapOutcome,
  evaluateNutritionOutcome,
  type DeloadEvalCtx,
  type SwapEvalCtx,
  type NutritionEvalCtx,
} from "../evaluate-outcome";
import type { CoachInterventionRow, MetricBaseline } from "@/lib/data/types";

// ── Shared helpers ─────────────────────────────────────────────────────────────

function makeRow(
  kind: CoachInterventionRow["kind"],
  started_on: string,
  context: Record<string, unknown> = {},
): CoachInterventionRow {
  return {
    id: "row-test-1",
    user_id: "user-test-1",
    kind,
    source: "explicit",
    started_on,
    context,
    outcome: null,
    outcome_evaluated_at: null,
    created_at: started_on + "T00:00:00Z",
  };
}

function makeBaseline(mean: number, sd: number): MetricBaseline {
  return { mean, sd, days: 30, status: "stable" };
}

function makeEstablishingBaseline(): MetricBaseline {
  return { mean: null, sd: null, days: 5, status: "establishing" };
}

// ── OUTCOME_WINDOWS ────────────────────────────────────────────────────────────

describe("OUTCOME_WINDOWS", () => {
  it("has correct window days for each intervention kind", () => {
    expect(OUTCOME_WINDOWS.reactive_deload).toBe(10);
    expect(OUTCOME_WINDOWS.exercise_swap).toBe(14);
    expect(OUTCOME_WINDOWS.nutrition_change).toBe(14);
  });
});

// ── windowClosed ───────────────────────────────────────────────────────────────

describe("windowClosed", () => {
  it("returns false when today is before window end", () => {
    const row = makeRow("reactive_deload", "2026-06-10");
    // Window = 10 days → closes on 2026-06-20. Today = 2026-06-19 → still open.
    expect(windowClosed(row, "2026-06-19")).toBe(false);
  });

  it("returns true when today equals the window end date", () => {
    const row = makeRow("reactive_deload", "2026-06-10");
    // 2026-06-10 + 10 days = 2026-06-20
    expect(windowClosed(row, "2026-06-20")).toBe(true);
  });

  it("returns true when today is after window end", () => {
    const row = makeRow("exercise_swap", "2026-06-01");
    // 2026-06-01 + 14 days = 2026-06-15. Today = 2026-06-26 → closed.
    expect(windowClosed(row, "2026-06-26")).toBe(true);
  });

  it("returns false on trigger day itself (window = 14d, same day)", () => {
    const row = makeRow("nutrition_change", "2026-06-10");
    // Day 0 — window hasn't started closing yet
    expect(windowClosed(row, "2026-06-10")).toBe(false);
  });
});

// ── evaluateDeloadOutcome ──────────────────────────────────────────────────────

describe("evaluateDeloadOutcome — success case", () => {
  it("returns success=true when HRV returns to baseline AND lift doesn't regress", () => {
    const row = makeRow("reactive_deload", "2026-06-10", { trigger: "low_hrv" });

    // HRV baseline: mean=65, sd=8. Back-to-baseline = within 0.5×8=4ms of 65 (i.e. >=61).
    const hrv_baseline = makeBaseline(65, 8);

    const ctx: DeloadEvalCtx = {
      triggered_at: "2026-06-10",
      daily_logs: [
        { date: "2026-06-10", hrv: 45, recovery: 28 },
        { date: "2026-06-11", hrv: 52, recovery: 35 },
        { date: "2026-06-12", hrv: 58, recovery: 48 },
        { date: "2026-06-13", hrv: 62, recovery: 60 }, // back to baseline (hrv_recovery_days = 3)
        { date: "2026-06-14", hrv: 66, recovery: 72 },
        { date: "2026-06-15", hrv: 64, recovery: 68 },
      ],
      workouts_before: [
        { date: "2026-06-08", exercise: "Deadlift (Barbell)", kg: 130, reps: 5, warmup: false },
      ],
      workouts_after: [
        { date: "2026-06-16", exercise: "Deadlift (Barbell)", kg: 132, reps: 5, warmup: false },
      ],
      hrv_baseline,
      recovery_baseline: makeBaseline(60, 10),
    };

    const result = evaluateDeloadOutcome(row, ctx);
    expect(result.success).toBe(true);
    expect(result.hrv_recovery_days).toBe(3);
    expect(result.performance_resumed).toBe(true);
  });
});

describe("evaluateDeloadOutcome — failure case", () => {
  it("returns success=false when HRV never returns to baseline in window", () => {
    const row = makeRow("reactive_deload", "2026-06-10", { trigger: "low_hrv" });
    const hrv_baseline = makeBaseline(65, 8);

    const ctx: DeloadEvalCtx = {
      triggered_at: "2026-06-10",
      daily_logs: [
        { date: "2026-06-10", hrv: 42, recovery: 25 },
        { date: "2026-06-11", hrv: 44, recovery: 28 },
        { date: "2026-06-12", hrv: 40, recovery: 22 },
        { date: "2026-06-13", hrv: 43, recovery: 26 },
        { date: "2026-06-14", hrv: 41, recovery: 24 },
        { date: "2026-06-15", hrv: 45, recovery: 30 },
        { date: "2026-06-16", hrv: 43, recovery: 28 },
        { date: "2026-06-17", hrv: 42, recovery: 25 },
        { date: "2026-06-18", hrv: 44, recovery: 27 },
        { date: "2026-06-19", hrv: 43, recovery: 26 },
      ],
      workouts_before: [
        { date: "2026-06-08", exercise: "Deadlift (Barbell)", kg: 130, reps: 5, warmup: false },
      ],
      workouts_after: [
        { date: "2026-06-18", exercise: "Deadlift (Barbell)", kg: 130, reps: 5, warmup: false },
      ],
      hrv_baseline,
      recovery_baseline: makeBaseline(60, 10),
    };

    const result = evaluateDeloadOutcome(row, ctx);
    expect(result.success).toBe(false);
    expect(result.hrv_recovery_days).toBeNull();
  });
});

describe("evaluateDeloadOutcome — inconclusive case (sparse HRV)", () => {
  it("returns success=null when fewer than 3 days of HRV data in window", () => {
    const row = makeRow("reactive_deload", "2026-06-10", { trigger: "low_hrv" });
    const hrv_baseline = makeBaseline(65, 8);

    const ctx: DeloadEvalCtx = {
      triggered_at: "2026-06-10",
      // Only 2 HRV data points — insufficient
      daily_logs: [
        { date: "2026-06-10", hrv: 45, recovery: 28 },
        { date: "2026-06-14", hrv: 63, recovery: 58 },
      ],
      workouts_before: [],
      workouts_after: [],
      hrv_baseline,
      recovery_baseline: makeBaseline(60, 10),
    };

    const result = evaluateDeloadOutcome(row, ctx);
    expect(result.success).toBeNull();
    expect(result.hrv_recovery_days).toBeNull();
    expect(result.performance_resumed).toBe(false);
  });

  it("returns success=null when no baseline available", () => {
    const row = makeRow("reactive_deload", "2026-06-10", { trigger: "low_hrv" });

    const ctx: DeloadEvalCtx = {
      triggered_at: "2026-06-10",
      daily_logs: [
        { date: "2026-06-10", hrv: 45, recovery: 28 },
        { date: "2026-06-11", hrv: 52, recovery: 35 },
        { date: "2026-06-12", hrv: 58, recovery: 48 },
        { date: "2026-06-13", hrv: 62, recovery: 60 },
      ],
      workouts_before: [],
      workouts_after: [],
      hrv_baseline: makeEstablishingBaseline(), // no baseline yet
      recovery_baseline: null,
    };

    const result = evaluateDeloadOutcome(row, ctx);
    expect(result.success).toBeNull();
  });
});

describe("evaluateDeloadOutcome — lift regression prevents success", () => {
  it("returns success=false when HRV recovers but lift regressed", () => {
    const row = makeRow("reactive_deload", "2026-06-10", { trigger: "low_hrv" });
    const hrv_baseline = makeBaseline(65, 8);

    const ctx: DeloadEvalCtx = {
      triggered_at: "2026-06-10",
      daily_logs: [
        { date: "2026-06-10", hrv: 45, recovery: 28 },
        { date: "2026-06-11", hrv: 55, recovery: 45 },
        { date: "2026-06-12", hrv: 62, recovery: 58 },
        { date: "2026-06-13", hrv: 64, recovery: 62 },
      ],
      workouts_before: [
        { date: "2026-06-08", exercise: "Deadlift (Barbell)", kg: 140, reps: 5, warmup: false },
      ],
      workouts_after: [
        // Post-deload lift is meaningfully lower: 120 kg (14% regression)
        { date: "2026-06-16", exercise: "Deadlift (Barbell)", kg: 120, reps: 5, warmup: false },
      ],
      hrv_baseline,
      recovery_baseline: makeBaseline(60, 10),
    };

    const result = evaluateDeloadOutcome(row, ctx);
    expect(result.success).toBe(false);
    // HRV recovered on day 2 (2026-06-12)
    expect(result.hrv_recovery_days).toBe(2);
    expect(result.performance_resumed).toBe(false);
  });
});

// ── evaluateSwapOutcome ────────────────────────────────────────────────────────

describe("evaluateSwapOutcome — success case", () => {
  it("returns success=true when pain resolved AND replacement progressed", () => {
    const row = makeRow("exercise_swap", "2026-06-10", {
      from_exercise: "Romanian Deadlift",
      to_exercise: "Hip Thrust (Machine)",
      reason: "pain",
    });

    const ctx: SwapEvalCtx = {
      triggered_at: "2026-06-10",
      soreness_checkins: [
        { date: "2026-06-11", areas: ["shoulders"] },
        { date: "2026-06-13", areas: [] },
        { date: "2026-06-15", areas: ["shoulders"] },
        { date: "2026-06-17", areas: [] },
      ],
      swapped_muscle_area: "hamstrings",
      baseline_sets: [
        { date: "2026-06-10", exercise: "Hip Thrust (Machine)", kg: 80, reps: 10, warmup: false },
      ],
      post_swap_sets: [
        { date: "2026-06-17", exercise: "Hip Thrust (Machine)", kg: 90, reps: 10, warmup: false },
      ],
    };

    const result = evaluateSwapOutcome(row, ctx);
    expect(result.success).toBe(true);
    expect(result.pain_resolved).toBe(true);
    expect(result.swap_stuck).toBe(false);
  });
});

describe("evaluateSwapOutcome — failure case (pain persists)", () => {
  it("returns success=false when pain area keeps appearing post-swap", () => {
    const row = makeRow("exercise_swap", "2026-06-10", {
      from_exercise: "Romanian Deadlift",
      to_exercise: "Hip Thrust (Machine)",
      reason: "pain",
    });

    const ctx: SwapEvalCtx = {
      triggered_at: "2026-06-10",
      soreness_checkins: [
        { date: "2026-06-11", areas: ["hamstrings", "lower back"] },
        { date: "2026-06-13", areas: ["hamstrings"] },
        { date: "2026-06-15", areas: ["hamstrings"] },
        { date: "2026-06-17", areas: ["hamstrings"] },
      ],
      swapped_muscle_area: "hamstrings",
      baseline_sets: [
        { date: "2026-06-10", exercise: "Hip Thrust (Machine)", kg: 80, reps: 10, warmup: false },
      ],
      post_swap_sets: [
        { date: "2026-06-17", exercise: "Hip Thrust (Machine)", kg: 82, reps: 10, warmup: false },
      ],
    };

    const result = evaluateSwapOutcome(row, ctx);
    expect(result.success).toBe(false);
    expect(result.pain_resolved).toBe(false);
  });
});

describe("evaluateSwapOutcome — failure case (swap stuck)", () => {
  it("returns success=false when pain resolved but replacement never progressed", () => {
    const row = makeRow("exercise_swap", "2026-06-10", {
      from_exercise: "Romanian Deadlift",
      to_exercise: "Hip Thrust (Machine)",
      reason: "stall",
    });

    const ctx: SwapEvalCtx = {
      triggered_at: "2026-06-10",
      soreness_checkins: [
        { date: "2026-06-11", areas: [] },
        { date: "2026-06-14", areas: [] },
      ],
      swapped_muscle_area: "hamstrings",
      baseline_sets: [
        { date: "2026-06-10", exercise: "Hip Thrust (Machine)", kg: 80, reps: 10, warmup: false },
      ],
      post_swap_sets: [
        { date: "2026-06-17", exercise: "Hip Thrust (Machine)", kg: 80, reps: 10, warmup: false },
      ],
    };

    const result = evaluateSwapOutcome(row, ctx);
    expect(result.success).toBe(false);
    expect(result.pain_resolved).toBe(true);
    expect(result.swap_stuck).toBe(true);
  });
});

describe("evaluateSwapOutcome — inconclusive case", () => {
  it("returns success=null when no workouts were logged in the window", () => {
    const row = makeRow("exercise_swap", "2026-06-10", {
      from_exercise: "Romanian Deadlift",
      to_exercise: "Hip Thrust (Machine)",
      reason: "pain",
    });

    const ctx: SwapEvalCtx = {
      triggered_at: "2026-06-10",
      soreness_checkins: [],
      swapped_muscle_area: "hamstrings",
      baseline_sets: [],
      post_swap_sets: [],
    };

    const result = evaluateSwapOutcome(row, ctx);
    expect(result.success).toBeNull();
    expect(result.pain_resolved).toBe(false);
    expect(result.swap_stuck).toBe(false);
  });

  it("returns success=null when replacement was trained but no post-trigger soreness checkins exist", () => {
    // Regression guard for the fabricated-verdict bug:
    // post_swap_sets non-empty (replacement trained + progressed) but soreness_checkins is empty.
    // Old code: postCheckins=[] → painPersists=false → pain_resolved=true → success:true (FABRICATED).
    // Fixed code: absence of soreness checkins means pain resolution is UNKNOWN → success:null.
    const row = makeRow("exercise_swap", "2026-06-10", {
      from_exercise: "Romanian Deadlift",
      to_exercise: "Hip Thrust (Machine)",
      reason: "pain",
    });

    const ctx: SwapEvalCtx = {
      triggered_at: "2026-06-10",
      soreness_checkins: [], // no morning intake soreness data at all
      swapped_muscle_area: "hamstrings",
      baseline_sets: [
        { date: "2026-06-10", exercise: "Hip Thrust (Machine)", kg: 80, reps: 10, warmup: false },
      ],
      post_swap_sets: [
        // Replacement was trained and progressed — but we have no soreness data
        { date: "2026-06-15", exercise: "Hip Thrust (Machine)", kg: 90, reps: 10, warmup: false },
      ],
    };

    const result = evaluateSwapOutcome(row, ctx);
    // Must be inconclusive — cannot confirm pain resolved with zero soreness checkins
    expect(result.success).toBeNull();
    expect(result.pain_resolved).toBe(false);
  });
});

// ── evaluateNutritionOutcome ───────────────────────────────────────────────────

describe("evaluateNutritionOutcome — protein_increase success", () => {
  it("returns success=true when protein avg improved by >=5g vs 7d baseline", () => {
    const row = makeRow("nutrition_change", "2026-06-10", {
      field: "protein_g",
      sub_kind: "protein_increase",
      from: 120,
      to: 150,
    });

    const ctx: NutritionEvalCtx = {
      triggered_at: "2026-06-10",
      sub_kind: "protein_increase",
      baseline_logs: [
        { date: "2026-06-03", calories_eaten: 1800, protein_g: 115, weight_kg: 103.0 },
        { date: "2026-06-04", calories_eaten: 1900, protein_g: 120, weight_kg: 103.1 },
        { date: "2026-06-05", calories_eaten: 1750, protein_g: 118, weight_kg: 102.9 },
        { date: "2026-06-06", calories_eaten: 1850, protein_g: 116, weight_kg: 103.0 },
        { date: "2026-06-07", calories_eaten: 1900, protein_g: 122, weight_kg: 103.2 },
        { date: "2026-06-08", calories_eaten: 1800, protein_g: 117, weight_kg: 103.0 },
        { date: "2026-06-09", calories_eaten: 1850, protein_g: 118, weight_kg: 103.1 },
      ],
      window_logs: [
        { date: "2026-06-10", calories_eaten: 1900, protein_g: 145, weight_kg: 103.0 },
        { date: "2026-06-11", calories_eaten: 1950, protein_g: 150, weight_kg: 102.9 },
        { date: "2026-06-12", calories_eaten: 2000, protein_g: 148, weight_kg: 103.1 },
        { date: "2026-06-13", calories_eaten: 1850, protein_g: 144, weight_kg: 102.8 },
        { date: "2026-06-14", calories_eaten: 1900, protein_g: 152, weight_kg: 102.7 },
      ],
      caloric_target: 1900,
    };

    const result = evaluateNutritionOutcome(row, ctx);
    expect(result.success).toBe(true);
    expect(result.improved).toBe(true);
    expect(result.signal).toBeTruthy();
  });
});

describe("evaluateNutritionOutcome — protein_increase failure", () => {
  it("returns success=false when protein improved by <5g vs baseline", () => {
    const row = makeRow("nutrition_change", "2026-06-10", {
      field: "protein_g",
      sub_kind: "protein_increase",
      from: 120,
      to: 150,
    });

    const ctx: NutritionEvalCtx = {
      triggered_at: "2026-06-10",
      sub_kind: "protein_increase",
      baseline_logs: [
        { date: "2026-06-03", calories_eaten: 1800, protein_g: 120, weight_kg: 103.0 },
        { date: "2026-06-04", calories_eaten: 1800, protein_g: 120, weight_kg: 103.0 },
        { date: "2026-06-05", calories_eaten: 1800, protein_g: 120, weight_kg: 103.0 },
        { date: "2026-06-06", calories_eaten: 1800, protein_g: 120, weight_kg: 103.0 },
        { date: "2026-06-07", calories_eaten: 1800, protein_g: 120, weight_kg: 103.0 },
      ],
      window_logs: [
        { date: "2026-06-10", calories_eaten: 1800, protein_g: 121, weight_kg: 103.0 },
        { date: "2026-06-11", calories_eaten: 1800, protein_g: 122, weight_kg: 103.0 },
        { date: "2026-06-12", calories_eaten: 1800, protein_g: 122, weight_kg: 103.0 },
        { date: "2026-06-13", calories_eaten: 1800, protein_g: 121, weight_kg: 103.0 },
        { date: "2026-06-14", calories_eaten: 1800, protein_g: 122, weight_kg: 103.0 },
      ],
      caloric_target: 1900,
    };

    const result = evaluateNutritionOutcome(row, ctx);
    expect(result.success).toBe(false);
    expect(result.improved).toBe(false);
  });
});

describe("evaluateNutritionOutcome — caloric_adjustment success", () => {
  it("returns success=true when avg calories within 200kcal of target", () => {
    const row = makeRow("nutrition_change", "2026-06-10", {
      field: "calories_eaten",
      sub_kind: "caloric_adjustment",
      from: 1500,
      to: 1900,
    });

    const ctx: NutritionEvalCtx = {
      triggered_at: "2026-06-10",
      sub_kind: "caloric_adjustment",
      baseline_logs: [],
      window_logs: [
        { date: "2026-06-10", calories_eaten: 1880, protein_g: 130, weight_kg: 103.0 },
        { date: "2026-06-11", calories_eaten: 1920, protein_g: 132, weight_kg: 102.9 },
        { date: "2026-06-12", calories_eaten: 1900, protein_g: 128, weight_kg: 102.8 },
        { date: "2026-06-13", calories_eaten: 1950, protein_g: 131, weight_kg: 102.7 },
        { date: "2026-06-14", calories_eaten: 1870, protein_g: 130, weight_kg: 102.6 },
      ],
      caloric_target: 1900,
    };

    const result = evaluateNutritionOutcome(row, ctx);
    expect(result.success).toBe(true);
    expect(result.improved).toBe(true);
  });
});

describe("evaluateNutritionOutcome — body_comp_improve success", () => {
  it("returns success=true when weight moved in right direction by >=0.3kg", () => {
    const row = makeRow("nutrition_change", "2026-06-10", {
      field: "weight_kg",
      sub_kind: "body_comp_improve",
      from: 103.5,
      to: 102.0,
    });

    const ctx: NutritionEvalCtx = {
      triggered_at: "2026-06-10",
      sub_kind: "body_comp_improve",
      baseline_logs: [
        { date: "2026-06-03", calories_eaten: 1800, protein_g: 120, weight_kg: 103.5 },
        { date: "2026-06-07", calories_eaten: 1800, protein_g: 120, weight_kg: 103.4 },
      ],
      window_logs: [
        { date: "2026-06-10", calories_eaten: 1700, protein_g: 140, weight_kg: 103.2 },
        { date: "2026-06-12", calories_eaten: 1700, protein_g: 138, weight_kg: 103.0 },
        { date: "2026-06-14", calories_eaten: 1700, protein_g: 140, weight_kg: 102.9 },
        { date: "2026-06-16", calories_eaten: 1700, protein_g: 142, weight_kg: 102.7 },
        { date: "2026-06-18", calories_eaten: 1700, protein_g: 140, weight_kg: 102.6 },
      ],
    };

    const result = evaluateNutritionOutcome(row, ctx);
    expect(result.success).toBe(true);
    expect(result.improved).toBe(true);
    expect(result.signal).toBeTruthy();
  });
});

describe("evaluateNutritionOutcome — inconclusive case", () => {
  it("returns success=null when fewer than 5 days of nutrition data in window", () => {
    const row = makeRow("nutrition_change", "2026-06-10", {
      field: "protein_g",
      sub_kind: "protein_increase",
      from: 120,
      to: 150,
    });

    const ctx: NutritionEvalCtx = {
      triggered_at: "2026-06-10",
      sub_kind: "protein_increase",
      baseline_logs: [
        { date: "2026-06-03", calories_eaten: 1800, protein_g: 120, weight_kg: 103.0 },
        { date: "2026-06-04", calories_eaten: 1800, protein_g: 118, weight_kg: 103.0 },
        { date: "2026-06-05", calories_eaten: 1800, protein_g: 122, weight_kg: 103.0 },
        { date: "2026-06-06", calories_eaten: 1800, protein_g: 119, weight_kg: 103.0 },
        { date: "2026-06-07", calories_eaten: 1800, protein_g: 121, weight_kg: 103.0 },
      ],
      // Only 4 days of data in window — insufficient (need >= 5)
      window_logs: [
        { date: "2026-06-10", calories_eaten: 1900, protein_g: 148, weight_kg: 103.0 },
        { date: "2026-06-12", calories_eaten: 1900, protein_g: 150, weight_kg: 102.9 },
        { date: "2026-06-14", calories_eaten: 1900, protein_g: 145, weight_kg: 102.8 },
        { date: "2026-06-16", calories_eaten: 1900, protein_g: 147, weight_kg: 102.7 },
      ],
      caloric_target: 1900,
    };

    const result = evaluateNutritionOutcome(row, ctx);
    expect(result.success).toBeNull();
    expect(result.signal).toBeTruthy();
  });
});

describe("evaluateNutritionOutcome — unsorted input handled correctly", () => {
  it("produces consistent results regardless of log entry order", () => {
    const row = makeRow("nutrition_change", "2026-06-10", {
      field: "protein_g",
      sub_kind: "protein_increase",
      from: 120,
      to: 150,
    });

    const baselineLogs = [
      { date: "2026-06-03", calories_eaten: 1800, protein_g: 120, weight_kg: 103.0 },
      { date: "2026-06-04", calories_eaten: 1800, protein_g: 118, weight_kg: 103.0 },
      { date: "2026-06-05", calories_eaten: 1800, protein_g: 122, weight_kg: 103.0 },
      { date: "2026-06-06", calories_eaten: 1800, protein_g: 119, weight_kg: 103.0 },
      { date: "2026-06-07", calories_eaten: 1800, protein_g: 121, weight_kg: 103.0 },
    ];

    const windowLogs = [
      { date: "2026-06-10", calories_eaten: 1900, protein_g: 150, weight_kg: 102.8 },
      { date: "2026-06-11", calories_eaten: 1900, protein_g: 145, weight_kg: 102.9 },
      { date: "2026-06-12", calories_eaten: 1900, protein_g: 148, weight_kg: 102.7 },
      { date: "2026-06-13", calories_eaten: 1900, protein_g: 152, weight_kg: 102.6 },
      { date: "2026-06-14", calories_eaten: 1900, protein_g: 146, weight_kg: 102.5 },
    ];

    const ctx1: NutritionEvalCtx = {
      triggered_at: "2026-06-10",
      sub_kind: "protein_increase",
      baseline_logs: baselineLogs,
      window_logs: windowLogs,
      caloric_target: 1900,
    };

    const ctx2: NutritionEvalCtx = {
      triggered_at: "2026-06-10",
      sub_kind: "protein_increase",
      baseline_logs: [...baselineLogs].reverse(),
      window_logs: [...windowLogs].reverse(),
      caloric_target: 1900,
    };

    const r1 = evaluateNutritionOutcome(row, ctx1);
    const r2 = evaluateNutritionOutcome(row, ctx2);
    expect(r1.success).toBe(r2.success);
    expect(r1.improved).toBe(r2.improved);
  });
});
