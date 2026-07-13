import { describe, expect, test } from "vitest";
import { applyManualSessionEdits } from "@/lib/coach/manual-edits";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

const day: PlannedExercise[] = [
  { name: "Squat (Barbell)", sets: 3, baseKg: 67.5, baseReps: 8 },
  { name: "RDL", sets: 3, baseKg: 80, baseReps: 8 },
  { name: "Hip Thrust (Machine)", sets: 3, baseKg: 100, baseReps: 10 },
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
