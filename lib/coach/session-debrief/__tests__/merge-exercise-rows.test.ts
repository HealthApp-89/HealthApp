import { describe, expect, it } from "vitest";
import { mergeExerciseRows } from "@/lib/coach/session-debrief/index";

type S = { warmup: boolean; kg: number };
const w = (kg: number): S => ({ warmup: true, kg });
const x = (kg: number): S => ({ warmup: false, kg });

describe("mergeExerciseRows", () => {
  it("collapses warmup-split rows into one entry with only the working sets counted", () => {
    const out = mergeExerciseRows([
      { name: "Squat (Barbell)", sets: [w(47.5)] },
      { name: "Squat (Barbell)", sets: [w(62.5)] },
      { name: "Squat (Barbell)", sets: [x(80), x(80), x(80)] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Squat (Barbell)");
    expect(out[0].sets.filter((s) => !s.warmup)).toHaveLength(3);
  });

  it("drops an exercise that logged only warmup sets", () => {
    const out = mergeExerciseRows([
      { name: "Mobility Drill", sets: [w(0), w(0)] },
      { name: "Squat (Barbell)", sets: [x(80)] },
    ]);
    expect(out.map((e) => e.name)).toEqual(["Squat (Barbell)"]);
  });

  it("does not merge distinct exercises", () => {
    const out = mergeExerciseRows([
      { name: "Squat (Barbell)", sets: [x(80)] },
      { name: "Leg Press Single Leg", sets: [x(140)] },
    ]);
    expect(out).toHaveLength(2);
  });

  it("matches names case- and whitespace-insensitively but keeps the first spelling", () => {
    const out = mergeExerciseRows([
      { name: "Squat (Barbell)", sets: [x(80)] },
      { name: "  squat (barbell) ", sets: [x(80)] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Squat (Barbell)");
    expect(out[0].sets).toHaveLength(2);
  });

  it("preserves first-appearance order", () => {
    const out = mergeExerciseRows([
      { name: "B", sets: [x(1)] },
      { name: "A", sets: [x(1)] },
      { name: "B", sets: [x(1)] },
    ]);
    expect(out.map((e) => e.name)).toEqual(["B", "A"]);
  });

  it("returns an empty array for no rows", () => {
    expect(mergeExerciseRows([])).toEqual([]);
  });
});
