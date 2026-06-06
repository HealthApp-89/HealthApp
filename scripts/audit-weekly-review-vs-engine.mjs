#!/usr/bin/env node
// scripts/audit-weekly-review-vs-engine.mjs
//
// Verifies the property "weekly_reviews.payload.prescription.per_lift values
// equal the training_weeks.session_prescriptions row for the same
// next_week_start". This is the property the engine collapse establishes —
// if it ever fails again, someone reintroduced a parallel rule path.
//
// Usage:
//   AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs \
//     --experimental-strip-types --env-file=.env.local \
//     scripts/audit-weekly-review-vs-engine.mjs
//
// Exits 0 on success, 1 on any divergence. Read-only.

import { createClient } from "@supabase/supabase-js";

const userId = process.env.AUDIT_USER_ID;
if (!userId) {
  console.error("AUDIT_USER_ID env var required");
  process.exit(1);
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// Pull the last 4 committed weekly reviews.
const { data: reviews, error: revErr } = await sb
  .from("weekly_reviews")
  .select("week_start, version, status, payload")
  .eq("user_id", userId)
  .eq("status", "committed")
  .order("week_start", { ascending: false })
  .limit(4);
if (revErr) { console.error("review fetch failed:", revErr); process.exit(1); }

let failed = 0;
for (const r of reviews ?? []) {
  const payload = r.payload;
  if (payload.schema_version !== 2) {
    console.log(`week_start=${r.week_start} v=${payload.schema_version} — skipping v1 historical row`);
    continue;
  }

  const nextWeekStart = payload.prescription.next_week_start;
  const { data: tw } = await sb
    .from("training_weeks")
    .select("session_prescriptions")
    .eq("user_id", userId)
    .eq("week_start", nextWeekStart)
    .maybeSingle();
  const stored = tw?.session_prescriptions ?? null;

  if (!stored) {
    console.warn(`week_start=${r.week_start} → next=${nextWeekStart}: NO training_weeks row (inline fallback was used)`);
    continue;
  }

  // Compare per_lift weights against the engine's emitted entries.
  for (const lp of payload.prescription.per_lift ?? []) {
    const engineEntry = findFirstByName(stored, lp.lift);
    if (!engineEntry) {
      console.error(`✗ ${nextWeekStart} ${lp.lift}: payload has prescription but engine row does not`);
      failed++;
      continue;
    }
    const engineKg = engineEntry.baseKg ?? 0;
    if (Math.abs(engineKg - lp.weight_kg) > 0.01) {
      console.error(`✗ ${nextWeekStart} ${lp.lift}: payload=${lp.weight_kg} engine=${engineKg}`);
      failed++;
    } else {
      console.log(`✓ ${nextWeekStart} ${lp.lift}: ${lp.weight_kg} kg`);
    }
  }
}

if (failed > 0) {
  console.error(`\n${failed} divergences`);
  process.exit(1);
}
console.log("\naudit passed");

function findFirstByName(prescription, liftName) {
  const order = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  for (const wd of order) {
    const list = prescription[wd];
    if (!list) continue;
    const m = list.find((e) => !e.warmup && e.name.toLowerCase() === liftName.toLowerCase());
    if (m) return m;
  }
  return null;
}
