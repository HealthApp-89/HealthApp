// lib/coach/intelligence/__tests__/body-comp-direction.test.ts
//
// Tests for composeBodyCompDirection() — the Body Composition Direction Detector.
// Run via: npx vitest lib/coach/intelligence/
//
// TDD: all 9 tests written BEFORE implementation.

import { describe, it, expect } from "vitest";
import {
  composeBodyCompDirection,
  BodyCompDirectionResultSchema,
  type BodyCompInput,
} from "../body-comp-direction";
import type { WorkoutSession } from "@/lib/data/workouts";
import { daysAgo } from "./fixtures";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a daily log row with optional body comp fields. */
function makeLog(
  date: string,
  weight_kg: number | null,
  body_fat_pct: number | null,
  fat_free_mass_kg: number | null = null,
  protein_g: number | null = null,
): BodyCompInput["dailyLogs"][number] {
  return { date, weight_kg, body_fat_pct, fat_free_mass_kg, protein_g };
}

/**
 * Build a minimal WorkoutSession with one main lift set.
 * Uses Deadlift (Barbell) as the exercise to hit the MAIN_LIFT_KEYWORDS list.
 */
function makeWorkout(
  date: string,
  kg: number,
  reps: number,
  warmup = false,
  exerciseName = "Deadlift (Barbell)",
): WorkoutSession {
  return {
    id: `workout-${date}-${exerciseName}`,
    date,
    type: "Strength",
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
    sets: 1,
  };
}

/**
 * Build 28 daily log rows with a linearly interpolated weight and body fat.
 * startWeight/endWeight: weight_kg for day-27 → day-0
 * startBf/endBf: body_fat_pct for day-27 → day-0
 * protein_g: constant protein value across all rows (or null)
 */
function makeBodyLogs(
  startWeight: number,
  endWeight: number,
  startBf: number,
  endBf: number,
  protein_g: number | null = null,
): BodyCompInput["dailyLogs"] {
  return Array.from({ length: 28 }, (_, i) => {
    // i=0 is daysAgo(0) = most recent; i=27 is oldest
    const t = 1 - i / 27; // 0 for oldest, 1 for most recent
    const weight_kg = startWeight + t * (endWeight - startWeight);
    const body_fat_pct = startBf + t * (endBf - startBf);
    return makeLog(daysAgo(i), weight_kg, body_fat_pct, null, protein_g);
  });
}

// ---------------------------------------------------------------------------
// Test 1: Weight down + bf down + lifts holding → 'losing_fat'
// ---------------------------------------------------------------------------

describe("composeBodyCompDirection — losing fat", () => {
  it("returns losing_fat when weight is falling, bf% is falling, and lifts are holding", () => {
    // Weight: 103 → 100.2 over 28d = −0.1 kg/d = −0.7 kg/wk → below −0.1 threshold
    const dailyLogs = makeBodyLogs(103, 100.2, 28, 27.2, 170);

    // Lifts: flat (same weight in prior and recent 14d) → not declining
    const workouts: WorkoutSession[] = [
      makeWorkout(daysAgo(25), 120, 5), // prior 14d
      makeWorkout(daysAgo(20), 120, 5),
      makeWorkout(daysAgo(16), 120, 5),
      makeWorkout(daysAgo(10), 120, 5), // recent 14d
      makeWorkout(daysAgo(5), 120, 5),
      makeWorkout(daysAgo(1), 120, 5),
    ];

    const input: BodyCompInput = {
      dailyLogs,
      workouts,
      bodyweight_kg: 100.2,
    };
    const result = composeBodyCompDirection(input);

    expect(result.direction).toBe("losing_fat");
    expect(result.weight_trend_kg_per_week).not.toBeNull();
    expect(result.weight_trend_kg_per_week!).toBeLessThan(-0.1);
    expect(result.bodyfat_trend_pct_per_week).not.toBeNull();
    expect(result.bodyfat_trend_pct_per_week!).toBeLessThan(-0.05);
    expect(result.lift_trend).not.toBe("declining");
  });
});

// ---------------------------------------------------------------------------
// Test 2: Weight down + lifts declining + bf flat → 'losing_muscle'
// ---------------------------------------------------------------------------

describe("composeBodyCompDirection — losing muscle", () => {
  it("returns losing_muscle when weight falls, lifts decline, and bf% is flat", () => {
    // Weight: 103 → 100.2 over 28d = ~−0.7 kg/wk → below −0.1 threshold
    // BF: stays essentially flat (27.0 → 27.05) → within ±0.05%/wk threshold
    const dailyLogs = makeBodyLogs(103, 100.2, 27.0, 27.05, 110);

    // Lifts: declining — prior 14d avg > recent 14d avg * 1.02 (> 2% drop)
    const workouts: WorkoutSession[] = [
      makeWorkout(daysAgo(25), 125, 5), // prior: Brzycki ~144 e1RM
      makeWorkout(daysAgo(20), 125, 5),
      makeWorkout(daysAgo(16), 125, 5),
      makeWorkout(daysAgo(10), 120, 5), // recent: Brzycki ~138 e1RM → >2% drop
      makeWorkout(daysAgo(5), 118, 5),
      makeWorkout(daysAgo(1), 118, 5),
    ];

    const input: BodyCompInput = {
      dailyLogs,
      workouts,
      bodyweight_kg: 100.2,
    };
    const result = composeBodyCompDirection(input);

    expect(result.direction).toBe("losing_muscle");
    expect(result.weight_trend_kg_per_week).not.toBeNull();
    expect(result.weight_trend_kg_per_week!).toBeLessThan(-0.1);
    expect(result.lift_trend).toBe("declining");
  });
});

// ---------------------------------------------------------------------------
// Test 3: Weight up + lifts progressing + bf flat → 'gaining_muscle'
// ---------------------------------------------------------------------------

describe("composeBodyCompDirection — gaining muscle", () => {
  it("returns gaining_muscle when weight rises, lifts progress, and bf% stays flat", () => {
    // Weight: 98 → 100.8 over 28d = +0.1 kg/d = +0.7 kg/wk → above +0.1 threshold
    // BF: flat (27.0 → 27.05) → within ±0.05%/wk
    const dailyLogs = makeBodyLogs(98, 100.8, 27.0, 27.05, 175);

    // Lifts: progressing — recent 14d avg > prior 14d avg * 1.01 (>1% improvement)
    const workouts: WorkoutSession[] = [
      makeWorkout(daysAgo(25), 115, 5), // prior: ~132 e1RM
      makeWorkout(daysAgo(20), 115, 5),
      makeWorkout(daysAgo(16), 115, 5),
      makeWorkout(daysAgo(10), 120, 5), // recent: ~138 e1RM → >1% increase
      makeWorkout(daysAgo(5), 122, 5),
      makeWorkout(daysAgo(1), 122, 5),
    ];

    const input: BodyCompInput = {
      dailyLogs,
      workouts,
      bodyweight_kg: 100.8,
    };
    const result = composeBodyCompDirection(input);

    expect(result.direction).toBe("gaining_muscle");
    expect(result.weight_trend_kg_per_week).not.toBeNull();
    expect(result.weight_trend_kg_per_week!).toBeGreaterThan(0.1);
    expect(result.lift_trend).toBe("progressing");
  });
});

// ---------------------------------------------------------------------------
// Test 4: Weight flat + bf down + lifts holding → 'recomp'
// ---------------------------------------------------------------------------

describe("composeBodyCompDirection — recomp", () => {
  it("returns recomp when weight is flat, bf% is falling, and lifts are holding", () => {
    // Weight: 101.5 → 101.3 over 28d ≈ flat (change ~−0.007 kg/d = ~−0.05 kg/wk → within ±0.1)
    // BF: 28.0 → 27.3 over 28d → slope ~−0.025 %/d = ~−0.175 %/wk → below −0.05 threshold
    const dailyLogs = makeBodyLogs(101.5, 101.3, 28.0, 27.3, 175);

    // Lifts: flat
    const workouts: WorkoutSession[] = [
      makeWorkout(daysAgo(25), 120, 5),
      makeWorkout(daysAgo(20), 120, 5),
      makeWorkout(daysAgo(16), 120, 5),
      makeWorkout(daysAgo(10), 120, 5),
      makeWorkout(daysAgo(5), 120, 5),
      makeWorkout(daysAgo(1), 120, 5),
    ];

    const input: BodyCompInput = {
      dailyLogs,
      workouts,
      bodyweight_kg: 101.3,
    };
    const result = composeBodyCompDirection(input);

    expect(result.direction).toBe("recomp");
    // Weight should be near-flat (|wt| ≤ 0.1 kg/wk)
    expect(result.weight_trend_kg_per_week).not.toBeNull();
    expect(Math.abs(result.weight_trend_kg_per_week!)).toBeLessThanOrEqual(0.1);
    // BF should be falling
    expect(result.bodyfat_trend_pct_per_week).not.toBeNull();
    expect(result.bodyfat_trend_pct_per_week!).toBeLessThan(-0.05);
  });
});

// ---------------------------------------------------------------------------
// Test 5: No body data → 'unknown', confidence ≤ 0.3
// ---------------------------------------------------------------------------

describe("composeBodyCompDirection — no body data", () => {
  it("returns unknown with confidence ≤0.3 when weight and bf% are both null throughout", () => {
    // All body measurements are null
    const dailyLogs = Array.from({ length: 28 }, (_, i) =>
      makeLog(daysAgo(i), null, null, null, null),
    );

    const workouts: WorkoutSession[] = [
      makeWorkout(daysAgo(20), 120, 5),
      makeWorkout(daysAgo(10), 120, 5),
      makeWorkout(daysAgo(5), 120, 5),
      makeWorkout(daysAgo(1), 120, 5),
    ];

    const input: BodyCompInput = {
      dailyLogs,
      workouts,
      bodyweight_kg: null,
    };
    const result = composeBodyCompDirection(input);

    expect(result.direction).toBe("unknown");
    expect(result.confidence).toBeLessThanOrEqual(0.3);
    expect(result.weight_trend_kg_per_week).toBeNull();
    expect(result.bodyfat_trend_pct_per_week).toBeNull();
    expect(result.narrative).toMatch(/no body/i);
  });
});

// ---------------------------------------------------------------------------
// Test 6: Short window (1 week) → confidence ≤ 0.4
// ---------------------------------------------------------------------------

describe("composeBodyCompDirection — short window", () => {
  it("caps confidence at 0.4 when there is less than 2 weeks of body data", () => {
    // Only 6 days of data — below the 2-week threshold
    const dailyLogs = Array.from({ length: 6 }, (_, i) => {
      const t = 1 - i / 5;
      const weight_kg = 100 + t * (103 - 100); // slight weight change
      return makeLog(daysAgo(i), weight_kg, 28.0, null, 170);
    });

    const workouts: WorkoutSession[] = [
      makeWorkout(daysAgo(5), 120, 5),
      makeWorkout(daysAgo(1), 120, 5),
    ];

    const input: BodyCompInput = {
      dailyLogs,
      workouts,
      bodyweight_kg: 103,
    };
    const result = composeBodyCompDirection(input);

    expect(result.confidence).toBeLessThanOrEqual(0.4);
    expect(result.weeks_of_data).toBeLessThan(2);
  });
});

// ---------------------------------------------------------------------------
// Test 7: Order-independence — ascending vs descending input → same result
// ---------------------------------------------------------------------------

describe("composeBodyCompDirection — order independence", () => {
  it("produces the same result regardless of whether input is sorted ascending or descending", () => {
    const dailyLogsDesc = makeBodyLogs(103, 100.2, 28, 27.2, 170);
    const dailyLogsAsc = [...dailyLogsDesc].reverse();

    const workoutsDesc: WorkoutSession[] = [
      makeWorkout(daysAgo(25), 120, 5),
      makeWorkout(daysAgo(20), 120, 5),
      makeWorkout(daysAgo(16), 120, 5),
      makeWorkout(daysAgo(10), 120, 5),
      makeWorkout(daysAgo(5), 120, 5),
      makeWorkout(daysAgo(1), 120, 5),
    ];
    const workoutsAsc = [...workoutsDesc].reverse();

    const inputDesc: BodyCompInput = {
      dailyLogs: dailyLogsDesc,
      workouts: workoutsDesc,
      bodyweight_kg: 100.2,
    };
    const inputAsc: BodyCompInput = {
      dailyLogs: dailyLogsAsc,
      workouts: workoutsAsc,
      bodyweight_kg: 100.2,
    };

    const resultDesc = composeBodyCompDirection(inputDesc);
    const resultAsc = composeBodyCompDirection(inputAsc);

    expect(resultDesc.direction).toBe(resultAsc.direction);
    expect(resultDesc.lift_trend).toBe(resultAsc.lift_trend);
    if (resultDesc.weight_trend_kg_per_week !== null && resultAsc.weight_trend_kg_per_week !== null) {
      expect(resultDesc.weight_trend_kg_per_week).toBeCloseTo(resultAsc.weight_trend_kg_per_week, 4);
    }
    if (resultDesc.bodyfat_trend_pct_per_week !== null && resultAsc.bodyfat_trend_pct_per_week !== null) {
      expect(resultDesc.bodyfat_trend_pct_per_week).toBeCloseTo(resultAsc.bodyfat_trend_pct_per_week, 4);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 8: Empty input → safe 'unknown', no throw
// ---------------------------------------------------------------------------

describe("composeBodyCompDirection — empty input", () => {
  it("returns safe unknown without throwing when all inputs are empty or null", () => {
    const input: BodyCompInput = {
      dailyLogs: [],
      workouts: [],
      bodyweight_kg: null,
    };

    expect(() => composeBodyCompDirection(input)).not.toThrow();
    const result = composeBodyCompDirection(input);

    expect(result.direction).toBe("unknown");
    expect(result.confidence).toBeLessThanOrEqual(0.3);
    expect(result.weight_trend_kg_per_week).toBeNull();
    expect(result.bodyfat_trend_pct_per_week).toBeNull();
    expect(result.narrative).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Test 9: FFM supplementary path → 'losing_muscle' with FFM-based narrative
// ---------------------------------------------------------------------------

describe("composeBodyCompDirection — FFM supplementary path", () => {
  it("returns losing_muscle via FFM path and cites fat-free mass, not e1RM, in narrative", () => {
    // Weight: roughly flat (101.5 → 101.3 over 28d ≈ −0.05 kg/wk → within ±0.1)
    // BF: flat (27.0 → 27.05) → no bf improvement, stays within ±0.05%/wk
    // FFM: 73.5 → 70.5 over 28d → −3 kg / 4 wks = −0.75 kg/wk → clearly below −0.1 threshold
    const dailyLogs = Array.from({ length: 28 }, (_, i) => {
      const t = 1 - i / 27; // t=1 is most recent, t=0 is oldest
      const weight_kg = 101.5 + t * (101.3 - 101.5); // near-flat: 101.5 → 101.3
      const body_fat_pct = 27.0 + t * (27.05 - 27.0); // flat: 27.0 → 27.05
      const fat_free_mass_kg = 73.5 + t * (70.5 - 73.5); // clearly declining: 73.5 → 70.5
      return makeLog(daysAgo(i), weight_kg, body_fat_pct, fat_free_mass_kg, 150);
    });

    // Lifts: flat — NOT declining (same weight, same reps in both windows)
    const workouts: WorkoutSession[] = [
      makeWorkout(daysAgo(25), 120, 5), // prior 14d
      makeWorkout(daysAgo(20), 120, 5),
      makeWorkout(daysAgo(16), 120, 5),
      makeWorkout(daysAgo(10), 120, 5), // recent 14d — identical load
      makeWorkout(daysAgo(5), 120, 5),
      makeWorkout(daysAgo(1), 120, 5),
    ];

    const input: BodyCompInput = {
      dailyLogs,
      workouts,
      bodyweight_kg: 101.3,
    };
    const result = composeBodyCompDirection(input);

    // Direction must be losing_muscle
    expect(result.direction).toBe("losing_muscle");

    // Lift trend must NOT be declining (FFM path fires, not primary path)
    expect(result.lift_trend).not.toBe("declining");

    // Narrative must NOT contain a false "e1RM declining" claim
    expect(result.narrative).not.toMatch(/e1rm declining/i);
    expect(result.narrative).not.toMatch(/lift.*declining/i);

    // Narrative must reference fat-free mass
    expect(result.narrative).toMatch(/fat-free mass/i);
  });
});

// ---------------------------------------------------------------------------
// Test 10: Output validates against schema
// ---------------------------------------------------------------------------

describe("composeBodyCompDirection — schema validation (all scenarios)", () => {
  it("produces output that validates against BodyCompDirectionResultSchema in all scenarios", () => {
    const scenarios: BodyCompInput[] = [
      // Scenario A: losing fat
      {
        dailyLogs: makeBodyLogs(103, 100.2, 28, 27.2, 170),
        workouts: [
          makeWorkout(daysAgo(20), 120, 5),
          makeWorkout(daysAgo(5), 120, 5),
        ],
        bodyweight_kg: 100.2,
      },
      // Scenario B: gaining muscle
      {
        dailyLogs: makeBodyLogs(98, 100.8, 27.0, 27.05, 175),
        workouts: [
          makeWorkout(daysAgo(20), 115, 5),
          makeWorkout(daysAgo(5), 122, 5),
        ],
        bodyweight_kg: 100.8,
      },
      // Scenario C: no body data
      {
        dailyLogs: Array.from({ length: 14 }, (_, i) => makeLog(daysAgo(i), null, null, null, null)),
        workouts: [],
        bodyweight_kg: null,
      },
      // Scenario D: empty
      { dailyLogs: [], workouts: [], bodyweight_kg: null },
    ];

    for (const input of scenarios) {
      const result = composeBodyCompDirection(input);
      const parsed = BodyCompDirectionResultSchema.safeParse(result);
      expect(parsed.success).toBe(true);
    }
  });
});
