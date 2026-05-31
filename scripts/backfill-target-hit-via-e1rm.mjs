// scripts/backfill-target-hit-via-e1rm.mjs
//
// One-shot backfill: for every active block, re-evaluate target_hit_at_week
// using the now-metric-aware target-hit-evaluator. Without --yes, prints a
// dry-run of would-be changes; with --yes, writes them.
//
// Why we need this: target-hit-evaluator pre-0041 compared raw working_weight
// against target_value regardless of target_metric. e1RM blocks therefore had
// their target_hit_at_week left stale (or stamped against the wrong metric).
// This script re-runs the evaluator across active blocks and stamps the
// correct week. Idempotent — running twice produces the same result.
//
// Run via:
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/backfill-target-hit-via-e1rm.mjs [--yes]

import { createClient } from "@supabase/supabase-js";
import { bestComparisonValue } from "@/lib/coach/e1rm";

const dryRun = !process.argv.includes("--yes");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(url, key);

const PRIMARY_LIFT_NAME_PATTERNS = {
  squat:    ["Squat (Barbell)"],
  bench:    ["Decline Bench Press (Barbell)", "Incline Bench Press (Dumbbell)", "Bench Press (Barbell)"],
  deadlift: ["Deadlift (Barbell)"],
  ohp:      ["Overhead Press (Barbell)"],
};

const { data: blocks, error: bErr } = await supabase
  .from("training_blocks")
  .select("id, user_id, primary_lift, target_value, target_metric, start_date, end_date, target_hit_at_week")
  .eq("status", "active");
if (bErr) {
  console.error("block_query_failed", bErr);
  process.exit(1);
}

let scanned = 0;
let toStamp = 0;
let stamped = 0;

for (const block of blocks ?? []) {
  scanned++;
  if (block.primary_lift == null || block.target_value == null) continue;
  const namePatterns = PRIMARY_LIFT_NAME_PATTERNS[block.primary_lift] ?? [];
  if (namePatterns.length === 0) continue;
  const patternsLower = namePatterns.map((p) => p.toLowerCase());

  // Pull every non-warmup set in the block window for this lift.
  const { data: workouts } = await supabase
    .from("workouts")
    .select("date, exercises(name, exercise_sets(kg, reps, warmup))")
    .eq("user_id", block.user_id)
    .gte("date", block.start_date)
    .lte("date", block.end_date);

  const candidates = [];
  let firstCrossingDate = null;
  const metric = block.target_metric ?? "working_weight";
  for (const w of (workouts ?? []).sort((a, b) => (a.date < b.date ? -1 : 1))) {
    for (const ex of w.exercises ?? []) {
      if (!patternsLower.includes(ex.name.toLowerCase())) continue;
      for (const s of ex.exercise_sets ?? []) {
        if (s.warmup) continue;
        candidates.push({ kg: s.kg, reps: s.reps, warmup: false });
        // Check after each set whether the new max meets target — that
        // gives us the EARLIEST week the target was crossed.
        const best = bestComparisonValue(candidates, metric);
        if (best != null && best >= block.target_value && firstCrossingDate == null) {
          firstCrossingDate = w.date;
        }
      }
    }
  }

  if (firstCrossingDate == null) {
    if (block.target_hit_at_week != null) {
      console.warn(
        `  ⚠ block ${block.id} (${block.primary_lift}, metric=${metric}): target_hit_at_week=${block.target_hit_at_week} but no crossing found in window. Manual review.`,
      );
    }
    continue;
  }

  const start = new Date(block.start_date + "T00:00:00Z");
  const cross = new Date(firstCrossingDate + "T00:00:00Z");
  const days = Math.floor((cross.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  const weekN = Math.max(1, Math.floor(days / 7) + 1);

  if (block.target_hit_at_week === weekN) continue;

  toStamp++;
  console.log(
    `  block ${block.id} user ${block.user_id} (${block.primary_lift}, metric=${metric}, target=${block.target_value}): stamp target_hit_at_week=${weekN} (was ${block.target_hit_at_week ?? "null"}) — first crossing ${firstCrossingDate}`,
  );

  if (!dryRun) {
    const { error: upErr } = await supabase
      .from("training_blocks")
      .update({ target_hit_at_week: weekN, updated_at: new Date().toISOString() })
      .eq("id", block.id);
    if (upErr) {
      console.error("    update_failed", upErr);
    } else {
      stamped++;
    }
  }
}

console.log(`\nScanned ${scanned} active blocks. ${toStamp} would-stamp; ${stamped} stamped.`);
if (dryRun && toStamp > 0) {
  console.log("Re-run with --yes to apply.");
}
process.exit(0);
