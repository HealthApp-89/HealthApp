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
import { annotateSession } from "@/lib/coach/session-structure/annotate";
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

/** A realistic lifting day: two ramp warm-ups on the opening compound, then a
 *  secondary, a large isolation, a small isolation, and a core finisher.
 *  Tier sequence 0,0,1,2,3,3,4 is strictly ascending, so this fixture raises
 *  no ordering warnings and exercises the plain annotation path. */
function liftingDay(): PlannedExercise[] {
  return [
    ex("Squat (Barbell)", { warmup: true, reps: "5" }),
    ex("Squat (Barbell)", { warmup: true, reps: "3" }),
    ex("Squat (Barbell)", { reps: "5" }),
    ex("Seated Cable Row"),
    ex("Leg Extension (Machine)"),
    ex("Lateral Raise (Dumbbell)"),
    ex("Plank"),
  ];
}

describe("annotateSession — rest", () => {
  it("prescribes one number per exercise, not a range", () => {
    const s = annotateSession(liftingDay());
    expect(typeof s.exercises[2].rest_seconds).toBe("number");
    expect(s.exercises[2].rest_seconds).toBe(240);
    expect(s.exercises[3].rest_seconds).toBe(180);
  });

  it("bumps the LAST warm-up before the first working exercise, not the first warm-up", () => {
    const s = annotateSession(liftingDay());
    expect(s.exercises[0].rest_seconds).toBe(45);
    expect(s.exercises[1].rest_seconds).toBe(120);
  });

  it("no-ops the bump on a session with no warm-ups", () => {
    const s = annotateSession([ex("Seated Cable Row"), ex("Chest Fly")]);
    expect(s.exercises.map((e) => e.rest_seconds)).toEqual([180, 120]);
  });

  it("no-ops the bump when every entry is a warm-up", () => {
    const s = annotateSession([
      ex("Squat (Barbell)", { warmup: true }),
      ex("Squat (Barbell)", { warmup: true }),
    ]);
    expect(s.exercises.map((e) => e.rest_seconds)).toEqual([45, 45]);
  });

  it("sets transition_seconds to the incoming exercise's rest plus a minute", () => {
    const s = annotateSession(liftingDay());
    expect(s.exercises[3].transition_seconds).toBe(240); // into the row: 180 + 60
    expect(s.exercises[4].transition_seconds).toBe(180); // into leg ext: 120 + 60
    expect(s.exercises[5].transition_seconds).toBe(120); // into lateral: 60 + 60
    expect(s.exercises[6].transition_seconds).toBe(105); // into plank: 45 + 60
  });

  it("leaves transition_seconds null on the first exercise and on every warm-up", () => {
    const s = annotateSession(liftingDay());
    expect(s.exercises[0].transition_seconds).toBeNull();
    expect(s.exercises[1].transition_seconds).toBeNull();
    expect(s.exercises[2].transition_seconds).toBe(300); // into the squat: 240 + 60
  });

  it("derives the transition from the prescription, not from a bumped warm-up value", () => {
    // The exercise at index 1 is bumped to 120s of REST, but it is a warm-up,
    // so it contributes no transition at all.
    const s = annotateSession(liftingDay());
    expect(s.exercises[1].rest_seconds).toBe(120);
    expect(s.exercises[1].transition_seconds).toBeNull();
  });
});
