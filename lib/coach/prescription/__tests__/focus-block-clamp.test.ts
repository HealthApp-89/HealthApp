import { describe, it, expect } from "vitest";
import { prescribeSecondaryAutoregulated } from "@/lib/coach/prescription/autoregulation-rule";
import { maintenanceLoadFor } from "@/lib/coach/prescription/maintenance-baseline";
import type { WorkoutSetSample } from "@/lib/coach/prescription/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

const FOCUS_BLOCK_CLAMP = 0.92;

const DEADLIFT: PlannedExercise = {
  name: "Deadlift (Barbell)",
  baseKg: 82.5,
  baseReps: 6,
  sets: 3,
  key: "deadlift",
  increment: { step: 2.5 },
};

function prescribe(currentWorkingKg: number, anchorKg: number) {
  return prescribeSecondaryAutoregulated({
    baseExercise: DEADLIFT,
    currentWorkingKg,
    // The athlete hit the prescription cleanly — the case that must not decay.
    lastWeekHitRirTargetCleanly: true,
    consecutiveRirMisses: 0,
    maintenanceBaselineKg: anchorKg,
    focusBlockClampMultiplier: FOCUS_BLOCK_CLAMP,
    baselineSets: 3,
    baselineReps: 8,
    isFocusBlock: true,
    blockPhase: "pre_target",
  });
}

describe("focus-block clamp on secondary primaries", () => {
  it("holds a steady load across cycles when anchored to block-entry capacity", () => {
    // Entering the block the athlete's clean max was 90 kg → ceiling 82.5.
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

    expect(prescribed).toEqual([82.5, 82.5, 82.5, 82.5, 82.5]);
  });

  it("ratchets down when the anchor tracks the rolling max (the pre-fix bug)", () => {
    // Documents WHY the anchor must be stable: feeding the clamped output back
    // in as the anchor decays the lift ~8% per cycle.
    let working = 90;
    const prescribed: number[] = [];
    for (let i = 0; i < 4; i++) {
      const out = prescribe(working, working); // anchor === rolling max
      prescribed.push(out.baseKg!);
      working = out.baseKg!;
    }
    expect(prescribed).toEqual([82.5, 75, 70, 65]);
    expect(prescribed.at(-1)!).toBeLessThan(prescribed[0]! * 0.8);
  });

  it("does not stop the athlete exceeding the ceiling from a real strength gain", () => {
    // Anchor rises only when block-entry capacity was genuinely higher.
    expect(prescribe(100, 100).baseKg).toBe(92.5);
    expect(prescribe(90, 90).baseKg).toBe(82.5);
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
