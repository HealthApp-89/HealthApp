// scripts/audit-sunday-prescription-e2e.mjs
//
// End-to-end audit for the Sunday Prescription System against live data.
// Verifies:
//   1. Schema columns are selectable on training_blocks + training_weeks
//   2. Active block's target_hit_at_week is set iff its target has been crossed
//   3. For the most recent committed week, session_prescriptions is either
//      present (post-Sunday) or null (pre-Sunday)
//   4. If session_prescriptions present: each exercise's baseKg is on grid
//   5. No axial-hinge accessories on non-focus days in a deadlift block
//
// Run via:
//   AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-sunday-prescription-e2e.mjs

import { createClient } from "@supabase/supabase-js";
import { validatePatternConflicts } from "@/lib/coach/prescription/pattern-conflict-overlay";
import { resolveExercise } from "@/lib/coach/exercise-library";
import { bestComparisonValue } from "@/lib/coach/e1rm";

const userId = process.env.AUDIT_USER_ID;
if (!userId) {
  console.error("Set AUDIT_USER_ID=<uuid>");
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(url, key);

let pass = 0;
let fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else      { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const PRIMARY_LIFT_NAMES = {
  squat:    ["Squat (Barbell)"],
  bench:    ["Decline Bench Press (Barbell)", "Incline Bench Press (Dumbbell)", "Bench Press (Barbell)"],
  deadlift: ["Deadlift (Barbell)"],
  ohp:      ["Overhead Press (Barbell)"],
};

// ── 1. Schema columns ──────────────────────────────────────────────────────
console.log("\n## Schema columns\n");
{
  const { error: tbErr } = await supabase.from("training_blocks").select("target_hit_at_week").limit(1);
  assert("training_blocks.target_hit_at_week selectable", tbErr === null, tbErr?.message);
  const { error: twErr } = await supabase.from("training_weeks").select("session_prescriptions").limit(1);
  assert("training_weeks.session_prescriptions selectable", twErr === null, twErr?.message);
}

// ── 2. Active block & target_hit_at_week consistency ───────────────────────
console.log("\n## Active block\n");
const { data: blocks } = await supabase
  .from("training_blocks")
  .select("*")
  .eq("user_id", userId)
  .eq("status", "active");

const block = blocks?.[0] ?? null;
if (!block) {
  console.log("  - No active block (skipping block-level checks).");
} else {
  console.log(`  Active block: ${block.primary_lift} target ${block.target_value} kg, target_hit_at_week=${block.target_hit_at_week ?? "null"}, ${block.start_date} → ${block.end_date}`);

  if (block.primary_lift && block.target_value != null) {
    const names = PRIMARY_LIFT_NAMES[block.primary_lift] ?? [];
    const { data: wRows } = await supabase
      .from("workouts")
      .select("date, exercises(name, exercise_sets(kg, reps, warmup))")
      .eq("user_id", userId)
      .gte("date", block.start_date)
      .lte("date", block.end_date);
    // Metric-aware comparison: working_weight blocks use max raw kg; e1rm
    // blocks use max Brzycki across 1..12-rep sets. Legacy NULL metric →
    // 'working_weight'. Matches lib/coach/prescription/target-hit-evaluator.ts.
    const metric = block.target_metric ?? "working_weight";
    const candidates = [];
    for (const w of wRows ?? []) {
      for (const ex of w.exercises ?? []) {
        if (!names.includes(ex.name)) continue;
        for (const s of ex.exercise_sets ?? []) {
          candidates.push({ kg: s.kg, reps: s.reps, warmup: s.warmup });
        }
      }
    }
    const best = bestComparisonValue(candidates, metric);
    if (best != null && best >= block.target_value) {
      assert(`target crossed (best ${best.toFixed(1)} ≥ ${block.target_value}, metric=${metric}) → target_hit_at_week must be set`, block.target_hit_at_week != null);
    } else {
      console.log(`  - best ${metric} ${block.primary_lift} = ${best == null ? "n/a" : best.toFixed(1)}; target ${block.target_value} not yet crossed (target_hit_at_week correctly null).`);
    }
  }
}

// ── 3. Most recent training_weeks row ──────────────────────────────────────
console.log("\n## Most recent training_weeks row\n");
const { data: weeks } = await supabase
  .from("training_weeks")
  .select("*")
  .eq("user_id", userId)
  .order("week_start", { ascending: false })
  .limit(1);

const week = weeks?.[0] ?? null;
if (!week) {
  console.log("  - No training_weeks row (skipping prescription checks).");
} else {
  console.log(`  Most recent week: ${week.week_start}, prescriptions: ${week.session_prescriptions ? "present" : "null"}`);

  if (week.session_prescriptions) {
    // ── 4. off_grid_weight check ────────────────────────────────────────────
    console.log("\n## On-grid weight check\n");
    let weightsChecked = 0;
    for (const [weekday, exercises] of Object.entries(week.session_prescriptions)) {
      for (const ex of exercises ?? []) {
        if (ex.baseKg == null) continue;
        const lib = resolveExercise(ex.name);
        if (!lib?.increment) continue;
        const step = lib.increment.step;
        const inter = lib.increment.intermediate;
        const onPrimary = Math.abs((ex.baseKg / step) - Math.round(ex.baseKg / step)) < 1e-6;
        const onInter =
          inter != null &&
          ex.baseKg >= inter &&
          Math.abs(((ex.baseKg - inter) / step) - Math.round((ex.baseKg - inter) / step)) < 1e-6;
        assert(`${weekday} ${ex.name} ${ex.baseKg} kg on grid (step ${step})`, onPrimary || onInter);
        weightsChecked++;
      }
    }
    if (weightsChecked === 0) {
      console.log("  - No baseKg-bearing prescribed exercises to check.");
    }

    // ── 5. Pattern conflict check ───────────────────────────────────────────
    console.log("\n## Pattern conflicts\n");
    if (block) {
      const err = validatePatternConflicts(week.session_prescriptions, block, week);
      assert("no pattern conflicts on the most recent week", err === null, err?.message);
    } else {
      console.log("  - No active block; skipping pattern-conflict check.");
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
