// lib/query/fetchers/__tests__/previousSet.test.ts
//
// Regression tests for the logger's "Previous" column.
//
// The bug these pin: `augmentWarmups` emits warmup sets as SEPARATE
// `exercises` rows carrying the SAME name as the working row. So a squat
// workout stores three rows all called "Squat (Barbell)" — two warmup-only,
// then the working one. The original selector used `.find()`, took the first
// of those (a warmup row), found no working sets in it, and `continue`d past
// the ENTIRE workout — repeating for every session since warmups shipped, and
// eventually surfacing a pre-warmup workout from months earlier.
//
// Observed 2026-08-10: the athlete squatted 80 × 7 × 3 on 2026-08-03 and the
// logger showed "65 × 10" — a set from 2026-06-01, the last session logged
// before warmup augmentation existed.

import { describe, it, expect } from "vitest";
import {
  selectPreviousWorkingSet,
  type PreviousSetWorkoutRow,
} from "@/lib/query/fetchers/previousSet";

const SQUAT = "squat";

function setRow(
  set_index: number,
  kg: number,
  reps: number,
  warmup = false,
) {
  return { set_index, kg, reps, warmup };
}

/** The real shape: two same-named warmup rows, then the working row. */
function squatWorkout(date: string, workingKg: number, reps: number): PreviousSetWorkoutRow {
  return {
    date,
    exercises: [
      { name: "Squat (Barbell)", position: 0, exercise_sets: [setRow(0, workingKg * 0.6, 5, true)] },
      { name: "Squat (Barbell)", position: 1, exercise_sets: [setRow(0, workingKg * 0.85, 3, true)] },
      {
        name: "Squat (Barbell)",
        position: 2,
        exercise_sets: [
          setRow(0, workingKg, reps),
          setRow(1, workingKg, reps),
          setRow(2, workingKg, reps),
        ],
      },
    ],
  };
}

describe("selectPreviousWorkingSet — warmups stored as separate same-named rows", () => {
  it("returns the working set, not a warmup, when warmup rows come first", () => {
    const got = selectPreviousWorkingSet([squatWorkout("2026-08-03", 80, 7)], SQUAT, 1);
    expect(got).not.toBeNull();
    expect(got!.kg).toBe(80);
    expect(got!.reps).toBe(7);
    expect(got!.workout_date).toBe("2026-08-03");
    expect(got!.fallback).toBe(false);
  });

  it("does NOT skip the workout and fall through to an older one", () => {
    // The exact production failure: recent sessions all have warmup-first
    // rows; an ancient pre-warmup session sits behind them.
    const ancient: PreviousSetWorkoutRow = {
      date: "2026-06-01",
      exercises: [
        { name: "Squat (Barbell)", position: 0, exercise_sets: [setRow(0, 65, 10)] },
      ],
    };
    const got = selectPreviousWorkingSet(
      [squatWorkout("2026-08-03", 80, 7), squatWorkout("2026-07-21", 80, 8), ancient],
      SQUAT,
      1,
    );
    expect(got!.kg).toBe(80);
    expect(got!.workout_date).toBe("2026-08-03");
  });

  it("aligns ordinals across the split rows", () => {
    const w = squatWorkout("2026-08-03", 80, 7);
    // Make the three working sets distinguishable.
    w.exercises![2].exercise_sets = [
      setRow(0, 80, 7),
      setRow(1, 82.5, 5),
      setRow(2, 85, 3),
    ];
    expect(selectPreviousWorkingSet([w], SQUAT, 1)!.kg).toBe(80);
    expect(selectPreviousWorkingSet([w], SQUAT, 2)!.kg).toBe(82.5);
    expect(selectPreviousWorkingSet([w], SQUAT, 3)!.kg).toBe(85);
  });

  it("orders working sets by row position, then set_index", () => {
    // Defensive: if a workout somehow carries two non-warmup rows for one
    // exercise, set_index alone would interleave them.
    const w: PreviousSetWorkoutRow = {
      date: "2026-08-03",
      exercises: [
        { name: "Squat (Barbell)", position: 5, exercise_sets: [setRow(0, 90, 3)] },
        { name: "Squat (Barbell)", position: 2, exercise_sets: [setRow(0, 80, 7)] },
      ],
    };
    expect(selectPreviousWorkingSet([w], SQUAT, 1)!.kg).toBe(80);
    expect(selectPreviousWorkingSet([w], SQUAT, 2)!.kg).toBe(90);
  });
});

describe("selectPreviousWorkingSet — preserved behaviour", () => {
  it("flags a fallback when today's ordinal overruns the prior session", () => {
    const got = selectPreviousWorkingSet([squatWorkout("2026-08-03", 80, 7)], SQUAT, 9);
    expect(got!.fallback).toBe(true);
    expect(got!.kg).toBe(80);
  });

  it("rejects a substring false-positive from the loose server-side ILIKE", () => {
    const hack: PreviousSetWorkoutRow = {
      date: "2026-08-03",
      exercises: [
        { name: "Hack Squat (Machine)", position: 0, exercise_sets: [setRow(0, 120, 10)] },
      ],
    };
    expect(selectPreviousWorkingSet([hack], SQUAT, 1)).toBeNull();
  });

  it("skips a workout that genuinely has only warmups for the lift", () => {
    const warmupsOnly: PreviousSetWorkoutRow = {
      date: "2026-08-03",
      exercises: [
        { name: "Squat (Barbell)", position: 0, exercise_sets: [setRow(0, 50, 5, true)] },
      ],
    };
    const got = selectPreviousWorkingSet(
      [warmupsOnly, squatWorkout("2026-07-21", 80, 8)],
      SQUAT,
      1,
    );
    expect(got!.workout_date).toBe("2026-07-21");
    expect(got!.kg).toBe(80);
  });

  it("returns null when nothing matches", () => {
    expect(selectPreviousWorkingSet([], SQUAT, 1)).toBeNull();
  });
});
