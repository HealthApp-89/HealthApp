// lib/coach/interventions/__tests__/detect-inferred.test.ts
//
// TDD tests for detectInferredInterventions — written BEFORE implementation.
// Rule: every emitted candidate must have been routed through classifyDeload /
// classifySwap so planned events are never credited as interventions.
//
// Run: npx vitest run lib/coach/interventions/__tests__/detect-inferred.test.ts

import { describe, it, expect } from "vitest";
import { detectInferredInterventions } from "../detect-inferred";
import type { WorkoutSession } from "@/lib/data/workouts";
import { makeBlock } from "./fixtures";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Build a minimal WorkoutSession. */
function makeWorkout(
  date: string,
  exerciseName: string,
  kg: number,
  reps: number,
  sessionType = "Deadlift Day",
  warmup = false,
): WorkoutSession {
  return {
    id: `workout-${date}-${exerciseName}`,
    date,
    type: sessionType,
    duration_min: 60,
    source: "logger",
    exercises: [
      {
        name: exerciseName,
        position: 0,
        kind: "weighted",
        sets: [
          {
            kg,
            reps,
            duration_seconds: null,
            warmup,
            failure: false,
          },
        ],
      },
    ],
    vol: kg * reps,
    bwReps: 0,
    sets: warmup ? 0 : 1,
  };
}

// ── Test 1: Mid-block 20% load drop → reactive_deload candidate ────────────────

describe("detectInferredInterventions — mid-block 20% load drop", () => {
  it("emits one reactive_deload candidate when primary-lift load drops 20%+ in a non-deload week", () => {
    // Block: starts 2026-05-25, 5 weeks. Deload week starts 2026-06-22.
    // Workouts in weeks 1-3 only (no deload week), so phase is pre_target.
    const block = makeBlock({
      start_date: "2026-05-25",
      primary_lift: "deadlift",
      target_metric: "working_weight",
      target_value: 200,
      target_hit_at_week: null,
    });

    // Week 1: 140 kg × 5 reps
    // Week 2: 140 kg × 5 reps
    // Week 3: 110 kg × 5 reps (≈21% drop in working weight)
    const workouts: WorkoutSession[] = [
      makeWorkout("2026-05-26", "Deadlift (Barbell)", 140, 5, "Deadlift Day"),
      makeWorkout("2026-06-02", "Deadlift (Barbell)", 140, 5, "Deadlift Day"),
      makeWorkout("2026-06-09", "Deadlift (Barbell)", 110, 5, "Deadlift Day"),
    ];

    const candidates = detectInferredInterventions({
      workouts,
      block,
      primaryLift: "Deadlift (Barbell)",
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe("reactive_deload");
    // started_on should be in week 3 (on or near 2026-06-09)
    expect(candidates[0].started_on).toBe("2026-06-09");
    // context should carry block info
    expect(candidates[0].context.block_id).toBe(block.id);
  });
});

// ── Test 2: Same drop in deload week → NO candidate (planned) ─────────────────

describe("detectInferredInterventions — load drop in deload week", () => {
  it("emits NO candidate when the load drop happens during the scheduled deload week", () => {
    // Block: starts 2026-05-25. Deload week = week 5, starting 2026-06-22.
    const block = makeBlock({
      start_date: "2026-05-25",
      primary_lift: "deadlift",
      target_metric: "working_weight",
      target_value: 200,
      target_hit_at_week: null,
    });

    // Weeks 1-4: 140 kg. Week 5 (deload): 112 kg (20% planned drop).
    const workouts: WorkoutSession[] = [
      makeWorkout("2026-05-26", "Deadlift (Barbell)", 140, 5, "Deadlift Day"),
      makeWorkout("2026-06-02", "Deadlift (Barbell)", 140, 5, "Deadlift Day"),
      makeWorkout("2026-06-09", "Deadlift (Barbell)", 140, 5, "Deadlift Day"),
      makeWorkout("2026-06-16", "Deadlift (Barbell)", 140, 5, "Deadlift Day"),
      makeWorkout("2026-06-23", "Deadlift (Barbell)", 112, 5, "Deadlift Day"), // deload week
    ];

    const candidates = detectInferredInterventions({
      workouts,
      block,
      primaryLift: "Deadlift (Barbell)",
    });

    expect(candidates).toHaveLength(0);
  });
});

// ── Test 3: Exercise leaves a slot mid-block → exercise_swap candidate ─────────

describe("detectInferredInterventions — exercise swap mid-block", () => {
  it("emits one exercise_swap candidate when an exercise leaves a session type mid-block", () => {
    // Block: starts 2026-05-25. Weeks 1-2 have Romanian Deadlift; week 3 has Hip Thrust.
    // That's a mid-block swap (not block-boundary week) → reactive.
    const block = makeBlock({
      start_date: "2026-05-25",
      primary_lift: "deadlift",
      target_metric: "working_weight",
      target_value: 200,
    });

    const workouts: WorkoutSession[] = [
      // Week 1: session has Romanian Deadlift
      makeWorkout("2026-05-26", "Romanian Deadlift", 60, 10, "Legs Day"),
      // Week 2: same exercise
      makeWorkout("2026-06-02", "Romanian Deadlift", 62, 10, "Legs Day"),
      // Week 3: Romanian Deadlift gone, Hip Thrust Machine appears
      makeWorkout("2026-06-09", "Hip Thrust (Machine)", 80, 10, "Legs Day"),
    ];

    const candidates = detectInferredInterventions({
      workouts,
      block,
      primaryLift: "Deadlift (Barbell)",
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe("exercise_swap");
    // started_on should be at the first week the new exercise appeared
    expect(candidates[0].started_on).toBe("2026-06-09");
    expect(candidates[0].context.block_id).toBe(block.id);
    expect(candidates[0].context.from_exercise).toBe("Romanian Deadlift");
    expect(candidates[0].context.to_exercise).toBe("Hip Thrust (Machine)");
  });
});

// ── Test 4: Empty input → [] no throw ──────────────────────────────────────────

describe("detectInferredInterventions — empty input", () => {
  it("returns empty array without throwing when workouts are empty", () => {
    const block = makeBlock({});
    expect(() =>
      detectInferredInterventions({ workouts: [], block, primaryLift: "Deadlift (Barbell)" }),
    ).not.toThrow();
    const result = detectInferredInterventions({
      workouts: [],
      block,
      primaryLift: "Deadlift (Barbell)",
    });
    expect(result).toEqual([]);
  });
});

// ── Test 5: Trivial load change does NOT trigger a deload candidate ─────────────

describe("detectInferredInterventions — trivial load change ignored", () => {
  it("does not emit a reactive_deload for a <10% load change", () => {
    const block = makeBlock({
      start_date: "2026-05-25",
      primary_lift: "deadlift",
      target_metric: "working_weight",
      target_value: 200,
    });

    const workouts: WorkoutSession[] = [
      makeWorkout("2026-05-26", "Deadlift (Barbell)", 140, 5, "Deadlift Day"),
      makeWorkout("2026-06-02", "Deadlift (Barbell)", 135, 5, "Deadlift Day"), // ~3.6% drop
    ];

    const candidates = detectInferredInterventions({
      workouts,
      block,
      primaryLift: "Deadlift (Barbell)",
    });

    expect(candidates.filter((c) => c.kind === "reactive_deload")).toHaveLength(0);
  });
});

// ── Test 6: Order independence — unsorted input → same candidates ───────────────

describe("detectInferredInterventions — order independence", () => {
  it("produces the same result regardless of input workout ordering", () => {
    const block = makeBlock({
      start_date: "2026-05-25",
      primary_lift: "deadlift",
      target_metric: "working_weight",
      target_value: 200,
      target_hit_at_week: null,
    });

    const sortedWorkouts: WorkoutSession[] = [
      makeWorkout("2026-05-26", "Deadlift (Barbell)", 140, 5, "Deadlift Day"),
      makeWorkout("2026-06-02", "Deadlift (Barbell)", 140, 5, "Deadlift Day"),
      makeWorkout("2026-06-09", "Deadlift (Barbell)", 110, 5, "Deadlift Day"),
    ];
    const reversedWorkouts = [...sortedWorkouts].reverse();

    const resultSorted = detectInferredInterventions({
      workouts: sortedWorkouts,
      block,
      primaryLift: "Deadlift (Barbell)",
    });
    const resultReversed = detectInferredInterventions({
      workouts: reversedWorkouts,
      block,
      primaryLift: "Deadlift (Barbell)",
    });

    expect(resultSorted.length).toBe(resultReversed.length);
    if (resultSorted.length > 0) {
      expect(resultSorted[0].kind).toBe(resultReversed[0].kind);
      expect(resultSorted[0].started_on).toBe(resultReversed[0].started_on);
    }
  });
});
