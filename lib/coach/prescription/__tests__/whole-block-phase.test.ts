import { describe, it, expect } from "vitest";
import {
  computeWholeBlockPhase,
  estimateProgressionRate,
  inferPrimaryLiftFromName,
} from "@/lib/coach/prescription/whole-block-phase";
import { bestComparisonValue } from "@/lib/coach/e1rm";
import type { WorkoutSetSample } from "@/lib/coach/prescription/types";
import type { TrainingBlock } from "@/lib/data/types";

const TODAY = "2026-08-10"; // Monday

function mkBlock(over: Partial<TrainingBlock> = {}): TrainingBlock {
  return {
    id: "b1",
    user_id: "u1",
    status: "active",
    start_date: "2026-08-03",
    end_date: "2026-09-06",
    goal_text: "deadlift 95",
    primary_lift: "deadlift",
    target_metric: "working_weight",
    target_value: 95,
    target_hit_at_week: null,
    target_unit: "kg",
    diet_goal: null,
    endurance_focus: null,
    session_structure_overrides: null,
    created_at: "2026-08-03T00:00:00Z",
    completed_at: null,
    updated_at: "2026-08-03T00:00:00Z",
    ...over,
  };
}

function mkSet(over: Partial<WorkoutSetSample> & { performed_on: string; kg: number }): WorkoutSetSample {
  return {
    exercise_name: "Deadlift (Barbell)",
    exercise_key: null,
    reps: 5,
    warmup: false,
    failure: false,
    rir: 2,
    ...over,
  } as WorkoutSetSample;
}

/** Back day carries the deadlift in SESSION_PLANS (Legs has the RDL). */
const WEEK = { session_plan: { Monday: "Legs", Thursday: "Back" } } as never;

describe("inferPrimaryLiftFromName", () => {
  it("matches on exact name, never substring", () => {
    expect(inferPrimaryLiftFromName("Deadlift (Barbell)")).toBe("deadlift");
    // The RDL CONTAINS "deadlift" but is Legs day's second hinge.
    expect(inferPrimaryLiftFromName("Romanian Deadlift (Barbell)")).toBeNull();
  });
});

describe("estimateProgressionRate", () => {
  const ex = { name: "Deadlift (Barbell)" } as never;

  it("returns 0 with fewer than two matching sets", () => {
    expect(estimateProgressionRate([mkSet({ performed_on: TODAY, kg: 85 })], ex, "working_weight")).toBe(0);
  });

  it("reads samples newest-first: a rising load yields a positive rate", () => {
    const sets = [
      mkSet({ performed_on: "2026-08-07", kg: 90 }),
      mkSet({ performed_on: "2026-07-31", kg: 85 }),
    ];
    expect(estimateProgressionRate(sets, ex, "working_weight")).toBeCloseTo(5, 5);
  });

  it("ignores sets belonging to another exercise", () => {
    const sets = [
      mkSet({ performed_on: "2026-08-07", kg: 90 }),
      mkSet({ performed_on: "2026-07-31", kg: 85, exercise_name: "Romanian Deadlift (Barbell)" }),
    ];
    expect(estimateProgressionRate(sets, ex, "working_weight")).toBe(0);
  });
});

describe("computeWholeBlockPhase — the 28-day window is the phase window", () => {
  /** The concrete divergence this module was extracted to close: 100 kg pulled
   *  in March, working at 85 since a layoff, target 95, unstamped. A 180-day
   *  max reads 100 >= 95 and calls the block pre_target, unfreezing load that
   *  the weekly engine froze. */
  const march = mkSet({ performed_on: "2026-03-02", kg: 100 });
  const recent28d = [
    mkSet({ performed_on: "2026-08-07", kg: 85 }),
    mkSet({ performed_on: "2026-07-31", kg: 85 }),
  ];

  it("reports off_pace from the 28-day stream", () => {
    // current 85, target 95, weeks remaining > 0, observed rate 0 -> off_pace
    // is unreachable via the rate branch (it needs rate > 0), so give it a
    // small positive slope that still cannot close a 10 kg gap.
    const sets = [
      mkSet({ performed_on: "2026-08-07", kg: 85 }),
      mkSet({ performed_on: "2026-07-31", kg: 84 }),
    ];
    const phase = computeWholeBlockPhase({
      block: mkBlock(),
      focusLift: "deadlift",
      week: WEEK,
      recentSets: sets,
      rirTarget: 2,
      todayIso: TODAY,
    });
    expect(phase).toBe("off_pace");
  });

  it("a wide window flips the SAME call from off_pace to pre_target", () => {
    // The divergence, isolated. An e1rm block targeting 110: the March set is
    // 100x5 = 112.5 Brzycki, the current working sets are 85x5 = 95.6 and
    // 84x5 = 94.5. Only the stream differs between the two calls below.
    //
    // (On working_weight blocks currentComparisonValueForLift self-windows via
    // maintenanceLoadFor, which is exactly the reasoning that talked a previous
    // implementer out of this fix. It does not hold on the e1rm branch, which
    // takes a plain bestComparisonValue over whatever it is handed — so the
    // caller, not the callee, owns the window.)
    const block = mkBlock({ target_metric: "e1rm", target_value: 110 });
    const recent = [
      mkSet({ performed_on: "2026-08-07", kg: 85 }),
      mkSet({ performed_on: "2026-07-31", kg: 84 }),
    ];
    expect(bestComparisonValue([march], "e1rm")).toBeCloseTo(112.5, 3);

    const twentyEight = computeWholeBlockPhase({
      block, focusLift: "deadlift", week: WEEK,
      recentSets: recent, rirTarget: 2, todayIso: TODAY,
    });
    const oneEighty = computeWholeBlockPhase({
      block, focusLift: "deadlift", week: WEEK,
      recentSets: [march, ...recent], rirTarget: 2, todayIso: TODAY,
    });

    expect(twentyEight).toBe("off_pace");
    expect(oneEighty).toBe("pre_target");
  });

  it("resolves the focus lift from the WEEK's plan, not from one day", () => {
    // No day in this week's plan carries the deadlift. The rule degrades to the
    // calendar/target signals rather than silently reporting a phase computed
    // off the wrong lift.
    const phase = computeWholeBlockPhase({
      block: mkBlock({ target_hit_at_week: 2 }),
      focusLift: "deadlift",
      week: { session_plan: { Monday: "Legs", Tuesday: "Chest" } } as never,
      recentSets: recent28d,
      rirTarget: 2,
      todayIso: TODAY,
    });
    expect(phase).toBe("consolidation");
  });

  it("deload week wins over everything", () => {
    const phase = computeWholeBlockPhase({
      block: mkBlock(),
      focusLift: "deadlift",
      week: WEEK,
      recentSets: recent28d,
      rirTarget: 2,
      todayIso: "2026-09-01", // week 5 of a 2026-08-03 block
    });
    expect(phase).toBe("deload_week");
  });
});
