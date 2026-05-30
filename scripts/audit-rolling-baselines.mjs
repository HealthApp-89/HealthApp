// scripts/audit-rolling-baselines.mjs
//
// Read-only audit of profiles.whoop_baselines.rolling_30d. Verifies:
//   1. rolling_30d exists and has all 5 metric keys.
//   2. Each metric's days field matches a fresh re-query of the 30d window.
//   3. Each metric's mean matches a fresh arithmetic mean.
//   4. computed_at is within the last 26 hours (cron is running).
//   5. Status assignment is consistent with days (establishing/partial/stable).
//   6. SD matches a fresh population stddev.
//
// Run via:
//   AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs \
//     --experimental-strip-types --env-file=.env.local \
//     scripts/audit-rolling-baselines.mjs

import { createClient } from "@supabase/supabase-js";

const USER_ID = process.env.AUDIT_USER_ID;
if (!USER_ID) {
  console.error("Set AUDIT_USER_ID=<uuid>");
  process.exit(2);
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const METRICS = [
  { key: "hrv", column: "hrv" },
  { key: "rhr", column: "resting_hr" },
  { key: "recovery", column: "recovery" },
  { key: "sleep_performance", column: "sleep_score" },
  { key: "resp_rate", column: "respiratory_rate" },
];

function approxEqual(a, b, tol = 1e-6) {
  return Math.abs(a - b) <= tol;
}

function statusFor(days) {
  if (days < 14) return "establishing";
  if (days < 30) return "partial";
  return "stable";
}

function meanSd(xs) {
  if (xs.length === 0) return { mean: null, sd: null };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((acc, x) => acc + (x - mean) ** 2, 0) / xs.length;
  return { mean, sd: Math.sqrt(variance) };
}

const failures = [];
function check(label, ok, detail = "") {
  const tag = ok ? "PASS" : "FAIL";
  console.log(`[${tag}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

const { data: profile, error: pErr } = await supabase
  .from("profiles")
  .select("whoop_baselines")
  .eq("user_id", USER_ID)
  .maybeSingle();
if (pErr) {
  console.error("Failed to read profile:", pErr.message);
  process.exit(1);
}
const wb = profile?.whoop_baselines ?? {};
const r = wb.rolling_30d;

check("rolling_30d exists", !!r);
if (!r) {
  console.error("\nNo rolling_30d — run the cron or POST /api/profile/baselines/recalibrate.");
  process.exit(1);
}

// 4. computed_at recency
const computedAt = new Date(r.computed_at);
const ageHours = (Date.now() - computedAt.getTime()) / 3_600_000;
check(`computed_at within 26h`, ageHours < 26, `${ageHours.toFixed(1)}h ago`);

// 1+5. shape + status
for (const { key } of METRICS) {
  const m = r[key];
  check(`metric ${key} present`, !!m);
  if (!m) continue;
  const expectedStatus = statusFor(m.days);
  check(
    `metric ${key} status matches days`,
    m.status === expectedStatus,
    `days=${m.days} got=${m.status} expected=${expectedStatus}`,
  );
}

// 2+3+6. re-query and recompute
const today = new Date().toISOString().slice(0, 10);
const start = (() => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString().slice(0, 10);
})();

const { data: rows, error: dErr } = await supabase
  .from("daily_logs")
  .select(METRICS.map((m) => m.column).join(","))
  .eq("user_id", USER_ID)
  .gte("date", start)
  .lt("date", today);
if (dErr) {
  console.error("Failed to read daily_logs:", dErr.message);
  process.exit(1);
}

for (const { key, column } of METRICS) {
  const m = r[key];
  if (!m) continue;
  const xs = (rows ?? []).map((row) => row[column]).filter((v) => v != null);
  check(`metric ${key} days = ${xs.length}`, m.days === xs.length, `got=${m.days}`);
  if (m.status === "establishing") continue;
  const fresh = meanSd(xs);
  check(
    `metric ${key} mean matches`,
    fresh.mean != null && approxEqual(m.mean, fresh.mean, 1e-3),
    `stored=${m.mean} fresh=${fresh.mean}`,
  );
  check(
    `metric ${key} sd matches`,
    fresh.sd != null && approxEqual(m.sd, fresh.sd, 1e-3),
    `stored=${m.sd} fresh=${fresh.sd}`,
  );
}

console.log(`\n${failures.length === 0 ? "All checks passed." : `${failures.length} failure(s).`}`);
process.exit(failures.length === 0 ? 0 : 1);
