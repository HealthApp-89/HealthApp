// scripts/audit-strain-recompute.mjs
//
// Verifies stored daily_logs.strain equals a fresh computation for the last 30
// days. Catches ingest drift, a missed recompute trigger, and any second writer
// reappearing on the column.
//
// READ-ONLY: uses computeDayStrain rather than recomputeStrainForDay, so a
// failure stays failed until someone fixes it.
//
//   AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs \
//     --experimental-strip-types --env-file=.env.local scripts/audit-strain-recompute.mjs

// computeDayStrain transitively imports lib/supabase/server.ts, which
// top-level-imports `next/headers` for its Server Component client. ESM hoists
// that import, so it explodes outside the Next bundler even though this script
// only ever uses the unrelated service-role export. Stub the specifier locally
// — same pattern as scripts/backfill-fused-strain.mjs. Deliberately NOT a
// change to scripts/alias-loader.mjs: that loader is shared by ~70 scripts, and
// a resolution fallback there would let `next/headers` load Next's real
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
import { createAuditReporter } from "./audit-utils.mjs";
const { computeDayStrain } = await import("@/lib/coach/strain/recompute");

const { assert, summary } = createAuditReporter();
const userId = process.env.AUDIT_USER_ID;
if (!userId) throw new Error("AUDIT_USER_ID is required");

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
const { data: rows, error } = await sb
  .from("daily_logs")
  .select("date, strain")
  .eq("user_id", userId)
  .gte("date", since)
  .order("date");
if (error) throw error;

let mismatches = 0;
for (const row of rows) {
  // computeDayStrain, NOT recomputeStrainForDay: an audit that writes heals the
  // drift it just found, reports it exactly once, and passes forever after.
  const { result } = await computeDayStrain({ supabase: sb, userId, dateIso: row.date });
  if (!result) continue;
  const drift = Math.abs(result.strain - (row.strain ?? 0));
  if (drift > 0.01) {
    mismatches++;
    console.log(`  ${row.date}: stored ${row.strain?.toFixed(2)} vs fresh ${result.strain.toFixed(2)}`);
  }
}
assert(`stored strain matches recompute for all ${rows.length} recent days`, mismatches === 0);

const nulls = rows.filter((r) => r.strain === null).length;
console.log(`${nulls}/${rows.length} days have no strain (no HR and no workout)`);

summary();
