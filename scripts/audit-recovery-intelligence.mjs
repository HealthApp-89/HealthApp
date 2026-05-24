// scripts/audit-recovery-intelligence.mjs
//
// Verifies the RecoveryIntelligencePayload composer outputs against raw
// queries on daily_logs / checkins / workouts for the target user.
//
// Usage:
//   AUDIT_USER_ID=<uuid> node \
//     --import ./scripts/alias-loader.mjs \
//     --experimental-strip-types \
//     --env-file=.env.local \
//     scripts/audit-recovery-intelligence.mjs

import { createClient } from "@supabase/supabase-js";
import { generateRecoveryIntelligence } from "../lib/coach/recovery-intelligence/index.ts";

const userId = process.env.AUDIT_USER_ID;
if (!userId) {
  console.error("AUDIT_USER_ID env var required");
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const today = new Date().toISOString().slice(0, 10);
console.log(`audit-recovery-intelligence · user ${userId} · today ${today}`);

const payload = await generateRecoveryIntelligence({ supabase, userId, today });

console.log("\n── shape ──");
console.log(`  daily: ${payload.daily.length} (expected 28)`);
console.log(`  weekly: ${payload.weekly.length} (expected 12)`);
console.log(`  sleep_architecture: ${payload.sleep_architecture.length} (expected 14)`);
console.log(`  bedtime: ${payload.bedtime.length} (expected 28)`);
console.log(`  subjective: ${payload.subjective.length} (expected 28)`);

console.log("\n── baselines ──");
console.log(`  hrv_mean: ${payload.baselines.hrv_mean}`);
console.log(`  hrv_sd: ${payload.baselines.hrv_sd}`);
console.log(`  resting_hr_mean: ${payload.baselines.resting_hr_mean}`);
console.log(`  skin_temp_baseline_c: ${payload.baselines.skin_temp_baseline_c}`);
console.log(`  respiratory_rate_baseline_bpm: ${payload.baselines.respiratory_rate_baseline_bpm}`);

console.log("\n── derived ──");
console.log(JSON.stringify(payload.derived, null, 2));

// Spot-check: composer daily 7d hrv avg == raw query 7d hrv avg.
const last7Iso = payload.daily.slice(-7).map((d) => d.date);
const { data: raw } = await supabase
  .from("daily_logs")
  .select("hrv")
  .eq("user_id", userId)
  .in("date", last7Iso);
const rawAvg = (() => {
  const v = (raw ?? []).map((r) => r.hrv).filter((x) => x != null);
  if (v.length === 0) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
})();
console.log("\n── crosscheck: hrv_avg_7d ──");
console.log(`  composer: ${payload.derived.hrv_avg_7d}`);
console.log(`  raw     : ${rawAvg}`);
const ok = (payload.derived.hrv_avg_7d == null && rawAvg == null) ||
  (payload.derived.hrv_avg_7d != null && rawAvg != null && Math.abs(payload.derived.hrv_avg_7d - rawAvg) < 0.01);
console.log(`  match: ${ok ? "✓" : "✗"}`);
process.exit(ok ? 0 : 1);
