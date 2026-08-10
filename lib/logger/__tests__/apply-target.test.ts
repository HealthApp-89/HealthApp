import { describe, it, expect } from "vitest";
import { findApplyTargetSetIndex } from "@/lib/logger/apply-target";
import type { ExerciseSetDraft } from "@/lib/logger/types";

function mkSet(over: Partial<ExerciseSetDraft> = {}): ExerciseSetDraft {
  return {
    set_index: 0,
    kg: 60,
    reps: null,
    duration_seconds: null,
    warmup: false,
    failure: false,
    rir: 2,
    committed_at: null,
    ...over,
  };
}

describe("findApplyTargetSetIndex", () => {
  it("targets the first uncommitted set AFTER the current one", () => {
    const sets = [
      mkSet({ set_index: 0, committed_at: "2026-08-10T09:00:00Z" }),
      mkSet({ set_index: 1, committed_at: "2026-08-10T09:03:00Z" }),
      mkSet({ set_index: 2 }),
      mkSet({ set_index: 3 }),
    ];
    expect(findApplyTargetSetIndex(sets, 1)).toBe(2);
  });

  it("targets a pending set whose kg is ALREADY pre-filled", () => {
    // The regression this whole helper exists for. Every pending set is
    // pre-filled with the prescribed baseKg by makeDraftFromPlan, so the old
    // `kg == null` clause made the one-tap apply button a permanent no-op.
    const sets = [
      mkSet({ set_index: 0, committed_at: "2026-08-10T09:00:00Z", kg: 60 }),
      mkSet({ set_index: 1, kg: 60 }),
    ];
    expect(findApplyTargetSetIndex(sets, 0)).toBe(1);
  });

  it("never targets the set that produced the line, nor anything before it", () => {
    const sets = [
      mkSet({ set_index: 0 }),
      mkSet({ set_index: 1, committed_at: "2026-08-10T09:03:00Z" }),
      mkSet({ set_index: 2 }),
    ];
    // Set 0 is uncommitted and earlier — it must be skipped.
    expect(findApplyTargetSetIndex(sets, 1)).toBe(2);
  });

  it("skips committed sets — a logged kg is a record, not a plan", () => {
    const sets = [
      mkSet({ set_index: 0, committed_at: "2026-08-10T09:00:00Z" }),
      mkSet({ set_index: 1, committed_at: "2026-08-10T09:03:00Z" }),
      mkSet({ set_index: 2, committed_at: "2026-08-10T09:06:00Z" }),
      mkSet({ set_index: 3 }),
    ];
    expect(findApplyTargetSetIndex(sets, 0)).toBe(3);
  });

  it("returns -1 on the final set — the line said 'next time', there is nothing to write", () => {
    const sets = [
      mkSet({ set_index: 0, committed_at: "2026-08-10T09:00:00Z" }),
      mkSet({ set_index: 1, committed_at: "2026-08-10T09:03:00Z" }),
    ];
    expect(findApplyTargetSetIndex(sets, 1)).toBe(-1);
  });

  it("returns -1 for an empty set list", () => {
    expect(findApplyTargetSetIndex([], 0)).toBe(-1);
  });
});
