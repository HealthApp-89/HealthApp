// scripts/audit-block-outcomes-e2e.mjs
//
// End-to-end audit. Verifies schema, orchestrator dry-run, and trajectory
// composition against live data.
//
// Run via:
//   AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-block-outcomes-e2e.mjs

import { createClient } from "@supabase/supabase-js";
import { generateBlockOutcome } from "@/lib/coach/block-outcomes/index";
import { generateBlockTrajectory } from "@/lib/coach/block-outcomes/trajectory";

const userId = process.env.AUDIT_USER_ID;
if (!userId) { console.error("Set AUDIT_USER_ID=<uuid>"); process.exit(1); }
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing env"); process.exit(1); }
const supabase = createClient(url, key);

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else      { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("\n## Schema\n");
{
  const a = await supabase.from("block_outcomes").select("id").limit(1);
  assert("block_outcomes selectable", a.error == null, a.error?.message);
  const b = await supabase.from("profiles").select("rotation_priority_lift").limit(1);
  assert("profiles.rotation_priority_lift selectable", b.error == null, b.error?.message);
}

console.log("\n## Orchestrator dry-run\n");
{
  const { data: blocks } = await supabase
    .from("training_blocks").select("id").eq("user_id", userId).limit(1);
  const blockId = blocks?.[0]?.id;
  if (!blockId) {
    console.log("  - No blocks for user; skipping.");
  } else {
    try {
      const { payload } = await generateBlockOutcome({ supabase, userId, blockId });
      assert("generateBlockOutcome returns payload", payload != null);
      assert("payload.primary_lift valid", ["squat","bench","deadlift","ohp"].includes(payload.primary_lift));
      assert("payload.block_phase_at_end valid", ["hit_early","hit_on_pace","off_pace","underperformed"].includes(payload.block_phase_at_end));
      console.log(`  Phase: ${payload.block_phase_at_end}, end ${payload.end_working_kg ?? "n/a"} vs target ${payload.target_value_kg ?? "n/a"}`);
      console.log(`  Recommended next: ${payload.recommended_next_focus} @ ${payload.recommended_target_value_kg ?? "n/a"} kg`);
    } catch (e) {
      assert("generateBlockOutcome dry-run", false, e.message);
    }
  }
}

console.log("\n## Trajectory\n");
{
  const todayIso = new Date().toISOString().slice(0, 10);
  try {
    const traj = await generateBlockTrajectory({ supabase, userId, todayIso });
    assert("trajectory payload returned", traj != null);
    assert("per_lift has all 4 entries", traj.per_lift.length === 4);
    console.log(`  Next focus due: ${traj.next_focus_due}, adherence ${traj.rotation_adherence.adherence_pct.toFixed(0)}%`);
  } catch (e) {
    assert("generateBlockTrajectory", false, e.message);
  }
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
