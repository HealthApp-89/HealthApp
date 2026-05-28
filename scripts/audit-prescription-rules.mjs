// scripts/audit-prescription-rules.mjs
//
// Fixture-based audit for the prescription rule modules. Exercises each
// rule with concrete inputs and asserts expected outputs. Run via:
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-prescription-rules.mjs
//
// No DB access — pure functions only.

import { maintenanceLoadFor } from "@/lib/coach/prescription/maintenance-baseline";

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

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
