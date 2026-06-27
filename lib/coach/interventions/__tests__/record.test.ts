// lib/coach/interventions/__tests__/record.test.ts
//
// Tests for buildExplicitIntervention (pure) and deriveSwapReason.
// The I/O recordIntervention is not tested here (requires a live DB).
//
// Run: npx vitest run lib/coach/interventions/

import { describe, it, expect } from "vitest";
import { buildExplicitIntervention, deriveSwapReason } from "../record";

// ── buildExplicitIntervention — exercise_swap ─────────────────────────────────

describe("buildExplicitIntervention — exercise_swap", () => {
  it("produces kind=exercise_swap and source=explicit", () => {
    const result = buildExplicitIntervention({
      kind: "exercise_swap",
      started_on: "2026-06-26",
      block_id: "block-1",
      block_phase: "pre_target",
      block_week: 2,
      from_exercise: "Romanian Deadlift",
      to_exercise: "Leg Curl (Machine)",
      reason: "pain",
    });

    expect(result.kind).toBe("exercise_swap");
    expect(result.source).toBe("explicit");
    expect(result.started_on).toBe("2026-06-26");
  });

  it("embeds from_exercise, to_exercise, and reason in context", () => {
    const result = buildExplicitIntervention({
      kind: "exercise_swap",
      started_on: "2026-06-26",
      block_id: "block-1",
      block_phase: "pre_target",
      block_week: 2,
      from_exercise: "Romanian Deadlift",
      to_exercise: "Leg Curl (Machine)",
      reason: "pain",
    });

    expect(result.context).toMatchObject({
      from_exercise: "Romanian Deadlift",
      to_exercise: "Leg Curl (Machine)",
      reason: "pain",
    });
  });

  it("embeds block context fields in context", () => {
    const result = buildExplicitIntervention({
      kind: "exercise_swap",
      started_on: "2026-06-26",
      block_id: "block-abc",
      block_phase: "consolidation",
      block_week: 3,
      from_exercise: "Squat",
      to_exercise: "Leg Press",
      reason: "equipment",
    });

    expect(result.context).toMatchObject({
      block_id: "block-abc",
      block_phase: "consolidation",
      block_week: 3,
    });
  });

  it("handles null block context (no active block)", () => {
    const result = buildExplicitIntervention({
      kind: "exercise_swap",
      started_on: "2026-06-26",
      block_id: null,
      block_phase: null,
      block_week: null,
      from_exercise: "Bench Press",
      to_exercise: "Dumbbell Press",
      reason: "stall",
    });

    expect(result.context).toMatchObject({
      block_id: null,
      block_phase: null,
      block_week: null,
      from_exercise: "Bench Press",
      to_exercise: "Dumbbell Press",
      reason: "stall",
    });
  });
});

// ── buildExplicitIntervention — nutrition_change ──────────────────────────────

describe("buildExplicitIntervention — nutrition_change", () => {
  it("produces kind=nutrition_change and source=explicit", () => {
    const result = buildExplicitIntervention({
      kind: "nutrition_change",
      started_on: "2026-06-26",
      block_id: null,
      block_phase: null,
      block_week: null,
      field: "kcal",
      from: 2400,
      to: 2100,
    });

    expect(result.kind).toBe("nutrition_change");
    expect(result.source).toBe("explicit");
  });

  it("embeds field/from/to in context", () => {
    const result = buildExplicitIntervention({
      kind: "nutrition_change",
      started_on: "2026-06-26",
      block_id: "block-2",
      block_phase: "pre_target",
      block_week: 1,
      field: "kcal",
      from: 2400,
      to: 2100,
    });

    expect(result.context).toMatchObject({
      field: "kcal",
      from: 2400,
      to: 2100,
      block_id: "block-2",
      block_phase: "pre_target",
      block_week: 1,
    });
  });

  it("accepts null from/to values", () => {
    const result = buildExplicitIntervention({
      kind: "nutrition_change",
      started_on: "2026-06-26",
      block_id: null,
      block_phase: null,
      block_week: null,
      field: "macro_ratios",
      from: null,
      to: null,
    });

    expect(result.context).toMatchObject({ field: "macro_ratios", from: null, to: null });
  });
});

// ── deriveSwapReason ──────────────────────────────────────────────────────────

describe("deriveSwapReason", () => {
  it("detects 'pain' keyword", () => {
    expect(deriveSwapReason("Athlete reports knee pain on Romanian Deadlifts")).toBe("pain");
  });

  it("detects 'injury' keyword", () => {
    expect(deriveSwapReason("Swap due to shoulder injury")).toBe("pain");
  });

  it("detects 'stall' keyword", () => {
    expect(deriveSwapReason("Progress stalled on bench press for 3 weeks")).toBe("stall");
  });

  it("detects 'plateau' keyword", () => {
    expect(deriveSwapReason("Hit a plateau on deadlift, trying Deficit DL")).toBe("stall");
  });

  it("detects 'equipment' keyword", () => {
    expect(deriveSwapReason("Barbell unavailable, equipment issue today")).toBe("equipment");
  });

  it("falls back to 'boredom' for unrecognised rationale", () => {
    expect(deriveSwapReason("Athlete wants to try something new")).toBe("boredom");
  });

  it("falls back to 'boredom' for empty rationale", () => {
    expect(deriveSwapReason("")).toBe("boredom");
  });
});
