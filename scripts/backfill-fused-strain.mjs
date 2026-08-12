// scripts/backfill-fused-strain.mjs
//
// Recompute daily_logs.strain across the range where all-day HR exists, so the
// whole series uses one formula. Prints a before/after diff and requires --yes.
//
// Jan-Mar 2026 is deliberately NOT touched: no Garmin all-day HR exists for it,
// so those rows stay WHOOP-legacy and the boundary is a known discontinuity.
//
//   AUDIT_USER_ID=<uuid> RANGE_START=2026-04-01 \
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//        --env-file=.env.local scripts/backfill-fused-strain.mjs --yes

import { createClient } from "@supabase/supabase-js";
import { recomputeStrainForDay } from "@/lib/coach/strain/recompute";

const userId = process.env.AUDIT_USER_ID;
if (!userId) throw new Error("AUDIT_USER_ID is required");
const start = process.env.RANGE_START;
if (!start) throw new Error("RANGE_START is required (the all-day-HR floor)");

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: before, error } = await sb
  .from("daily_logs")
  .select("date, strain")
  .eq("user_id", userId)
  .gte("date", start)
  .order("date");
if (error) throw error;

console.log(`${before.length} days from ${start}`);
if (!process.argv.includes("--yes")) {
  console.log("dry run — pass --yes to write. Recomputing first 10 for preview:");
  for (const row of before.slice(0, 10)) {
    console.log(`  ${row.date}  stored=${row.strain?.toFixed(2) ?? "-"}`);
  }
  process.exit(0);
}

let changed = 0;
let skipped = 0;
for (const row of before) {
  const res = await recomputeStrainForDay({ supabase: sb, userId, dateIso: row.date });
  if (res.strain === null) {
    skipped++;
    continue;
  }
  const delta = res.strain - (row.strain ?? 0);
  if (Math.abs(delta) > 0.005) changed++;
  console.log(
    `${row.date}  ${String((row.strain ?? 0).toFixed(2)).padStart(6)} → ${String(res.strain.toFixed(2)).padStart(6)}  ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`,
  );
}
console.log(`\n${changed} changed, ${skipped} skipped (no input), ${before.length} total`);
