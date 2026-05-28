// scripts/audit-prescription-rules.mjs
//
// Fixture-based audit for the prescription rule modules. Exercises each
// rule with concrete inputs and asserts expected outputs. Run via:
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs
//
// No DB access — pure functions only.

import { maintenanceLoadFor } from "@/lib/coach/prescription/maintenance-baseline";
import { evaluateBlockPhase, prescribePrimaryFromPhase } from "@/lib/coach/prescription/block-phase-rule";

let pass = 0;
let fail = 0;

function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else      { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("\n## maintenance-baseline.ts\n");

{
  const sets = [
    { exercise_name: "Deadlift (Barbell)", exercise_key: "deadlift", kg: 95, reps: 7, rpe: 8, rir: null, performed_on: "2026-05-21" },
    { exercise_name: "Deadlift (Barbell)", exercise_key: "deadlift", kg: 97.5, reps: 6, rpe: 8.5, rir: null, performed_on: "2026-05-28" },
    { exercise_name: "Deadlift (Barbell)", exercise_key: "deadlift", kg: 100, reps: 1, rpe: 10, rir: null, performed_on: "2026-05-28" }, // dirty — RPE 10 with rir target 2 means rpe > 3, rejected
    { exercise_name: "Deadlift (Barbell)", exercise_key: "deadlift", kg: 92.5, reps: 6, rpe: 7, rir: null, performed_on: "2026-04-20" }, // outside 28-day window, rejected
  ];
  const result = maintenanceLoadFor("deadlift", 2, sets, "2026-05-28");
  assert("max clean kg in window is 97.5 (rejects RPE 10 + outside-window)", result === 97.5, `got ${result}`);

  const noSets = maintenanceLoadFor("squat", 2, sets, "2026-05-28");
  assert("returns null when no matching exercise found", noSets === null);

  const onlyOutOfWindow = maintenanceLoadFor("deadlift", 2, sets.slice(3), "2026-05-28");
  assert("returns null when only out-of-window sets exist", onlyOutOfWindow === null);
}

console.log("\n## block-phase-rule.ts\n");

{
  const block = {
    id: "fixture",
    user_id: "fixture",
    block_id: null,
    start_date: "2026-05-04",
    end_date: "2026-06-07",
    primary_lift: "deadlift",
    target_metric: "working_weight",
    target_value: 95,
    target_unit: "kg",
    status: "active",
    diet_goal: null,
    goal_text: "fixture",
    notes: null,
    created_at: "2026-05-04",
    updated_at: "2026-05-04",
    target_hit_at_week: null,
  };

  const preTarget = evaluateBlockPhase({
    block,
    currentWorkingKg: 90,
    recentProgressionRatePerWeek: 1.25,
    todayIso: "2026-05-17", // week 2 — required (95-90)/3 = 1.67, observed × 1.5 = 1.875 → pre_target
  });
  assert("pre_target when remaining weeks can keep up", preTarget === "pre_target", `got ${preTarget}`);

  const offPace = evaluateBlockPhase({
    block,
    currentWorkingKg: 90,
    recentProgressionRatePerWeek: 0.4,
    todayIso: "2026-05-31", // week 4 — required (95-90)/1 = 5.0, observed × 1.5 = 0.6 → off_pace
  });
  assert("off_pace when remaining can't catch up", offPace === "off_pace", `got ${offPace}`);

  const consolidation = evaluateBlockPhase({
    block: { ...block, target_hit_at_week: 3 },
    currentWorkingKg: 97.5,
    recentProgressionRatePerWeek: 1.25,
    todayIso: "2026-05-31",
  });
  assert("consolidation when target_hit_at_week set", consolidation === "consolidation", `got ${consolidation}`);

  const deload = evaluateBlockPhase({
    block,
    currentWorkingKg: 95,
    recentProgressionRatePerWeek: 1.25,
    todayIso: "2026-06-07", // week 5 (last)
  });
  assert("deload_week at week >= total_weeks", deload === "deload_week", `got ${deload}`);
}

{
  const baseEx = {
    name: "Deadlift (Barbell)",
    key: "deadlift",
    baseKg: 82.5,
    baseReps: 6,
    sets: 2,
    increment: { step: 2.5 },
  };

  const consolidated = prescribePrimaryFromPhase({
    baseExercise: baseEx,
    phase: "consolidation",
    currentWorkingKg: 97.5,
    lastWeekHitRirTargetCleanly: true,
    rirTarget: 1,
    baselineSets: 3,
    baselineReps: 6,
  });
  assert("consolidation holds load", consolidated.baseKg === 97.5);
  assert("consolidation progresses reps", consolidated.baseReps === 7);
  assert("consolidation progresses sets", consolidated.sets === 4);

  const progressed = prescribePrimaryFromPhase({
    baseExercise: baseEx,
    phase: "pre_target",
    currentWorkingKg: 90,
    lastWeekHitRirTargetCleanly: true,
    rirTarget: 2,
    baselineSets: 3,
    baselineReps: 6,
  });
  assert("pre_target with clean RIR adds step (90→92.5)", progressed.baseKg === 92.5);

  const heldDueToMiss = prescribePrimaryFromPhase({
    baseExercise: baseEx,
    phase: "pre_target",
    currentWorkingKg: 90,
    lastWeekHitRirTargetCleanly: false,
    rirTarget: 2,
    baselineSets: 3,
    baselineReps: 6,
  });
  assert("pre_target with missed RIR holds (90)", heldDueToMiss.baseKg === 90);

  const deloaded = prescribePrimaryFromPhase({
    baseExercise: baseEx,
    phase: "deload_week",
    currentWorkingKg: 97.5,
    lastWeekHitRirTargetCleanly: true,
    rirTarget: 1,
    baselineSets: 3,
    baselineReps: 6,
  });
  // 97.5 × 0.80 = 78.0; rounded to nearest 2.5 step = 77.5 or 80 (both acceptable)
  assert("deload rounds 80% of 97.5 to step grid", deloaded.baseKg === 77.5 || deloaded.baseKg === 80, `got ${deloaded.baseKg}`);
  assert("deload halves sets (3 → 1)", deloaded.sets === 1);
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
