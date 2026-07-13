import { describe, expect, test } from "vitest";
import { applyManualSessionEdits, nonWarmupNames, validateDayEdits } from "@/lib/coach/manual-edits";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

const day: PlannedExercise[] = [
  { name: "Squat (Barbell)", sets: 3, baseKg: 67.5, baseReps: 8 },
  { name: "RDL", sets: 3, baseKg: 80, baseReps: 8 },
  { name: "Hip Thrust (Machine)", sets: 3, baseKg: 100, baseReps: 10 },
];

// Prescription days carry warmup ramp entries as SEPARATE entries with the
// SAME name as the working entry (augmentFirstLoadedCompoundWithWarmups).
const warmupDay: PlannedExercise[] = [
  { name: "Squat (Barbell)", sets: 1, baseKg: 40, baseReps: 5, warmup: true, note: "Warmup 1 — ramp to working set" },
  { name: "Squat (Barbell)", sets: 1, baseKg: 55, baseReps: 3, warmup: true, note: "Warmup 2 — ramp to working set" },
  { name: "Squat (Barbell)", sets: 3, baseKg: 67.5, baseReps: 8 },
  { name: "RDL", sets: 3, baseKg: 80, baseReps: 8 },
];

describe("applyManualSessionEdits", () => {
  test("per-exercise deltas override only named fields", () => {
    const { exercises, touched } = applyManualSessionEdits(day, {
      exercises: { "Squat (Barbell)": { sets: 4, kg: 70 } },
    });
    expect(touched).toBe(true);
    expect(exercises[0]).toMatchObject({ name: "Squat (Barbell)", sets: 4, baseKg: 70, baseReps: 8 });
    expect(exercises[1]).toMatchObject({ name: "RDL", sets: 3, baseKg: 80 });
  });
  test("order permutes; unknown names in order are ignored (falls back to input order)", () => {
    const { exercises } = applyManualSessionEdits(day, {
      order: ["RDL", "Squat (Barbell)", "Hip Thrust (Machine)"],
    });
    expect(exercises.map((e) => e.name)).toEqual(["RDL", "Squat (Barbell)", "Hip Thrust (Machine)"]);
    const bad = applyManualSessionEdits(day, { order: ["Nonexistent"] });
    expect(bad.exercises.map((e) => e.name)).toEqual(day.map((e) => e.name));
  });
  test("edits naming a missing exercise are skipped, others still apply", () => {
    const { exercises } = applyManualSessionEdits(day, {
      exercises: { Ghost: { sets: 9 }, RDL: { reps: 10 } },
    });
    expect(exercises[1].baseReps).toBe(10);
    expect(exercises.every((e) => e.sets !== 9)).toBe(true);
  });
  test("null/empty edits → untouched, same array content", () => {
    expect(applyManualSessionEdits(day, null).touched).toBe(false);
    expect(applyManualSessionEdits(day, {}).touched).toBe(false);
  });
});

describe("applyManualSessionEdits — warmup-duplicated names (C1 regression)", () => {
  test("delta on a name with warmup duplicates hits ONLY the working entry", () => {
    const { exercises, touched } = applyManualSessionEdits(warmupDay, {
      exercises: { "Squat (Barbell)": { sets: 4, kg: 70 } },
    });
    expect(touched).toBe(true);
    // Warmup entries untouched.
    expect(exercises[0]).toMatchObject({ name: "Squat (Barbell)", warmup: true, sets: 1, baseKg: 40 });
    expect(exercises[1]).toMatchObject({ name: "Squat (Barbell)", warmup: true, sets: 1, baseKg: 55 });
    // Working entry gets the delta.
    expect(exercises[2]).toMatchObject({ name: "Squat (Barbell)", sets: 4, baseKg: 70, baseReps: 8 });
    expect(exercises[2].warmup).toBeUndefined();
    expect(exercises[3]).toMatchObject({ name: "RDL", sets: 3, baseKg: 80 });
  });

  test("order permutes non-warmup names; warmups re-anchor before their working entry", () => {
    const { exercises, touched } = applyManualSessionEdits(warmupDay, {
      order: ["RDL", "Squat (Barbell)"],
    });
    expect(touched).toBe(true);
    expect(exercises.map((e) => `${e.name}${e.warmup ? " [w]" : ""}`)).toEqual([
      "RDL",
      "Squat (Barbell) [w]",
      "Squat (Barbell) [w]",
      "Squat (Barbell)",
    ]);
    // Warmup relative order preserved (40 kg ramp before 55 kg ramp).
    expect(exercises[1].baseKg).toBe(40);
    expect(exercises[2].baseKg).toBe(55);
  });

  test("validateDayEdits accepts a non-warmup permutation against a warmup-duplicated day", () => {
    expect(validateDayEdits({ order: ["RDL", "Squat (Barbell)"] }, warmupDay).ok).toBe(true);
    // Full raw-length order (with duplicate names) is NOT a valid permutation.
    expect(
      validateDayEdits(
        { order: ["Squat (Barbell)", "Squat (Barbell)", "Squat (Barbell)", "RDL"] },
        warmupDay,
      ).ok,
    ).toBe(false);
  });

  test("untouched warmup day → touched:false, entries unchanged", () => {
    expect(applyManualSessionEdits(warmupDay, null).touched).toBe(false);
    const { exercises, touched } = applyManualSessionEdits(warmupDay, {});
    expect(touched).toBe(false);
    expect(exercises).toEqual(warmupDay);
  });

  test("nonWarmupNames dedupes to the editable name universe", () => {
    expect(nonWarmupNames(warmupDay)).toEqual(["Squat (Barbell)", "RDL"]);
  });
});
