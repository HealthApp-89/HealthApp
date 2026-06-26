// lib/coach/interventions/__tests__/context-outcome-schema.test.ts
//
// Zod schema validation tests for intervention context and outcome types.
// Run via: npx vitest run lib/coach/interventions/

import { describe, it, expect } from "vitest";
import {
  DeloadContextSchema,
  DeloadOutcomeSchema,
  SwapOutcomeSchema,
} from "../types";

// ---------------------------------------------------------------------------
// DeloadContextSchema
// ---------------------------------------------------------------------------

describe("DeloadContextSchema", () => {
  it("accepts a valid context with block_* populated", () => {
    const result = DeloadContextSchema.safeParse({
      block_id: "abc-123",
      block_phase: "pre_target",
      block_week: 2,
      deload_depth_pct: 40,
      trigger: "low_hrv",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid context with block_* as null (no active block)", () => {
    const result = DeloadContextSchema.safeParse({
      block_id: null,
      block_phase: null,
      block_week: null,
      deload_depth_pct: null,
      trigger: "athlete_request",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid trigger value", () => {
    const result = DeloadContextSchema.safeParse({
      block_id: null,
      block_phase: null,
      block_week: null,
      deload_depth_pct: null,
      trigger: "overreaching", // not in enum
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DeloadOutcomeSchema
// ---------------------------------------------------------------------------

describe("DeloadOutcomeSchema", () => {
  it("accepts a valid outcome with success: null (not yet evaluated)", () => {
    const result = DeloadOutcomeSchema.safeParse({
      success: null,
      hrv_recovery_days: null,
      performance_resumed: false,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid outcome with success: true", () => {
    const result = DeloadOutcomeSchema.safeParse({
      success: true,
      hrv_recovery_days: 4,
      performance_resumed: true,
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SwapOutcomeSchema
// ---------------------------------------------------------------------------

describe("SwapOutcomeSchema", () => {
  it("rejects a swap outcome missing swap_stuck", () => {
    const result = SwapOutcomeSchema.safeParse({
      success: null,
      pain_resolved: false,
      // swap_stuck intentionally omitted
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid swap outcome", () => {
    const result = SwapOutcomeSchema.safeParse({
      success: false,
      pain_resolved: false,
      swap_stuck: true,
    });
    expect(result.success).toBe(true);
  });
});
