// scripts/audit-strain-2026.mjs
//
// Read-only audit: compare daily_logs.strain against WHOOP-app ground truth
// (transcribed from in-app "Day Strain" screenshots) for 2026-04-01 → 2026-05-12.
// Reports rows where DB-strain rounded to 1 dp differs from the app value.
//
// Usage: node scripts/audit-strain-2026.mjs [--fix]
//   default = read-only, prints diff
//   --fix   = update mismatched rows (source='whoop_manual_audit', updated_at=now)

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// Load .env.local manually
try {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

// WHOOP-app Day Strain values, transcribed from screenshots.
const GROUND_TRUTH = {
  "2026-04-01":  8.8,
  "2026-04-02": 14.8,
  "2026-04-03":  3.3,
  "2026-04-04":  2.9,
  "2026-04-05":  2.7,
  "2026-04-06":  5.3,
  "2026-04-07":  1.7,
  "2026-04-08":  4.0,
  "2026-04-09":  0.9,
  "2026-04-10":  2.3,
  "2026-04-11":  1.4,
  "2026-04-12":  2.6,
  "2026-04-13": 11.3,
  "2026-04-14": 12.8,
  "2026-04-15": 14.3,
  "2026-04-16": 10.1,
  "2026-04-17":  4.1,
  "2026-04-18":  1.7,
  "2026-04-19":  1.2,
  "2026-04-20": 11.5,
  "2026-04-21": 13.6,
  "2026-04-22":  6.3,
  "2026-04-23": 13.6,
  "2026-04-24": 14.4,
  "2026-04-25":  1.5,
  "2026-04-26":  4.7,
  "2026-04-27": 11.5,
  "2026-04-28": 14.1,
  "2026-04-29":  4.1,
  "2026-04-30": 13.8,
  "2026-05-01":  4.1,
  "2026-05-02":  4.2,
  "2026-05-03":  3.7,
  "2026-05-04": 12.9,
  "2026-05-05": 12.9,
  "2026-05-06":  4.5,
  "2026-05-07": 14.4,
  "2026-05-08": 13.9,
  "2026-05-09":  4.2,
  "2026-05-10":  4.0,
  "2026-05-11": 15.9,
  "2026-05-12": 13.1,
};

const FROM = "2026-04-01";
const TO   = "2026-05-12";
const SHOULD_FIX = process.argv.includes("--fix");

// Resolve the user id (single-user app, but be safe).
const { data: profiles, error: profErr } = await sb
  .from("profiles")
  .select("user_id, name")
  .limit(2);
if (profErr) { console.error(profErr); process.exit(1); }
if (!profiles || profiles.length === 0) { console.error("No profiles row found."); process.exit(1); }
if (profiles.length > 1) {
  console.error("Multiple profiles found — refusing to guess. Found:", profiles.map(p => p.user_id));
  process.exit(1);
}
const userId = profiles[0].user_id;
console.log(`User: ${profiles[0].name ?? "(no name)"} (${userId})\n`);

const { data: rows, error } = await sb
  .from("daily_logs")
  .select("date, strain, source, updated_at")
  .eq("user_id", userId)
  .gte("date", FROM)
  .lte("date", TO)
  .order("date", { ascending: true });
if (error) { console.error(error); process.exit(1); }

const byDate = new Map(rows.map((r) => [r.date, r]));

const round1 = (n) => Math.round(n * 10) / 10;
const fmt = (n) => (n == null ? "—" : round1(n).toFixed(1));

const diffs = [];
const missing = [];
for (const date of Object.keys(GROUND_TRUTH).sort()) {
  const expected = GROUND_TRUTH[date];
  const row = byDate.get(date);
  if (!row) { missing.push(date); continue; }
  const dbVal = row.strain == null ? null : round1(row.strain);
  if (dbVal !== expected) {
    diffs.push({ date, expected, dbVal, raw: row.strain, source: row.source, updated_at: row.updated_at });
  }
}

console.log(`Window: ${FROM} → ${TO}  (${Object.keys(GROUND_TRUTH).length} days expected)`);
console.log(`DB rows in window: ${rows.length}`);
console.log(`Missing rows:      ${missing.length}`);
console.log(`Mismatches:        ${diffs.length}\n`);

if (missing.length) {
  console.log("MISSING (no daily_logs row at all):");
  for (const d of missing) console.log(`  ${d}  expected ${GROUND_TRUTH[d].toFixed(1)}`);
  console.log();
}

if (diffs.length) {
  console.log("MISMATCHES (db strain rounded to 1 dp ≠ WHOOP-app value):");
  console.log("  DATE        | WHOOP | DB     | RAW          | SOURCE  | UPDATED");
  console.log("  ------------+-------+--------+--------------+---------+-----------------------");
  for (const d of diffs) {
    console.log(
      `  ${d.date}  | ${d.expected.toFixed(1).padStart(5)} | ${fmt(d.dbVal).padStart(6)} | ${
        d.raw == null ? "null" : String(d.raw).slice(0, 12)
      }`.padEnd(56) +
      ` | ${(d.source ?? "—").padEnd(7)} | ${d.updated_at}`,
    );
  }
  console.log();
}

if (!diffs.length && !missing.length) {
  console.log("✅ All days match. No corrections needed.");
}

if (SHOULD_FIX && diffs.length) {
  console.log("\n--fix passed → applying corrections...");
  for (const d of diffs) {
    const { error: upErr } = await sb
      .from("daily_logs")
      .update({
        strain: d.expected,
        source: "whoop_manual_audit",
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .eq("date", d.date);
    if (upErr) { console.error(`  ${d.date}: FAILED`, upErr); continue; }
    console.log(`  ${d.date}: ${d.dbVal ?? "null"} → ${d.expected.toFixed(1)}`);
  }
  console.log("\nDone. Re-run without --fix to verify.");
}
