// lib/coach/plan-builder/__tests__/constraint-aware-exercises.test.ts
//
// Tests for applyConstraintAwareSelection — pure, deterministic function.
//
// All tests use a stub getSubstitute for full determinism (no library dependency).
// The real getSubstitute (defaultGetSubstitute) is tested via a separate smoke test.
//
// Test axes:
//   1. No constraints + no identity → exercises unchanged, adjustments: []
//   2. Exercise on constraints.exercise_exclusions → substituted + logged
//   3. Injury-conflicting exercise (jointStress overlap) → substituted + logged
//   4. Equipment-unavailable exercise (home_gym + cable-only) → substituted + logged
//   5. Latitude accessory with an identity top_exercise match → substituted + logged
//   6. Already-preferred top_exercise → no swap (no adjustments)
//   7. Main lift role → no identity swap attempted (only hard constraints)
//   8. Warmup exercises → never substituted (pass through unchanged)
//   9. No substitute found → exercise kept as-is, no adjustment logged
//  10. Both hard + soft conditions → hard takes priority, identity not evaluated

import { describe, it, expect } from "vitest";
import {
  applyConstraintAwareSelection,
  type GetSubstituteFn,
} from "@/lib/coach/plan-builder/constraint-aware-exercises";
import type { ConstraintPayload, IdentityPayload } from "@/lib/coach/intelligence/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

// ─────────────────────────────────────────────────────────────────────────────
// Stubs
// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic stub: always returns "Incline Bench Press (Dumbbell)" regardless of input. */
const STUB_SUBSTITUTE: GetSubstituteFn = () => "Incline Bench Press (Dumbbell)";

/** Stub that returns null — simulates "no substitute found". */
const STUB_NO_SUBSTITUTE: GetSubstituteFn = () => null;

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

function makePlanned(name: string, overrides: Partial<PlannedExercise> = {}): PlannedExercise {
  return { name, baseKg: 60, baseReps: 8, sets: 3, ...overrides };
}

const EMPTY_CONSTRAINTS: ConstraintPayload = {
  active_injuries: [],
  exercise_exclusions: [],
  equipment_access: "commercial_gym",
  schedule_constraints: [],
};

const EMPTY_IDENTITY: IdentityPayload = {
  top_exercises: {
    lower: [],
    upper: [],
    pulls: [],
    isolation: [],
  },
  eating_identity: {
    top_proteins: [],
    top_carbs: [],
    top_fats: [],
    cuisines: [],
    monotone_flags: [],
  },
  training_style_signature: {
    volume_preference: "moderate",
    intensity_distribution_percent: null,
    recovery_speed_days: null,
    session_duration_preference_min: null,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Test 1 — no constraints + no identity → unchanged
// ─────────────────────────────────────────────────────────────────────────────

describe("applyConstraintAwareSelection — no intelligence", () => {
  it("returns exercises unchanged with empty adjustments when constraints and identity are both absent", () => {
    const exercises = [
      makePlanned("Decline Bench Press (Barbell)"),
      makePlanned("Chest Fly (Cable)"),
    ];
    const result = applyConstraintAwareSelection({ exercises });
    expect(result.exercises).toEqual(exercises);
    expect(result.adjustments).toEqual([]);
  });

  it("returns exercises unchanged with empty adjustments when constraints and identity are both null", () => {
    const exercises = [makePlanned("Squat (Barbell)")];
    const result = applyConstraintAwareSelection({
      exercises,
      constraints: null,
      identity: null,
    });
    expect(result.exercises).toEqual(exercises);
    expect(result.adjustments).toEqual([]);
  });

  it("empty exercise list returns empty list with no adjustments", () => {
    const result = applyConstraintAwareSelection({
      exercises: [],
      constraints: EMPTY_CONSTRAINTS,
      identity: EMPTY_IDENTITY,
    });
    expect(result.exercises).toEqual([]);
    expect(result.adjustments).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2 — exercise on exercise_exclusions → substituted
// ─────────────────────────────────────────────────────────────────────────────

describe("applyConstraintAwareSelection — explicit exclusion", () => {
  it("replaces excluded exercise and logs adjustment", () => {
    const excluded = makePlanned("Decline Bench Press (Barbell)");
    const constraints: ConstraintPayload = {
      ...EMPTY_CONSTRAINTS,
      exercise_exclusions: ["Decline Bench Press (Barbell)"],
    };

    const result = applyConstraintAwareSelection({
      exercises: [excluded],
      constraints,
      getSubstitute: STUB_SUBSTITUTE,
    });

    expect(result.exercises[0].name).toBe("Incline Bench Press (Dumbbell)");
    expect(result.adjustments).toHaveLength(1);
    expect(result.adjustments[0].from).toBe("Decline Bench Press (Barbell)");
    expect(result.adjustments[0].to).toBe("Incline Bench Press (Dumbbell)");
    expect(result.adjustments[0].reason).toMatch(/excluded/i);
  });

  it("exclusion comparison is case-insensitive", () => {
    const constraints: ConstraintPayload = {
      ...EMPTY_CONSTRAINTS,
      exercise_exclusions: ["decline bench press (barbell)"],
    };

    const result = applyConstraintAwareSelection({
      exercises: [makePlanned("Decline Bench Press (Barbell)")],
      constraints,
      getSubstitute: STUB_SUBSTITUTE,
    });

    expect(result.exercises[0].name).toBe("Incline Bench Press (Dumbbell)");
    expect(result.adjustments).toHaveLength(1);
  });

  it("keeps exercise unchanged (no adjustment logged) when no substitute is found", () => {
    const constraints: ConstraintPayload = {
      ...EMPTY_CONSTRAINTS,
      exercise_exclusions: ["Decline Bench Press (Barbell)"],
    };

    const result = applyConstraintAwareSelection({
      exercises: [makePlanned("Decline Bench Press (Barbell)")],
      constraints,
      getSubstitute: STUB_NO_SUBSTITUTE,
    });

    // Exercise kept as-is; no adjustment logged since no sub was available
    expect(result.exercises[0].name).toBe("Decline Bench Press (Barbell)");
    expect(result.adjustments).toHaveLength(0);
  });

  it("only excluded exercises are substituted; others pass through", () => {
    const constraints: ConstraintPayload = {
      ...EMPTY_CONSTRAINTS,
      exercise_exclusions: ["Squat (Barbell)"],
    };

    const result = applyConstraintAwareSelection({
      exercises: [
        makePlanned("Squat (Barbell)"),
        makePlanned("Leg Press"),
      ],
      constraints,
      getSubstitute: STUB_SUBSTITUTE,
    });

    expect(result.exercises[0].name).toBe("Incline Bench Press (Dumbbell)");
    expect(result.exercises[1].name).toBe("Leg Press");
    expect(result.adjustments).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3 — injury-conflicting exercise → substituted
// ─────────────────────────────────────────────────────────────────────────────

describe("applyConstraintAwareSelection — injury conflict", () => {
  it("substitutes exercise conflicting with active shoulder injury", () => {
    // "Decline Bench Press (Barbell)" has shoulder in jointStress
    const constraints: ConstraintPayload = {
      ...EMPTY_CONSTRAINTS,
      active_injuries: [{ area: "shoulder", status: "acute", weeks_ago_onset: 1 }],
    };

    let capturedExcludeJoint: string | undefined;
    const capturingStub: GetSubstituteFn = (_name, opts) => {
      capturedExcludeJoint = opts?.excludeJoint;
      return "Incline Bench Press (Dumbbell)";
    };

    const result = applyConstraintAwareSelection({
      exercises: [makePlanned("Decline Bench Press (Barbell)")],
      constraints,
      getSubstitute: capturingStub,
    });

    expect(result.exercises[0].name).toBe("Incline Bench Press (Dumbbell)");
    expect(result.adjustments).toHaveLength(1);
    expect(result.adjustments[0].from).toBe("Decline Bench Press (Barbell)");
    expect(result.adjustments[0].reason).toMatch(/shoulder/i);
    // Verify excludeJoint is passed through so the real substitute avoids the same stress
    expect(capturedExcludeJoint).toBe("shoulder");
  });

  it("does NOT substitute for a recovered injury", () => {
    const constraints: ConstraintPayload = {
      ...EMPTY_CONSTRAINTS,
      active_injuries: [{ area: "shoulder", status: "recovered", weeks_ago_onset: 8 }],
    };

    const result = applyConstraintAwareSelection({
      exercises: [makePlanned("Decline Bench Press (Barbell)")],
      constraints,
      getSubstitute: STUB_SUBSTITUTE,
    });

    expect(result.exercises[0].name).toBe("Decline Bench Press (Barbell)");
    expect(result.adjustments).toHaveLength(0);
  });

  it("logs appropriate reason for injury substitution", () => {
    const constraints: ConstraintPayload = {
      ...EMPTY_CONSTRAINTS,
      active_injuries: [{ area: "lumbar", status: "chronic", weeks_ago_onset: 12 }],
    };

    // Deadlift (Barbell) has lumbar in jointStress
    const result = applyConstraintAwareSelection({
      exercises: [makePlanned("Deadlift (Barbell)")],
      constraints,
      getSubstitute: STUB_SUBSTITUTE,
    });

    expect(result.adjustments[0].reason).toMatch(/lumbar/i);
    expect(result.adjustments[0].reason).toMatch(/injury/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4 — equipment unavailable (home_gym) → substituted
// ─────────────────────────────────────────────────────────────────────────────

describe("applyConstraintAwareSelection — equipment unavailable", () => {
  it("substitutes cable-only exercise for home_gym access", () => {
    const constraints: ConstraintPayload = {
      ...EMPTY_CONSTRAINTS,
      equipment_access: "home_gym",
    };

    // "Chest Fly (Cable)" is cable-only per the library
    const result = applyConstraintAwareSelection({
      exercises: [makePlanned("Chest Fly (Cable)")],
      constraints,
      getSubstitute: STUB_SUBSTITUTE,
    });

    expect(result.exercises[0].name).toBe("Incline Bench Press (Dumbbell)");
    expect(result.adjustments).toHaveLength(1);
    expect(result.adjustments[0].reason).toMatch(/home_gym/i);
  });

  it("does NOT substitute commercial_gym exercises for commercial_gym access", () => {
    const constraints: ConstraintPayload = {
      ...EMPTY_CONSTRAINTS,
      equipment_access: "commercial_gym",
    };

    const result = applyConstraintAwareSelection({
      exercises: [makePlanned("Chest Fly (Cable)")],
      constraints,
      getSubstitute: STUB_SUBSTITUTE,
    });

    expect(result.exercises[0].name).toBe("Chest Fly (Cable)");
    expect(result.adjustments).toHaveLength(0);
  });

  it("does NOT substitute barbell exercise for home_gym (barbells available at home)", () => {
    const constraints: ConstraintPayload = {
      ...EMPTY_CONSTRAINTS,
      equipment_access: "home_gym",
    };

    // Barbell exercises are available at home
    const result = applyConstraintAwareSelection({
      exercises: [makePlanned("Squat (Barbell)")],
      constraints,
      getSubstitute: STUB_SUBSTITUTE,
    });

    expect(result.exercises[0].name).toBe("Squat (Barbell)");
    expect(result.adjustments).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5 — latitude accessory with identity match → preferred
// ─────────────────────────────────────────────────────────────────────────────

describe("applyConstraintAwareSelection — identity preference", () => {
  it("replaces latitude accessory with matching identity top_exercise", () => {
    // "Lat Pulldown (Cable)" is an accessory pull/Lats exercise.
    // "Neutral Pulldown (Cable)" is also a pull/Lats accessory — it can be swapped in.
    // We need to set top_exercises.pulls to contain an entry that resolves to the
    // same pattern+primaryMuscle as "Lat Pulldown (Cable)" but is different.
    // "Pull-Up" is pull / Lats — same pattern (pull) + primaryMuscle (Lats).

    const identity: IdentityPayload = {
      ...EMPTY_IDENTITY,
      top_exercises: {
        lower: [],
        upper: [],
        pulls: ["Pull-Up"],   // Pull-Up matches pull/Lats
        isolation: [],
      },
    };

    const result = applyConstraintAwareSelection({
      exercises: [makePlanned("Lat Pulldown (Cable)")],
      constraints: null,
      identity,
      getSubstitute: STUB_SUBSTITUTE,
    });

    // Pull-Up is a top exercise matching Lats/pull — swap should happen
    expect(result.exercises[0].name).toBe("Pull-Up");
    expect(result.adjustments).toHaveLength(1);
    expect(result.adjustments[0].from).toBe("Lat Pulldown (Cable)");
    expect(result.adjustments[0].to).toBe("Pull-Up");
    expect(result.adjustments[0].reason).toMatch(/identity/i);
  });

  it("does NOT swap if the exercise is already a top_exercise", () => {
    // If Lat Pulldown is already in top_exercises.pulls, no swap.
    const identity: IdentityPayload = {
      ...EMPTY_IDENTITY,
      top_exercises: {
        lower: [],
        upper: [],
        pulls: ["Lat Pulldown (Cable)", "Pull-Up"],
        isolation: [],
      },
    };

    const result = applyConstraintAwareSelection({
      exercises: [makePlanned("Lat Pulldown (Cable)")],
      constraints: null,
      identity,
    });

    expect(result.exercises[0].name).toBe("Lat Pulldown (Cable)");
    expect(result.adjustments).toHaveLength(0);
  });

  it("does NOT apply identity swap to a main lift", () => {
    // "Deadlift (Barbell)" has role "main" in the library — no identity swap.
    const identity: IdentityPayload = {
      ...EMPTY_IDENTITY,
      top_exercises: {
        lower: [],
        upper: [],
        pulls: ["Romanian Deadlift (Barbell)"],
        isolation: [],
      },
    };

    const result = applyConstraintAwareSelection({
      exercises: [makePlanned("Deadlift (Barbell)")],
      constraints: null,
      identity,
    });

    expect(result.exercises[0].name).toBe("Deadlift (Barbell)");
    expect(result.adjustments).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6 — warmup exercises → never substituted
// ─────────────────────────────────────────────────────────────────────────────

describe("applyConstraintAwareSelection — warmup pass-through", () => {
  it("never substitutes warmup exercises even when excluded", () => {
    const constraints: ConstraintPayload = {
      ...EMPTY_CONSTRAINTS,
      exercise_exclusions: ["Push Up"],
    };

    const result = applyConstraintAwareSelection({
      exercises: [makePlanned("Push Up", { warmup: true })],
      constraints,
      getSubstitute: STUB_SUBSTITUTE,
    });

    expect(result.exercises[0].name).toBe("Push Up");
    expect(result.adjustments).toHaveLength(0);
  });

  it("never substitutes warmup exercises for identity reasons", () => {
    const identity: IdentityPayload = {
      ...EMPTY_IDENTITY,
      top_exercises: {
        lower: [],
        upper: [],
        pulls: ["Chin-Up"],
        isolation: [],
      },
    };

    const result = applyConstraintAwareSelection({
      exercises: [makePlanned("Pull-Up", { warmup: true })],
      constraints: null,
      identity,
    });

    expect(result.exercises[0].name).toBe("Pull-Up");
    expect(result.adjustments).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7 — hard constraint takes priority over identity
// ─────────────────────────────────────────────────────────────────────────────

describe("applyConstraintAwareSelection — hard constraint priority over identity", () => {
  it("applies hard constraint before checking identity for the same exercise", () => {
    // Set up: exercise is both excluded AND could be identity-swapped.
    // Hard constraint should win.
    const constraints: ConstraintPayload = {
      ...EMPTY_CONSTRAINTS,
      exercise_exclusions: ["Lat Pulldown (Cable)"],
    };
    const identity: IdentityPayload = {
      ...EMPTY_IDENTITY,
      top_exercises: {
        lower: [],
        upper: [],
        pulls: ["Chin-Up"],
        isolation: [],
      },
    };

    const result = applyConstraintAwareSelection({
      exercises: [makePlanned("Lat Pulldown (Cable)")],
      constraints,
      identity,
      getSubstitute: STUB_SUBSTITUTE,
    });

    // STUB_SUBSTITUTE returns "Incline Bench Press (Dumbbell)" — hard constraint path
    expect(result.exercises[0].name).toBe("Incline Bench Press (Dumbbell)");
    expect(result.adjustments[0].reason).toMatch(/excluded/i);
    // Exactly one adjustment (not two — identity path not evaluated)
    expect(result.adjustments).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8 — original PlannedExercise fields preserved on substitution
// ─────────────────────────────────────────────────────────────────────────────

describe("applyConstraintAwareSelection — field preservation", () => {
  it("preserves all PlannedExercise fields except name when substituting", () => {
    const original: PlannedExercise = {
      name: "Decline Bench Press (Barbell)",
      baseKg: 80,
      baseReps: 6,
      sets: 4,
      key: "decline_bench",
      increment: { step: 2.5 },
      video_url: "https://example.com/video",
    };

    const constraints: ConstraintPayload = {
      ...EMPTY_CONSTRAINTS,
      exercise_exclusions: ["Decline Bench Press (Barbell)"],
    };

    const result = applyConstraintAwareSelection({
      exercises: [original],
      constraints,
      getSubstitute: STUB_SUBSTITUTE,
    });

    const substituted = result.exercises[0];
    expect(substituted.name).toBe("Incline Bench Press (Dumbbell)");
    expect(substituted.baseKg).toBe(80);
    expect(substituted.baseReps).toBe(6);
    expect(substituted.sets).toBe(4);
    expect(substituted.key).toBe("decline_bench");
    expect(substituted.increment).toEqual({ step: 2.5 });
    expect(substituted.video_url).toBe("https://example.com/video");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 9 — empty constraints / identity → no changes
// ─────────────────────────────────────────────────────────────────────────────

describe("applyConstraintAwareSelection — empty but present constraints", () => {
  it("returns exercises unchanged when constraints present but empty", () => {
    const exercises = [makePlanned("Decline Bench Press (Barbell)")];
    const result = applyConstraintAwareSelection({
      exercises,
      constraints: EMPTY_CONSTRAINTS,
      identity: EMPTY_IDENTITY,
    });
    expect(result.exercises).toEqual(exercises);
    expect(result.adjustments).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 10 — multiple exercises, mixed outcomes
// ─────────────────────────────────────────────────────────────────────────────

describe("applyConstraintAwareSelection — mixed exercises", () => {
  it("processes a list with excluded, clean, and identity-preferred exercises independently", () => {
    const constraints: ConstraintPayload = {
      ...EMPTY_CONSTRAINTS,
      exercise_exclusions: ["Decline Bench Press (Barbell)"],
    };
    const identity: IdentityPayload = {
      ...EMPTY_IDENTITY,
      top_exercises: {
        lower: [],
        upper: [],
        pulls: ["Pull-Up"],
        isolation: [],
      },
    };

    const exercises = [
      makePlanned("Decline Bench Press (Barbell)"),   // excluded → substituted
      makePlanned("Squat (Barbell)"),                  // clean → unchanged
      makePlanned("Lat Pulldown (Cable)"),             // latitude accessory + identity match → swapped
    ];

    const result = applyConstraintAwareSelection({
      exercises,
      constraints,
      identity,
      getSubstitute: STUB_SUBSTITUTE,
    });

    expect(result.exercises[0].name).toBe("Incline Bench Press (Dumbbell)");
    expect(result.exercises[1].name).toBe("Squat (Barbell)");
    expect(result.exercises[2].name).toBe("Pull-Up");
    expect(result.adjustments).toHaveLength(2);
  });
});
