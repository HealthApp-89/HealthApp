// lib/coach/intelligence/__tests__/coach-history.test.ts
//
// Tests for composeCoachHistory() — the history composer function (Phase 1 stub).
// Run via: npx vitest lib/coach/intelligence/__tests__/coach-history.test.ts

import { describe, it, expect } from "vitest";
import { HistoryPayloadSchema } from "../types";
import { composeCoachHistory } from "../coach-history";
import { SAMPLE_WORKOUTS_90D } from "./fixtures";

describe("composeCoachHistory — Phase 1 stub", () => {
  // Test 1: Returns object with three array keys, all empty
  it("returns object with three array keys: recent_deloads, exercise_swaps_8w, nutrition_interventions", () => {
    const result = composeCoachHistory([], [], []);
    expect(result).toHaveProperty("recent_deloads");
    expect(result).toHaveProperty("exercise_swaps_8w");
    expect(result).toHaveProperty("nutrition_interventions");
  });

  it("returns all arrays empty in Phase 1 stub", () => {
    const result = composeCoachHistory([], [], []);
    expect(result.recent_deloads).toEqual([]);
    expect(result.exercise_swaps_8w).toEqual([]);
    expect(result.nutrition_interventions).toEqual([]);
  });

  // Test 2: Return validates against HistoryPayload schema
  it("output validates against HistoryPayloadSchema", () => {
    const result = composeCoachHistory([], [], []);
    const parsed = HistoryPayloadSchema.safeParse(result);
    if (!parsed.success) {
      throw new Error(`Schema validation failed: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
    expect(parsed.success).toBe(true);
  });

  it("validates against schema for populated workout input arrays", () => {
    const result = composeCoachHistory(SAMPLE_WORKOUTS_90D, [], []);
    const parsed = HistoryPayloadSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  // Test 3: Does not throw on empty input arrays
  it("does not throw on empty workouts and daily logs", () => {
    expect(() => {
      composeCoachHistory([], [], []);
    }).not.toThrow();
  });

  // Test 4: Does not throw on populated input arrays (proves it ignores them safely)
  it("does not throw on populated workouts", () => {
    expect(() => {
      composeCoachHistory(SAMPLE_WORKOUTS_90D, [], []);
    }).not.toThrow();
  });

  it("returns consistent result for same input", () => {
    const result1 = composeCoachHistory([], [], []);
    const result2 = composeCoachHistory([], [], []);
    expect(result1).toEqual(result2);
  });

  it("returns consistent result regardless of input data (Phase 1 ignores inputs)", () => {
    const result1 = composeCoachHistory([], [], []);
    const result2 = composeCoachHistory(SAMPLE_WORKOUTS_90D, [], []);
    // Both return the same empty stub in Phase 1
    expect(result1).toEqual(result2);
  });

  it("respects schema constraints: recent_deloads max 5", () => {
    const result = composeCoachHistory([], [], []);
    expect(result.recent_deloads.length).toBeLessThanOrEqual(5);
  });

  it("respects schema constraints: exercise_swaps_8w max 10", () => {
    const result = composeCoachHistory([], [], []);
    expect(result.exercise_swaps_8w.length).toBeLessThanOrEqual(10);
  });

  it("respects schema constraints: nutrition_interventions max 6", () => {
    const result = composeCoachHistory([], [], []);
    expect(result.nutrition_interventions.length).toBeLessThanOrEqual(6);
  });
});
