// lib/coach/blocks/__tests__/summary.test.ts
import { describe, expect, test } from "vitest";
import { computeBlockPace } from "@/lib/coach/blocks/summary";

describe("computeBlockPace", () => {
  test("projects hit week from OLS slope", () => {
    const pts = [{ week: 1, e1rm: 86 }, { week: 2, e1rm: 88 }, { week: 3, e1rm: 90 }];
    const r = computeBlockPace(pts, 94, 5);
    expect(r.currentBest).toBe(90);
    expect(r.slopePerWeek).toBeCloseTo(2, 5);
    expect(r.projectedHitWeek).toBe(5);   // 90 + 2/wk → 94 at week 5
    expect(r.kgToGo).toBe(4);
  });
  test("null-safe with <2 points", () => {
    const r = computeBlockPace([{ week: 1, e1rm: 86 }], 94, 5);
    expect(r.currentBest).toBe(86);
    expect(r.slopePerWeek).toBeNull();
    expect(r.projectedHitWeek).toBeNull();
  });
  test("already-hit target projects the current week", () => {
    const pts = [{ week: 1, e1rm: 86 }, { week: 2, e1rm: 95 }];
    const r = computeBlockPace(pts, 94, 5);
    expect(r.projectedHitWeek).toBe(2);
    expect(r.kgToGo).toBe(0);
  });
  test("null target yields null pace fields (grandfathered blocks)", () => {
    const pts = [{ week: 1, e1rm: 86 }, { week: 2, e1rm: 88 }];
    const r = computeBlockPace(pts, null, 5);
    expect(r.currentBest).toBe(88);
    expect(r.slopePerWeek).toBeCloseTo(2, 5);
    expect(r.projectedHitWeek).toBeNull();
    expect(r.kgToGo).toBeNull();
  });
});

import { computeSecondary, secondaryInjuryArea } from "@/lib/coach/blocks/summary";

describe("computeSecondary", () => {
  const names = new Set(["deadlift (barbell)"]);
  const workouts = [
    { date: "2026-06-18", exercises: [{ name: "Deadlift (Barbell)", exercise_sets: [{ kg: 95, reps: 8, warmup: false }] }] },
    { date: "2026-06-25", exercises: [{ name: "Deadlift (Barbell)", exercise_sets: [{ kg: 90, reps: 10, warmup: false }, { kg: 40, reps: 5, warmup: true }] }] },
  ];
  test("returns the LATEST session's working kg, not the window max", () => {
    const r = computeSecondary(workouts, names);
    expect(r.kg).toBe(90);
    expect(r.lastDate).toBe("2026-06-25");
  });
  test("warmup-only and non-matching workouts yield null", () => {
    expect(computeSecondary([{ date: "2026-07-01", exercises: [{ name: "Deadlift (Barbell)", exercise_sets: [{ kg: 40, reps: 5, warmup: true }] }] }], names).kg).toBeNull();
    expect(computeSecondary(workouts, new Set(["bench press (barbell)"])).kg).toBeNull();
  });
});

import type { Injury } from "@/lib/data/types";

const makeInjury = (area: string, affectedLifts: Injury["affected_lifts"]): Injury => ({
  id: "test-id",
  user_id: "user-1",
  area,
  side: null,
  cause: null,
  severity: "mild",
  onset_date: "2026-07-01",
  status: "active",
  resolved_at: null,
  affected_session_types: [],
  affected_lifts: affectedLifts,
  notes: null,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
});

describe("secondaryInjuryArea", () => {
  test("returns area of first injury that covers the lift", () => {
    const injuries: Injury[] = [
      makeInjury("Hip", ["deadlift", "squat"]),
      makeInjury("Shoulder", ["bench", "ohp"]),
    ];
    expect(secondaryInjuryArea(injuries, "deadlift")).toBe("Hip");
    expect(secondaryInjuryArea(injuries, "ohp")).toBe("Shoulder");
  });
  test("returns null when no injury covers the lift", () => {
    const injuries: Injury[] = [makeInjury("Hip", ["squat"])];
    expect(secondaryInjuryArea(injuries, "bench")).toBeNull();
    expect(secondaryInjuryArea([], "deadlift")).toBeNull();
  });
});
