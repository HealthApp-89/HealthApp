// scripts/audit-block-outcomes-rules.mjs
//
// Fixture-based audit for lib/coach/block-outcomes/ pure modules.
// No DB access. Run via:
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-block-outcomes-rules.mjs

import { evaluateBlockOutcome } from "@/lib/coach/block-outcomes/evaluator";
import { recommendNextFocus, idealSequence } from "@/lib/coach/block-outcomes/rotation";

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else      { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("\n## evaluator.ts\n");
{
  const block = {
    id: "fixture", user_id: "fixture", block_id: null,
    primary_lift: "deadlift", target_metric: "working_weight",
    target_value: 115, target_unit: "kg", status: "active",
    diet_goal: null, goal_text: "fixture", notes: null,
    target_hit_at_week: null,
    start_date: "2026-05-11", end_date: "2026-06-14",
    created_at: "2026-05-11", updated_at: "2026-05-11",
  };

  const sets = [
    { exercise_name: "Deadlift (Barbell)", kg: 95,  reps: 7, performed_on: "2026-05-21", weekN: 2 },
    { exercise_name: "Deadlift (Barbell)", kg: 97.5,reps: 8, performed_on: "2026-05-28", weekN: 3 },
    { exercise_name: "Deadlift (Barbell)", kg: 100, reps: 6, performed_on: "2026-06-04", weekN: 4 },
  ];
  const offPace = evaluateBlockOutcome({ block, primarySets: sets, totalBlockWeeks: 5 });
  assert("off-pace: end_working_kg = 100", offPace.end_working_kg === 100);
  assert("off-pace: target_hit = false", offPace.target_hit === false);
  assert("off-pace: phase = off_pace", offPace.block_phase_at_end === "off_pace");
  assert("off-pace: observed step ~2.5 kg/wk", Math.abs((offPace.observed_step_kg_per_wk ?? 0) - 2.5) < 0.01);
  assert("off-pace: gap_kg = 15", offPace.gap_kg === 15);

  const hitEarlyBlock = { ...block, target_value: 100, target_hit_at_week: 3 };
  const hitEarlySets = [
    { exercise_name: "Deadlift (Barbell)", kg: 95, reps: 7, performed_on: "2026-05-21", weekN: 2 },
    { exercise_name: "Deadlift (Barbell)", kg: 100, reps: 6, performed_on: "2026-05-28", weekN: 3 },
  ];
  const hitEarly = evaluateBlockOutcome({ block: hitEarlyBlock, primarySets: hitEarlySets, totalBlockWeeks: 5 });
  assert("hit_early: phase = hit_early", hitEarly.block_phase_at_end === "hit_early");
  assert("hit_early: target_hit = true", hitEarly.target_hit === true);

  const underperformedSets = [
    { exercise_name: "Deadlift (Barbell)", kg: 92.5, reps: 7, performed_on: "2026-05-21", weekN: 2 },
    { exercise_name: "Deadlift (Barbell)", kg: 95,   reps: 6, performed_on: "2026-05-28", weekN: 3 },
  ];
  const under = evaluateBlockOutcome({
    block: { ...block, target_value: 100, target_hit_at_week: null },
    primarySets: underperformedSets,
    totalBlockWeeks: 5,
  });
  assert("underperformed: phase = underperformed", under.block_phase_at_end === "underperformed");

  const empty = evaluateBlockOutcome({ block, primarySets: [], totalBlockWeeks: 5 });
  assert("no sets: end_working_kg null", empty.end_working_kg === null);
  assert("no sets: phase = underperformed", empty.block_phase_at_end === "underperformed");
}

console.log("\n## rotation.ts\n");
{
  const blockOf = (lift) => ({ primary_lift: lift });
  const lastOf = (lift, phase = "hit_on_pace") => ({ primary_lift: lift, block_phase_at_end: phase });

  const r1 = recommendNextFocus({ userBlocks: [blockOf("deadlift")], priorityLift: null, lastOutcome: lastOf("deadlift") });
  assert("standard: after deadlift → bench", r1.recommended_lift === "bench" && r1.reasoning === "standard_rotation");

  const r2 = recommendNextFocus({ userBlocks: [blockOf("bench")], priorityLift: null, lastOutcome: lastOf("bench") });
  assert("standard: after bench → squat", r2.recommended_lift === "squat");

  const r4 = recommendNextFocus({ userBlocks: [blockOf("ohp")], priorityLift: null, lastOutcome: lastOf("ohp") });
  assert("standard: after ohp → deadlift (wraps)", r4.recommended_lift === "deadlift");

  const p1 = recommendNextFocus({ userBlocks: [blockOf("bench"), blockOf("deadlift")], priorityLift: "deadlift", lastOutcome: lastOf("bench") });
  assert("priority deadlift, last bench → next deadlift", p1.recommended_lift === "deadlift" && p1.reasoning === "priority_injection");

  const p2 = recommendNextFocus({ userBlocks: [blockOf("deadlift"), blockOf("bench")], priorityLift: "deadlift", lastOutcome: lastOf("deadlift") });
  assert("priority deadlift, last deadlift → recovery (non-deadlift)", p2.recommended_lift !== "deadlift" && p2.reasoning === "priority_injection");

  const p3 = recommendNextFocus({ userBlocks: [blockOf("deadlift")], priorityLift: "deadlift", lastOutcome: lastOf("deadlift", "off_pace") });
  assert("priority deadlift, last off-pace deadlift → off_pace_recovery_avoided", p3.reasoning === "off_pace_recovery_avoided");

  const f1 = recommendNextFocus({ userBlocks: [], priorityLift: null, lastOutcome: null });
  assert("first block, no priority → deadlift", f1.recommended_lift === "deadlift" && f1.reasoning === "first_block");

  const f2 = recommendNextFocus({ userBlocks: [], priorityLift: "bench", lastOutcome: null });
  assert("first block, priority bench → bench", f2.recommended_lift === "bench");

  const ideal = idealSequence({ n: 8, priorityLift: "deadlift" });
  assert("ideal sequence with priority deadlift starts D, B, D, S", ideal[0] === "deadlift" && ideal[1] === "bench" && ideal[2] === "deadlift" && ideal[3] === "squat", `got ${JSON.stringify(ideal)}`);
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
