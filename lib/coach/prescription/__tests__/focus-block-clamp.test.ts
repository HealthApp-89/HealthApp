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

function prescribe(currentWorkingKg: number, anchorKg: number, staticSets: number | null = null) {
  return prescribeSecondaryAutoregulated({
    baseExercise: DEADLIFT,
    currentWorkingKg,
    // The athlete hit the prescription cleanly — the case that must not decay.
    lastWeekHitRirTargetCleanly: true,
    consecutiveRirMisses: 0,
    maintenanceBaselineKg: anchorKg,
    focusBlockClampMultiplier: FOCUS_BLOCK_CLAMP,
    baselineSets: 3,
    staticBaselineSets: staticSets,
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
  it("takes one set off the STATIC template count", () => {
    expect(prescribe(82.5, 82.5, 3).sets).toBe(2);
    expect(prescribe(82.5, 82.5, 4).sets).toBe(3);
  });

  it("does not compound when its own output is fed back as realized volume", () => {
    // THE bug that got the 2026-06-06 version removed. Discovery reports the
    // MEDIAN REALIZED set count, so last week's reduced prescription becomes
    // this week's baselineSets. Anchored to the static template, the result is
    // identical every week regardless of what was performed.
    const staticSets = 3;
    let realized = 3;
    const out: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = prescribeSecondaryAutoregulated({
        baseExercise: DEADLIFT,
        currentWorkingKg: 82.5,
        lastWeekHitRirTargetCleanly: true,
        consecutiveRirMisses: 0,
        maintenanceBaselineKg: 82.5,
        focusBlockClampMultiplier: FOCUS_BLOCK_CLAMP,
        baselineSets: realized,          // <- tracks what was performed
        staticBaselineSets: staticSets,  // <- does not move
        baselineReps: 8,
        isFocusBlock: true,
        blockPhase: "pre_target",
      });
      out.push(r.sets!);
      realized = r.sets!;
    }
    expect(out).toEqual([2, 2, 2, 2, 2]);
  });

  it("floors at 2 — one working set is a token, not a maintenance dose", () => {
    expect(prescribe(82.5, 82.5, 2).sets).toBe(2);
    expect(prescribe(82.5, 82.5, 1).sets).toBe(2);
  });

  it("leaves volume alone outside a focus block", () => {
    const r = prescribeSecondaryAutoregulated({
      baseExercise: DEADLIFT, currentWorkingKg: 82.5,
      lastWeekHitRirTargetCleanly: true, consecutiveRirMisses: 0,
      maintenanceBaselineKg: null, focusBlockClampMultiplier: null,
      baselineSets: 3, staticBaselineSets: 3, baselineReps: 8,
      isFocusBlock: false, blockPhase: "pre_target",
    });
    expect(r.sets).toBe(3);
    expect(r.baseKg).toBe(85); // free to progress
  });

  it("lets deload_week's halving win over the focus-block cut", () => {
    const r = prescribeSecondaryAutoregulated({
      baseExercise: DEADLIFT, currentWorkingKg: 82.5,
      lastWeekHitRirTargetCleanly: true, consecutiveRirMisses: 0,
      maintenanceBaselineKg: 82.5, focusBlockClampMultiplier: FOCUS_BLOCK_CLAMP,
      baselineSets: 4, staticBaselineSets: 4, baselineReps: 8,
      isFocusBlock: true, blockPhase: "deload_week",
    });
    expect(r.sets).toBe(2);
    expect(r.baseKg).toBe(65); // 0.80x still applies in deload
  });
});
