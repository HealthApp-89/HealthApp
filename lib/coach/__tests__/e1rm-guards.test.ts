import { describe, it, expect } from "vitest";
import { brzycki, epley, bestComparisonValue } from "@/lib/coach/e1rm";

/** `NaN <= 0` and `NaN < 1` are both FALSE, so a bare `<= 0` guard is not a
 *  finiteness guard. Unreachable from today's write paths, but this is the
 *  single conversion site every strength surface funnels through: a non-finite
 *  kg reaching it renders "PR — NaN × 5 = NaN e1RM" with the audio cue on. */
describe("e1rm — non-finite inputs", () => {
  it("brzycki rejects NaN and Infinity kg", () => {
    expect(brzycki(Number.NaN, 5)).toBeNull();
    expect(brzycki(Number.POSITIVE_INFINITY, 5)).toBeNull();
    expect(brzycki(Number.NEGATIVE_INFINITY, 5)).toBeNull();
  });

  it("epley rejects NaN and Infinity kg", () => {
    expect(epley(Number.NaN, 5)).toBeNull();
    expect(epley(Number.POSITIVE_INFINITY, 5)).toBeNull();
  });

  it("both still accept ordinary loads", () => {
    expect(brzycki(100, 5)).toBeCloseTo(112.5, 6);
    expect(epley(100, 5)).toBeCloseTo(116.667, 3);
  });

  it("bestComparisonValue skips non-finite kg on the working_weight branch", () => {
    // The working_weight branch returns the raw kg, so there is no formula to
    // reject it downstream — the filter has to.
    expect(
      bestComparisonValue([{ kg: Number.NaN, reps: 5, warmup: false }], "working_weight"),
    ).toBeNull();
    expect(
      bestComparisonValue(
        [{ kg: Number.NaN, reps: 5, warmup: false }, { kg: 80, reps: 5, warmup: false }],
        "working_weight",
      ),
    ).toBe(80);
  });

  it("bestComparisonValue skips non-finite reps", () => {
    expect(
      bestComparisonValue([{ kg: 80, reps: Number.NaN, warmup: false }], "working_weight"),
    ).toBeNull();
  });

  it("bestComparisonValue skips non-finite kg on the e1rm branch", () => {
    expect(
      bestComparisonValue([{ kg: Number.NaN, reps: 5, warmup: false }], "e1rm"),
    ).toBeNull();
  });
});
