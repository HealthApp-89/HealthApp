import { describe, it, expect } from "vitest";
import { restingBaseline, MIN_BASELINE_SAMPLES } from "@/lib/coach/strain/resting-baseline";

describe("restingBaseline", () => {
  it("returns the fallback when there is nothing to work with", () => {
    expect(restingBaseline([], 50)).toBe(50);
    expect(restingBaseline([null, null], 50)).toBe(50);
  });

  it("returns the fallback below the minimum sample count", () => {
    const few = Array.from({ length: MIN_BASELINE_SAMPLES - 1 }, () => 55);
    expect(restingBaseline(few, 50)).toBe(50);
  });

  it("uses the median once there are enough samples", () => {
    const vals = Array.from({ length: MIN_BASELINE_SAMPLES }, (_, i) => 50 + i);
    expect(restingBaseline(vals, 99)).toBe(vals[Math.floor(vals.length / 2)]);
  });

  it("ignores nulls when counting toward the minimum", () => {
    const vals = [...Array.from({ length: MIN_BASELINE_SAMPLES }, () => 55), null, null];
    expect(restingBaseline(vals, 99)).toBe(55);
  });

  it("is a median, not a mean — one implausible reading cannot move it", () => {
    const vals = [...Array.from({ length: 30 }, () => 55), 200];
    expect(restingBaseline(vals, 99)).toBe(55);
  });

  it("tracks a genuine sustained drop rather than freezing forever", () => {
    const before = restingBaseline(Array.from({ length: 90 }, () => 61), 50);
    const after = restingBaseline(Array.from({ length: 90 }, () => 55), 50);
    expect(after).toBeLessThan(before);
  });
});
