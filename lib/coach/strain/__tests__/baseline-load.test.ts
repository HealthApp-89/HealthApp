import { describe, it, expect } from "vitest";
import { baselineTrimp } from "@/lib/coach/strain/baseline-load";
import type { HrSample } from "@/lib/coach/strain/types";

/** A day of 2-minute samples at `bpm`, starting at midnight epoch 0. */
function allDay(bpm: number, n = 720): HrSample[] {
  return Array.from({ length: n }, (_, i) => ({ ts: i * 120_000, bpm }));
}

describe("baselineTrimp", () => {
  it("is 0 for an empty stream", () => {
    expect(baselineTrimp([], [], 50, 183)).toBe(0);
  });

  it("scores an ordinary living day above zero — the Edwards floor is gone", () => {
    // 65 bpm sits under 50% of HRmax 183 (91.5) and scored exactly 0 under
    // Edwards. This is the regression that motivated the whole change.
    expect(baselineTrimp(allDay(65), [], 50, 183)).toBeGreaterThan(0);
  });

  it("scores a busier day above a quieter one", () => {
    expect(baselineTrimp(allDay(80), [], 50, 183)).toBeGreaterThan(
      baselineTrimp(allDay(60), [], 50, 183),
    );
  });

  it("excludes an activity window from the total", () => {
    const full = baselineTrimp(allDay(80), [], 50, 183);
    const cut = baselineTrimp(
      allDay(80),
      [{ startMs: 0, endMs: 60 * 60_000 }],
      50,
      183,
    );
    expect(cut).toBeLessThan(full);
  });

  it("does not credit the excluded span at the ambient heart rate", () => {
    // A 60-minute exclusion on a flat 80 bpm day should remove ~60 minutes of
    // load, not zero and not more.
    const perMinute = baselineTrimp(allDay(80), [], 50, 183) / (719 * 2);
    const cut = baselineTrimp(
      allDay(80),
      [{ startMs: 0, endMs: 60 * 60_000 }],
      50,
      183,
    );
    const full = baselineTrimp(allDay(80), [], 50, 183);
    expect(full - cut).toBeCloseTo(perMinute * 60, 1);
  });

  it("handles several disjoint exclusion windows", () => {
    const cut = baselineTrimp(
      allDay(80),
      [
        { startMs: 0, endMs: 30 * 60_000 },
        { startMs: 600 * 60_000, endMs: 660 * 60_000 },
      ],
      50,
      183,
    );
    expect(cut).toBeGreaterThan(0);
    expect(cut).toBeLessThan(baselineTrimp(allDay(80), [], 50, 183));
  });

  it("returns 0 when every interval is excluded", () => {
    expect(
      baselineTrimp(allDay(80), [{ startMs: -1, endMs: 720 * 120_000 + 1 }], 50, 183),
    ).toBe(0);
  });
});
