import { describe, expect, test } from "vitest";
import { validateDayEdits } from "@/lib/coach/manual-edits";

const names = ["Squat (Barbell)", "RDL"];
describe("validateDayEdits", () => {
  test("happy path", () => {
    expect(validateDayEdits({ order: ["RDL", "Squat (Barbell)"], exercises: { RDL: { sets: 4, kg: 82.5, reps: 8 } } }, names).ok).toBe(true);
  });
  test("order must be a permutation", () => {
    expect(validateDayEdits({ order: ["RDL"] }, names).ok).toBe(false);
  });
  test("bounds: sets>=1, kg on 0.25 grid, reps<=30", () => {
    expect(validateDayEdits({ exercises: { RDL: { sets: 0 } } }, names).ok).toBe(false);
    expect(validateDayEdits({ exercises: { RDL: { kg: 71.13 } } }, names).ok).toBe(false);
    expect(validateDayEdits({ exercises: { RDL: { reps: 31 } } }, names).ok).toBe(false);
  });
});
