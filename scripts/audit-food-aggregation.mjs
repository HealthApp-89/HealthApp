#!/usr/bin/env node
// scripts/audit-food-aggregation.mjs
//
// Read-only audit: for any date with committed food_log_entries, verify
// daily_logs nutrition columns equal sum_food_entries(user_id, date).
// Flags drift (e.g. a Yazio write that snuck through after in-app commit,
// or a bug in the commit route's reaggregateDay call).
//
// Run via:
//   AUDIT_USER_ID=<your-uuid> \
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//        --env-file=.env.local scripts/audit-food-aggregation.mjs

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const userId = process.env.AUDIT_USER_ID;
if (!userId) {
  console.error("Set AUDIT_USER_ID env var to your user id");
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const env = {};
for (const line of readFileSync(resolve(repoRoot, ".env.local"), "utf-8").split("\n")) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

const { data: entries, error: entriesError } = await supabase
  .from("food_log_entries")
  .select("eaten_at")
  .eq("user_id", userId)
  .eq("status", "committed");

if (entriesError) {
  console.error("Failed to fetch food_log_entries:", entriesError.message);
  process.exit(1);
}

const dates = new Set((entries ?? []).map((e) => e.eaten_at.slice(0, 10)));
if (dates.size === 0) {
  console.log("✓ No committed food_log_entries — nothing to audit");
  process.exit(0);
}

console.log(`Auditing ${dates.size} date(s) with committed food entries…`);

const fieldMap = {
  kcal: "calories_eaten",
  protein_g: "protein_g",
  carbs_g: "carbs_g",
  fat_g: "fat_g",
  fiber_g: "fiber_g",
};
const tolerance = 0.5;
let drift = 0;

for (const date of [...dates].sort()) {
  const [aggRes, logRes] = await Promise.all([
    supabase.rpc("sum_food_entries", { p_user_id: userId, p_date: date }),
    supabase
      .from("daily_logs")
      .select("calories_eaten, protein_g, carbs_g, fat_g, fiber_g")
      .eq("user_id", userId)
      .eq("date", date)
      .maybeSingle(),
  ]);

  if (aggRes.error) {
    console.warn(`[${date}] sum_food_entries error:`, aggRes.error.message);
    drift++;
    continue;
  }
  if (logRes.error) {
    console.warn(`[${date}] daily_logs read error:`, logRes.error.message);
    drift++;
    continue;
  }

  const expected = aggRes.data ?? {};
  const actual = logRes.data ?? {};
  const driftFields = Object.entries(fieldMap).filter(([fdKey, colName]) => {
    const e = Number(expected[fdKey] ?? 0);
    const a = Number(actual[colName] ?? 0);
    return Math.abs(a - e) > tolerance;
  });

  if (driftFields.length > 0) {
    drift++;
    console.warn(`[DRIFT] ${date} fields: ${driftFields.map(([k]) => k).join(",")}`);
    console.warn(`  expected:`, expected);
    console.warn(`  actual:`, actual);
  }
}

if (drift === 0) {
  console.log(`✓ ${dates.size} date(s) audited, no drift`);
  process.exit(0);
} else {
  console.log(`✗ ${drift}/${dates.size} date(s) drifted — see warnings above`);
  process.exit(1);
}
