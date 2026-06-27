// lib/coach/interventions/__tests__/responsiveness.test.ts
//
// Tests for summarizeResponsiveness() and renderResponsivenessLines().
//
// Covers:
//   - Empty input → empty rollup
//   - Inconclusive rows (success: null) are skipped
//   - high_roi: kinds with ≥2 successes emitted; <2 successes omitted
//   - low_signal: kinds with ≥2 attempts AND 0 successes emitted; <2 attempts omitted
//   - recent_wins: success rows within 10d of today; outside window omitted
//   - Mixed kinds correctly partitioned
//   - renderResponsivenessLines: empty when all empty; lines per non-empty bucket
//   - Stable kind ordering (deload → swap → nutrition)
//
// Run via: npx vitest run lib/coach/interventions/__tests__/responsiveness.test.ts

import { describe, it, expect } from "vitest";
import { summarizeResponsiveness, renderResponsivenessLines } from "../responsiveness";
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
    outcome: { success: true, pain_resolved: true, swap_stuck: true },
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

describe("summarizeResponsiveness — empty input", () => {
  it("returns empty arrays for empty input", () => {
    const result = summarizeResponsiveness([]);
    expect(result.high_roi).toEqual([]);
    expect(result.low_signal).toEqual([]);
    expect(result.recent_wins).toEqual([]);
  });

  it("returns empty arrays when all rows are inconclusive (success: null)", () => {
    const rows: CoachInterventionRow[] = [
      makeDeloadRow({ outcome: { success: null, hrv_recovery_days: null, performance_resumed: false } }),
      makeSwapRow({ outcome: { success: null, pain_resolved: false, swap_stuck: false } }),
      makeNutritionRow({ outcome: { success: null, signal: "partial", improved: false } }),
    ];
    const result = summarizeResponsiveness(rows);
    expect(result.high_roi).toEqual([]);
    expect(result.low_signal).toEqual([]);
    expect(result.recent_wins).toEqual([]);
  });

  it("returns empty arrays when all rows have null outcome", () => {
    const rows: CoachInterventionRow[] = [
      makeDeloadRow({ outcome: null }),
      makeSwapRow({ outcome: null }),
    ];
    const result = summarizeResponsiveness(rows);
    expect(result.high_roi).toEqual([]);
    expect(result.low_signal).toEqual([]);
    expect(result.recent_wins).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests — high_roi
// ─────────────────────────────────────────────────────────────────────────────

describe("summarizeResponsiveness — high_roi", () => {
  it("emits high_roi entry for kind with ≥2 successes", () => {
    const rows = [
      makeDeloadRow({ id: "d1", started_on: "2026-04-01", outcome: { success: true, hrv_recovery_days: 4, performance_resumed: true } }),
      makeDeloadRow({ id: "d2", started_on: "2026-05-01", outcome: { success: true, hrv_recovery_days: 3, performance_resumed: true } }),
    ];
    const result = summarizeResponsiveness(rows);
    expect(result.high_roi).toHaveLength(1);
    // Should mention "reactive deloads" with 2/2
    expect(result.high_roi[0]).toMatch(/reactive deloads.*2\/2/);
  });

  it("omits kind from high_roi when it has only 1 success", () => {
    const rows = [
      makeDeloadRow({ id: "d1", outcome: { success: true, hrv_recovery_days: 4, performance_resumed: true } }),
    ];
    const result = summarizeResponsiveness(rows);
    expect(result.high_roi).toHaveLength(0);
  });

  it("emits high_roi for exercise_swap with ≥2 successes", () => {
    const rows = [
      makeSwapRow({ id: "s1", started_on: "2026-04-10", outcome: { success: true, pain_resolved: true, swap_stuck: true } }),
      makeSwapRow({ id: "s2", started_on: "2026-05-10", outcome: { success: true, pain_resolved: true, swap_stuck: true } }),
      makeSwapRow({ id: "s3", started_on: "2026-06-10", outcome: { success: false, pain_resolved: false, swap_stuck: false } }),
    ];
    const result = summarizeResponsiveness(rows);
    // 2 successes out of 3 attempts → high_roi
    expect(result.high_roi).toHaveLength(1);
    expect(result.high_roi[0]).toMatch(/exercise swaps.*2\/3/);
  });

  it("counts only success:true rows toward high_roi threshold", () => {
    const rows = [
      // 1 success, 1 failure → not enough for high_roi
      makeDeloadRow({ id: "d1", started_on: "2026-04-01", outcome: { success: true, hrv_recovery_days: 4, performance_resumed: true } }),
      makeDeloadRow({ id: "d2", started_on: "2026-05-01", outcome: { success: false, hrv_recovery_days: null, performance_resumed: false } }),
    ];
    const result = summarizeResponsiveness(rows);
    expect(result.high_roi).toHaveLength(0);
  });

  it("high_roi phrase uses plural kind label", () => {
    const rows = [
      makeNutritionRow({ id: "n1", started_on: "2026-04-01" }),
      makeNutritionRow({ id: "n2", started_on: "2026-05-01" }),
    ];
    const result = summarizeResponsiveness(rows);
    expect(result.high_roi).toHaveLength(1);
    expect(result.high_roi[0]).toMatch(/^nutrition changes:/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests — low_signal
// ─────────────────────────────────────────────────────────────────────────────

describe("summarizeResponsiveness — low_signal", () => {
  it("emits low_signal for kind with ≥2 attempts AND 0 successes", () => {
    const rows = [
      makeDeloadRow({ id: "d1", started_on: "2026-04-01", outcome: { success: false, hrv_recovery_days: null, performance_resumed: false } }),
      makeDeloadRow({ id: "d2", started_on: "2026-05-01", outcome: { success: false, hrv_recovery_days: null, performance_resumed: false } }),
    ];
    const result = summarizeResponsiveness(rows);
    expect(result.low_signal).toHaveLength(1);
    expect(result.low_signal[0]).toMatch(/reactive deloads.*2 attempts, 0 successes/);
  });

  it("omits kind from low_signal when it has only 1 attempt", () => {
    const rows = [
      makeDeloadRow({ id: "d1", outcome: { success: false, hrv_recovery_days: null, performance_resumed: false } }),
    ];
    const result = summarizeResponsiveness(rows);
    expect(result.low_signal).toHaveLength(0);
  });

  it("omits kind from low_signal when it has ≥1 success (even if also has failures)", () => {
    // 2 attempts, 1 success → NOT low_signal (has a success)
    const rows = [
      makeSwapRow({ id: "s1", started_on: "2026-04-10", outcome: { success: true, pain_resolved: true, swap_stuck: true } }),
      makeSwapRow({ id: "s2", started_on: "2026-05-10", outcome: { success: false, pain_resolved: false, swap_stuck: false } }),
    ];
    const result = summarizeResponsiveness(rows);
    expect(result.low_signal).toHaveLength(0);
  });

  it("emits low_signal for nutrition_change with ≥2 failures", () => {
    const rows = [
      makeNutritionRow({ id: "n1", started_on: "2026-04-01", outcome: { success: false, signal: "no change", improved: false } }),
      makeNutritionRow({ id: "n2", started_on: "2026-05-01", outcome: { success: false, signal: "no change", improved: false } }),
    ];
    const result = summarizeResponsiveness(rows);
    expect(result.low_signal).toHaveLength(1);
    expect(result.low_signal[0]).toMatch(/nutrition changes/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests — recent_wins
// ─────────────────────────────────────────────────────────────────────────────

describe("summarizeResponsiveness — recent_wins", () => {
  it("emits recent_wins for success rows within 10 days of today", () => {
    const today = "2026-06-26";
    // 5 days ago — within 10d window
    const rows = [
      makeDeloadRow({ started_on: "2026-06-21", outcome: { success: true, hrv_recovery_days: 5, performance_resumed: true } }),
    ];
    const result = summarizeResponsiveness(rows, today);
    expect(result.recent_wins).toHaveLength(1);
    expect(result.recent_wins[0]).toMatch(/reactive deload 2026-06-21/);
    expect(result.recent_wins[0]).toMatch(/HRV recovered in 5d/);
  });

  it("omits rows outside the 10-day window from recent_wins", () => {
    const today = "2026-06-26";
    // 15 days ago — outside window
    const rows = [
      makeDeloadRow({ started_on: "2026-06-11", outcome: { success: true, hrv_recovery_days: 4, performance_resumed: true } }),
    ];
    const result = summarizeResponsiveness(rows, today);
    expect(result.recent_wins).toHaveLength(0);
  });

  it("omits failure rows from recent_wins even if within 10 days", () => {
    const today = "2026-06-26";
    const rows = [
      makeDeloadRow({ started_on: "2026-06-22", outcome: { success: false, hrv_recovery_days: null, performance_resumed: false } }),
    ];
    const result = summarizeResponsiveness(rows, today);
    expect(result.recent_wins).toHaveLength(0);
  });

  it("returns empty recent_wins when today string is empty (no anchor)", () => {
    const rows = [
      makeDeloadRow({ started_on: "2026-06-25", outcome: { success: true, hrv_recovery_days: 4, performance_resumed: true } }),
    ];
    const result = summarizeResponsiveness(rows, "");
    expect(result.recent_wins).toHaveLength(0);
  });

  it("recent_wins phrase includes exercise names for swap wins", () => {
    const today = "2026-06-26";
    const rows = [
      makeSwapRow({ started_on: "2026-06-22", outcome: { success: true, pain_resolved: true, swap_stuck: true } }),
    ];
    const result = summarizeResponsiveness(rows, today);
    expect(result.recent_wins).toHaveLength(1);
    expect(result.recent_wins[0]).toMatch(/Romanian Deadlift.*Leg Curl/);
  });

  it("recent_wins phrase includes field and signal for nutrition wins", () => {
    const today = "2026-06-26";
    const rows = [
      makeNutritionRow({ started_on: "2026-06-23" }),
    ];
    const result = summarizeResponsiveness(rows, today);
    expect(result.recent_wins).toHaveLength(1);
    expect(result.recent_wins[0]).toMatch(/nutrition change 2026-06-23/);
    expect(result.recent_wins[0]).toMatch(/protein_g/);
  });

  it("recent_wins are sorted most-recent first", () => {
    const today = "2026-06-26";
    const rows = [
      makeDeloadRow({ id: "d-older", started_on: "2026-06-17", outcome: { success: true, hrv_recovery_days: 3, performance_resumed: true } }),
      makeDeloadRow({ id: "d-newer", started_on: "2026-06-22", outcome: { success: true, hrv_recovery_days: 4, performance_resumed: true } }),
    ];
    const result = summarizeResponsiveness(rows, today);
    expect(result.recent_wins).toHaveLength(2);
    // Most recent first
    expect(result.recent_wins[0]).toMatch(/2026-06-22/);
    expect(result.recent_wins[1]).toMatch(/2026-06-17/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests — kind ordering
// ─────────────────────────────────────────────────────────────────────────────

describe("summarizeResponsiveness — stable kind ordering", () => {
  it("high_roi order is deload → swap → nutrition regardless of input order", () => {
    const rows = [
      makeNutritionRow({ id: "n1", started_on: "2026-03-01" }),
      makeNutritionRow({ id: "n2", started_on: "2026-04-01" }),
      makeSwapRow({ id: "s1", started_on: "2026-03-15" }),
      makeSwapRow({ id: "s2", started_on: "2026-04-15" }),
      makeDeloadRow({ id: "d1", started_on: "2026-03-20" }),
      makeDeloadRow({ id: "d2", started_on: "2026-04-20" }),
    ];
    const result = summarizeResponsiveness(rows);
    // All three should be in high_roi
    expect(result.high_roi).toHaveLength(3);
    expect(result.high_roi[0]).toMatch(/^reactive deloads/);
    expect(result.high_roi[1]).toMatch(/^exercise swaps/);
    expect(result.high_roi[2]).toMatch(/^nutrition changes/);
  });

  it("low_signal order is deload → swap → nutrition", () => {
    const rows = [
      makeNutritionRow({ id: "n1", started_on: "2026-03-01", outcome: { success: false, signal: "none", improved: false } }),
      makeNutritionRow({ id: "n2", started_on: "2026-04-01", outcome: { success: false, signal: "none", improved: false } }),
      makeDeloadRow({ id: "d1", started_on: "2026-03-20", outcome: { success: false, hrv_recovery_days: null, performance_resumed: false } }),
      makeDeloadRow({ id: "d2", started_on: "2026-04-20", outcome: { success: false, hrv_recovery_days: null, performance_resumed: false } }),
    ];
    const result = summarizeResponsiveness(rows);
    expect(result.low_signal).toHaveLength(2);
    expect(result.low_signal[0]).toMatch(/^reactive deloads/);
    expect(result.low_signal[1]).toMatch(/^nutrition changes/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests — mixed scenarios
// ─────────────────────────────────────────────────────────────────────────────

describe("summarizeResponsiveness — mixed scenarios", () => {
  it("same kind can be in neither bucket if <2 attempts or 1+ success with <2", () => {
    // 1 swap success — not high_roi (need 2), not low_signal (has a success)
    const rows = [makeSwapRow()];
    const result = summarizeResponsiveness(rows);
    expect(result.high_roi).toHaveLength(0);
    expect(result.low_signal).toHaveLength(0);
  });

  it("inconclusive rows do not count toward attempts or successes", () => {
    const rows = [
      makeDeloadRow({ id: "d1", outcome: { success: null, hrv_recovery_days: null, performance_resumed: false } }),
      makeDeloadRow({ id: "d2", outcome: { success: null, hrv_recovery_days: null, performance_resumed: false } }),
      makeDeloadRow({ id: "d3", started_on: "2026-05-01", outcome: { success: true, hrv_recovery_days: 4, performance_resumed: true } }),
    ];
    // Only 1 evaluated success → not high_roi; 1 evaluated attempt, 1 success → not low_signal
    const result = summarizeResponsiveness(rows);
    expect(result.high_roi).toHaveLength(0);
    expect(result.low_signal).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests — renderResponsivenessLines
// ─────────────────────────────────────────────────────────────────────────────

describe("renderResponsivenessLines", () => {
  it("returns empty array when all buckets are empty", () => {
    const result = renderResponsivenessLines({ high_roi: [], low_signal: [], recent_wins: [] });
    expect(result).toEqual([]);
  });

  it("renders high_roi line when present", () => {
    const lines = renderResponsivenessLines({
      high_roi: ["reactive deloads: 3/3 recovered"],
      low_signal: [],
      recent_wins: [],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^- Responsive to:/);
    expect(lines[0]).toContain("reactive deloads: 3/3 recovered");
  });

  it("renders low_signal line when present", () => {
    const lines = renderResponsivenessLines({
      high_roi: [],
      low_signal: ["exercise swaps: 2 attempts, 0 successes"],
      recent_wins: [],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^- Low signal:/);
    expect(lines[0]).toContain("exercise swaps: 2 attempts, 0 successes");
  });

  it("renders recent_wins line when present", () => {
    const lines = renderResponsivenessLines({
      high_roi: [],
      low_signal: [],
      recent_wins: ["reactive deload 2026-06-20 → HRV recovered in 5d"],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^- Recent wins:/);
    expect(lines[0]).toContain("reactive deload 2026-06-20 → HRV recovered in 5d");
  });

  it("renders all three lines when all buckets are non-empty", () => {
    const lines = renderResponsivenessLines({
      high_roi: ["reactive deloads: 2/2 recovered"],
      low_signal: ["exercise swaps: 2 attempts, 0 successes"],
      recent_wins: ["nutrition change 2026-06-23 (protein_g) → protein avg: 198 g/d (+38 g vs baseline)"],
    });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^- Responsive to:/);
    expect(lines[1]).toMatch(/^- Low signal:/);
    expect(lines[2]).toMatch(/^- Recent wins:/);
  });

  it("joins multiple entries in a bucket with semicolons", () => {
    const lines = renderResponsivenessLines({
      high_roi: ["reactive deloads: 3/4 recovered", "exercise swaps: 2/2 recovered"],
      low_signal: [],
      recent_wins: [],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("; ");
  });
});
