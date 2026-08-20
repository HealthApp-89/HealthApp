import { describe, it, expect } from "vitest";
import { expandPlannedSets } from "@/lib/logger/expand-sets";
import { maintenanceLoadFor } from "@/lib/coach/prescription/maintenance-baseline";
import { sessionsForExercise } from "@/lib/coach/prescription/session-grouping";
import type { WorkoutSetSample } from "@/lib/coach/prescription/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

const BENCH: PlannedExercise = {
  name: "Bench Press (Barbell)",
  baseKg: 60,
  baseReps: 8,
  sets: 3,
  key: "bench",
  increment: { step: 2.5 },
};

describe("expandPlannedSets", () => {
  it("opens with the working sets when there is no top set", () => {
    const sets = expandPlannedSets(BENCH, 2);
    expect(sets).toHaveLength(3);
    expect(sets.every((s) => s.is_top_set === false)).toBe(true);
    expect(sets.map((s) => s.set_index)).toEqual([0, 1, 2]);
  });

  it("puts a resolved top set FIRST and renumbers the working sets", () => {
    const sets = expandPlannedSets({ ...BENCH, topSet: { reps: 5, pctOfE1rm: 0.85, kg: 72.5 } }, 2);
    expect(sets).toHaveLength(4); // `sets` still means WORKING sets
    expect(sets[0]).toMatchObject({ set_index: 0, kg: 72.5, reps: 5, is_top_set: true, warmup: false });
    expect(sets.slice(1).map((s) => s.set_index)).toEqual([1, 2, 3]);
    expect(sets.slice(1).every((s) => s.kg === 60 && s.is_top_set === false)).toBe(true);
  });

  it("ignores an UNRESOLVED top set — intent without a load is not a set", () => {
    // prescribeWeek drops the field when it cannot resolve a load, but a stale
    // draft or a hand-authored plan can still carry {reps, pctOfE1rm} alone.
    const sets = expandPlannedSets({ ...BENCH, topSet: { reps: 5, pctOfE1rm: 0.85 } }, 2);
    expect(sets).toHaveLength(3);
    expect(sets.some((s) => s.is_top_set)).toBe(false);
  });

  it("never marks the top set as a warmup", () => {
    // It is the heaviest real effort of the exercise: it counts for volume and
    // it is the week's best e1RM data point. Warmup would exclude it from both.
    const sets = expandPlannedSets({ ...BENCH, topSet: { reps: 5, pctOfE1rm: 0.85, kg: 72.5 } }, 2);
    expect(sets[0]!.warmup).toBe(false);
  });

  it("leaves RIR unseeded on the top set", () => {
    const sets = expandPlannedSets({ ...BENCH, topSet: { reps: 5, pctOfE1rm: 0.85, kg: 72.5 } }, 2);
    expect(sets[0]!.rir).toBeNull();
    expect(sets[1]!.rir).toBe(2); // working sets still get the week's target
  });

  it("does not add a top set to a timed or warmup exercise", () => {
    const timed = expandPlannedSets(
      { name: "Plank", duration_seconds: 30, sets: 2, topSet: { reps: 5, pctOfE1rm: 0.85, kg: 20 } }, 2);
    expect(timed.some((s) => s.is_top_set)).toBe(false);

    const warm = expandPlannedSets(
      { ...BENCH, warmup: true, topSet: { reps: 5, pctOfE1rm: 0.85, kg: 72.5 } }, 2);
    expect(warm.some((s) => s.is_top_set)).toBe(false);
  });
});

describe("the engine must not read a top set as a working load", () => {
  const mk = (kg: number, reps: number, isTop = false): WorkoutSetSample => ({
    exercise_name: "Bench Press (Barbell)",
    exercise_key: null,
    kg, reps, warmup: false, failure: false,
    performed_on: "2026-08-25", rir: 2, is_top_set: isTop,
  });

  it("excludes the top set from maintenanceLoadFor", () => {
    // THE bug this column exists to prevent: maintenanceLoadFor returns a MAX,
    // and a top set is heavier by design. Counted, its 72.5 becomes next
    // week's working load and the back-offs ratchet up to it.
    const sets = [mk(72.5, 5, true), mk(60, 8), mk(60, 8), mk(60, 8)];
    expect(maintenanceLoadFor("Bench Press (Barbell)", 2, sets, "2026-08-26")).toBe(60);
  });

  it("would return the top-set load if the flag were dropped", () => {
    const sets = [mk(72.5, 5, false), mk(60, 8), mk(60, 8), mk(60, 8)];
    expect(maintenanceLoadFor("Bench Press (Barbell)", 2, sets, "2026-08-26")).toBe(72.5);
  });

  it("excludes the top set from the per-session clean/miss verdicts", () => {
    // isCleanSet checks reps against the prescribed target. A 5-rep top set
    // against an 8-rep target reads as a miss and triggers a back-off on an
    // exercise that performed exactly as prescribed.
    const sets = [mk(72.5, 5, true), mk(60, 8), mk(60, 8), mk(60, 8)];
    const sessions = sessionsForExercise(sets, "Bench Press (Barbell)");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sets).toHaveLength(3);
    expect(sessions[0]!.sets.every((s) => s.reps === 8)).toBe(true);
  });

  it("treats an absent flag as not-a-top-set, so pre-0059 rows are unchanged", () => {
    const legacy: WorkoutSetSample[] = [
      { exercise_name: "Bench Press (Barbell)", exercise_key: null, kg: 60, reps: 8,
        warmup: false, failure: false, performed_on: "2026-08-25" },
    ];
    expect(maintenanceLoadFor("Bench Press (Barbell)", 2, legacy, "2026-08-26")).toBe(60);
    expect(sessionsForExercise(legacy, "Bench Press (Barbell)")[0]!.sets).toHaveLength(1);
  });
});
