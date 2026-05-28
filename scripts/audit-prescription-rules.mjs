// scripts/audit-prescription-rules.mjs
//
// Fixture-based audit for the prescription rule modules. Exercises each
// rule with concrete inputs and asserts expected outputs. Run via:
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs
//
// No DB access — pure functions only.

import { maintenanceLoadFor } from "@/lib/coach/prescription/maintenance-baseline";
import { evaluateBlockPhase, prescribePrimaryFromPhase } from "@/lib/coach/prescription/block-phase-rule";
import { prescribeSecondaryAutoregulated } from "@/lib/coach/prescription/autoregulation-rule";

let pass = 0;
let fail = 0;

function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else      { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("\n## maintenance-baseline.ts\n");

{
  const sets = [
    { exercise_name: "Deadlift (Barbell)", exercise_key: "deadlift", kg: 95,   reps: 7, warmup: false, failure: false, performed_on: "2026-05-21" },
    { exercise_name: "Deadlift (Barbell)", exercise_key: "deadlift", kg: 97.5, reps: 6, warmup: false, failure: false, performed_on: "2026-05-28" },
    { exercise_name: "Deadlift (Barbell)", exercise_key: "deadlift", kg: 100,  reps: 1, warmup: false, failure: false, performed_on: "2026-05-28" }, // dirty — reps < 5 (sub-hypertrophy range), rejected
    { exercise_name: "Deadlift (Barbell)", exercise_key: "deadlift", kg: 50,   reps: 10, warmup: true,  failure: false, performed_on: "2026-05-28" }, // dirty — warmup, rejected
    { exercise_name: "Deadlift (Barbell)", exercise_key: "deadlift", kg: 92.5, reps: 8, warmup: false, failure: true,  performed_on: "2026-05-21" }, // dirty — failure, rejected
    { exercise_name: "Deadlift (Barbell)", exercise_key: "deadlift", kg: 92.5, reps: 6, warmup: false, failure: false, performed_on: "2026-04-20" }, // dirty — outside 28-day window
  ];
  const result = maintenanceLoadFor("deadlift", 2, sets, "2026-05-28");
  assert("max clean kg in window is 97.5 (rejects <5 reps, warmup, failure, out-of-window)", result === 97.5, `got ${result}`);

  const noSets = maintenanceLoadFor("squat", 2, sets, "2026-05-28");
  assert("returns null when no matching exercise found", noSets === null);

  const onlyOutOfWindow = maintenanceLoadFor("deadlift", 2, sets.slice(5), "2026-05-28");
  assert("returns null when only out-of-window sets exist", onlyOutOfWindow === null);

  const allDirty = maintenanceLoadFor("deadlift", 2, sets.slice(2, 5), "2026-05-28");
  assert("returns null when all candidate sets are dirty (low-reps / warmup / failure)", allDirty === null);
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
  assert("consolidation holds sets at baseline (one-variable-at-a-time)", consolidated.sets === 3);

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

console.log("\n## autoregulation-rule.ts\n");

{
  const baseEx = {
    name: "Squat (Barbell)",
    key: "squat",
    baseKg: 62.5,
    baseReps: 6,
    sets: 3,
    increment: { step: 2.5 },
  };

  const focusClean = prescribeSecondaryAutoregulated({
    baseExercise: baseEx,
    currentWorkingKg: 80,
    lastWeekHitRirTargetCleanly: true,
    consecutiveRirMisses: 0,
    maintenanceBaselineKg: 80,
    focusBlockClampMultiplier: 0.92,
    baselineSets: 3,
    baselineReps: 6,
    isFocusBlock: true,
  });
  // autoreg says: clean → 80 + 2.5 = 82.5. Then clamp to 0.92 × 80 = 73.6, rounded to step 2.5 = 72.5 or 75.
  assert("focus block clean: clamped to ≤ 0.92×80 (round to grid)", focusClean.baseKg === 72.5 || focusClean.baseKg === 75, `got ${focusClean.baseKg}`);
  assert("focus block drops one set (3→2)", focusClean.sets === 2);

  const focusMissedTwice = prescribeSecondaryAutoregulated({
    baseExercise: baseEx,
    currentWorkingKg: 80,
    lastWeekHitRirTargetCleanly: false,
    consecutiveRirMisses: 2,
    maintenanceBaselineKg: 80,
    focusBlockClampMultiplier: 0.92,
    baselineSets: 3,
    baselineReps: 6,
    isFocusBlock: true,
  });
  // autoreg says: missed twice → 80 × 0.90 = 72, rounded to step 2.5 = 72.5. Clamp ceiling = 0.92×80 = 73.6 → 72.5/75. 72.5 ≤ ceiling so 72.5 passes through.
  assert("focus block missed twice: drop 10% then clamp (72.5)", focusMissedTwice.baseKg === 72.5, `got ${focusMissedTwice.baseKg}`);

  const nonFocusClean = prescribeSecondaryAutoregulated({
    baseExercise: baseEx,
    currentWorkingKg: 80,
    lastWeekHitRirTargetCleanly: true,
    consecutiveRirMisses: 0,
    maintenanceBaselineKg: null,
    focusBlockClampMultiplier: null,
    baselineSets: 3,
    baselineReps: 6,
    isFocusBlock: false,
  });
  assert("non-focus block clean: +step (80→82.5)", nonFocusClean.baseKg === 82.5);
  assert("non-focus block clean: no set drop", nonFocusClean.sets === 3);

  const nonFocusMissed = prescribeSecondaryAutoregulated({
    baseExercise: baseEx,
    currentWorkingKg: 80,
    lastWeekHitRirTargetCleanly: false,
    consecutiveRirMisses: 1,
    maintenanceBaselineKg: null,
    focusBlockClampMultiplier: null,
    baselineSets: 3,
    baselineReps: 6,
    isFocusBlock: false,
  });
  assert("non-focus missed once: hold (80)", nonFocusMissed.baseKg === 80);
}

import { prescribeAccessoryFromVolumeBand, classifyVolumeBand } from "@/lib/coach/prescription/volume-balance-rule";

console.log("\n## volume-balance-rule.ts\n");

{
  const baseEx = {
    name: "Lat Pulldown (Cable)",
    key: "lat_pulldown",
    baseKg: 45,
    baseReps: 10,
    sets: 4,
    increment: { step: 5 },
  };

  const belowMev = prescribeAccessoryFromVolumeBand({ baseExercise: baseEx, currentSets: 3, bandPosition: "below_mev" });
  assert("below MEV adds a set", belowMev.sets === 4);

  const atMev = prescribeAccessoryFromVolumeBand({ baseExercise: baseEx, currentSets: 3, bandPosition: "at_mev" });
  assert("at MEV adds a set (push toward MAV)", atMev.sets === 4);

  const inBand = prescribeAccessoryFromVolumeBand({ baseExercise: baseEx, currentSets: 3, bandPosition: "in_band" });
  assert("in band holds", inBand.sets === 3);

  const nearMrv = prescribeAccessoryFromVolumeBand({ baseExercise: baseEx, currentSets: 4, bandPosition: "near_mrv" });
  assert("near MRV holds", nearMrv.sets === 4);

  const aboveMrv = prescribeAccessoryFromVolumeBand({ baseExercise: baseEx, currentSets: 4, bandPosition: "above_mrv" });
  assert("above MRV drops a set", aboveMrv.sets === 3);

  assert("classify 7 with mev=8 → below_mev",  classifyVolumeBand({ actualWeeklySets: 7,  mev: 8, mav: 14, mrv: 20 }) === "below_mev");
  assert("classify 8 with mev=8 → at_mev",     classifyVolumeBand({ actualWeeklySets: 8,  mev: 8, mav: 14, mrv: 20 }) === "at_mev");
  assert("classify 12 with mev=8 → in_band",   classifyVolumeBand({ actualWeeklySets: 12, mev: 8, mav: 14, mrv: 20 }) === "in_band");
  assert("classify 18 with mrv=20 → near_mrv", classifyVolumeBand({ actualWeeklySets: 18, mev: 8, mav: 14, mrv: 20 }) === "near_mrv");
  assert("classify 20 with mrv=20 → above_mrv",classifyVolumeBand({ actualWeeklySets: 20, mev: 8, mav: 14, mrv: 20 }) === "above_mrv");
}

import { validatePatternConflicts } from "@/lib/coach/prescription/pattern-conflict-overlay";

console.log("\n## pattern-conflict-overlay.ts\n");

{
  const block = {
    id: "fixture", user_id: "fixture", primary_lift: "deadlift", target_metric: "working_weight",
    target_value: 95, target_unit: "kg", status: "active",
    start_date: "2026-05-04", end_date: "2026-06-07",
    target_hit_at_week: null,
    diet_goal: null, goal_text: "fixture", notes: null, block_id: null,
    created_at: "2026-05-04", updated_at: "2026-05-04",
  };
  const week = {
    user_id: "fixture", week_start: "2026-05-25",
    session_plan: { Monday: "Legs", Tuesday: "Chest", Wednesday: "Mobility", Thursday: "Back", Friday: "Arms", Saturday: "REST", Sunday: "REST" },
    intensity_modifier: {}, rir_target: 2, research_phase: "accumulate",
    block_id: "fixture", exercise_overrides: null, session_prescriptions: null,
    weekly_focus: null, original_session_plan: null,
  };

  const violating = {
    Monday: [{ name: "Romanian Deadlift (Barbell)", key: "rdl", baseKg: 65, baseReps: 6, sets: 3 }],
  };
  const r1 = validatePatternConflicts(violating, block, week);
  assert("RDL on Monday during deadlift block flagged", r1 !== null && r1.code === "pattern_conflict");
  assert("offending list points at Monday RDL", r1 && r1.offending[0].weekday === "Monday" && r1.offending[0].exercise === "Romanian Deadlift (Barbell)");
  assert("hint mentions the focus day (Thursday)", r1 !== null && r1.hint.includes("Thursday"), `got hint: ${r1?.hint}`);

  const okOnFocusDay = {
    Thursday: [{ name: "Romanian Deadlift (Barbell)", key: "rdl", baseKg: 65, baseReps: 6, sets: 3 }],
  };
  assert("RDL on Thursday (focus day) NOT flagged", validatePatternConflicts(okOnFocusDay, block, week) === null);

  const lowAxialOk = {
    Monday: [{ name: "Hip Thrust", key: "hip_thrust", baseKg: 60, baseReps: 10, sets: 3 }],
  };
  assert("Hip Thrust on Monday NOT flagged", validatePatternConflicts(lowAxialOk, block, week) === null);

  const noOpForSquatBlock = validatePatternConflicts(
    violating,
    { ...block, primary_lift: "squat" },
    week,
  );
  assert("non-deadlift block: RDL on non-Back day allowed (squat-focus rule not implemented)", noOpForSquatBlock === null);

  const goodMorningViolation = {
    Tuesday: [{ name: "Good Morning (Barbell)", key: "good_morning", baseKg: 45, baseReps: 8, sets: 3 }],
  };
  assert("Good Morning on Tuesday flagged", validatePatternConflicts(goodMorningViolation, block, week) !== null);

  const stiffLegViolation = {
    Friday: [{ name: "Stiff-Leg Deadlift (Barbell)", key: "stiff_leg_dl", baseKg: 60, baseReps: 8, sets: 3 }],
  };
  assert("Stiff-Leg Deadlift on Friday flagged", validatePatternConflicts(stiffLegViolation, block, week) !== null);
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
