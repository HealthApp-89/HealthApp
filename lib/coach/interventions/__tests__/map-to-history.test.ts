// lib/coach/interventions/__tests__/map-to-history.test.ts
//
// Tests for mapToHistory() — the pure mapper from CoachInterventionRow[]
// to HistoryPayload.
//
// Covers:
//   - Valid mappings for each intervention kind
//   - Inconclusive rows (success: null) are dropped
//   - Array caps respected (max 5 / 10 / 6)
//   - Most-recent first ordering within each kind
//   - Output validates against HistoryPayloadSchema
//   - Empty input returns empty arrays
//   - Rows with null outcome are dropped
//
// Run via: npx vitest run lib/coach/interventions/__tests__/map-to-history.test.ts

import { describe, it, expect } from "vitest";
import { mapToHistory } from "../map-to-history";
import { HistoryPayloadSchema } from "@/lib/coach/intelligence/types";
import type { CoachInterventionRow } from "@/lib/data/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeDeloadRow(overrides: Partial<CoachInterventionRow> = {}): CoachInterventionRow {
  return {
    id: "row-deload-1",
    user_id: "user-1",
    kind: "reactive_deload",
    source: "inferred",
    started_on: "2026-06-01",
    context: { trigger: "low_hrv", block_id: null, block_phase: null, block_week: null },
    outcome: { success: true, hrv_recovery_days: 4, performance_resumed: true },
    outcome_evaluated_at: "2026-06-11T00:00:00Z",
    created_at: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

function makeSwapRow(overrides: Partial<CoachInterventionRow> = {}): CoachInterventionRow {
  return {
    id: "row-swap-1",
    user_id: "user-1",
    kind: "exercise_swap",
    source: "explicit",
    started_on: "2026-06-05",
    context: {
      from_exercise: "Romanian Deadlift (RDL)",
      to_exercise: "Leg Curl (Machine)",
      reason: "pain",
      block_id: null,
      block_phase: null,
      block_week: null,
    },
    outcome: { success: true, pain_resolved: true, swap_stuck: false },
    outcome_evaluated_at: "2026-06-19T00:00:00Z",
    created_at: "2026-06-05T00:00:00Z",
    ...overrides,
  };
}

function makeNutritionRow(overrides: Partial<CoachInterventionRow> = {}): CoachInterventionRow {
  return {
    id: "row-nutrition-1",
    user_id: "user-1",
    kind: "nutrition_change",
    source: "explicit",
    started_on: "2026-05-20",
    context: {
      field: "protein_g",
      from: 160,
      to: 200,
      block_id: null,
      block_phase: null,
      block_week: null,
    },
    outcome: {
      success: true,
      signal: "protein avg: 198 g/d (+38 g vs baseline)",
      improved: true,
    },
    outcome_evaluated_at: "2026-06-03T00:00:00Z",
    created_at: "2026-05-20T00:00:00Z",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — empty input
// ─────────────────────────────────────────────────────────────────────────────

describe("mapToHistory — empty input", () => {
  it("returns empty arrays for all kinds", () => {
    const result = mapToHistory([]);
    expect(result.recent_deloads).toEqual([]);
    expect(result.exercise_swaps_8w).toEqual([]);
    expect(result.nutrition_interventions).toEqual([]);
  });

  it("output validates against HistoryPayloadSchema for empty input", () => {
    const result = mapToHistory([]);
    const parsed = HistoryPayloadSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests — reactive_deload mapping
// ─────────────────────────────────────────────────────────────────────────────

describe("mapToHistory — reactive_deload mapping", () => {
  it("maps a successful deload row to DeloadRecord", () => {
    const row = makeDeloadRow();
    const result = mapToHistory([row]);
    expect(result.recent_deloads).toHaveLength(1);
    const record = result.recent_deloads[0];
    expect(record.date).toBe("2026-06-01");
    expect(record.type).toBe("reactive");
    expect(record.hrv_recovery_days).toBe(4);
    expect(record.success).toBe(true);
    expect(record.reason_if_failed).toBeUndefined();
  });

  it("maps a failed deload row and includes reason_if_failed", () => {
    const row = makeDeloadRow({
      outcome: { success: false, hrv_recovery_days: null, performance_resumed: false },
    });
    const result = mapToHistory([row]);
    expect(result.recent_deloads).toHaveLength(1);
    const record = result.recent_deloads[0];
    expect(record.success).toBe(false);
    expect(typeof record.reason_if_failed).toBe("string");
    expect(record.reason_if_failed!.length).toBeGreaterThan(0);
  });

  it("drops deload row when outcome.success is null (inconclusive)", () => {
    const row = makeDeloadRow({
      outcome: { success: null, hrv_recovery_days: null, performance_resumed: false },
    });
    const result = mapToHistory([row]);
    expect(result.recent_deloads).toHaveLength(0);
  });

  it("drops deload row when outcome is null", () => {
    const row = makeDeloadRow({ outcome: null });
    const result = mapToHistory([row]);
    expect(result.recent_deloads).toHaveLength(0);
  });

  it("hrv_recovery_days defaults to 0 when missing from outcome", () => {
    const row = makeDeloadRow({
      outcome: { success: true, performance_resumed: true },
    });
    const result = mapToHistory([row]);
    expect(result.recent_deloads[0].hrv_recovery_days).toBe(0);
  });

  it("sets hrv_recovery_days to 0 if outcome value is null", () => {
    const row = makeDeloadRow({
      outcome: { success: true, hrv_recovery_days: null, performance_resumed: true },
    });
    const result = mapToHistory([row]);
    expect(result.recent_deloads[0].hrv_recovery_days).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests — exercise_swap mapping
// ─────────────────────────────────────────────────────────────────────────────

describe("mapToHistory — exercise_swap mapping", () => {
  it("maps a successful swap (success:true) to result='kept'", () => {
    // The base fixture has success:true, swap_stuck:false — matches real evaluator output.
    // swap_stuck is a failure signal; a kept/successful swap always has swap_stuck:false.
    const row = makeSwapRow();
    const result = mapToHistory([row]);
    expect(result.exercise_swaps_8w).toHaveLength(1);
    const record = result.exercise_swaps_8w[0];
    expect(record.from).toBe("Romanian Deadlift (RDL)");
    expect(record.to).toBe("Leg Curl (Machine)");
    expect(record.reason).toBe("pain");
    // success:true → result = "kept" (athlete adopted the replacement)
    expect(record.result).toBe("kept");
    expect(record.date).toBe("2026-06-05");
  });

  it("maps a failed swap (success:false, swap_stuck:true) to result='reverted'", () => {
    // swap_stuck:true means the replacement did NOT progress — a genuine failure row.
    // The old inverted mapping would have returned "kept" here, which was wrong.
    const row = makeSwapRow({
      outcome: { success: false, pain_resolved: false, swap_stuck: true },
    });
    const result = mapToHistory([row]);
    expect(result.exercise_swaps_8w[0].result).toBe("reverted");
  });

  it("drops swap row when outcome.success is null (inconclusive)", () => {
    const row = makeSwapRow({
      outcome: { success: null, pain_resolved: false, swap_stuck: false },
    });
    const result = mapToHistory([row]);
    expect(result.exercise_swaps_8w).toHaveLength(0);
  });

  it("drops swap row when outcome is null", () => {
    const row = makeSwapRow({ outcome: null });
    const result = mapToHistory([row]);
    expect(result.exercise_swaps_8w).toHaveLength(0);
  });

  it("maps a failed swap (success:false, swap_stuck:false) to result='reverted'", () => {
    // success:false is the decisive signal — result is "reverted" regardless of swap_stuck.
    const row = makeSwapRow({
      outcome: { success: false, pain_resolved: false, swap_stuck: false },
    });
    const result = mapToHistory([row]);
    expect(result.exercise_swaps_8w).toHaveLength(1);
    expect(result.exercise_swaps_8w[0].result).toBe("reverted");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests — nutrition_change mapping
// ─────────────────────────────────────────────────────────────────────────────

describe("mapToHistory — nutrition_change mapping", () => {
  it("maps a successful nutrition change to NutritionIntervention", () => {
    const row = makeNutritionRow();
    const result = mapToHistory([row]);
    expect(result.nutrition_interventions).toHaveLength(1);
    const record = result.nutrition_interventions[0];
    expect(record.intervention).toBe("protein_g: 160 → 200");
    expect(record.duration_weeks).toBe(2); // 14d / 7
    expect(record.effect_measured).toBe("protein avg: 198 g/d (+38 g vs baseline)");
    expect(record.effect_value).toBe(1); // improved = true
    expect(record.adopted).toBe(true);
  });

  it("maps a failed nutrition change (improved=false → effect_value=0)", () => {
    const row = makeNutritionRow({
      outcome: {
        success: false,
        signal: "protein avg: 162 g/d (+2 g vs baseline)",
        improved: false,
      },
    });
    const result = mapToHistory([row]);
    expect(result.nutrition_interventions[0].effect_value).toBe(0);
    expect(result.nutrition_interventions[0].adopted).toBe(false);
  });

  it("drops nutrition row when outcome.success is null (inconclusive)", () => {
    const row = makeNutritionRow({
      outcome: {
        success: null,
        signal: "protein avg (partial, 3 days): 170 g/d",
        improved: false,
      },
    });
    const result = mapToHistory([row]);
    expect(result.nutrition_interventions).toHaveLength(0);
  });

  it("drops nutrition row when outcome is null", () => {
    const row = makeNutritionRow({ outcome: null });
    const result = mapToHistory([row]);
    expect(result.nutrition_interventions).toHaveLength(0);
  });

  it("uses fallback signal when outcome.signal is missing", () => {
    const row = makeNutritionRow({
      outcome: { success: true, improved: true },
    });
    const result = mapToHistory([row]);
    expect(result.nutrition_interventions[0].effect_measured).toBe("no signal recorded");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests — array caps
// ─────────────────────────────────────────────────────────────────────────────

describe("mapToHistory — array caps", () => {
  it("caps recent_deloads at max 5", () => {
    // 8 rows with distinct valid dates
    const dates = [
      "2025-01-01", "2025-02-01", "2025-03-01", "2025-04-01",
      "2025-05-01", "2025-06-01", "2025-07-01", "2025-08-01",
    ];
    const rows = dates.map((started_on, i) =>
      makeDeloadRow({
        id: `deload-${i}`,
        started_on,
        outcome: { success: true, hrv_recovery_days: 3, performance_resumed: true },
      }),
    );
    const result = mapToHistory(rows);
    expect(result.recent_deloads.length).toBeLessThanOrEqual(5);
    expect(result.recent_deloads).toHaveLength(5);
  });

  it("caps exercise_swaps_8w at max 10", () => {
    // 14 rows with distinct valid dates
    const dates = [
      "2025-01-01", "2025-01-15", "2025-02-01", "2025-02-15",
      "2025-03-01", "2025-03-15", "2025-04-01", "2025-04-15",
      "2025-05-01", "2025-05-15", "2025-06-01", "2025-06-15",
      "2025-07-01", "2025-07-15",
    ];
    const rows = dates.map((started_on, i) =>
      makeSwapRow({
        id: `swap-${i}`,
        started_on,
        outcome: { success: true, pain_resolved: true, swap_stuck: true },
      }),
    );
    const result = mapToHistory(rows);
    expect(result.exercise_swaps_8w.length).toBeLessThanOrEqual(10);
    expect(result.exercise_swaps_8w).toHaveLength(10);
  });

  it("caps nutrition_interventions at max 6", () => {
    // 9 rows with distinct valid dates
    const dates = [
      "2025-01-01", "2025-02-01", "2025-03-01",
      "2025-04-01", "2025-05-01", "2025-06-01",
      "2025-07-01", "2025-08-01", "2025-09-01",
    ];
    const rows = dates.map((started_on, i) =>
      makeNutritionRow({
        id: `nutrition-${i}`,
        started_on,
        outcome: {
          success: true,
          signal: `signal-${i}`,
          improved: true,
        },
      }),
    );
    const result = mapToHistory(rows);
    expect(result.nutrition_interventions.length).toBeLessThanOrEqual(6);
    expect(result.nutrition_interventions).toHaveLength(6);
  });

  it("selects most-recent rows when capping recent_deloads", () => {
    // 6 rows: dates 2026-01 through 2026-06. Cap at 5 → should keep 5 most recent.
    const rows = Array.from({ length: 6 }, (_, i) =>
      makeDeloadRow({
        id: `deload-${i}`,
        started_on: `2026-0${i + 1}-01`,
        outcome: { success: true, hrv_recovery_days: i + 1, performance_resumed: true },
      }),
    );
    const result = mapToHistory(rows);
    expect(result.recent_deloads).toHaveLength(5);
    // Most recent first → 2026-06-01 is index 0
    expect(result.recent_deloads[0].date).toBe("2026-06-01");
    // Oldest included is 2026-02-01
    expect(result.recent_deloads[4].date).toBe("2026-02-01");
    // 2026-01-01 was dropped (oldest of 6)
    const dates = result.recent_deloads.map((r) => r.date);
    expect(dates).not.toContain("2026-01-01");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests — mixed kinds and schema validation
// ─────────────────────────────────────────────────────────────────────────────

describe("mapToHistory — mixed kinds and schema validation", () => {
  it("correctly partitions rows by kind", () => {
    const rows = [
      makeDeloadRow({ id: "d1" }),
      makeSwapRow({ id: "s1" }),
      makeNutritionRow({ id: "n1" }),
    ];
    const result = mapToHistory(rows);
    expect(result.recent_deloads).toHaveLength(1);
    expect(result.exercise_swaps_8w).toHaveLength(1);
    expect(result.nutrition_interventions).toHaveLength(1);
  });

  it("output validates against HistoryPayloadSchema for mixed evaluated input", () => {
    const rows = [
      makeDeloadRow({ id: "d1" }),
      makeDeloadRow({ id: "d2", started_on: "2026-05-20" }),
      makeSwapRow({ id: "s1" }),
      makeNutritionRow({ id: "n1" }),
    ];
    const result = mapToHistory(rows);
    const parsed = HistoryPayloadSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("drops inconclusive rows across all kinds, keeps only evaluated", () => {
    const rows = [
      makeDeloadRow({ id: "d-conclusive", outcome: { success: true, hrv_recovery_days: 3, performance_resumed: true } }),
      makeDeloadRow({ id: "d-inconclusive", started_on: "2026-05-10", outcome: { success: null, hrv_recovery_days: null, performance_resumed: false } }),
      makeSwapRow({ id: "s-conclusive" }),
      makeSwapRow({ id: "s-inconclusive", started_on: "2026-05-10", outcome: { success: null, pain_resolved: false, swap_stuck: false } }),
      makeNutritionRow({ id: "n-conclusive" }),
      makeNutritionRow({ id: "n-inconclusive", started_on: "2026-04-10", outcome: { success: null, signal: "partial", improved: false } }),
    ];
    const result = mapToHistory(rows);
    // Only evaluated rows survive
    expect(result.recent_deloads).toHaveLength(1);
    expect(result.exercise_swaps_8w).toHaveLength(1);
    expect(result.nutrition_interventions).toHaveLength(1);
  });

  it("returns correct result when all rows are inconclusive", () => {
    const rows = [
      makeDeloadRow({ outcome: { success: null, hrv_recovery_days: null, performance_resumed: false } }),
      makeSwapRow({ outcome: { success: null, pain_resolved: false, swap_stuck: false } }),
      makeNutritionRow({ outcome: { success: null, signal: "partial", improved: false } }),
    ];
    const result = mapToHistory(rows);
    expect(result.recent_deloads).toHaveLength(0);
    expect(result.exercise_swaps_8w).toHaveLength(0);
    expect(result.nutrition_interventions).toHaveLength(0);
    const parsed = HistoryPayloadSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("most-recent ordering is maintained for exercise_swaps_8w", () => {
    const rows = [
      makeSwapRow({ id: "old-swap", started_on: "2026-01-10" }),
      makeSwapRow({ id: "new-swap", started_on: "2026-06-10" }),
    ];
    const result = mapToHistory(rows);
    expect(result.exercise_swaps_8w[0].date).toBe("2026-06-10");
    expect(result.exercise_swaps_8w[1].date).toBe("2026-01-10");
  });

  it("most-recent ordering is maintained for nutrition_interventions", () => {
    const rows = [
      makeNutritionRow({ id: "old", started_on: "2026-01-05" }),
      makeNutritionRow({ id: "new", started_on: "2026-06-15" }),
    ];
    const result = mapToHistory(rows);
    expect(result.nutrition_interventions[0].intervention).toBeDefined();
    expect(result.nutrition_interventions[0]).toBeDefined();
    // The most recent row comes first
    expect(result.nutrition_interventions[0].effect_measured).toBeDefined();
    // Verify ordering by checking the dates were processed correctly
    // (nutrition_interventions doesn't carry a date field, but we verify
    // by checking cap with a 7-row scenario below)
    const allRows = Array.from({ length: 7 }, (_, i) =>
      makeNutritionRow({
        id: `n-${i}`,
        started_on: `2026-0${i + 1}-01`,
        outcome: { success: true, signal: `signal-month-${i + 1}`, improved: true },
      }),
    );
    const capResult = mapToHistory(allRows);
    // Signal for month 7 (most recent) should be first
    expect(capResult.nutrition_interventions[0].effect_measured).toBe("signal-month-7");
    // Signal for month 1 (oldest) should be dropped (7 rows, cap 6 → drop oldest)
    const signals = capResult.nutrition_interventions.map((n) => n.effect_measured);
    expect(signals).not.toContain("signal-month-1");
  });
});
