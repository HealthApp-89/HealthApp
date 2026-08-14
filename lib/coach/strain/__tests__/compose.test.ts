import { describe, it, expect } from "vitest";
import { composeStrain } from "@/lib/coach/strain/compose";
import { STRAIN_CALIBRATION } from "@/lib/coach/strain/constants";

describe("composeStrain", () => {
  it("returns 0 for a day with no load at all", () => {
    expect(composeStrain({ baseline: 0, activity: 0, mechanical: 0 })).toBe(0);
  });

  it("is monotonic in every term", () => {
    const base = { baseline: 10, activity: 10, mechanical: 1000 };
    expect(composeStrain({ ...base, baseline: 20 })).toBeGreaterThan(composeStrain(base));
    expect(composeStrain({ ...base, activity: 20 })).toBeGreaterThan(composeStrain(base));
    expect(composeStrain({ ...base, mechanical: 2000 })).toBeGreaterThan(composeStrain(base));
  });

  it("clamps at 21 for absurd load", () => {
    expect(composeStrain({ baseline: 0, activity: 1e9, mechanical: 0 })).toBe(21);
  });

  it("weights ambient baseline load below deliberate activity load", () => {
    // The whole point of the 2026-08-14 refit. An hour of padel and eight hours
    // of ambient living can produce the same TRIMP total; they are not the same
    // day, and WHOOP's labels say so.
    const viaBaseline = composeStrain({ baseline: 100, activity: 0, mechanical: 0 });
    const viaActivity = composeStrain({ baseline: 0, activity: 100, mechanical: 0 });
    expect(viaBaseline).toBeLessThan(viaActivity);
  });

  it("weights mechanical load by w — 126 kg of tonnage ≈ 1 TRIMP", () => {
    const viaCardio = composeStrain({ baseline: 0, activity: 10, mechanical: 0 });
    const viaTonnage = composeStrain({ baseline: 0, activity: 0, mechanical: 10 / STRAIN_CALIBRATION.w });
    expect(viaTonnage).toBeCloseTo(viaCardio, 6);
  });

  it("applies the curve as A·ln(1+k·load)", () => {
    const { A, k, w, baselineWeight } = STRAIN_CALIBRATION;
    const load = baselineWeight * 12 + 60 + w * 8000;
    expect(composeStrain({ baseline: 12, activity: 60, mechanical: 8000 })).toBeCloseTo(
      A * Math.log(1 + k * load),
      9,
    );
  });

  it("discounts the baseline term by baselineWeight, not by dropping it", () => {
    // A quiet day still scores: the term is downweighted, never zeroed.
    expect(composeStrain({ baseline: 100, activity: 0, mechanical: 0 })).toBeGreaterThan(0);
    const { baselineWeight } = STRAIN_CALIBRATION;
    expect(baselineWeight).toBeGreaterThan(0);
    expect(baselineWeight).toBeLessThan(1);
    // 100 TRIMP of ambient living scores as baselineWeight×100 of activity.
    expect(composeStrain({ baseline: 100, activity: 0, mechanical: 0 })).toBeCloseTo(
      composeStrain({ baseline: 0, activity: baselineWeight * 100, mechanical: 0 }),
      9,
    );
  });

  it("never returns a negative number for negative-ish input", () => {
    expect(composeStrain({ baseline: -5, activity: 0, mechanical: 0 })).toBe(0);
  });
});
