import { describe, expect, it } from "vitest";
import {
  prescribeAccessoryFromVolumeBand,
  isEffortSuppressed,
  HARD_RATE_SUPPRESS_THRESHOLD,
  MIN_SETS_FOR_EFFORT_GATE,
} from "@/lib/coach/prescription/volume-balance-rule";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

const ex: PlannedExercise = { name: "Lat Pulldown (Cable)", baseKg: 50, baseReps: 12, sets: 3 };

describe("effort gate on the volume bump", () => {
  it("adds a set below MEV when effort is clean", () => {
    const out = prescribeAccessoryFromVolumeBand({
      baseExercise: ex, currentSets: 3, bandPosition: "below_mev",
      hardRate: 0, effortSampleSets: 6,
    });
    expect(out.sets).toBe(4);
  });

  it("holds below MEV when more than a third of recent sets were hard", () => {
    const out = prescribeAccessoryFromVolumeBand({
      baseExercise: ex, currentSets: 3, bandPosition: "below_mev",
      hardRate: 0.5, effortSampleSets: 6,
    });
    expect(out.sets).toBe(3);
  });

  it("still adds a set at exactly one third (one hard finishing set is acceptable)", () => {
    const out = prescribeAccessoryFromVolumeBand({
      baseExercise: ex, currentSets: 3, bandPosition: "below_mev",
      hardRate: HARD_RATE_SUPPRESS_THRESHOLD, effortSampleSets: 3,
    });
    expect(out.sets).toBe(4);
  });

  it("ignores the gate when the effort sample is too small", () => {
    const out = prescribeAccessoryFromVolumeBand({
      baseExercise: ex, currentSets: 3, bandPosition: "below_mev",
      hardRate: 1, effortSampleSets: MIN_SETS_FOR_EFFORT_GATE - 1,
    });
    expect(out.sets).toBe(4);
  });

  it("applies the gate to at_mev as well as below_mev", () => {
    const out = prescribeAccessoryFromVolumeBand({
      baseExercise: ex, currentSets: 3, bandPosition: "at_mev",
      hardRate: 0.9, effortSampleSets: 10,
    });
    expect(out.sets).toBe(3);
  });

  it("never suppresses the above_mrv set drop", () => {
    const out = prescribeAccessoryFromVolumeBand({
      baseExercise: ex, currentSets: 4, bandPosition: "above_mrv",
      hardRate: 0.9, effortSampleSets: 10,
    });
    expect(out.sets).toBe(3);
    expect(
      isEffortSuppressed({
        baseExercise: ex, currentSets: 4, bandPosition: "above_mrv",
        hardRate: 0.9, effortSampleSets: 10,
      }),
    ).toBe(false);
  });

  it("behaves exactly as before when the effort fields are omitted", () => {
    expect(
      prescribeAccessoryFromVolumeBand({ baseExercise: ex, currentSets: 3, bandPosition: "below_mev" }).sets,
    ).toBe(4);
    expect(
      prescribeAccessoryFromVolumeBand({ baseExercise: ex, currentSets: 3, bandPosition: "in_band" }).sets,
    ).toBe(3);
  });
});
