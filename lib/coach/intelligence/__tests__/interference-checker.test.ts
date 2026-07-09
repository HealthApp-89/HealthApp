// lib/coach/intelligence/__tests__/interference-checker.test.ts
//
// Tests for composeInterference() — the Strength-Endurance Interference Checker.
// Run via: npx vitest lib/coach/intelligence/
//
// TDD: all 8 tests written BEFORE implementation.

import { describe, it, expect } from "vitest";
import {
  composeInterference,
  InterferenceResultSchema,
  type InterferenceInput,
} from "../interference-checker";
import type { WorkoutSession } from "@/lib/data/workouts";
import { daysAgo } from "./fixtures";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a daily log row with optional endurance_load. */
function makeLog(date: string, endurance_load: number | null): { date: string; endurance_load: number | null } {
  return { date, endurance_load };
}

/**
 * Build 28 daily logs. If loadByDay is provided, those days get that load.
 * Otherwise all days get the defaultLoad.
 */
function makeLogs(defaultLoad: number | null = null): { date: string; endurance_load: number | null }[] {
  return Array.from({ length: 28 }, (_, i) => makeLog(daysAgo(i), defaultLoad));
}

function makeLogsWithPattern(
  recent7: number,
  older21: number,
): { date: string; endurance_load: number | null }[] {
  return Array.from({ length: 28 }, (_, i) =>
    makeLog(daysAgo(i), i < 7 ? recent7 : older21),
  );
}

/** Build a minimal WorkoutSession with one main lift set. */
function makeWorkout(
  date: string,
  exerciseName: string,
  kg: number,
  reps: number,
  warmup = false,
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

// ---------------------------------------------------------------------------
// Test 1: Steady Z2 (~equal load each week) + progressing lifts → 'none', ratio ≈ 1.0
// ---------------------------------------------------------------------------

describe("composeInterference — steady Z2 + progressing lifts", () => {
  it("returns none with ratio ≈ 1.0 when endurance is steady and lifts are progressing", () => {
    // ~25 TSS per day across 28d → weekly 7d sum ≈ 175, 28d avg/week ≈ 175 → ratio ≈ 1.0
    const dailyLogs = makeLogs(25);

    // Progressing lifts: recent 14d has higher e1RM than prior 14d
    // Prior 14d: squat 80kg×5 = ~93 e1RM (Brzycki)
    // Recent 14d: squat 85kg×5 = ~98 e1RM (Brzycki) — clearly > 1% increase
    const workouts: WorkoutSession[] = [
      // Prior period (days 14–27 ago)
      makeWorkout(daysAgo(25), "Squat (Barbell)", 80, 5),
      makeWorkout(daysAgo(20), "Squat (Barbell)", 80, 5),
      makeWorkout(daysAgo(16), "Squat (Barbell)", 80, 5),
      // Recent period (days 0–13 ago)
      makeWorkout(daysAgo(10), "Squat (Barbell)", 85, 5),
      makeWorkout(daysAgo(5), "Squat (Barbell)", 85, 5),
      makeWorkout(daysAgo(1), "Squat (Barbell)", 85, 5),
    ];

    const input: InterferenceInput = { dailyLogs, workouts };
    const result = composeInterference(input);

    expect(result.interference_level).toBe("none");
    expect(result.action).toBeNull();
    expect(result.lift_trend).toBe("progressing");
    // ratio should be approximately 1.0 (within a small tolerance)
    expect(result.tss_ratio_7d_28d).not.toBeNull();
    expect(result.tss_ratio_7d_28d!).toBeGreaterThan(0.8);
    expect(result.tss_ratio_7d_28d!).toBeLessThan(1.2);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Load spike 1.5x + flat lifts → 'high', action 'reduce_endurance_volume'
// ---------------------------------------------------------------------------

describe("composeInterference — load spike 1.5x + flat lifts", () => {
  it("returns high interference with reduce_endurance_volume when load spikes 1.5x and lifts are flat", () => {
    // Recent 7d avg: 150 TSS/day, older 21d avg: ~67 TSS/day
    // weekly_7d = 150*7 = 1050
    // avg_weekly_28d = (150*7 + 67*21) / 4 = (1050 + 1407) / 4 = 614.25
    // ratio = 1050 / 614.25 ≈ 1.71 → > 1.4 → high
    const dailyLogs = makeLogsWithPattern(150, 67);

    // Flat lifts: recent 14d ≈ prior 14d (within 1%)
    // Use same weight but slightly different reps that stay within the flat band
    const workouts: WorkoutSession[] = [
      makeWorkout(daysAgo(25), "Deadlift (Barbell)", 100, 5),
      makeWorkout(daysAgo(20), "Deadlift (Barbell)", 100, 5),
      makeWorkout(daysAgo(16), "Deadlift (Barbell)", 100, 5),
      makeWorkout(daysAgo(10), "Deadlift (Barbell)", 100, 5),
      makeWorkout(daysAgo(5), "Deadlift (Barbell)", 100, 5),
      makeWorkout(daysAgo(1), "Deadlift (Barbell)", 100, 5),
    ];

    const input: InterferenceInput = { dailyLogs, workouts };
    const result = composeInterference(input);

    expect(result.interference_level).toBe("high");
    expect(result.action).toBe("reduce_endurance_volume");
    expect(result.lift_trend).toBe("flat");
    expect(result.tss_ratio_7d_28d).not.toBeNull();
    expect(result.tss_ratio_7d_28d!).toBeGreaterThan(1.4);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Load spike 1.3x + flat lifts → 'mild', action 'monitor'
// ---------------------------------------------------------------------------

describe("composeInterference — load spike 1.3x + flat lifts", () => {
  it("returns mild interference with monitor action when load spikes 1.3x and lifts are flat", () => {
    // We need ratio in (1.2, 1.4]
    // weekly_7d = recent7 * 7
    // avg_weekly_28d = (recent7*7 + older21) / 4
    // To get ratio ≈ 1.3: recent7 * 7 = 1.3 * avg_weekly_28d
    // Let older daily = 50 → older21 total = 1050
    // recent7*7 = 1.3 * (recent7*7 + 1050)/4
    // 4*recent7*7 = 1.3*(recent7*7 + 1050)
    // 28*r = 1.3*7*r + 1.3*1050
    // 28r - 9.1r = 1365
    // 18.9r = 1365 → r ≈ 72.2
    // So recent7 ≈ 72, older = 50:
    // weekly_7d = 504, avg = (504+1050)/4 = 388.5, ratio = 504/388.5 ≈ 1.297 ✓
    const dailyLogs = makeLogsWithPattern(72, 50);

    // Flat lifts
    const workouts: WorkoutSession[] = [
      makeWorkout(daysAgo(25), "Squat (Barbell)", 90, 5),
      makeWorkout(daysAgo(20), "Squat (Barbell)", 90, 5),
      makeWorkout(daysAgo(16), "Squat (Barbell)", 90, 5),
      makeWorkout(daysAgo(10), "Squat (Barbell)", 90, 5),
      makeWorkout(daysAgo(5), "Squat (Barbell)", 90, 5),
      makeWorkout(daysAgo(1), "Squat (Barbell)", 90, 5),
    ];

    const input: InterferenceInput = { dailyLogs, workouts };
    const result = composeInterference(input);

    expect(result.interference_level).toBe("mild");
    expect(result.action).toBe("monitor");
    expect(result.lift_trend).toBe("flat");
    expect(result.tss_ratio_7d_28d).not.toBeNull();
    expect(result.tss_ratio_7d_28d!).toBeGreaterThan(1.2);
    expect(result.tss_ratio_7d_28d!).toBeLessThanOrEqual(1.4);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Load spike 1.5x + progressing lifts → 'mild', action 'monitor'
// ---------------------------------------------------------------------------

describe("composeInterference — load spike 1.5x + progressing lifts", () => {
  it("returns mild interference with monitor action when load spikes 1.5x but lifts are still progressing", () => {
    // Same spike pattern as test 2 (ratio > 1.4)
    const dailyLogs = makeLogsWithPattern(150, 67);

    // Progressing lifts: recent is clearly higher
    const workouts: WorkoutSession[] = [
      makeWorkout(daysAgo(25), "Squat (Barbell)", 80, 5),
      makeWorkout(daysAgo(20), "Squat (Barbell)", 80, 5),
      makeWorkout(daysAgo(16), "Squat (Barbell)", 80, 5),
      makeWorkout(daysAgo(10), "Squat (Barbell)", 88, 5),
      makeWorkout(daysAgo(5), "Squat (Barbell)", 88, 5),
      makeWorkout(daysAgo(1), "Squat (Barbell)", 88, 5),
    ];

    const input: InterferenceInput = { dailyLogs, workouts };
    const result = composeInterference(input);

    expect(result.interference_level).toBe("mild");
    expect(result.action).toBe("monitor");
    expect(result.lift_trend).toBe("progressing");
    expect(result.tss_ratio_7d_28d).not.toBeNull();
    expect(result.tss_ratio_7d_28d!).toBeGreaterThan(1.4);
  });
});

// ---------------------------------------------------------------------------
// Test 5: No endurance data → 'none', ratio null, lift_trend still computed
// ---------------------------------------------------------------------------

describe("composeInterference — no endurance data", () => {
  it("returns none with null ratio when there is no endurance load, but lift trend is still computed", () => {
    const dailyLogs = makeLogs(null); // all null endurance_load

    // Progressing lifts — should still be computed
    const workouts: WorkoutSession[] = [
      makeWorkout(daysAgo(25), "Squat (Barbell)", 80, 5),
      makeWorkout(daysAgo(20), "Squat (Barbell)", 80, 5),
      makeWorkout(daysAgo(16), "Squat (Barbell)", 80, 5),
      makeWorkout(daysAgo(10), "Squat (Barbell)", 87, 5),
      makeWorkout(daysAgo(5), "Squat (Barbell)", 87, 5),
      makeWorkout(daysAgo(1), "Squat (Barbell)", 87, 5),
    ];

    const input: InterferenceInput = { dailyLogs, workouts };
    const result = composeInterference(input);

    expect(result.interference_level).toBe("none");
    expect(result.action).toBeNull();
    expect(result.tss_ratio_7d_28d).toBeNull();
    // lift trend is still computed from workouts
    expect(result.lift_trend).not.toBe("insufficient_data");
    expect(result.narrative).toMatch(/no endurance/i);
  });
});

// ---------------------------------------------------------------------------
// Test 6: Order-independence — ascending vs descending input → same result
// ---------------------------------------------------------------------------

describe("composeInterference — order independence", () => {
  it("produces the same result regardless of whether input is sorted ascending or descending", () => {
    const dailyLogsDesc = makeLogs(30); // newest-first
    const dailyLogsAsc = [...dailyLogsDesc].reverse(); // oldest-first

    const workoutsDesc: WorkoutSession[] = [
      makeWorkout(daysAgo(25), "Deadlift (Barbell)", 110, 4),
      makeWorkout(daysAgo(18), "Deadlift (Barbell)", 112, 4),
      makeWorkout(daysAgo(10), "Deadlift (Barbell)", 115, 4),
      makeWorkout(daysAgo(3), "Deadlift (Barbell)", 118, 4),
    ];
    const workoutsAsc = [...workoutsDesc].reverse();

    const resultDesc = composeInterference({
      dailyLogs: dailyLogsDesc,
      workouts: workoutsDesc,
    });
    const resultAsc = composeInterference({
      dailyLogs: dailyLogsAsc,
      workouts: workoutsAsc,
    });

    expect(resultDesc.interference_level).toBe(resultAsc.interference_level);
    expect(resultDesc.tss_ratio_7d_28d).toBeCloseTo(resultAsc.tss_ratio_7d_28d!);
    expect(resultDesc.lift_trend).toBe(resultAsc.lift_trend);
    expect(resultDesc.action).toBe(resultAsc.action);
  });
});

// ---------------------------------------------------------------------------
// Test 7: Empty input → safe 'none', no throw
// ---------------------------------------------------------------------------

describe("composeInterference — empty input", () => {
  it("returns safe none without throwing when both dailyLogs and workouts are empty", () => {
    const input: InterferenceInput = { dailyLogs: [], workouts: [] };

    expect(() => composeInterference(input)).not.toThrow();
    const result = composeInterference(input);

    expect(result.interference_level).toBe("none");
    expect(result.action).toBeNull();
    expect(result.tss_ratio_7d_28d).toBeNull();
    expect(result.lift_trend).toBe("insufficient_data");
    expect(result.narrative).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Test 8: Output validates against schema
// ---------------------------------------------------------------------------

describe("composeInterference — schema validation", () => {
  it("produces output that validates against InterferenceResultSchema in all scenarios", () => {
    const scenarios: InterferenceInput[] = [
      // Scenario A: steady state
      { dailyLogs: makeLogs(25), workouts: [makeWorkout(daysAgo(10), "Squat (Barbell)", 85, 5)] },
      // Scenario B: spike + flat
      {
        dailyLogs: makeLogsWithPattern(150, 67),
        workouts: [
          makeWorkout(daysAgo(20), "Squat (Barbell)", 90, 5),
          makeWorkout(daysAgo(5), "Squat (Barbell)", 90, 5),
        ],
      },
      // Scenario C: empty
      { dailyLogs: [], workouts: [] },
      // Scenario D: no endurance, no workouts
      { dailyLogs: makeLogs(null), workouts: [] },
    ];

    for (const input of scenarios) {
      const result = composeInterference(input);
      const parsed = InterferenceResultSchema.safeParse(result);
      expect(parsed.success).toBe(true);
    }
  });
});
