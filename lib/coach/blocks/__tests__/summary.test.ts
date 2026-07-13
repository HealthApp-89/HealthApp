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
});
