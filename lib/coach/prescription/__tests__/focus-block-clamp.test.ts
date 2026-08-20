import { describe, it, expect } from "vitest";
import { prescribeSecondaryAutoregulated } from "@/lib/coach/prescription/autoregulation-rule";
import { maintenanceLoadFor } from "@/lib/coach/prescription/maintenance-baseline";
import type { WorkoutSetSample } from "@/lib/coach/prescription/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

// Mirrors prescribe-week.ts. 1.0 since 2026-08-20: the ceiling stops a
// secondary CLIMBING mid-block, it does not cut load. Maintenance relief comes
// from the volume cut instead.
const FOCUS_BLOCK_CLAMP = 1.0;

const DEADLIFT: PlannedExercise = {
  name: "Deadlift (Barbell)",
  baseKg: 82.5,
  baseReps: 6,
  sets: 3,
  key: "deadlift",
  increment: { step: 2.5 },
};

function prescribe(currentWorkingKg: number, anchorKg: number, staticReps: number | null = null) {
  return prescribeSecondaryAutoregulated({
    baseExercise: DEADLIFT,
    currentWorkingKg,
    // The athlete hit the prescription cleanly — the case that must not decay.
    lastWeekHitRirTargetCleanly: true,
    consecutiveRirMisses: 0,
    maintenanceBaselineKg: anchorKg,
    focusBlockClampMultiplier: FOCUS_BLOCK_CLAMP,
    baselineSets: 3,
    staticBaselineReps: staticReps,
    baselineReps: 8,
    isFocusBlock: true,
    blockPhase: "pre_target",
  });
}

describe("focus-block clamp on secondary primaries", () => {
  it("holds a steady load across cycles when anchored to block-entry capacity", () => {
    // Entering the block the athlete's clean max was 90 kg. The ceiling is now
    // 90 itself, not 82.5 — held at demonstrated capacity, not 8% under it.
    const anchor = 90;
    let working = 90;
    const prescribed: number[] = [];

    // Five cycles where the athlete performs exactly what was prescribed, so
    // the rolling window max becomes the clamped load each time.
    for (let i = 0; i < 5; i++) {
      const out = prescribe(working, anchor);
      prescribed.push(out.baseKg!);
      working = out.baseKg!; // athlete lifts exactly the prescription
    }

    expect(prescribed).toEqual([90, 90, 90, 90, 90]);
  });

  it("cannot ratchet even when the anchor tracks the rolling max", () => {
    // Before 2026-08-20 this decayed 82.5 -> 75 -> 70 -> 65: the multiplier cut
    // 8% off, the athlete performed the cut load, and it became the next
    // anchor. Two independent fixes now close it — the anchor is pinned to
    // block-entry capacity, AND the multiplier no longer cuts at all. Feeding
    // the output straight back in is the harshest version of the old bug.
    let working = 90;
    const prescribed: number[] = [];
    for (let i = 0; i < 4; i++) {
      const out = prescribe(working, working);
      prescribed.push(out.baseKg!);
      working = out.baseKg!;
    }
    expect(prescribed).toEqual([90, 90, 90, 90]);
  });

  it("holds load at demonstrated capacity rather than below it", () => {
    // The point of the 2026-08-20 change: a secondary is held at what the
    // athlete has already done, not 8% under it. Deadlift at 82.5x8 stays at
    // 82.5, which is what maintenance means.
    expect(prescribe(82.5, 82.5).baseKg).toBe(82.5);
    expect(prescribe(90, 90).baseKg).toBe(90);
  });

  it("still refuses to let a secondary climb during a focus block", () => {
    // A clean week would otherwise add a step. The ceiling is the whole reason
    // the multiplier survives at 1.0 rather than being deleted.
    expect(prescribe(80, 80).baseKg).toBe(80);
  });

  it("block-entry baseline ignores in-block sessions", () => {
    const sets: WorkoutSetSample[] = [
      // Pre-block: the capacity the ceiling should anchor to.
      mk("2026-07-05", 90, 10),
      // In-block: clamped work that must NOT lower the anchor.
      mk("2026-08-12", 82.5, 8),
    ];
    const blockStart = "2026-07-13";
    const preBlockOnly = sets.filter((s) => s.performed_on < blockStart);

    expect(maintenanceLoadFor("Deadlift (Barbell)", 2, preBlockOnly, blockStart)).toBe(90);
    // Rolling window as of today would have collapsed to the clamped load.
    expect(maintenanceLoadFor("Deadlift (Barbell)", 2, sets, "2026-08-20")).toBe(82.5);
  });
});

function mk(performed_on: string, kg: number, reps: number): WorkoutSetSample {
  return {
    exercise_name: "Deadlift (Barbell)",
    exercise_key: null,
    kg,
    reps,
    warmup: false,
    failure: false,
    performed_on,
    rir: 2,
  };
}

describe("focus-block volume cut", () => {
  it("takes a quarter off the STATIC template rep target and HOLDS sets", () => {
    // Sets carry the exposure: 3x6 is three rehearsals of the pattern at the
    // maintenance load, 2x8 is two. And at a load good for 8 reps at RIR 2,
    // the second set of 2x8 lands near failure on a lift that is resting.
    const r = prescribe(82.5, 82.5, 8);
    expect(r.baseReps).toBe(6);
    expect(r.sets).toBe(3);
  });

  it("does not compound when its own output is fed back as realized reps", () => {
    // THE bug that got the 2026-06-06 version removed, in its new location.
    // Discovery reports the MEDIAN REALIZED rep count, so last week's reduced
    // prescription becomes this week's baselineReps. Anchored to the static
    // template, the result is identical every week regardless.
    let realizedReps = 8;
    const out: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = prescribeSecondaryAutoregulated({
        baseExercise: DEADLIFT,
        currentWorkingKg: 82.5,
        lastWeekHitRirTargetCleanly: true,
        consecutiveRirMisses: 0,
        maintenanceBaselineKg: 82.5,
        focusBlockClampMultiplier: FOCUS_BLOCK_CLAMP,
        baselineSets: 3,
        baselineReps: realizedReps,   // <- tracks what was performed
        staticBaselineReps: 8,        // <- does not move
        isFocusBlock: true,
        blockPhase: "pre_target",
      });
      out.push(r.baseReps!);
      realizedReps = r.baseReps!;
    }
    expect(out).toEqual([6, 6, 6, 6, 6]);
  });

  it("floors at 4 reps — below that it is heavy singles, not maintenance", () => {
    expect(prescribe(82.5, 82.5, 5).baseReps).toBe(4);
    expect(prescribe(82.5, 82.5, 4).baseReps).toBe(4);
  });

  it("keeps total volume in the maintenance band, not half", () => {
    // The first version cut a set and landed at ~50% of working volume. Holding
    // sets and trimming reps lands at 75%.
    const r = prescribe(82.5, 82.5, 8);
    const full = 82.5 * 8 * 3;
    const maintained = r.baseKg! * r.baseReps! * r.sets!;
    expect(maintained / full).toBeGreaterThan(0.6);
    expect(maintained / full).toBeLessThan(0.85);
  });

  it("leaves volume alone outside a focus block", () => {
    const r = prescribeSecondaryAutoregulated({
      baseExercise: DEADLIFT, currentWorkingKg: 82.5,
      lastWeekHitRirTargetCleanly: true, consecutiveRirMisses: 0,
      maintenanceBaselineKg: null, focusBlockClampMultiplier: null,
      baselineSets: 3, baselineReps: 8, staticBaselineReps: 8,
      isFocusBlock: false, blockPhase: "pre_target",
    });
    expect(r.sets).toBe(3);
    expect(r.baseReps).toBe(8);
    expect(r.baseKg).toBe(85); // free to progress
  });

  it("lets deload_week's set halving win over the focus-block rep cut", () => {
    const r = prescribeSecondaryAutoregulated({
      baseExercise: DEADLIFT, currentWorkingKg: 82.5,
      lastWeekHitRirTargetCleanly: true, consecutiveRirMisses: 0,
      maintenanceBaselineKg: 82.5, focusBlockClampMultiplier: FOCUS_BLOCK_CLAMP,
      baselineSets: 4, baselineReps: 8, staticBaselineReps: 8,
      isFocusBlock: true, blockPhase: "deload_week",
    });
    expect(r.sets).toBe(2);
    expect(r.baseReps).toBe(8);   // deload owns volume via sets, not reps
    expect(r.baseKg).toBe(65);
  });
});
