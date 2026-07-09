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
import { brzycki, bestComparisonValue, metricLabel } from "@/lib/coach/e1rm";
import { annotateSession } from "@/lib/coach/session-structure/annotate";
import { classifyLightenTier, lightenExercise, lastWeekClean, consecutiveMisses } from "@/lib/coach/prescription/prescribe-week";
import { mergePreservedDays } from "@/lib/coach/prescription/upsert-week-prescription";
import { mondayOfIso, diffFutureDays, diffDay, formatRepatchNotes } from "@/lib/coach/prescription/repatch-week";
import { patchExercisesForRung, revertDayExercises, hasMorningPatchEntry, hasMorningRevertEntry } from "@/lib/coach/prescription/patch-today";
import { createAuditReporter } from "./audit-utils.mjs";

const { assert, summary } = createAuditReporter();

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
  assert("deload sets MEV-floor (3 → 2)", deloaded.sets === 2, `got ${deloaded.sets}`);
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
  // 2026-06-06: -1 set rule removed; focus blocks keep full baseline volume on secondaries.
  assert("focus block preserves baseline sets (3)", focusClean.sets === 3);

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

  // Block-phase gating — whole-block discipline propagates to secondaries +
  // accessories so off-focus exercises don't keep autoregulating while the
  // primary lift is held. Use current=70 with baseline=80 so the clamp
  // ceiling (0.92×80=73.6 → rounded to 72.5/75) sits ABOVE current; this
  // isolates the phase-gate effect from the clamp.
  const consolidationHold = prescribeSecondaryAutoregulated({
    baseExercise: baseEx,
    currentWorkingKg: 70,
    lastWeekHitRirTargetCleanly: true, // would normally +step to 72.5
    consecutiveRirMisses: 0,
    maintenanceBaselineKg: 80,
    focusBlockClampMultiplier: 0.92,
    baselineSets: 3,
    baselineReps: 6,
    isFocusBlock: true,
    blockPhase: "consolidation",
  });
  assert("consolidation phase: hold at current (no +step) — 70", consolidationHold.baseKg === 70, `got ${consolidationHold.baseKg}`);

  const offPaceHold = prescribeSecondaryAutoregulated({
    baseExercise: baseEx,
    currentWorkingKg: 70,
    lastWeekHitRirTargetCleanly: true,
    consecutiveRirMisses: 0,
    maintenanceBaselineKg: 80,
    focusBlockClampMultiplier: 0.92,
    baselineSets: 3,
    baselineReps: 6,
    isFocusBlock: true,
    blockPhase: "off_pace",
  });
  assert("off_pace phase: hold at current (mirrors primary) — 70", offPaceHold.baseKg === 70, `got ${offPaceHold.baseKg}`);

  const deloadCut = prescribeSecondaryAutoregulated({
    baseExercise: baseEx,
    currentWorkingKg: 70,
    lastWeekHitRirTargetCleanly: true,
    consecutiveRirMisses: 0,
    maintenanceBaselineKg: 80,
    focusBlockClampMultiplier: 0.92,
    baselineSets: 3,
    baselineReps: 6,
    isFocusBlock: true,
    blockPhase: "deload_week",
  });
  // 70 × 0.80 = 56; round to step 2.5 → 55.
  assert("deload_week: 0.80× rounded to grid (55)", deloadCut.baseKg === 55, `got ${deloadCut.baseKg}`);
  assert("deload_week: sets MEV-floor (3 → 2)", deloadCut.sets === 2, `got ${deloadCut.sets}`);

  // Clamp still wins when current sits at or above the clamped ceiling —
  // ensures the phase gate doesn't accidentally re-permit over-the-ceiling holds.
  const consolidationStillClamped = prescribeSecondaryAutoregulated({
    baseExercise: baseEx,
    currentWorkingKg: 80, // at baseline; clamp ceiling = 72.5 (rounded from 73.6)
    lastWeekHitRirTargetCleanly: true,
    consecutiveRirMisses: 0,
    maintenanceBaselineKg: 80,
    focusBlockClampMultiplier: 0.92,
    baselineSets: 3,
    baselineReps: 6,
    isFocusBlock: true,
    blockPhase: "consolidation",
  });
  assert("consolidation phase: clamp still binds when hold > ceiling", consolidationStillClamped.baseKg === 72.5, `got ${consolidationStillClamped.baseKg}`);

  const preTargetUnchanged = prescribeSecondaryAutoregulated({
    baseExercise: baseEx,
    currentWorkingKg: 80,
    lastWeekHitRirTargetCleanly: true,
    consecutiveRirMisses: 0,
    maintenanceBaselineKg: null,
    focusBlockClampMultiplier: null,
    baselineSets: 3,
    baselineReps: 6,
    isFocusBlock: false,
    blockPhase: "pre_target",
  });
  assert("pre_target phase: existing autoreg behavior preserved (+step)", preTargetUnchanged.baseKg === 82.5);
}

// ── warmup augmentation post-processing ────────────────────────────────────
console.log("\n## warmup augmentation\n");
{
  // Import the augmentation by invoking prescribeWeek on a small fixture —
  // it isn't exported separately. We synthesize the input/output shapes
  // around what augmentFirstLoadedCompoundWithWarmups would produce for a
  // working entry of Deadlift 100kg × 6 × 3.
  //
  // Since the augmentation is a pure function inside prescribe-week.ts, we
  // re-import it indirectly by calling the orchestrator's helper through a
  // light wrapper. For now, exercise the rule by checking the prescribed
  // shape after augmentation: 2 warmup entries with the correct ramp loads
  // (60% and 80% of working, floored to step), preceding the working entry.

  // Direct check: for a 100kg working compound at step=2.5:
  //   warmup 1 = floor(100*0.6/2.5)*2.5 = floor(24)*2.5 = 60
  //   warmup 2 = floor(100*0.8/2.5)*2.5 = floor(32)*2.5 = 80
  // We assert the math here; the orchestrator-level wiring is exercised by
  // the e2e audit script.
  const workingKg = 100;
  const step = 2.5;
  const w1 = Math.floor(workingKg * 0.6 / step) * step;
  const w2 = Math.floor(workingKg * 0.8 / step) * step;
  assert("warmup 1 = 60% rounded down to step (60kg at 100kg working)", w1 === 60, `got ${w1}`);
  assert("warmup 2 = 80% rounded down to step (80kg at 100kg working)", w2 === 80, `got ${w2}`);

  // Deadlift library now requires 3 working sets — locks in the bump from
  // sets: 2 → sets: 3 to keep the focus lift at the user's working-set count.
  const { SESSION_PLANS } = await import("@/lib/coach/sessionPlans");
  const dl = SESSION_PLANS.Back.find((e) => e.name === "Deadlift (Barbell)");
  assert("library Deadlift has 3 working sets (was 2)", dl?.sets === 3, `got ${dl?.sets}`);

  // Squat is already at sets: 3 — sanity-check it hasn't regressed.
  const sq = SESSION_PLANS.Legs.find((e) => e.name === "Squat (Barbell)");
  assert("library Squat has 3 working sets (unchanged)", sq?.sets === 3, `got ${sq?.sets}`);
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

import { validateWeekPrescription } from "@/lib/coach/prescription/validate-week";

console.log("\n## validate-week.ts\n");

{
  const block = {
    id: "fixture", user_id: "fixture", primary_lift: "deadlift", target_metric: "working_weight",
    target_value: 95, target_unit: "kg", status: "active",
    start_date: "2026-05-04", end_date: "2026-06-07",
    target_hit_at_week: 3,
    diet_goal: null, goal_text: "fixture", notes: null, block_id: null,
    created_at: "2026-05-04", updated_at: "2026-05-04",
  };
  const week = {
    user_id: "fixture", week_start: "2026-06-01",
    session_plan: { Monday: "Legs", Tuesday: "Chest", Wednesday: "Mobility", Thursday: "Back", Friday: "Arms", Saturday: "REST", Sunday: "REST" },
    intensity_modifier: {}, rir_target: 1, research_phase: "accumulate",
    block_id: "fixture", exercise_overrides: null, session_prescriptions: null,
    weekly_focus: null, original_session_plan: null,
  };
  const prevWeek = {
    ...week, week_start: "2026-05-25",
    session_prescriptions: {
      Thursday: [{ name: "Deadlift (Barbell)", key: "deadlift", baseKg: 97.5, baseReps: 7, sets: 3, increment: { step: 2.5 } }],
    },
  };

  const consolidationViolation = validateWeekPrescription({
    prescription: { Thursday: [{ name: "Deadlift (Barbell)", key: "deadlift", baseKg: 100, baseReps: 7, sets: 3, increment: { step: 2.5 } }] },
    block, week, prevWeek,
    maintenanceBaselines: { squat: 80, bench: 72.5, ohp: 40 },
  });
  assert("consolidation: deadlift 97.5 → 100 rejected", consolidationViolation !== null && consolidationViolation.code === "consolidation_load_increase");

  const okSameLoad = validateWeekPrescription({
    prescription: { Thursday: [{ name: "Deadlift (Barbell)", key: "deadlift", baseKg: 97.5, baseReps: 8, sets: 4, increment: { step: 2.5 } }] },
    block, week, prevWeek,
    maintenanceBaselines: { squat: 80, bench: 72.5, ohp: 40 },
  });
  assert("consolidation: same load + more reps/sets OK", okSameLoad === null);

  const overcooked = validateWeekPrescription({
    prescription: { Monday: [{ name: "Squat (Barbell)", key: "squat", baseKg: 80, baseReps: 6, sets: 2, increment: { step: 2.5 } }] },
    block, week, prevWeek,
    maintenanceBaselines: { squat: 80, bench: 72.5, ohp: 40 },
  });
  assert("secondary at baseline (80 kg) > clamp (0.92×80=73.6) rejected", overcooked !== null && overcooked.code === "non_focus_primary_overcooked");

  const okSecondaryAtClamp = validateWeekPrescription({
    prescription: { Monday: [{ name: "Squat (Barbell)", key: "squat", baseKg: 72.5, baseReps: 6, sets: 2, increment: { step: 2.5 } }] },
    block, week, prevWeek,
    maintenanceBaselines: { squat: 80, bench: 72.5, ohp: 40 },
  });
  assert("secondary at 72.5 (≤ clamp 73.6) and 2 sets (< baseline 3) OK", okSecondaryAtClamp === null);

  // 2026-06-06: non_focus_primary_volume_too_high removed; full-volume secondaries are now allowed.
  const fullVolumeOk = validateWeekPrescription({
    prescription: { Monday: [{ name: "Squat (Barbell)", key: "squat", baseKg: 72.5, baseReps: 6, sets: 3, increment: { step: 2.5 } }] },
    block, week, prevWeek,
    maintenanceBaselines: { squat: 80, bench: 72.5, ohp: 40 },
  });
  assert("secondary at 3 sets (full baseline) is OK post-2026-06-06", fullVolumeOk === null);
}

console.log("\n## e1rm.ts\n");

{
  // Brzycki: 1RM = kg × 36 / (37 − reps)
  const a = brzycki(100, 5);
  assert("brzycki(100,5) = 112.5", Math.abs(a - 112.5) < 0.001, `got ${a}`);
  const b = brzycki(100, 1);
  assert("brzycki(100,1) = 100 (1RM = the kg lifted)", Math.abs(b - 100) < 0.001, `got ${b}`);
  assert("brzycki rejects reps=0", brzycki(100, 0) === null);
  assert("brzycki rejects reps=13", brzycki(100, 13) === null);
  assert("brzycki rejects kg=0", brzycki(0, 5) === null);

  // bestComparisonValue: working_weight vs e1rm comparison
  // Brzycki e1RM = kg × 36 / (37 − reps):
  //   95 × 8  → 95 × 36 / 29 = 117.93  ← e1RM winner (sub-maximal but high vol)
  //  100 × 5  → 100 × 36 / 32 = 112.5
  //  105 × 1  → 105 × 36 / 36 = 105.0  ← working-weight winner (raw kg max)
  const sets = [
    { kg: 95,  reps: 8,  warmup: false },
    { kg: 100, reps: 5,  warmup: false },
    { kg: 105, reps: 1,  warmup: false },
    { kg: 80,  reps: 10, warmup: true },   // warmup — skipped
    { kg: 70,  reps: 20, warmup: false },  // reps > 12 — rejected for e1rm
  ];
  assert("bestComparisonValue working_weight = 105", bestComparisonValue(sets, "working_weight") === 105);
  const e1 = bestComparisonValue(sets, "e1rm");
  const expectedE1 = (95 * 36) / 29; // ≈ 117.93
  assert(`bestComparisonValue e1rm picks Brzycki-best ${expectedE1.toFixed(2)}`, Math.abs(e1 - expectedE1) < 0.001, `got ${e1}`);

  // empty / all-warmup
  assert("bestComparisonValue null on empty input", bestComparisonValue([], "e1rm") === null);
  assert("bestComparisonValue null when only warmups", bestComparisonValue([{ kg: 50, reps: 10, warmup: true }], "working_weight") === null);

  // metricLabel
  assert("metricLabel('e1rm')", metricLabel("e1rm") === "kg (e1RM)");
  assert("metricLabel('working_weight')", metricLabel("working_weight") === "kg (working set)");
  assert("metricLabel(null)", metricLabel(null) === "kg");
}

console.log("\n## block-phase-rule.ts — e1RM target semantics\n");

{
  // e1rm block: target_value is an e1RM. Caller passes currentValue as e1RM.
  const blockE1rm = {
    id: "fixture",
    user_id: "fixture",
    block_id: null,
    start_date: "2026-05-04",
    end_date: "2026-06-07",
    primary_lift: "deadlift",
    target_metric: "e1rm",
    target_value: 115, // e1RM in kg
    target_unit: "kg",
    status: "active",
    diet_goal: null,
    goal_text: "fixture",
    notes: null,
    created_at: "2026-05-04",
    updated_at: "2026-05-04",
    target_hit_at_week: null,
  };

  // Athlete pulling 97.5 × 8 (Brzycki = 121) ALREADY at e1RM target. The pre-
  // 0041 evaluator would have compared 97.5 < 115 and said pre_target/off_pace.
  // With currentValue = 121 (e1RM), the evaluator should recognize "already met".
  const alreadyMet = evaluateBlockPhase({
    block: blockE1rm,
    currentWorkingKg: 121, // e1RM-space value passed by caller
    recentProgressionRatePerWeek: 1.0,
    todayIso: "2026-05-17", // week 2
  });
  assert("e1rm block: currentValue ≥ target → pre_target (defensive: not off_pace)", alreadyMet === "pre_target", `got ${alreadyMet}`);
}

console.log("\n## calibrate-target.ts (pure helpers)\n");
{
  const {
    coefficientFor,
    computeOlsSlope,
    computeSanityBounds,
    gridRoundDown,
    gridRoundUp,
    COEFFICIENT_TABLE,
  } = await import("@/lib/coach/prescription/calibrate-target");

  // coefficient table
  assert("coefficient deadlift cut = 1.5", coefficientFor("deadlift", "cut") === 1.5);
  assert("coefficient bench cut = 0.75", coefficientFor("bench", "cut") === 0.75);
  assert("coefficient ohp cut = 0.4", coefficientFor("ohp", "cut") === 0.4);
  assert("coefficient default phase = cut", coefficientFor("squat") === coefficientFor("squat", "cut"));
  assert("coefficient table covers all 4 lifts", Object.keys(COEFFICIENT_TABLE).sort().join(",") === "bench,deadlift,ohp,squat");

  // grid rounding
  assert("gridRoundDown 81.7 = 80", gridRoundDown(81.7) === 80);
  assert("gridRoundDown 82.5 = 82.5", gridRoundDown(82.5) === 82.5);
  assert("gridRoundUp 81.7 = 82.5", gridRoundUp(81.7) === 82.5);
  assert("gridRoundUp 82.5 = 82.5", gridRoundUp(82.5) === 82.5);

  // OLS slope
  assert("OLS null on <3 samples", computeOlsSlope([{ weekIndex: 0, e1rm: 80 }, { weekIndex: 1, e1rm: 81 }]) === null);
  const slope1 = computeOlsSlope([
    { weekIndex: 0, e1rm: 80 },
    { weekIndex: 1, e1rm: 81 },
    { weekIndex: 2, e1rm: 82 },
  ]);
  assert("OLS slope of perfectly-linear +1/wk = 1.0", Math.abs(slope1 - 1.0) < 1e-9, `got ${slope1}`);
  const slope2 = computeOlsSlope([
    { weekIndex: 0, e1rm: 80 },
    { weekIndex: 1, e1rm: 80 },
    { weekIndex: 2, e1rm: 80 },
  ]);
  assert("OLS slope of flat samples = 0", slope2 === 0);
  const slope3 = computeOlsSlope([
    { weekIndex: 0, e1rm: 85 },
    { weekIndex: 1, e1rm: 84 },
    { weekIndex: 2, e1rm: 83 },
  ]);
  assert("OLS slope of declining samples = -1.0", Math.abs(slope3 + 1.0) < 1e-9, `got ${slope3}`);
  // OLS handles gaps (week 0, 2, 5) — uses x-values as supplied
  const slope4 = computeOlsSlope([
    { weekIndex: 0, e1rm: 80 },
    { weekIndex: 2, e1rm: 82 },
    { weekIndex: 5, e1rm: 85 },
  ]);
  assert("OLS slope on sparse weeks ≈ 1.0", Math.abs(slope4 - 1.0) < 0.001, `got ${slope4}`);

  // sanity bounds
  // current = 80.7, coef = 0.75 (bench cut)
  //   lower = ceil(81.7 / 2.5) × 2.5 = 82.5
  //   upper = floor(80.7 + 0.75 × 4 × 1.5 / 2.5) × 2.5 = floor((80.7 + 4.5) / 2.5) × 2.5 = floor(85.2/2.5)×2.5 = 85
  const bounds1 = computeSanityBounds({ currentE1rm: 80.7, coefficient: 0.75 });
  assert("bounds for bench cut current=80.7 are [82.5, 85]",
    bounds1[0] === 82.5 && bounds1[1] === 85,
    `got [${bounds1[0]}, ${bounds1[1]}]`);
  // current = 117.9 (your post-stamp deadlift e1RM), coef = 1.5 (deadlift cut)
  //   lower = ceil(118.9 / 2.5) × 2.5 = 120
  //   upper = floor((117.9 + 9) / 2.5) × 2.5 = floor(126.9/2.5)×2.5 = 125
  const bounds2 = computeSanityBounds({ currentE1rm: 117.9, coefficient: 1.5 });
  assert("bounds for deadlift cut current=117.9 are [120, 125]",
    bounds2[0] === 120 && bounds2[1] === 125,
    `got [${bounds2[0]}, ${bounds2[1]}]`);
}

console.log("\n## annotate.ts — per-exercise rir override\n");

{
  const [a] = annotateSession([
    { name: "Squat (Barbell)", baseKg: 100, baseReps: 5, sets: 3, key: "squat", rir: 3 },
  ]).exercises;
  assert(
    "rir override should surface in rpe_target",
    a.rpe_target.includes("3 RIR"),
    `got "${a.rpe_target}"`,
  );
}
{
  const [b] = annotateSession([
    { name: "Leg Press", baseKg: 100, baseReps: 12, sets: 3, key: "leg_press" },
  ]).exercises;
  assert(
    "no rir → unchanged tier-derived rpe_target",
    !b.rpe_target.includes("RIR ("),
    `got "${b.rpe_target}"`,
  );
}

console.log("\n## lightenExercise / classifyLightenTier — tiered RIR-aware lighten\n");

const LEGS = ["legs"];
{
  // Primary compound: hold load, drop 1 set (floor 2), baseReps -1, +1 RIR.
  const sq = { name: "Squat (Barbell)", baseKg: 100, baseReps: 6, sets: 3, key: "squat" };
  assert("squat is primary_compound", classifyLightenTier(sq, LEGS) === "primary_compound", `got ${classifyLightenTier(sq, LEGS)}`);
  const out = lightenExercise(sq, "Legs", LEGS);
  assert("primary holds load", out.baseKg === 100, `got ${out.baseKg}`);
  assert("primary drops 1 set to 2", out.sets === 2, `primary drops 1 set to 2, got ${out.sets}`);
  assert("primary reps 6→5", out.baseReps === 5, `primary reps 6→5, got ${out.baseReps}`);
  assert("primary rir default(2)+1=3", out.rir === 3, `primary rir default(2)+1=3, got ${out.rir}`);
}
{
  // Eccentric accessory in affected region: hold load, drop 2 sets (floor 1), +2 RIR.
  const lp = { name: "Leg Press", baseKg: 85, baseReps: 12, sets: 3, key: "leg_press" };
  assert("leg press is eccentric_accessory", classifyLightenTier(lp, LEGS) === "eccentric_accessory", `got ${classifyLightenTier(lp, LEGS)}`);
  const out = lightenExercise(lp, "Legs", LEGS);
  assert("accessory holds load", out.baseKg === 85, `got ${out.baseKg}`);
  assert("accessory drops 2 sets to floor 1", out.sets === 1, `accessory drops 2 sets to floor 1, got ${out.sets}`);
  assert("accessory baseReps 12−2=10", out.baseReps === 10, `accessory baseReps 12−2=10, got ${out.baseReps}`);
  assert("accessory rir default(2)+2=4", out.rir === 4, `accessory rir default(2)+2=4, got ${out.rir}`);
}
{
  // Non-affected region exercise is untouched (region gating preserved).
  const bench = { name: "Decline Bench Press (Barbell)", baseKg: 60, baseReps: 8, sets: 3, key: "decline_bench" };
  const out = lightenExercise(bench, "Chest", LEGS);
  assert("off-region exercise unchanged", out.sets === 3 && out.baseReps === 8 && out.rir === undefined, `sets=${out.sets} reps=${out.baseReps} rir=${out.rir}`);
}
{
  // Warmup never lightened.
  const wu = { name: "Squat (Barbell)", warmup: true, baseKg: 60, baseReps: 5, sets: 1 };
  const out = lightenExercise(wu, "Legs", LEGS);
  assert("warmup returned unchanged", out === wu, `got different object`);
}

console.log("\n## prescribe-week.ts — RIR-aware clean predicates\n");

{
  const ex = { name: "Squat (Barbell)", baseReps: 6, sets: 3, rir: 2 };
  const base = { exercise_name: "Squat (Barbell)", exercise_key: null, kg: 100, reps: 6, warmup: false, failure: false, performed_on: "2026-07-06" };

  assert("clean when recorded RIR meets prescription", lastWeekClean([{ ...base, rir: 2 }], ex, 2) === true);
  assert("dirty when recorded RIR below prescription (grind)", lastWeekClean([{ ...base, rir: 0 }], ex, 2) === false);
  assert("legacy: missing RIR keeps old verdict (clean)", lastWeekClean([base], ex, 2) === true);
  assert("legacy: missing RIR keeps old verdict (reps short = dirty)", lastWeekClean([{ ...base, reps: 4 }], ex, 2) === false);
  assert("per-exercise ex.rir overrides week rirTarget", lastWeekClean([{ ...base, rir: 2 }], { ...ex, rir: 3 }, 2) === false);
  assert("week rirTarget used when ex.rir absent", lastWeekClean([{ ...base, rir: 1 }], { name: ex.name, baseReps: 6, sets: 3 }, 2) === false);
  assert("failure dirty regardless of RIR", lastWeekClean([{ ...base, rir: 3, failure: true }], ex, 2) === false);
  assert("over-target RIR is still just clean (no double-step signal)", lastWeekClean([{ ...base, rir: 4 }], ex, 2) === true);

  assert(
    "consecutiveMisses counts RIR grinds",
    consecutiveMisses(
      [{ ...base, rir: 0 }, { ...base, rir: 1, performed_on: "2026-06-29" }],
      ex,
      2,
    ) === 2,
  );
  assert(
    "consecutiveMisses stops at first RIR-clean set",
    consecutiveMisses(
      [{ ...base, rir: 0 }, { ...base, rir: 2, performed_on: "2026-06-29" }],
      ex,
      2,
    ) === 1,
  );
  assert(
    "consecutiveMisses legacy path unchanged when RIR absent",
    consecutiveMisses([{ ...base, reps: 4 }, base], ex, 2) === 1,
  );
}

console.log("\n## upsert-week-prescription.ts — mergePreservedDays\n");

{
  const stored = {
    Monday: [{ name: "Squat (Barbell)", baseKg: 130, baseReps: 6, sets: 3 }],
    Thursday: [{ name: "Deadlift (Barbell)", baseKg: 132.5, baseReps: 6, sets: 3 }],
  };
  const computed = {
    Monday: [{ name: "Squat (Barbell)", baseKg: 135, baseReps: 6, sets: 3 }],
    Tuesday: [{ name: "Decline Bench Press (Barbell)", baseKg: 80, baseReps: 8, sets: 3 }],
    Thursday: [{ name: "Deadlift (Barbell)", baseKg: 130, baseReps: 6, sets: 3 }],
  };
  // week 2026-07-06 (Mon) … today is Tuesday 2026-07-07
  const merged = mergePreservedDays({ computed, stored, weekStart: "2026-07-06", preserveDaysThrough: "2026-07-07" });

  assert("past day keeps stored load verbatim", merged.Monday[0].baseKg === 130);
  assert("today keeps stored state — absence preserved (Tuesday deleted)", !("Tuesday" in merged));
  assert("future day takes computed load", merged.Thursday[0].baseKg === 130);
  assert("boundary before week start returns computed untouched",
    mergePreservedDays({ computed, stored, weekStart: "2026-07-06", preserveDaysThrough: "2026-07-05" }).Monday[0].baseKg === 135);
  assert("full-week boundary preserves everything stored",
    mergePreservedDays({ computed, stored, weekStart: "2026-07-06", preserveDaysThrough: "2026-07-12" }).Thursday[0].baseKg === 132.5);
  assert("null stored + preserve → computed days ≤ boundary removed",
    !("Monday" in mergePreservedDays({ computed, stored: null, weekStart: "2026-07-06", preserveDaysThrough: "2026-07-07" })));
}

console.log("\n## mergePreservedDays — yesterday boundary (morning-patch protection)\n");

{
  const stored = {
    Monday: [{ name: "Squat (Barbell)", baseKg: 130, baseReps: 6, sets: 3 }],
    Tuesday: [{ name: "Decline Bench Press (Barbell)", baseKg: 80, baseReps: 8, sets: 2 }],
  };
  const computed = {
    Monday: [{ name: "Squat (Barbell)", baseKg: 135, baseReps: 6, sets: 3 }],
    Tuesday: [{ name: "Decline Bench Press (Barbell)", baseKg: 80, baseReps: 8, sets: 3 }],
  };
  // today = Tuesday 2026-07-07; boundary = yesterday (Monday 2026-07-06)
  const merged = mergePreservedDays({ computed, stored, weekStart: "2026-07-06", preserveDaysThrough: "2026-07-06" });
  assert("yesterday boundary: past day (Monday) preserved", merged.Monday[0].baseKg === 130);
  assert("yesterday boundary: today (Tuesday) takes computed", merged.Tuesday[0].sets === 3);
}

console.log("\n## repatch-week.ts — pure helpers\n");

{
  assert("mondayOfIso: Thursday → Monday", mondayOfIso("2026-07-09") === "2026-07-06");
  assert("mondayOfIso: Monday is identity", mondayOfIso("2026-07-06") === "2026-07-06");
  assert("mondayOfIso: Sunday belongs to preceding Monday", mondayOfIso("2026-07-12") === "2026-07-06");

  const stored = {
    Monday: [{ name: "Squat (Barbell)", baseKg: 130, baseReps: 6, sets: 3, rir: 2 }],
    Thursday: [
      { name: "Deadlift (Barbell)", baseKg: 60, baseReps: 8, sets: 2, warmup: true },
      { name: "Deadlift (Barbell)", baseKg: 132.5, baseReps: 6, sets: 3, rir: 2 },
      { name: "Lat Pulldown (Cable)", baseKg: 70, baseReps: 10, sets: 3, rir: 2 },
    ],
  };
  const next = {
    Monday: [{ name: "Squat (Barbell)", baseKg: 999, baseReps: 6, sets: 3, rir: 2 }], // past-day change must be IGNORED
    Thursday: [
      { name: "Deadlift (Barbell)", baseKg: 60, baseReps: 8, sets: 2, warmup: true },
      { name: "Deadlift (Barbell)", baseKg: 130, baseReps: 6, sets: 3, rir: 2 },
      { name: "Seated Row (Cable)", baseKg: 60, baseReps: 10, sets: 3, rir: 2 },
    ],
  };
  const changes = diffFutureDays({ stored, next, weekStart: "2026-07-06", todayIso: "2026-07-07" });

  assert("past days never diffed", changes.every((c) => c.weekday !== "Monday"));
  const kgChange = changes.find((c) => c.field === "baseKg");
  assert("load change detected on future day", kgChange && kgChange.exercise === "Deadlift (Barbell)" && kgChange.from === 132.5 && kgChange.to === 130);
  assert("warmup rows excluded from diff", changes.filter((c) => c.exercise === "Deadlift (Barbell)").length === 1);
  assert("removed exercise detected", changes.some((c) => c.field === "removed" && c.exercise === "Lat Pulldown (Cable)"));
  assert("added exercise detected", changes.some((c) => c.field === "added" && c.exercise === "Seated Row (Cable)"));
  assert("identical inputs → empty diff (idempotence)", diffFutureDays({ stored: next, next, weekStart: "2026-07-06", todayIso: "2026-07-07" }).length === 0);

  const notes = formatRepatchNotes({
    at: "2026-07-07T10:00:00Z",
    reason: "workout_commit",
    workout_date: "2026-07-07",
    changes,
  });
  assert("one note per changed weekday", notes.length === 1 && notes[0].startsWith("Plan updated for Thursday:"));
  assert("note formats load with fmtNum (no trailing zeros)", notes[0].includes("Deadlift (Barbell) 132.5 → 130 kg"));
}

console.log("\n## repatch-week.ts — diffDay (single-day diff)\n");

{
  const stored = [
    { name: "Squat (Barbell)", baseKg: 60, baseReps: 8, sets: 2, warmup: true },
    { name: "Squat (Barbell)", baseKg: 130, baseReps: 6, sets: 3, rir: 2 },
  ];
  const next = [
    { name: "Squat (Barbell)", baseKg: 60, baseReps: 8, sets: 2, warmup: true },
    { name: "Squat (Barbell)", baseKg: 130, baseReps: 6, sets: 2, rir: 3 },
  ];
  const changes = diffDay(stored, next, "Monday");
  assert("diffDay: two field changes detected", changes.length === 2);
  assert("diffDay: sets change recorded", changes.some((c) => c.field === "sets" && c.from === 3 && c.to === 2));
  assert("diffDay: rir change recorded", changes.some((c) => c.field === "rir" && c.from === 2 && c.to === 3));
  assert("diffDay: weekday stamped", changes.every((c) => c.weekday === "Monday"));
  assert("diffDay: identical inputs → empty", diffDay(next, next, "Monday").length === 0);
}

console.log("\n## patch-today.ts — rung transforms + revert\n");

{
  const legs = [
    { name: "Squat (Barbell)", baseKg: 60, baseReps: 8, sets: 2, warmup: true },
    { name: "Squat (Barbell)", baseKg: 130, baseReps: 6, sets: 3, rir: 2 },
    { name: "Leg Extension (Machine)", baseKg: 50, baseReps: 12, sets: 3, rir: 2 },
  ];

  // load_down: RIR +1 on affected, weight/sets/reps held, warmup untouched
  const eased = patchExercisesForRung(legs, "load_down", "Legs", ["legs"]);
  assert("load_down: working squat rir 2→3", eased[1].rir === 3);
  assert("load_down: kg held", eased[1].baseKg === 130 && eased[2].baseKg === 50);
  assert("load_down: sets/reps held", eased[1].sets === 3 && eased[2].baseReps === 12);
  assert("load_down: warmup untouched", eased[0].rir === undefined && eased[0].sets === 2);
  assert("load_down: rir caps at 5", patchExercisesForRung(
    [{ name: "Squat (Barbell)", baseKg: 100, baseReps: 6, sets: 3, rir: 5 }],
    "load_down", "Legs", ["legs"])[0].rir === 5);

  // region gating: chest exercise on Legs day with sore legs → untouched
  const mixed = patchExercisesForRung(
    [{ name: "Chest Fly (Machine)", baseKg: 90, baseReps: 12, sets: 3, rir: 2 }],
    "load_down", "Legs", ["legs"]);
  assert("load_down: non-affected region untouched", mixed[0].rir === 2);

  // volume_down delegates to lightenExercise tiering (primary compound: sets−1 floor 2, reps−1, rir+1)
  const trimmed = patchExercisesForRung(legs, "volume_down", "Legs", ["legs"]);
  assert("volume_down: compound sets 3→2", trimmed[1].sets === 2);
  assert("volume_down: compound rir 2→3", trimmed[1].rir === 3);
  assert("volume_down: kg held", trimmed[1].baseKg === 130);
  // high-rep accessory (baseReps ≥ 10): eccentric tier → sets−2 floor 1, rir+2
  assert("volume_down: accessory sets 3→1", trimmed[2].sets === 1);
  assert("volume_down: accessory rir 2→4", trimmed[2].rir === 4);

  // escalation + none rungs are identity
  assert("swap_day: identity", patchExercisesForRung(legs, "swap_day", "Legs", ["legs"]) === legs);
  assert("swap_exercise: identity", patchExercisesForRung(legs, "swap_exercise", "Legs", ["legs"]) === legs);
  assert("none: identity", patchExercisesForRung(legs, "none", "Legs", ["legs"]) === legs);

  // apply → revert identity via diffDay changes
  const changes = diffDay(legs, trimmed, "Monday");
  const restored = revertDayExercises(trimmed, changes);
  assert("revert: squat sets restored", restored[1].sets === 3);
  assert("revert: squat rir restored", restored[1].rir === 2);
  assert("revert: accessory restored", restored[2].sets === 3 && restored[2].rir === 2);
  assert("revert: full identity vs diff", diffDay(legs, restored, "Monday").length === 0);

  // repatch_log entry guards
  const log = [
    { at: "2026-07-07T05:00:00Z", reason: "workout_commit", workout_date: "2026-07-06", changes: [] },
    { at: "2026-07-07T06:00:00Z", reason: "morning_checkin", workout_date: "2026-07-07", changes },
  ];
  assert("hasMorningPatchEntry: true for today", hasMorningPatchEntry(log, "2026-07-07") === true);
  assert("hasMorningPatchEntry: false other day", hasMorningPatchEntry(log, "2026-07-08") === false);
  assert("hasMorningPatchEntry: null log", hasMorningPatchEntry(null, "2026-07-07") === false);
  assert("hasMorningRevertEntry: false before revert", hasMorningRevertEntry(log, "2026-07-07") === false);
  assert("hasMorningRevertEntry: true after revert", hasMorningRevertEntry(
    [...log, { at: "2026-07-07T07:00:00Z", reason: "morning_checkin_revert", workout_date: "2026-07-07", changes: [] }],
    "2026-07-07") === true);
}

import { prescribeAccessoryDoubleProgression, REP_RANGE_WIDTH, nextUpKg, nextDownKg } from "@/lib/coach/prescription/double-progression-rule";

console.log("\n## double-progression-rule.ts — accessory double progression\n");

{
  // Lateral Raise (DB, coarse): step 2, bottom 10, width 4 → range 10..14.
  const ex = { name: "Lateral Raise (Dumbbell)", baseReps: 10, sets: 3, rir: 2, increment: { step: 2 } };
  const S = (kg, reps, rir, date, extra = {}) => ({
    exercise_name: "Lateral Raise (Dumbbell)", exercise_key: null,
    kg, reps, warmup: false, failure: false, rir, performed_on: date, ...extra,
  });
  const input = (over = {}) => ({
    baseExercise: ex, currentWorkingKg: 12, recentSets: [], rirTarget: 2,
    blockPhase: "pre_target", loadability: "coarse", focusClampCeilingKg: null,
    bottomReps: 10, ...over,
  });

  assert("width table", REP_RANGE_WIDTH.fine === 2 && REP_RANGE_WIDTH.moderate === 3 && REP_RANGE_WIDTH.coarse === 4);

  // 1) STEP UP: two sets at L, both clean at top (14 reps, rir ≥ 2) → 14 kg, reps reset to 10.
  const up = prescribeAccessoryDoubleProgression(input({
    recentSets: [S(12, 14, 2, "2026-07-07"), S(12, 14, 3, "2026-07-07")],
  }));
  assert("step up: load +step on grid", up.baseKg === 14);
  assert("step up: reps reset to bottom", up.baseReps === 10);

  // 2) Clamp parks at top instead of exceeding ceiling.
  const parked = prescribeAccessoryDoubleProgression(input({
    recentSets: [S(12, 14, 2, "2026-07-07"), S(12, 14, 2, "2026-07-07")],
    focusClampCeilingKg: 12,
  }));
  assert("clamp: load parked at L", parked.baseKg === 12);
  assert("clamp: reps parked at top", parked.baseReps === 14);

  // 3) Single set at L is NOT enough for a step up → rep-up path instead.
  const single = prescribeAccessoryDoubleProgression(input({
    recentSets: [S(12, 14, 2, "2026-07-07")],
  }));
  assert("single set: no load jump", single.baseKg === 12);
  assert("single set: rep-up capped at top", single.baseReps === 14);

  // 4) REP UP: top set clean at 11 reps → prescribe 12.
  const repUp = prescribeAccessoryDoubleProgression(input({
    recentSets: [S(12, 11, 2, "2026-07-07"), S(12, 10, 1, "2026-07-07")],
  }));
  assert("rep up: load held", repUp.baseKg === 12);
  assert("rep up: reps +1 from achieved top set", repUp.baseReps === 12);

  // 5) Null RIR history → reps-only criterion still progresses.
  const legacy = prescribeAccessoryDoubleProgression(input({
    recentSets: [S(12, 11, null, "2026-07-07")],
  }));
  assert("null rir: rep up works", legacy.baseReps === 12 && legacy.baseKg === 12);

  // 6) Grinding below prescribed RIR is dirty: reps hit but rir 0 < 2 → not a rep-up.
  const grind = prescribeAccessoryDoubleProgression(input({
    recentSets: [S(12, 11, 0, "2026-07-07")],
  }));
  assert("grind: no rep up (hold)", grind.baseKg === 12 && grind.baseReps === 11);

  // 7) STEP DOWN: two consecutive sessions dirty at bottom (reps < 10) → 10 kg, reps 10.
  const down = prescribeAccessoryDoubleProgression(input({
    recentSets: [S(12, 8, 0, "2026-07-07"), S(12, 9, 1, "2026-06-30")],
  }));
  assert("step down: load -step", down.baseKg === 10);
  assert("step down: reps at bottom", down.baseReps === 10);

  // 8) ONE dirty session → hold (reps clamped into range).
  const hold = prescribeAccessoryDoubleProgression(input({
    recentSets: [S(12, 8, 0, "2026-07-07"), S(12, 12, 2, "2026-06-30")],
  }));
  assert("one dirty session: load held", hold.baseKg === 12);
  assert("one dirty session: reps clamped to bottom", hold.baseReps === 10);

  // 9) Descent floor: L = one step → never below step.
  const floor = prescribeAccessoryDoubleProgression(input({
    currentWorkingKg: 2,
    recentSets: [S(2, 8, 0, "2026-07-07"), S(2, 8, 0, "2026-06-30")],
  }));
  assert("descent floor: never below one step", floor.baseKg === 2);

  // 10) No history → hold at bottom.
  const fresh = prescribeAccessoryDoubleProgression(input({}));
  assert("no history: L + bottom", fresh.baseKg === 12 && fresh.baseReps === 10);

  // 11) DELOAD: load held, sets halved (3 → 2), volume-balance is skipped by the caller.
  const deload = prescribeAccessoryDoubleProgression(input({ blockPhase: "deload_week" }));
  assert("deload: load HELD", deload.baseKg === 12);
  assert("deload: sets halved", deload.sets === 2);
  assert("deload: reps at bottom", deload.baseReps === 10);

  // 12) CONSOLIDATION: all-top-clean does NOT step load; parks via rep-up at top.
  const consol = prescribeAccessoryDoubleProgression(input({
    blockPhase: "consolidation",
    recentSets: [S(12, 14, 2, "2026-07-07"), S(12, 14, 2, "2026-07-07")],
  }));
  assert("consolidation: load frozen", consol.baseKg === 12);
  assert("consolidation: reps park at top", consol.baseReps === 14);

  // 13) OFF_PACE: hold both even on a clean session.
  const off = prescribeAccessoryDoubleProgression(input({
    blockPhase: "off_pace",
    recentSets: [S(12, 11, 2, "2026-07-07")],
  }));
  assert("off_pace: load held", off.baseKg === 12);
  assert("off_pace: reps held (clamped achieved)", off.baseReps === 11);

  // 14) Warmup rows ignored in rung derivation.
  const warm = prescribeAccessoryDoubleProgression(input({
    recentSets: [S(6, 20, 4, "2026-07-07", { warmup: true }), S(12, 11, 2, "2026-07-07")],
  }));
  assert("warmups ignored", warm.baseReps === 12 && warm.baseKg === 12);
}

// ─── New fixtures: descent stickiness, strain-evidence gating, micro-pin grid ─────
console.log("\n## double-progression-rule.ts — fix fixtures (descent stickiness / strain / grid)\n");

{
  // Helpers reuse the same coarse DB setup (step 2, bottom 10, L=12)
  const ex = { name: "Lateral Raise (Dumbbell)", baseReps: 10, sets: 3, rir: 2, increment: { step: 2 } };
  const S = (kg, reps, rir, date, extra = {}) => ({
    exercise_name: "Lateral Raise (Dumbbell)", exercise_key: null,
    kg, reps, warmup: false, failure: false, rir, performed_on: date, ...extra,
  });
  const input = (over = {}) => ({
    baseExercise: ex, currentWorkingKg: 12, recentSets: [], rirTarget: 2,
    blockPhase: "pre_target", loadability: "coarse", focusClampCeilingKg: null,
    bottomReps: 10, ...over,
  });

  // --- Fix 1: Descent stickiness ---
  // After a step-down (L=12, last session was clean at 10), effL adopts 10.
  // The rep-up rung should climb from 10, NOT snap back to 12.
  // Fixture 1: clean at 10 (one grid-step below L=12) → prescription anchors at 10.
  const stickyRepUp = prescribeAccessoryDoubleProgression(input({
    currentWorkingKg: 12,
    recentSets: [S(10, 11, 2, "2026-07-07")], // clean at 10 (≥bottom, rir ok)
  }));
  assert("fix1 descent stickiness: baseKg adopted to 10 (not snapped back to 12)", stickyRepUp.baseKg === 10);
  assert("fix1 descent stickiness: rep-up from 10 (reps=12, not held at L=12 baseline)", stickyRepUp.baseReps === 12);

  // Fixture 2: Anomalous light session — top at 6 kg (TWO steps below L=12, clean).
  // Should NOT adopt the anomaly as effL; should HOLD at {12, bottom}.
  const anomaly = prescribeAccessoryDoubleProgression(input({
    currentWorkingKg: 12,
    recentSets: [S(6, 11, 2, "2026-07-07")], // clean but 6 is 3 steps below L=12
  }));
  assert("fix2 anomalous light session: load held at 12", anomaly.baseKg === 12);
  assert("fix2 anomalous light session: hold at bottom", anomaly.baseReps === 10);

  // --- Fix 2: Strain-evidence gating ---
  // Fixture 3: Compliant lighten — reps-short but HIGH rir (athlete chose to stop early).
  // Two sessions short of bottom but rir=3 (≥ prescribedRir=2) → HOLD, not descent.
  const compliantLighten = prescribeAccessoryDoubleProgression(input({
    currentWorkingKg: 12,
    recentSets: [S(12, 8, 3, "2026-07-07"), S(12, 9, 3, "2026-06-30")],
  }));
  assert("fix3 compliant lighten: HOLD not descent (load stays at 12)", compliantLighten.baseKg === 12);

  // Fixture 4: Strained descent still fires — rir=0 on both short sessions → step down.
  const strainedDown = prescribeAccessoryDoubleProgression(input({
    currentWorkingKg: 12,
    recentSets: [S(12, 8, 0, "2026-07-07"), S(12, 9, 0, "2026-06-30")],
  }));
  assert("fix4 strained descent: load steps down", strainedDown.baseKg === 10);
  assert("fix4 strained descent: reps at bottom", strainedDown.baseReps === 10);

  // Fixture 5a: Null-RIR reps-short without failure twice → HOLD (no strain evidence).
  const nullRirShort = prescribeAccessoryDoubleProgression(input({
    currentWorkingKg: 12,
    recentSets: [S(12, 8, null, "2026-07-07"), S(12, 8, null, "2026-06-30")],
  }));
  assert("fix5a null-RIR short no failure: HOLD at 12", nullRirShort.baseKg === 12);

  // Fixture 5b: Null-RIR with failure=true twice → descends.
  const nullRirFail = prescribeAccessoryDoubleProgression(input({
    currentWorkingKg: 12,
    recentSets: [
      S(12, 8, null, "2026-07-07", { failure: true }),
      S(12, 8, null, "2026-06-30", { failure: true }),
    ],
  }));
  assert("fix5b null-RIR with failure twice: descends", nullRirFail.baseKg === 10);

  // --- Fix 3: Micro-pin machines (nextUpKg / nextDownKg) ---
  // Leg Extension style: step=5, intermediate=2.3
  const exFine = { name: "Leg Extension (Machine)", baseReps: 10, sets: 3, rir: 2, increment: { step: 5, intermediate: 2.3 } };
  const SF = (kg, reps, rir, date, extra = {}) => ({
    exercise_name: "Leg Extension (Machine)", exercise_key: null,
    kg, reps, warmup: false, failure: false, rir, performed_on: date, ...extra,
  });
  const inputFine = (over = {}) => ({
    baseExercise: exFine, currentWorkingKg: 30, recentSets: [], rirTarget: 2,
    blockPhase: "pre_target", loadability: "fine", focusClampCeilingKg: null,
    bottomReps: 10, ...over,
  });

  // Fixture 6: Micro-pin step-up from L=30 → should jump to 32.3 (not 35).
  const microUp30 = prescribeAccessoryDoubleProgression(inputFine({
    currentWorkingKg: 30,
    recentSets: [SF(30, 12, 2, "2026-07-07"), SF(30, 12, 2, "2026-07-07")],
  }));
  assert("fix6a micro-pin step-up from 30: baseKg === 32.3", Math.abs(microUp30.baseKg - 32.3) < 0.01);

  // From 32.3 → next step up should be 35.
  const microUp32 = prescribeAccessoryDoubleProgression(inputFine({
    currentWorkingKg: 32.3,
    recentSets: [SF(32.3, 12, 2, "2026-07-07"), SF(32.3, 12, 2, "2026-07-07")],
  }));
  assert("fix6b micro-pin step-up from 32.3: baseKg === 35", Math.abs(microUp32.baseKg - 35) < 0.01);

  // Fixture 7: Micro-pin descent from 32.3 (strained twice) → should go to 30.
  const microDown = prescribeAccessoryDoubleProgression(inputFine({
    currentWorkingKg: 32.3,
    recentSets: [SF(32.3, 8, 0, "2026-07-07"), SF(32.3, 8, 0, "2026-06-30")],
  }));
  assert("fix7 micro-pin descent from 32.3: baseKg === 30", Math.abs(microDown.baseKg - 30) < 0.01);

  // Fixture 8 (regression guard): coarse DB grid unchanged — step=2, L=12.
  assert("fix8 nextUpKg coarse: 12+2=14", nextUpKg(12, { step: 2 }) === 14);
  assert("fix8 nextDownKg coarse: 12-2=10", nextDownKg(12, { step: 2 }) === 10);
  assert("fix8 nextDownKg floor: max(2,0)=2", nextDownKg(2, { step: 2 }) === 2);

  // Fixture 9: Width behavioral cases for fine (+2) and moderate (+3).
  // fine loadability: top = bottom+2 = 12; rep-up from 11 should cap at 12.
  const exFineRep = { name: "Leg Extension (Machine)", baseReps: 10, sets: 3, rir: 2, increment: { step: 5, intermediate: 2.3 } };
  const inputFineRep = (over = {}) => ({
    baseExercise: exFineRep, currentWorkingKg: 30, recentSets: [], rirTarget: 2,
    blockPhase: "pre_target", loadability: "fine", focusClampCeilingKg: null,
    bottomReps: 10, ...over,
  });
  const SFine = (kg, reps, rir, date, extra = {}) => ({
    exercise_name: "Leg Extension (Machine)", exercise_key: null,
    kg, reps, warmup: false, failure: false, rir, performed_on: date, ...extra,
  });
  const fineRepUp = prescribeAccessoryDoubleProgression(inputFineRep({
    recentSets: [SFine(30, 11, 2, "2026-07-07")],
  }));
  assert("fix9a fine width: rep-up caps at bottom+2=12", fineRepUp.baseReps === 12);

  // moderate loadability: top = bottom+3 = 13; rep-up from 12 should cap at 13.
  const exMod = { name: "Curl (Dumbbell)", baseReps: 10, sets: 3, rir: 2, increment: { step: 2.5 } };
  const SM = (kg, reps, rir, date, extra = {}) => ({
    exercise_name: "Curl (Dumbbell)", exercise_key: null,
    kg, reps, warmup: false, failure: false, rir, performed_on: date, ...extra,
  });
  const inputMod = (over = {}) => ({
    baseExercise: exMod, currentWorkingKg: 12, recentSets: [], rirTarget: 2,
    blockPhase: "pre_target", loadability: "moderate", focusClampCeilingKg: null,
    bottomReps: 10, ...over,
  });
  const modRepUp = prescribeAccessoryDoubleProgression(inputMod({
    recentSets: [SM(12, 12, 2, "2026-07-07")],
  }));
  assert("fix9b moderate width: rep-up caps at bottom+3=13", modRepUp.baseReps === 13);
}

// M2 hardening: off-grid loads snap to the grid before neighbor math.
assert("off-grid up on pin grid: 33 → 35", nextUpKg(33, { step: 5, intermediate: 2.3 }) === 35);
assert("off-grid down on pin grid: 31 → 30", nextDownKg(31, { step: 5, intermediate: 2.3 }) === 30);
assert("off-grid plain grid unaffected: 11.3 → 14 up", nextUpKg(11.3, { step: 2 }) === 14);

summary("audit-prescription-rules");
