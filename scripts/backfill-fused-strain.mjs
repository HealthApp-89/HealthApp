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

// recomputeStrainForDay transitively imports lib/supabase/server.ts, which
// top-level-imports `next/headers` for its Server Component client. ESM hoists
// that import, so it explodes outside the Next bundler even though this script
// only ever uses the unrelated service-role export. Stub the specifier locally
// — same pattern as scripts/backfill-block-narratives.mjs and
// scripts/smoke-food-lookup.mjs. Deliberately NOT a change to
// scripts/alias-loader.mjs: that loader is shared by ~70 scripts, and a
// resolution fallback there would let `next/headers` load Next's real
// internals rather than a stub.
import { register } from "node:module";

const stubLoader = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/headers") {
    return {
      url: "data:text/javascript,export%20const%20cookies%20%3D%20()%20%3D%3E%20(%7B%20getAll%3A%20()%20%3D%3E%20%5B%5D%2C%20set%3A%20()%20%3D%3E%20%7B%7D%20%7D)%3Bexport%20const%20headers%20%3D%20()%20%3D%3E%20new%20Headers()%3Bexport%20const%20draftMode%20%3D%20()%20%3D%3E%20(%7B%20isEnabled%3A%20false%2C%20enable%3A%20()%20%3D%3E%20%7B%7D%2C%20disable%3A%20()%20%3D%3E%20%7B%7D%20%7D)%3B",
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
`;
register("data:text/javascript," + encodeURIComponent(stubLoader), import.meta.url);

import { createClient } from "@supabase/supabase-js";
const { recomputeStrainForDay } = await import("@/lib/coach/strain/recompute");

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
    console.log(`${row.date}  SKIPPED (${res.skipped ?? "no input"})`);
    continue;
  }
  const delta = res.strain - (row.strain ?? 0);
  if (Math.abs(delta) > 0.005) changed++;
  console.log(
    `${row.date}  ${String((row.strain ?? 0).toFixed(2)).padStart(6)} → ${String(res.strain.toFixed(2)).padStart(6)}  ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`,
  );
}
console.log(`\n${changed} changed, ${skipped} skipped (no input), ${before.length} total`);
