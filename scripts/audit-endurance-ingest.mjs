#!/usr/bin/env node
// scripts/audit-endurance-ingest.mjs
//
// Read-only audit: for every date in the last 30 days that has any
// endurance_activities row, verify daily_logs.{endurance_load,
// endurance_minutes, endurance_z2_minutes} equals the output of
// sum_endurance_for_day(user_id, date). Drift here means a Strava webhook
// fired but the daily_logs upsert at the end of lib/strava/ingest.ts was
// skipped or stale — the same bug class the food-aggregation audit catches.
//
// Run via:
//   AUDIT_USER_ID=<your-uuid> \
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//        --env-file=.env.local scripts/audit-endurance-ingest.mjs

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

const today = new Date();
const d30 = new Date(today.getTime() - 30 * 86400000);
const fmt = (d) => d.toISOString().slice(0, 10);

const { data: acts, error: aErr } = await supabase
  .from("endurance_activities")
  .select("local_date")
  .eq("user_id", userId)
  .is("deleted_at", null)
  .gte("local_date", fmt(d30))
  .lte("local_date", fmt(today));
if (aErr) {
  console.error("Failed to fetch endurance_activities:", aErr.message);
  process.exit(1);
}

const dates = [...new Set((acts ?? []).map((r) => r.local_date))].sort();
if (dates.length === 0) {
  console.log("✓ No endurance_activities in last 30d — nothing to audit");
  process.exit(0);
}

console.log(`Auditing ${dates.length} date(s) with endurance activities…`);

let drift = 0;
for (const date of dates) {
  const [rpcRes, logRes] = await Promise.all([
    supabase.rpc("sum_endurance_for_day", { p_user_id: userId, p_date: date }),
    supabase
      .from("daily_logs")
      .select("endurance_load, endurance_minutes, endurance_z2_minutes")
      .eq("user_id", userId)
      .eq("date", date)
      .maybeSingle(),
  ]);

  if (rpcRes.error) {
    console.warn(`[${date}] sum_endurance_for_day error:`, rpcRes.error.message);
    drift++;
    continue;
  }
  if (logRes.error) {
    console.warn(`[${date}] daily_logs read error:`, logRes.error.message);
    drift++;
    continue;
  }

  const rpc = Array.isArray(rpcRes.data) ? rpcRes.data[0] : rpcRes.data;
  const dailyRow = logRes.data;

  const dlLoad = Number(dailyRow?.endurance_load ?? 0);
  const dlMin = Number(dailyRow?.endurance_minutes ?? 0);
  const dlZ2 = Number(dailyRow?.endurance_z2_minutes ?? 0);
  const rpcLoad = Number(rpc?.tss_sum ?? 0);
  const rpcMin = Number(rpc?.duration_minutes_sum ?? 0);
  const rpcZ2 = Number(rpc?.z2_minutes_sum ?? 0);

  // tss can be null on activities without HR — sum_endurance_for_day
  // coalesces to 0, the daily_logs upsert writes 0 too, so exact match
  // (no tolerance) is correct here.
  const ok = dlLoad === rpcLoad && dlMin === rpcMin && dlZ2 === rpcZ2;
  if (!ok) {
    drift++;
    console.log(
      `DRIFT ${date}: daily_logs={load:${dlLoad}, min:${dlMin}, z2:${dlZ2}} ` +
        `rpc={load:${rpcLoad}, min:${rpcMin}, z2:${rpcZ2}}`,
    );
  }
}

console.log(`\n${dates.length - drift} aligned, ${drift} drifted.`);
if (drift > 0) process.exit(1);
