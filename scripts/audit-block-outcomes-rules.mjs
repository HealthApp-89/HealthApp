// scripts/audit-block-outcomes-rules.mjs
//
// Fixture-based audit for lib/coach/block-outcomes/ pure modules.
// No DB access. Run via:
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-block-outcomes-rules.mjs

import { evaluateBlockOutcome } from "@/lib/coach/block-outcomes/evaluator";

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

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
