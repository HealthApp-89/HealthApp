// scripts/seed-target-hit-at-week.mjs
//
// One-shot backfill: walks all active training_blocks and runs
// evaluateAndStampTargetHit for each. Idempotent — only stamps blocks
// where target_hit_at_week is currently NULL and the target has been
// crossed. Run once after migration 0036 applies.
//
// Run via:
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/seed-target-hit-at-week.mjs

import { createClient } from "@supabase/supabase-js";
import { evaluateAndStampTargetHit } from "@/lib/coach/prescription/target-hit-evaluator";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(url, key);

const { data: blocks, error } = await supabase
  .from("training_blocks")
  .select("id, user_id, primary_lift, target_value, target_hit_at_week, start_date, end_date, status")
  .eq("status", "active")
  .is("target_hit_at_week", null);

if (error) {
  console.error("Failed to load active blocks:", error);
  process.exit(1);
}

console.log(`Found ${blocks.length} active blocks with NULL target_hit_at_week.`);

let stamped = 0;
let skipped = 0;

for (const block of blocks) {
  if (block.primary_lift == null || block.target_value == null) {
    console.log(`  - Block ${block.id}: skipped (no primary_lift / target_value)`);
    skipped++;
    continue;
  }
  try {
    const result = await evaluateAndStampTargetHit({ supabase, userId: block.user_id });
    if (result.stamped) {
      console.log(`  ✓ Block ${block.id} (${block.primary_lift} → ${block.target_value} kg): STAMPED at week ${result.week_n}`);
      stamped++;
    } else {
      console.log(`  - Block ${block.id} (${block.primary_lift} → ${block.target_value} kg): no stamp (target not yet crossed)`);
      skipped++;
    }
  } catch (e) {
    console.error(`  ✗ Block ${block.id}: error`, e);
  }
}

console.log(`\nDone. Stamped: ${stamped}, Skipped: ${skipped}.`);
