import { describe, expect, it } from "vitest";
import { recentEffortQuality } from "@/lib/coach/prescription/effort-quality";
import type { WorkoutSetSample } from "@/lib/coach/prescription/types";

function s(overrides: Partial<WorkoutSetSample>): WorkoutSetSample {
  return {
    exercise_name: "Lat Pulldown (Cable)",
    exercise_key: null,
    kg: 50,
    reps: 12,
    warmup: false,
    failure: false,
    performed_on: "2026-08-01",
    rir: 2,
    ...overrides,
  };
}

describe("recentEffortQuality", () => {
  it("returns a zero rate for an empty sample", () => {
    expect(recentEffortQuality("Lat Pulldown (Cable)", [], "2026-08-03")).toEqual({
      totalSets: 0,
      hardSets: 0,
      hardRate: 0,
    });
  });

  it("counts a set as hard when failure is true", () => {
    const sets = [s({}), s({}), s({ failure: true })];
    const q = recentEffortQuality("Lat Pulldown (Cable)", sets, "2026-08-03");
    expect(q).toEqual({ totalSets: 3, hardSets: 1, hardRate: 1 / 3 });
  });

  it("counts a set as hard when rir is exactly 0", () => {
    const sets = [s({}), s({ rir: 0 })];
    const q = recentEffortQuality("Lat Pulldown (Cable)", sets, "2026-08-03");
    expect(q.hardSets).toBe(1);
    expect(q.hardRate).toBe(0.5);
  });

  it("does not count a null rir as hard", () => {
    const sets = [s({ rir: null }), s({ rir: null })];
    expect(recentEffortQuality("Lat Pulldown (Cable)", sets, "2026-08-03").hardSets).toBe(0);
  });

  it("excludes warmup sets from both numerator and denominator", () => {
    const sets = [s({ warmup: true, failure: true }), s({}), s({ failure: true })];
    const q = recentEffortQuality("Lat Pulldown (Cable)", sets, "2026-08-03");
    expect(q.totalSets).toBe(2);
    expect(q.hardSets).toBe(1);
  });

  it("excludes sets outside the 28-day window", () => {
    // 2026-08-03 minus 28 days = 2026-07-06. 07-05 is out, 07-06 is in.
    const sets = [
      s({ performed_on: "2026-07-05", failure: true }),
      s({ performed_on: "2026-07-06" }),
    ];
    const q = recentEffortQuality("Lat Pulldown (Cable)", sets, "2026-08-03");
    expect(q.totalSets).toBe(1);
    expect(q.hardSets).toBe(0);
  });

  it("matches the exercise name case-insensitively and ignores other exercises", () => {
    const sets = [
      s({ exercise_name: "LAT PULLDOWN (CABLE)" }),
      s({ exercise_name: "Seated Row (Machine)", failure: true }),
    ];
    const q = recentEffortQuality("Lat Pulldown (Cable)", sets, "2026-08-03");
    expect(q.totalSets).toBe(1);
    expect(q.hardSets).toBe(0);
  });
});
