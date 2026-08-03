import { describe, expect, it } from "vitest";
import { lastWeekClean, consecutiveMisses } from "@/lib/coach/prescription/prescribe-week";
import type { WorkoutSetSample } from "@/lib/coach/prescription/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

function set(
  date: string,
  kg: number,
  reps: number,
  extra: Partial<WorkoutSetSample> = {},
): WorkoutSetSample {
  return {
    exercise_name: "X",
    exercise_key: null,
    kg,
    reps,
    warmup: false,
    failure: false,
    performed_on: date,
    rir: 2,
    ...extra,
  };
}

const EX: PlannedExercise = { name: "X", baseReps: 8, sets: 3, rir: 2 };

describe("lastWeekClean — production regressions", () => {
  it("is dirty when a deadlift session opens clean and ends in failure", () => {
    // 2026-07-23: 90x8 @2, 90x8 @1, 90x8 FAIL @0 — previously read CLEAN.
    const sets = [
      set("2026-07-23", 90, 8, { rir: 2 }),
      set("2026-07-23", 90, 8, { rir: 1 }),
      set("2026-07-23", 90, 8, { rir: 0, failure: true }),
    ];
    expect(lastWeekClean(sets, EX, 2)).toBe(false);
  });

  it("is dirty when an overhead press session collapses after set one", () => {
    // 2026-07-22: 30x10 @2, 30x10 FAIL @0, 30x9 FAIL @0 — previously read CLEAN.
    const ohp: PlannedExercise = { name: "X", baseReps: 10, sets: 3, rir: 2 };
    const sets = [
      set("2026-07-22", 30, 10, { rir: 2 }),
      set("2026-07-22", 30, 10, { rir: 0, failure: true }),
      set("2026-07-22", 30, 9, { rir: 0, failure: true }),
    ];
    expect(lastWeekClean(sets, ohp, 2)).toBe(false);
  });

  it("is clean when every working set of the latest session is clean", () => {
    const sets = [
      set("2026-07-23", 90, 8),
      set("2026-07-23", 90, 8),
      set("2026-07-23", 90, 8),
    ];
    expect(lastWeekClean(sets, EX, 2)).toBe(true);
  });

  it("judges only the latest session, ignoring older dirty ones", () => {
    const sets = [
      set("2026-07-23", 90, 8),
      set("2026-07-16", 90, 8, { failure: true }),
    ];
    expect(lastWeekClean(sets, EX, 2)).toBe(true);
  });

  it("is dirty with no history at all", () => {
    expect(lastWeekClean([], EX, 2)).toBe(false);
  });

  it("is dirty when a compliant reps-short set is present (no step earned)", () => {
    const sets = [set("2026-07-23", 90, 8), set("2026-07-23", 90, 5, { rir: 3 })];
    expect(lastWeekClean(sets, EX, 2)).toBe(false);
  });
});

describe("consecutiveMisses — counts strained sessions", () => {
  it("counts consecutive sessions containing a strained set", () => {
    const sets = [
      set("2026-07-23", 90, 8, { rir: 0 }),
      set("2026-07-16", 90, 8, { failure: true }),
      set("2026-07-09", 90, 8),
    ];
    expect(consecutiveMisses(sets, EX, 2)).toBe(2);
  });

  it("stops at the first unstrained session", () => {
    const sets = [
      set("2026-07-23", 90, 8, { rir: 0 }),
      set("2026-07-16", 90, 8),
      set("2026-07-09", 90, 8, { failure: true }),
    ];
    expect(consecutiveMisses(sets, EX, 2)).toBe(1);
  });

  it("does NOT count a compliant reps-short session as a miss", () => {
    // Athlete chose to stop: reps short, RIR at target, no failure.
    const sets = [set("2026-07-23", 90, 4, { rir: 3 })];
    expect(consecutiveMisses(sets, EX, 2)).toBe(0);
  });

  it("does NOT count reps-short with unrecorded RIR as a miss", () => {
    const sets = [set("2026-07-23", 90, 4, { rir: null })];
    expect(consecutiveMisses(sets, EX, 2)).toBe(0);
  });

  it("counts a whole session once even when several of its sets are strained", () => {
    const sets = [
      set("2026-07-23", 90, 8, { rir: 0 }),
      set("2026-07-23", 90, 8, { failure: true }),
    ];
    expect(consecutiveMisses(sets, EX, 2)).toBe(1);
  });

  it("returns 0 with no history", () => {
    expect(consecutiveMisses([], EX, 2)).toBe(0);
  });

  it("honours a per-exercise rir override above the week target", () => {
    const sets = [set("2026-07-23", 90, 8, { rir: 2 })];
    expect(consecutiveMisses(sets, { ...EX, rir: 3 }, 2)).toBe(1);
  });
});
