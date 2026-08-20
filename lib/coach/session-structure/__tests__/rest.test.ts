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
import { tierOf, getFatigueTier } from "@/lib/coach/session-structure/tiers";
import { annotateSession } from "@/lib/coach/session-structure/annotate";
import { SESSION_PLANS, type PlannedExercise } from "@/lib/coach/sessionPlans";

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

  it("splits tier 1 by the size of the PRIMARY mover, not by tier alone", () => {
    // Recalibrated 2026-08-20 from the athlete's own recorded rest: he takes
    // 4:01 on squat/deadlift/bench and 2:31 on the overhead press. Same tier,
    // same relative intensity, a fraction of the systemic cost — 35 kg
    // overhead is not 85 kg on the back. Reuses isolationSize rather than
    // inventing a second taxonomy.
    for (const heavy of ["Squat (Barbell)", "Deadlift (Barbell)", "Bench Press (Barbell)"]) {
      expect(restSecondsFor(ex(heavy), 1), heavy).toBe(240);
    }
    expect(restSecondsFor(ex("Overhead Press (Barbell)"), 1)).toBe(150);
  });

  it("gives a secondary compound 2 minutes", () => {
    const e = ex("Seated Cable Row");
    expect(tierOf(e)).toBe(2);
    expect(restSecondsFor(e, 2)).toBe(120);
  });

  it("gives a large-muscle isolation 75 seconds", () => {
    const e = ex("Chest Fly");
    expect(tierOf(e)).toBe(3);
    expect(restSecondsFor(e, 3)).toBe(75);
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
    expect(s.exercises[3].rest_seconds).toBe(120);
  });

  it("bumps the LAST warm-up before the first working exercise, not the first warm-up", () => {
    const s = annotateSession(liftingDay());
    expect(s.exercises[0].rest_seconds).toBe(45);
    expect(s.exercises[1].rest_seconds).toBe(120);
  });

  it("no-ops the bump on a session with no warm-ups", () => {
    const s = annotateSession([ex("Seated Cable Row"), ex("Chest Fly")]);
    expect(s.exercises.map((e) => e.rest_seconds)).toEqual([120, 75]);
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
    expect(s.exercises[2].transition_seconds).toBe(300); // into the squat: 240 + 60
    expect(s.exercises[3].transition_seconds).toBe(180); // into the row:   120 + 60
  });

  it("gives no transition into an isolation or a finisher", () => {
    // The buffer buys plate loading and a fresh start on a lift where arriving
    // tired costs load. Walking to a cable stack needs neither, and charging
    // for it produced two minutes between consecutive foam rolls on Mobility.
    const s = annotateSession(liftingDay());
    expect(s.exercises[4].transition_seconds).toBeNull(); // leg extension
    expect(s.exercises[5].transition_seconds).toBeNull(); // lateral raise
    expect(s.exercises[6].transition_seconds).toBeNull(); // plank
  });

  it("gives a whole mobility session no transitions at all", () => {
    const s = annotateSession([
      ex("Cat-Cow"),
      ex("Foam Roll: Quads"),
      ex("Child's Pose"),
    ]);
    expect(s.exercises.map((e) => e.transition_seconds)).toEqual([null, null, null]);
  });

  it("leaves transition_seconds null on the first exercise and on every warm-up", () => {
    const s = annotateSession(liftingDay());
    expect(s.exercises[0].transition_seconds).toBeNull();
    expect(s.exercises[1].transition_seconds).toBeNull();
  });

  it("derives the transition from the prescription, not from a bumped warm-up value", () => {
    // The exercise at index 1 is bumped to 120s of REST, but it is a warm-up,
    // so it contributes no transition at all.
    const s = annotateSession(liftingDay());
    expect(s.exercises[1].rest_seconds).toBe(120);
    expect(s.exercises[1].transition_seconds).toBeNull();
  });
});

describe("rest_seconds_override — the athlete's own value", () => {
  it("beats the tier table", () => {
    // The escape hatch for exercises the tier system over-classifies: correct
    // about which muscle, wrong about what the movement costs.
    const e = ex("Hip Thrust (Machine)");
    expect(restSecondsFor(e, 2)).toBe(120);
    expect(restSecondsFor({ ...e, rest_seconds_override: 90 }, 2)).toBe(90);
  });

  it("is set on the entries the athlete called out on 2026-08-20", () => {
    const hip = SESSION_PLANS["Lower B"]!.find((e) => e.name === "Hip Thrust (Machine)")!;
    expect(hip.rest_seconds_override).toBe(90);
    const pullover = SESSION_PLANS.Back!.find((e) => e.name === "Pullover (Dumbbell)")!;
    expect(pullover.rest_seconds_override).toBe(60);
    // Pullover's recorded ratio was 0.34 — told 3:00, took 1:02 — the lowest
    // in the dataset. The override matches what he actually does.
    expect(restSecondsFor(pullover, getFatigueTier(pullover.name, false))).toBe(60);
  });

  it("does not leak onto exercises the tier table gets right", () => {
    for (const name of ["Seated Row (Machine)", "Lat Pulldown (Cable)", "Leg Press"]) {
      const e = SESSION_PLANS["Upper A"]?.find((x) => x.name === name)
        ?? SESSION_PLANS["Upper B"]?.find((x) => x.name === name)
        ?? SESSION_PLANS["Lower B"]?.find((x) => x.name === name);
      if (!e) continue;
      expect(e.rest_seconds_override, name).toBeUndefined();
      expect(restSecondsFor(e, getFatigueTier(e.name, false)), name).toBe(120);
    }
  });
});
