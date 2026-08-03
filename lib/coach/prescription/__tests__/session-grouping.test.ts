import { describe, expect, it } from "vitest";
import {
  sessionsForExercise,
  isCleanSet,
  isStrainedSet,
} from "@/lib/coach/prescription/session-grouping";
import type { WorkoutSetSample } from "@/lib/coach/prescription/types";

function s(overrides: Partial<WorkoutSetSample> = {}): WorkoutSetSample {
  return {
    exercise_name: "Squat (Barbell)",
    exercise_key: null,
    kg: 100,
    reps: 6,
    warmup: false,
    failure: false,
    performed_on: "2026-07-06",
    rir: 2,
    ...overrides,
  };
}

describe("sessionsForExercise", () => {
  it("groups sets by date, newest session first", () => {
    const out = sessionsForExercise(
      [
        s({ performed_on: "2026-06-29" }),
        s({ performed_on: "2026-07-06" }),
        s({ performed_on: "2026-07-06" }),
      ],
      "Squat (Barbell)",
    );
    expect(out.map((x) => x.date)).toEqual(["2026-07-06", "2026-06-29"]);
    expect(out[0].sets).toHaveLength(2);
    expect(out[1].sets).toHaveLength(1);
  });

  it("excludes warmup sets", () => {
    const out = sessionsForExercise([s({ warmup: true }), s({})], "Squat (Barbell)");
    expect(out).toHaveLength(1);
    expect(out[0].sets).toHaveLength(1);
  });

  it("drops a session that contributed only warmup sets", () => {
    const out = sessionsForExercise(
      [s({ performed_on: "2026-06-29", warmup: true }), s({ performed_on: "2026-07-06" })],
      "Squat (Barbell)",
    );
    expect(out.map((x) => x.date)).toEqual(["2026-07-06"]);
  });

  it("matches the exercise name case- and whitespace-insensitively", () => {
    const out = sessionsForExercise([s({ exercise_name: "  SQUAT (BARBELL) " })], "Squat (Barbell)");
    expect(out).toHaveLength(1);
  });

  it("ignores other exercises", () => {
    const out = sessionsForExercise([s({ exercise_name: "Deadlift (Barbell)" })], "Squat (Barbell)");
    expect(out).toEqual([]);
  });

  it("returns an empty array for no history", () => {
    expect(sessionsForExercise([], "Squat (Barbell)")).toEqual([]);
  });
});

describe("isCleanSet", () => {
  it("is clean when reps and RIR both meet the prescription", () => {
    expect(isCleanSet(s({ reps: 6, rir: 2 }), 6, 2)).toBe(true);
  });

  it("is dirty on failure regardless of RIR", () => {
    expect(isCleanSet(s({ rir: 4, failure: true }), 6, 2)).toBe(false);
  });

  it("is dirty when reps fall short", () => {
    expect(isCleanSet(s({ reps: 4 }), 6, 2)).toBe(false);
  });

  it("is dirty when RIR is below the prescription", () => {
    expect(isCleanSet(s({ rir: 0 }), 6, 2)).toBe(false);
  });

  it("ignores RIR when it is null (legacy rows)", () => {
    expect(isCleanSet(s({ rir: null }), 6, 2)).toBe(true);
  });

  it("ignores RIR when the field is absent entirely", () => {
    const legacy = s();
    delete (legacy as { rir?: number | null }).rir;
    expect(isCleanSet(legacy, 6, 2)).toBe(true);
  });

  it("treats over-target RIR as merely clean", () => {
    expect(isCleanSet(s({ rir: 4 }), 6, 2)).toBe(true);
  });
});

describe("isStrainedSet", () => {
  it("is strained on failure", () => {
    expect(isStrainedSet(s({ failure: true }), 2)).toBe(true);
  });

  it("is strained when RIR is below the prescription", () => {
    expect(isStrainedSet(s({ rir: 0 }), 2)).toBe(true);
  });

  it("is NOT strained when reps fall short but RIR is fine (athlete chose to stop)", () => {
    expect(isStrainedSet(s({ reps: 2, rir: 3 }), 2)).toBe(false);
  });

  it("is NOT strained when RIR is unrecorded, even with short reps", () => {
    expect(isStrainedSet(s({ reps: 2, rir: null }), 2)).toBe(false);
  });
});
