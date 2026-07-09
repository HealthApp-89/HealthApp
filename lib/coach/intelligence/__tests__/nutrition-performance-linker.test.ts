// lib/coach/intelligence/__tests__/nutrition-performance-linker.test.ts
//
// Tests for composeNutritionPerformance() — the Nutrition-Performance Linker.
// Run via: npx vitest lib/coach/intelligence/

import { describe, it, expect } from "vitest";
import {
  composeNutritionPerformance,
  NutritionPerformanceResultSchema,
  type DailyLogRow,
  type NutritionPerformanceInput,
} from "../nutrition-performance-linker";
import type { WorkoutSession } from "@/lib/data/workouts";
import { daysAgo } from "./fixtures";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a daily log row with sensible defaults. */
function makeLog(
  date: string,
  overrides: Partial<DailyLogRow> = {},
): DailyLogRow {
  return {
    date,
    calories_eaten: overrides.calories_eaten !== undefined ? overrides.calories_eaten : 2200,
    protein_g: overrides.protein_g !== undefined ? overrides.protein_g : 180,
    carbs_g: overrides.carbs_g !== undefined ? overrides.carbs_g : 220,
    fat_g: overrides.fat_g !== undefined ? overrides.fat_g : 70,
    weight_kg: overrides.weight_kg !== undefined ? overrides.weight_kg : 100,
  };
}

/** Build 14 daily logs from newest (day 0) to oldest (day 13). */
function makeLogs(
  fields: Partial<DailyLogRow> = {},
  overridesByDay: Record<number, Partial<DailyLogRow>> = {},
): DailyLogRow[] {
  return Array.from({ length: 14 }, (_, i) =>
    makeLog(daysAgo(i), { ...fields, ...(overridesByDay[i] ?? {}) }),
  );
}

/** Build a minimal WorkoutSession. */
function makeWorkout(date: string, kgVol = 5000): WorkoutSession {
  // One exercise, one set: kg*reps = kgVol
  return {
    id: `workout-${date}`,
    date,
    type: "Strength",
    duration_min: 60,
    source: "logger",
    exercises: [
      {
        name: "Squat (Barbell)",
        position: 0,
        kind: "weighted",
        sets: [
          {
            kg: kgVol / 10,
            reps: 10,
            duration_seconds: null,
            warmup: false,
            failure: false,
          },
        ],
      },
    ],
    vol: kgVol,
    bwReps: 0,
    sets: 1,
  };
}

/** Build 14 days of workouts — every other day is a training day. */
function makeWorkouts(trainingDays: number[] = [0, 2, 4, 6, 8, 10, 12]): WorkoutSession[] {
  return trainingDays.map((d) => makeWorkout(daysAgo(d)));
}

/** Standard targets for tests */
const STANDARD_TARGETS: NutritionPerformanceInput["targets"] = {
  kcal: 2300,
  protein_g: 200,
  phase: "cut",
};

// ---------------------------------------------------------------------------
// Test 1: Adequate protein + moderate deficit → adequate, risk low
// ---------------------------------------------------------------------------

describe("composeNutritionPerformance", () => {
  it("Test 1: adequate protein + moderate deficit → protein_status adequate, risk low", () => {
    // Protein at 180g out of 200g target = 90% → adequate
    // bodyweight 100kg → 1.8 g/kg → adequate (≥1.6)
    // Calories: 2100 vs 2300 target = 200 kcal deficit → appropriate
    const logs = makeLogs({ calories_eaten: 2100, protein_g: 180, weight_kg: 100 });
    const workouts = makeWorkouts();
    const input: NutritionPerformanceInput = {
      dailyLogs: logs,
      workouts,
      targets: STANDARD_TARGETS,
      bodyweight_kg: 100,
    };

    const result = composeNutritionPerformance(input);

    expect(result.protein_status).toBe("adequate");
    expect(result.predicted_muscle_loss_risk).toBe("low");
    expect(result.deficit_severity).toBe("appropriate");
  });

  // ── Test 2: Low protein + big deficit + flat lifts → critically_low, unsustainable, high ──

  it("Test 2: low protein (1.3 g/kg) + 750 deficit + flat lifts → critically_low, unsustainable, high risk", () => {
    // 100kg athlete, protein 130g = 1.3 g/kg (< 1.4 → critically_low)
    // pctOfTarget = 130/200 = 0.65 → critically_low
    // 2300 - 1550 = 750 kcal deficit → unsustainable
    // Week 1 vol = week 2 vol → flat
    const logs = makeLogs({
      calories_eaten: 1550,
      protein_g: 130,
      weight_kg: 100,
    });
    // Same volume week 1 and 2: training days 1,3,5,6,7,8,9
    const workoutsFlat: WorkoutSession[] = [
      makeWorkout(daysAgo(1), 4000),
      makeWorkout(daysAgo(3), 4000),
      makeWorkout(daysAgo(5), 4000),
      makeWorkout(daysAgo(8), 4000),
      makeWorkout(daysAgo(10), 4000),
      makeWorkout(daysAgo(12), 4000),
    ];
    const input: NutritionPerformanceInput = {
      dailyLogs: logs,
      workouts: workoutsFlat,
      targets: STANDARD_TARGETS,
      bodyweight_kg: 100,
    };

    const result = composeNutritionPerformance(input);

    expect(result.protein_status).toBe("critically_low");
    expect(result.deficit_severity).toBe("unsustainable");
    expect(result.predicted_muscle_loss_risk).toBe("high");
  });

  // ── Test 3: Carbs evenly spread (rest = training) → carb_timing_suboptimal true ──

  it("Test 3: carbs evenly spread across training + rest days → carb_timing_suboptimal true", () => {
    // Training days: 0,2,4,6,8,10,12 — rest days: 1,3,5,7,9,11,13
    // Both get same carbs: 200g → training avg NOT higher than rest → suboptimal
    const logs = makeLogs({ carbs_g: 200, protein_g: 180, calories_eaten: 2100 });
    const workouts = makeWorkouts([0, 2, 4, 6, 8, 10, 12]);
    const input: NutritionPerformanceInput = {
      dailyLogs: logs,
      workouts,
      targets: STANDARD_TARGETS,
      bodyweight_kg: 100,
    };

    const result = composeNutritionPerformance(input);

    expect(result.carb_timing_suboptimal).toBe(true);
  });

  // ── Test 4: Carbs concentrated on training days → carb_timing_suboptimal false ──

  it("Test 4: carbs higher on training days → carb_timing_suboptimal false", () => {
    // Training days: 0,2,4,6,8,10,12 — carbs 300g
    // Rest days: 1,3,5,7,9,11,13 — carbs 150g
    // Training avg (300) > rest avg (150) → NOT suboptimal
    const overridesByDay: Record<number, Partial<DailyLogRow>> = {};
    // training days (even indices): high carbs
    for (const d of [0, 2, 4, 6, 8, 10, 12]) {
      overridesByDay[d] = { carbs_g: 300 };
    }
    // rest days (odd indices): low carbs
    for (const d of [1, 3, 5, 7, 9, 11, 13]) {
      overridesByDay[d] = { carbs_g: 150 };
    }
    const logs = makeLogs({ protein_g: 180, calories_eaten: 2100 }, overridesByDay);
    const workouts = makeWorkouts([0, 2, 4, 6, 8, 10, 12]);
    const input: NutritionPerformanceInput = {
      dailyLogs: logs,
      workouts,
      targets: STANDARD_TARGETS,
      bodyweight_kg: 100,
    };

    const result = composeNutritionPerformance(input);

    expect(result.carb_timing_suboptimal).toBe(false);
  });

  // ── Test 5: Not in deficit (maintain phase, intake ≈ target) → not_in_deficit ──

  it("Test 5: maintain phase + intake near target → deficit_severity not_in_deficit", () => {
    // Phase = maintain, eating 2290 vs 2300 target = 10 kcal deficit (< 100 threshold)
    const logs = makeLogs({ calories_eaten: 2290, protein_g: 185 });
    const workouts = makeWorkouts();
    const input: NutritionPerformanceInput = {
      dailyLogs: logs,
      workouts,
      targets: { kcal: 2300, protein_g: 200, phase: "maintain" },
      bodyweight_kg: 100,
    };

    const result = composeNutritionPerformance(input);

    expect(result.deficit_severity).toBe("not_in_deficit");
  });

  // ── Test 6: Order-independence ───────────────────────────────────────────

  it("Test 6: ascending-ordered input produces same result as descending-ordered", () => {
    // Build logs in ASCENDING (oldest-first) order
    const ascending: DailyLogRow[] = Array.from({ length: 14 }, (_, i) =>
      makeLog(daysAgo(13 - i), { calories_eaten: 1550, protein_g: 130, weight_kg: 100 }),
    );

    // Same logs in DESCENDING (newest-first) order
    const descending: DailyLogRow[] = Array.from({ length: 14 }, (_, i) =>
      makeLog(daysAgo(i), { calories_eaten: 1550, protein_g: 130, weight_kg: 100 }),
    );

    const workouts = makeWorkouts();

    const resultAsc = composeNutritionPerformance({
      dailyLogs: ascending,
      workouts,
      targets: STANDARD_TARGETS,
      bodyweight_kg: 100,
    });

    const resultDesc = composeNutritionPerformance({
      dailyLogs: descending,
      workouts,
      targets: STANDARD_TARGETS,
      bodyweight_kg: 100,
    });

    expect(resultAsc.protein_status).toBe(resultDesc.protein_status);
    expect(resultAsc.deficit_severity).toBe(resultDesc.deficit_severity);
    expect(resultAsc.predicted_muscle_loss_risk).toBe(resultDesc.predicted_muscle_loss_risk);
    expect(resultAsc.carb_timing_suboptimal).toBe(resultDesc.carb_timing_suboptimal);
  });

  // ── Test 7: Empty input → safe defaults, no throw ────────────────────────

  it("Test 7: empty dailyLogs → safe defaults without throwing", () => {
    expect(() => {
      const result = composeNutritionPerformance({
        dailyLogs: [],
        workouts: [],
        targets: STANDARD_TARGETS,
        bodyweight_kg: null,
      });

      expect(result.protein_status).toBe("adequate");
      expect(result.deficit_severity).toBe("not_in_deficit");
      expect(result.predicted_muscle_loss_risk).toBe("low");
      expect(result.carb_timing_suboptimal).toBe(false);
      expect(result.narrative).toMatch(/Not enough nutrition data/i);
    }).not.toThrow();
  });

  // ── Test 8: Output validates against schema ───────────────────────────────

  it("Test 8: output validates against NutritionPerformanceResultSchema for multiple cases", () => {
    const cases: NutritionPerformanceInput[] = [
      // Case 1: adequate protein, moderate deficit
      {
        dailyLogs: makeLogs({ calories_eaten: 2100, protein_g: 180, weight_kg: 100 }),
        workouts: makeWorkouts(),
        targets: STANDARD_TARGETS,
        bodyweight_kg: 100,
      },
      // Case 2: critically low protein, unsustainable deficit
      {
        dailyLogs: makeLogs({ calories_eaten: 1550, protein_g: 130, weight_kg: 100 }),
        workouts: makeWorkouts(),
        targets: STANDARD_TARGETS,
        bodyweight_kg: 100,
      },
      // Case 3: maintain phase
      {
        dailyLogs: makeLogs({ calories_eaten: 2290, protein_g: 185 }),
        workouts: makeWorkouts(),
        targets: { kcal: 2300, protein_g: 200, phase: "maintain" },
        bodyweight_kg: 100,
      },
      // Case 4: empty input
      {
        dailyLogs: [],
        workouts: [],
        targets: STANDARD_TARGETS,
        bodyweight_kg: null,
      },
    ];

    for (const input of cases) {
      const result = composeNutritionPerformance(input);
      const parsed = NutritionPerformanceResultSchema.safeParse(result);
      if (!parsed.success) {
        throw new Error(
          `Schema validation failed: ${JSON.stringify(parsed.error.issues, null, 2)}`,
        );
      }
      expect(parsed.success).toBe(true);
    }
  });

  // ── Additional: marginally short protein ─────────────────────────────────

  it("protein at 80% of target with g/kg in [1.4, 1.6) → marginally_short", () => {
    // 100 kg athlete, 155g protein = 1.55 g/kg (in [1.4, 1.6)) → marginally_short
    // pctOfTarget = 155/200 = 0.775 (in [0.75, 0.9)) → also marginally_short
    const logs = makeLogs({ protein_g: 155, calories_eaten: 2100 });
    const result = composeNutritionPerformance({
      dailyLogs: logs,
      workouts: makeWorkouts(),
      targets: STANDARD_TARGETS,
      bodyweight_kg: 100,
    });

    expect(result.protein_status).toBe("marginally_short");
  });

  // ── Additional: aggressive_sustainable via kcal delta ────────────────────

  it("500 kcal deficit vs target → aggressive_sustainable deficit", () => {
    // 2300 - 1800 = 500 kcal deficit (in (400, 700]) → aggressive_sustainable
    // Weight trend: stable (100 kg all days) → no weight-based bump
    const logs = makeLogs({ calories_eaten: 1800, protein_g: 180, weight_kg: 100 });
    const result = composeNutritionPerformance({
      dailyLogs: logs,
      workouts: makeWorkouts(),
      targets: STANDARD_TARGETS,
      bodyweight_kg: 100,
    });

    expect(result.deficit_severity).toBe("aggressive_sustainable");
  });

  // ── Additional: invalid protein target → no throw ─────────────────────────

  it("protein target ≤ 0 → does not throw, protein status treated as adequate", () => {
    expect(() => {
      const result = composeNutritionPerformance({
        dailyLogs: makeLogs({ protein_g: 150 }),
        workouts: makeWorkouts(),
        targets: { kcal: 2300, protein_g: 0, phase: "cut" },
        bodyweight_kg: 100,
      });
      // protein_status should be adequate (safe default when target not assessable)
      expect(result.protein_status).toBe("adequate");
    }).not.toThrow();
  });

  // ── Additional: weight-loss-based deficit trigger (>0.7 kg/wk) ───────────

  it("rapid weight loss (>0.7 kg/wk from OLS slope) → unsustainable even with kcal below threshold", () => {
    // Weight drops from 103 to 100 over 13 days = ~1.6 kg/week loss
    // That's >0.7 kg/wk threshold → unsustainable
    const overrides: Record<number, Partial<DailyLogRow>> = {};
    for (let i = 0; i < 14; i++) {
      // Newest (day 0) = 100 kg, oldest (day 13) = 103 kg
      overrides[i] = { weight_kg: 100 + i * 0.23 };
    }
    const logs = makeLogs({ calories_eaten: 2050, protein_g: 185 }, overrides);
    const result = composeNutritionPerformance({
      dailyLogs: logs,
      workouts: makeWorkouts(),
      targets: STANDARD_TARGETS,
      bodyweight_kg: 100,
    });

    expect(result.deficit_severity).toBe("unsustainable");
  });

  // ── Additional: not_in_deficit for lean_bulk with intake ≈ target ─────────

  it("lean_bulk phase + intake at target → not_in_deficit", () => {
    // lean_bulk phase, eating 2300 (= target) → not_in_deficit
    const logs = makeLogs({ calories_eaten: 2300, protein_g: 190 });
    const result = composeNutritionPerformance({
      dailyLogs: logs,
      workouts: makeWorkouts(),
      targets: { kcal: 2300, protein_g: 200, phase: "lean_bulk" },
      bodyweight_kg: 100,
    });

    expect(result.deficit_severity).toBe("not_in_deficit");
  });
});
