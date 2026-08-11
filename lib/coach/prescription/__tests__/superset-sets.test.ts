import { describe, it, expect } from "vitest";
import { equalizeSupersetSets } from "@/lib/coach/prescription/superset-sets";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

const ex = (name: string, sets: number | undefined, superset?: string): PlannedExercise => ({
  name, ...(sets === undefined ? {} : { sets }), ...(superset ? { superset } : {}),
});

describe("equalizeSupersetSets", () => {
  it("raises the short member to the group's max", () => {
    // The real Friday case: biceps read below target so the volume engine gave
    // Bicep Curl 4 while its shoulder partner stayed at 3.
    const out = equalizeSupersetSets([
      ex("Arnold Press (Dumbbell)", 3, "A"),
      ex("Bicep Curl (Dumbbell)", 4, "A"),
    ]);
    expect(out.map((e) => e.sets)).toEqual([4, 4]);
  });

  it("equalizes each group independently", () => {
    const out = equalizeSupersetSets([
      ex("Arnold Press (Dumbbell)", 3, "A"),
      ex("Bicep Curl (Dumbbell)", 4, "A"),
      ex("Front Raise (Dumbbell)", 3, "B"),
      ex("Hammer Curl (Dumbbell)", 3, "B"),
    ]);
    expect(out.map((e) => e.sets)).toEqual([4, 4, 3, 3]);
  });

  it("leaves solo exercises alone", () => {
    const out = equalizeSupersetSets([
      ex("Squat (Barbell)", 3),
      ex("Leg Extension (Machine)", 4),
    ]);
    expect(out.map((e) => e.sets)).toEqual([3, 4]);
  });

  it("hands back the same array when nothing needs changing", () => {
    const input = [ex("Arnold Press (Dumbbell)", 3, "A"), ex("Bicep Curl (Dumbbell)", 3, "A")];
    expect(equalizeSupersetSets(input)).toBe(input);
  });

  it("treats a non-contiguous shared tag as two separate groups", () => {
    // Same rule as the logger's groupsOf: a reorder that splits a pair
    // dissolves it, so the survivors must not be equalized to each other.
    const out = equalizeSupersetSets([
      ex("Arnold Press (Dumbbell)", 3, "A"),
      ex("Rear Delt Fly", 5),
      ex("Bicep Curl (Dumbbell)", 4, "A"),
    ]);
    expect(out.map((e) => e.sets)).toEqual([3, 5, 4]);
  });

  it("does not invent a count when no member declares one", () => {
    const out = equalizeSupersetSets([
      ex("Arnold Press (Dumbbell)", undefined, "A"),
      ex("Bicep Curl (Dumbbell)", undefined, "A"),
    ]);
    expect(out.map((e) => e.sets)).toEqual([undefined, undefined]);
  });

  it("ignores warm-ups, which carry no superset tag by construction", () => {
    const warm: PlannedExercise = { name: "Arnold Press (Dumbbell)", sets: 1, warmup: true };
    const out = equalizeSupersetSets([
      warm,
      ex("Arnold Press (Dumbbell)", 3, "A"),
      ex("Bicep Curl (Dumbbell)", 4, "A"),
    ]);
    expect(out.map((e) => e.sets)).toEqual([1, 4, 4]);
  });
});
