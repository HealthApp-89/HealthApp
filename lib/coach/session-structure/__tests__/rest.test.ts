// lib/coach/session-structure/__tests__/rest.test.ts
//
// First test coverage this module has ever had. The rest table was previously
// verified by nothing — annotateSession is imported only by an audit script
// that makes no rest assertions.
//
// Every exercise name below was checked against BOTH lookup tables, which use
// DIFFERENT normalizers: FATIGUE_TIER (via normalize() in
// exercise-categories.ts) decides the tier, EXERCISE_MUSCLES (via
// normalizeExerciseName()) decides the large/small split. A name missing from
// the second one classifies as "small" silently rather than erroring, so
// substituting names here without checking both maps weakens the test without
// failing it.

import { describe, it, expect } from "vitest";
import {
  REST_SECONDS,
  TRANSITION_BUFFER_SECONDS,
  isolationSize,
  restSecondsFor,
} from "@/lib/coach/session-structure/rules";
import { tierOf } from "@/lib/coach/session-structure/tiers";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

// PlannedExercise requires only `name`; every other field is optional, so no
// cast is needed here.
function ex(name: string, over: Partial<PlannedExercise> = {}): PlannedExercise {
  return { name, sets: 3, reps: "8", ...over };
}

describe("isolationSize", () => {
  it("classifies a large-muscle isolation as large", () => {
    expect(isolationSize("Chest Fly")).toBe("large");
    expect(isolationSize("Leg Extension (Machine)")).toBe("large");
    expect(isolationSize("Leg Curl (Machine)")).toBe("large");
  });

  it("classifies a small-muscle isolation as small", () => {
    expect(isolationSize("Lateral Raise (Dumbbell)")).toBe("small");
    expect(isolationSize("Triceps Pushdown")).toBe("small");
    expect(isolationSize("Bicep Curl (Dumbbell)")).toBe("small");
  });

  it("resolves a mixed large+small primary set to large", () => {
    // "chin up" maps to primary [Lats, Biceps] — one large, one small.
    expect(isolationSize("Chin Up")).toBe("large");
  });

  it("falls back to small for an unmapped exercise name", () => {
    expect(isolationSize("Zercher Good Morning")).toBe("small");
  });
});

describe("restSecondsFor", () => {
  it("gives a heavy compound 4 minutes", () => {
    const e = ex("Squat (Barbell)");
    expect(tierOf(e)).toBe(1);
    expect(restSecondsFor(e, 1)).toBe(240);
  });

  it("gives a secondary compound 3 minutes", () => {
    const e = ex("Seated Cable Row");
    expect(tierOf(e)).toBe(2);
    expect(restSecondsFor(e, 2)).toBe(180);
  });

  it("gives a large-muscle isolation 2 minutes", () => {
    const e = ex("Chest Fly");
    expect(tierOf(e)).toBe(3);
    expect(restSecondsFor(e, 3)).toBe(120);
  });

  it("gives a small-muscle isolation 60 seconds", () => {
    const e = ex("Lateral Raise (Dumbbell)");
    expect(tierOf(e)).toBe(3);
    expect(restSecondsFor(e, 3)).toBe(60);
  });

  it("gives a warm-up ramp and a finisher 45 seconds", () => {
    expect(restSecondsFor(ex("Squat (Barbell)", { warmup: true }), 0)).toBe(45);
    expect(restSecondsFor(ex("Plank"), 4)).toBe(45);
  });

  it("ignores the rep target — a 5-rep and a 10-rep squat rest the same", () => {
    expect(restSecondsFor(ex("Squat (Barbell)", { reps: "5" }), 1)).toBe(
      restSecondsFor(ex("Squat (Barbell)", { reps: "10" }), 1),
    );
  });

  it("exposes the constants the annotation layer builds on", () => {
    expect(REST_SECONDS.lastWarmup).toBe(120);
    expect(TRANSITION_BUFFER_SECONDS).toBe(60);
  });
});
