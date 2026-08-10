import { describe, it, expect } from "vitest";
import { isFinalWorkingSet, effortBand, ordinal } from "@/lib/coach/live-session/helpers";
import type { ExerciseDraft, ExerciseSetDraft } from "@/lib/logger/types";

function mkSet(over: Partial<ExerciseSetDraft> = {}): ExerciseSetDraft {
  return {
    set_index: 0,
    kg: 60,
    reps: 10,
    duration_seconds: null,
    warmup: false,
    failure: false,
    rir: 2,
    committed_at: "2026-08-10T09:00:00.000Z",
    ...over,
  };
}

function mkExercise(sets: ExerciseSetDraft[]): ExerciseDraft {
  return {
    name: "Decline Bench Press (Barbell)",
    position: 0,
    prescribed: { name: "Decline Bench Press (Barbell)", baseKg: 60, baseReps: 10, sets: 3 },
    sets,
  };
}

describe("effortBand", () => {
  it("classifies two or more reps in reserve above target as easy", () => {
    expect(effortBand(mkSet({ rir: 4 }), 2)).toBe("easy");
    expect(effortBand(mkSet({ rir: 5 }), 3)).toBe("easy");
  });

  it("treats one rep above target as on-target, not easy", () => {
    // One rep is inside normal RIR-estimation error; it must not move a load.
    expect(effortBand(mkSet({ rir: 3 }), 2)).toBe("on");
    expect(effortBand(mkSet({ rir: 2 }), 2)).toBe("on");
  });

  it("classifies below-target RIR as strained", () => {
    expect(effortBand(mkSet({ rir: 1 }), 2)).toBe("strained");
    expect(effortBand(mkSet({ rir: 0 }), 2)).toBe("strained");
  });

  it("treats a failure-flagged set as strained regardless of RIR", () => {
    expect(effortBand(mkSet({ rir: 4, failure: true }), 2)).toBe("strained");
  });

  it("returns null when RIR was not recorded", () => {
    expect(effortBand(mkSet({ rir: null }), 2)).toBeNull();
  });
});

describe("isFinalWorkingSet", () => {
  it("is true for the highest-indexed non-warmup set", () => {
    const sets = [
      mkSet({ set_index: 0, warmup: true }),
      mkSet({ set_index: 1 }),
      mkSet({ set_index: 2 }),
    ];
    expect(isFinalWorkingSet(mkExercise(sets), sets[2])).toBe(true);
    expect(isFinalWorkingSet(mkExercise(sets), sets[1])).toBe(false);
  });

  it("ignores warmups when they sit after working sets", () => {
    const sets = [mkSet({ set_index: 0 }), mkSet({ set_index: 1, warmup: true })];
    expect(isFinalWorkingSet(mkExercise(sets), sets[0])).toBe(true);
  });

  it("is false for a warmup set", () => {
    const sets = [mkSet({ set_index: 0, warmup: true }), mkSet({ set_index: 1 })];
    expect(isFinalWorkingSet(mkExercise(sets), sets[0])).toBe(false);
  });
});

describe("ordinal", () => {
  it("renders English ordinals for the counts the guardrails use", () => {
    expect(ordinal(2)).toBe("2nd");
    expect(ordinal(3)).toBe("3rd");
    expect(ordinal(4)).toBe("4th");
    expect(ordinal(11)).toBe("11th");
    expect(ordinal(21)).toBe("21st");
  });
});
