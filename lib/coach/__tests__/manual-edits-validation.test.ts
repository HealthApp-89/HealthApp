import { describe, expect, test } from "vitest";
import { validateDayEdits } from "@/lib/coach/manual-edits";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

const day: PlannedExercise[] = [
  { name: "Squat (Barbell)", sets: 3, baseKg: 67.5, baseReps: 8 },
  { name: "RDL", sets: 3, baseKg: 80, baseReps: 8 },
];
describe("validateDayEdits", () => {
  test("happy path", () => {
    expect(validateDayEdits({ order: ["RDL", "Squat (Barbell)"], exercises: { RDL: { sets: 4, kg: 82.5, reps: 8 } } }, day).ok).toBe(true);
  });
  test("order must be a permutation", () => {
    expect(validateDayEdits({ order: ["RDL"] }, day).ok).toBe(false);
  });
  test("bounds: sets>=1, kg on 0.25 grid, reps<=30", () => {
    expect(validateDayEdits({ exercises: { RDL: { sets: 0 } } }, day).ok).toBe(false);
    expect(validateDayEdits({ exercises: { RDL: { kg: 71.13 } } }, day).ok).toBe(false);
    expect(validateDayEdits({ exercises: { RDL: { reps: 31 } } }, day).ok).toBe(false);
  });
  test("warmup ramp entries are excluded from the name universe", () => {
    const withWarmups: PlannedExercise[] = [
      { name: "Squat (Barbell)", sets: 1, baseKg: 40, warmup: true },
      { name: "Squat (Barbell)", sets: 1, baseKg: 55, warmup: true },
      ...day,
    ];
    // Permutation is over the deduped non-warmup names — length 2, not 4.
    expect(validateDayEdits({ order: ["RDL", "Squat (Barbell)"] }, withWarmups).ok).toBe(true);
    expect(validateDayEdits({ exercises: { "Squat (Barbell)": { sets: 4 } } }, withWarmups).ok).toBe(true);
  });
});
