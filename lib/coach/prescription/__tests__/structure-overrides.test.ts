// lib/coach/prescription/__tests__/structure-overrides.test.ts
import { describe, expect, test } from "vitest";
import { applyStructureOverrides } from "@/lib/coach/prescription/structure-overrides";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

const legs: PlannedExercise[] = [
  { name: "Squat (Barbell)", sets: 3 },
  { name: "RDL", sets: 3 },
];

describe("applyStructureOverrides", () => {
  test("set counts override; order permutes", () => {
    const out = applyStructureOverrides(legs, "Legs", {
      Legs: { order: ["RDL", "Squat (Barbell)"], sets: { RDL: 4 } },
    });
    expect(out.map((e) => e.name)).toEqual(["RDL", "Squat (Barbell)"]);
    expect(out[0].sets).toBe(4);
  });
  test("null overrides / other session types are no-ops", () => {
    expect(applyStructureOverrides(legs, "Legs", null)).toEqual(legs);
    expect(applyStructureOverrides(legs, "Legs", { Chest: { sets: { RDL: 5 } } })).toEqual(legs);
  });
  test("warmup-duplicated names: sets hit only the working entry; order re-anchors warmups", () => {
    const withWarmups: PlannedExercise[] = [
      { name: "Squat (Barbell)", sets: 1, baseKg: 40, warmup: true },
      { name: "Squat (Barbell)", sets: 1, baseKg: 55, warmup: true },
      { name: "Squat (Barbell)", sets: 3, baseKg: 67.5 },
      { name: "RDL", sets: 3, baseKg: 80 },
    ];
    const out = applyStructureOverrides(withWarmups, "Legs", {
      Legs: { order: ["RDL", "Squat (Barbell)"], sets: { "Squat (Barbell)": 4 } },
    });
    expect(out.map((e) => `${e.name}${e.warmup ? " [w]" : ""}`)).toEqual([
      "RDL",
      "Squat (Barbell) [w]",
      "Squat (Barbell) [w]",
      "Squat (Barbell)",
    ]);
    // Warmup entries keep sets:1; only the working squat picks up sets:4.
    expect(out[1].sets).toBe(1);
    expect(out[2].sets).toBe(1);
    expect(out[3].sets).toBe(4);
  });
});
