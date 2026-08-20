import { describe, it, expect } from "vitest";
import { resolveExercise } from "@/lib/coach/exercise-library";
import { SESSION_PLANS } from "@/lib/coach/sessionPlans";
import { setTonnage, rawTonnage, type MechanicalExercise } from "@/lib/coach/strain/mechanical-load";
import { brzycki } from "@/lib/coach/e1rm";

describe("unilateral exercise modelling", () => {
  it("marks the rotations unilateral in both the library and the plan", () => {
    for (const name of ["Cable External Rotation", "Cable Internal Rotation"]) {
      expect(resolveExercise(name)?.unilateral, `${name} library`).toBe(true);
      const planned = SESSION_PLANS.Arms!.find((e) => e.name === name);
      expect(planned?.unilateral, `${name} plan`).toBe(true);
      // baseReps is now a PER SIDE quantity.
      expect(planned?.baseReps, `${name} anchor`).toBe(15);
    }
  });

  it("does not mark bilateral exercises unilateral", () => {
    for (const name of ["Leg Press", "Squat (Barbell)", "Chest Fly", "Lateral Raise (Dumbbell)"]) {
      expect(resolveExercise(name)?.unilateral ?? false, name).toBe(false);
    }
  });

  it("keeps both leg press variants, under unambiguous names", () => {
    expect(resolveExercise("Leg Press")?.id).toBe("leg_press");
    expect(resolveExercise("Leg Press")?.unilateral ?? false).toBe(false);

    const single = resolveExercise("Leg Press (Single Leg)");
    expect(single?.id).toBe("leg_press_single_leg");
    expect(single?.unilateral).toBe(true);

    // The stale title must NOT resolve to the single-leg entry — in this
    // athlete's history it denotes bilateral work and was migrated to leg_press.
    const stale = resolveExercise("Leg Press Single Leg");
    expect(stale?.id).not.toBe("leg_press_single_leg");
  });
});

describe("mechanical load with unilateral sets", () => {
  it("doubles a unilateral set because reps are per side", () => {
    expect(setTonnage("Cable Internal Rotation", 18, 15)).toBe(540);
    expect(setTonnage("Chest Fly", 18, 15)).toBe(270);
  });

  it("is scale-preserving across the migration", () => {
    // Pre-migration this row read 18 kg x 30 combined and scored 540 as a
    // bilateral set. Post-migration it reads 18 x 15 per side and must still
    // score 540, or STRAIN_CALIBRATION silently stops applying.
    const before = 18 * 30;
    const after = setTonnage("Cable Internal Rotation", 18, 15);
    expect(after).toBe(before);
  });

  it("carries the doubling through rawTonnage", () => {
    const exercises: MechanicalExercise[] = [
      { name: "Cable External Rotation", e1rm: null, sets: [
        { kg: 9, reps: 15, warmup: false, rir: 2 },
        { kg: 9, reps: 15, warmup: false, rir: 2 },
      ] },
      { name: "Chest Fly", e1rm: null, sets: [{ kg: 30, reps: 10, warmup: false, rir: 2 }] },
    ];
    // (9*15*2)*2 rotation sets = 540, plus 30*10 = 300.
    expect(rawTonnage(exercises)).toBe(840);
  });

  it("ignores warmups regardless of the flag", () => {
    const exercises: MechanicalExercise[] = [
      { name: "Cable External Rotation", e1rm: null, sets: [{ kg: 9, reps: 15, warmup: true, rir: null }] },
    ];
    expect(rawTonnage(exercises)).toBe(0);
  });

  it("treats an unresolved name as bilateral rather than throwing", () => {
    expect(setTonnage("Some Exercise Not In The Library", 20, 10)).toBe(200);
  });
});

describe("rep anchors after the 15 → 10 drop", () => {
  const LOWERED = [
    ["Chest", "Chest Fly"], ["Chest", "Lateral Raise (Dumbbell)"], ["Chest", "Triceps Pushdown (Cable)"],
    ["Legs", "Hip Abductor (Machine)"], ["Legs", "Seated Calf Raise"],
    ["Back", "Shrug (Barbell)"],
    ["Arms", "Arnold Press (Dumbbell)"], ["Arms", "Bicep Curl (Dumbbell)"],
    ["Arms", "Front Raise (Dumbbell)"], ["Arms", "Hammer Curl (Dumbbell)"],
    ["Arms", "Lateral Raise (Dumbbell)"], ["Arms", "Rear Delt Fly"],
    ["Arms", "Triceps Pushdown (Cable - Straight Bar)"],
  ] as const;

  it.each(LOWERED)("%s / %s anchors at 10", (session, name) => {
    const ex = SESSION_PLANS[session]!.find((e) => e.name === name);
    expect(ex, `${name} missing from ${session}`).toBeDefined();
    expect(ex!.baseReps).toBe(10);
  });

  it("gives Lateral Raise ONE anchor across both days it appears on", () => {
    const chest = SESSION_PLANS.Chest!.find((e) => e.name === "Lateral Raise (Dumbbell)");
    const arms = SESSION_PLANS.Arms!.find((e) => e.name === "Lateral Raise (Dumbbell)");
    expect(chest!.baseReps).toBe(arms!.baseReps);
  });

  it("leaves the compounds alone", () => {
    const compounds: Array<[string, string, number]> = [
      ["Legs", "Squat (Barbell)", 6],
      ["Back", "Deadlift (Barbell)", 6],
      ["Chest", "Decline Bench Press (Barbell)", 8],
      ["Chest", "Overhead Press (Barbell)", 7],
      ["Chest", "Incline Bench Press (Dumbbell)", 11],
    ];
    for (const [session, name, expected] of compounds) {
      const ex = SESSION_PLANS[session]!.find((e) => e.name === name);
      expect(ex!.baseReps, name).toBe(expected);
    }
  });

  it("puts accessory work back inside the e1RM-eligible rep window", () => {
    // brzycki rejects >12 reps, so a 15-anchored accessory produced no
    // trackable data point at the top of its range. A 10 anchor does.
    expect(brzycki(30, 15)).toBeNull();
    expect(brzycki(30, 10)).not.toBeNull();
  });
});
