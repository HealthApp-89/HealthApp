// scripts/audit-remi-triggers.mjs
//
// For AUDIT_USER_ID, dry-runs the 14 Remi triggers (13 new + existing
// hrv_below_baseline) against current data and reports for each:
// would_fire | would_skip with reason. Doesn't write to chat_messages or
// proactive_nudge_dedup — pass dry_run=true.
//
// Usage:
//   AUDIT_USER_ID=<uuid> node \
//     --import ./scripts/alias-loader.mjs \
//     --experimental-strip-types \
//     --env-file=.env.local \
//     scripts/audit-remi-triggers.mjs

import { createClient } from "@supabase/supabase-js";
import { generateCoachTrends } from "../lib/coach/trends/index.ts";
import { generateRecoveryIntelligence } from "../lib/coach/recovery-intelligence/index.ts";
import { runProactiveChecks } from "../lib/coach/proactive/index.ts";

const userId = process.env.AUDIT_USER_ID;
if (!userId) { console.error("AUDIT_USER_ID required"); process.exit(1); }

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const today = new Date().toISOString().slice(0, 10);
console.log(`audit-remi-triggers · user ${userId} · today ${today}\n`);

const [trends, recoveryIntelligence] = await Promise.all([
  generateCoachTrends({ supabase, userId, today }),
  generateRecoveryIntelligence({ supabase, userId, today }),
]);

const result = await runProactiveChecks({
  supabase, userId, trends, recoveryIntelligence, dry_run: true,
});

const remiTriggerPrefixes = [
  "hrv_below_baseline", "hrv_chronic_depression",
  "rhr_elevated", "sleep_debt_accumulated",
  "low_recovery_streak", "strain_recovery_imbalance",
  "skin_temp_elevated", "recurring_soreness_",
  "sickness_lingering", "deep_sleep_deficit",
  "bedtime_drift", "respiratory_rate_elevated",
  "heavy_fatigue_cluster", "post_strain_undersleep",
];

const isRemi = (key) => remiTriggerPrefixes.some((p) => key.startsWith(p));

const remiFired = result.fired.filter((f) => isRemi(f.event.trigger_key));
console.log(`── Remi triggers WOULD fire (${remiFired.length}) ──`);
for (const f of remiFired) {
  console.log(`  ✓ ${f.event.trigger_key}`);
  console.log(`    ${f.card.headline}`);
  console.log(`    payload: ${JSON.stringify(f.event.payload)}`);
}

const allRemiKeys = remiTriggerPrefixes.filter((p) => !p.endsWith("_")); // exclude per-area family
const firedKeys = new Set(remiFired.map((f) => f.event.trigger_key));
const wouldSkip = allRemiKeys.filter((k) => !firedKeys.has(k));
console.log(`\n── Remi triggers WOULD skip (${wouldSkip.length}) ──`);
for (const k of wouldSkip) console.log(`  · ${k}`);

console.log(`\n── shape sanity ──`);
console.log(`  recoveryIntelligence.daily: ${recoveryIntelligence.daily.length}`);
console.log(`  recoveryIntelligence.subjective: ${recoveryIntelligence.subjective.length}`);
console.log(`  hrv baseline: ${recoveryIntelligence.baselines.hrv_mean}`);
console.log(`  rhr baseline: ${recoveryIntelligence.baselines.resting_hr_mean}`);
console.log(`  skin temp baseline: ${recoveryIntelligence.baselines.skin_temp_baseline_c}`);
console.log(`  bedtime_sd_minutes: ${recoveryIntelligence.derived.bedtime_sd_minutes}`);
process.exit(0);
