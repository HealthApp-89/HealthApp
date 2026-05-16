#!/usr/bin/env node
// scripts/audit-coach-trends.mjs
//
// Exercise the coach-trends compute against the live fixture and dump
// the payload for manual inspection. Read-only.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const env = {};
for (const line of readFileSync(resolve(repoRoot, ".env.local"), "utf-8").split("\n")) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing env"); process.exit(1); }

const sb = createClient(url, key, { auth: { persistSession: false } });
const { data: profile } = await sb
  .from("profiles")
  .select("user_id")
  .order("created_at", { ascending: true })
  .limit(1)
  .single();
const userId = profile.user_id;
const today = new Date().toISOString().slice(0, 10);

const { generateCoachTrends } = await import("../lib/coach/trends/index.ts");
const payload = await generateCoachTrends({ supabase: sb, userId, today });

console.log("=== HEADLINE ===");
console.log(payload.headline);
console.log("\n=== STRENGTH per-lift ===");
for (const p of payload.strength.per_lift) {
  const slope4 = p.slope_pct_per_wk_4w != null ? `${(p.slope_pct_per_wk_4w * 100).toFixed(1)}%/wk` : "n/a";
  const plateau = p.plateau_active ? ` PLATEAU ${p.plateau_weeks_flat}wk` : "";
  console.log(`  ${p.lift.padEnd(35)} e1RM=${p.e1rm_kg_now ?? "n/a"}  slope=${slope4}${plateau}`);
}
console.log("\n=== BODY ===");
console.log(`  weight ${payload.body.weight.now_kg}kg  rate4w=${payload.body.weight.rate_kg_per_wk_4w}  inBand=${payload.body.weight.in_band}`);
console.log(`  LBM ${payload.body.lbm.now_kg}kg  Δ4w=${payload.body.lbm.delta_4w_kg}`);
console.log("\n=== NUTRITION ===");
console.log(`  protein 4w hits: ${payload.nutrition.protein.days_hit_4w}/${payload.nutrition.protein.days_total_4w}  (${((payload.nutrition.protein.pct_4w ?? 0) * 100).toFixed(0)}%)`);
console.log(`  kcal 4w hits: ${payload.nutrition.kcal.days_hit_4w}/${payload.nutrition.kcal.days_total_4w}`);
console.log("\n=== RECOVERY ===");
console.log(`  sleep 4w avg: ${payload.recovery.sleep.avg_h_4w}h  eff=${payload.recovery.sleep.avg_efficiency_pct_4w}`);
const hrvDelta = payload.recovery.hrv.vs_baseline_pct_4w;
const hrvDeltaStr = hrvDelta != null ? (hrvDelta * 100).toFixed(0) + "%" : "n/a";
console.log(`  HRV 4w avg: ${payload.recovery.hrv.avg_4w}  vs baseline: ${hrvDeltaStr}`);
console.log("\n=== CROSS INSIGHTS ===");
for (const c of payload.cross_insights) {
  console.log(`  [${c.pair} / ${c.window}] n=${c.n_points} R²=${c.r_squared.toFixed(2)}`);
  console.log(`    ${c.insight_md}`);
}
