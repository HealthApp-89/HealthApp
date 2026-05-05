// scripts/rekey-withings.mts
//
// One-shot Withings re-key for body-comp measurements. Re-fetches measure
// groups from Withings, clears Withings body-comp columns in daily_logs over
// the window, then upserts freshly-keyed rows. Prints a date-level diff.
//
// NOTE: `exercise_min` is intentionally NOT touched. WithingsActivity.date
// already arrives as YYYY-MM-DD from the API (never UTC-sliced), so it was
// never a bug site. Apple Health also writes that column; clearing would
// silently destroy data.
//
// Run from the repo root (must include the alias-loader for @/ imports):
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/rekey-withings.mts
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/rekey-withings.mts --since 2026-04-05 --yes
//
// Required env (from .env.local):
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   WITHINGS_CLIENT_ID, WITHINGS_CLIENT_SECRET

import { createClient } from "@supabase/supabase-js";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { mergeWithingsToRows } from "../lib/withings-merge.ts";
import { getMeasures, getValidAccessToken } from "../lib/withings.ts";
import { todayInUserTz } from "../lib/time.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const userEmail = process.env.SEED_USER_EMAIL || "abdelouahed.elbied@icloud.com";

if (!url || !key) {
  console.error("Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const args = process.argv.slice(2);
let sinceArg: string | null = null;
let skipPrompt = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--since" && args[i + 1]) {
    sinceArg = args[i + 1];
    i++;
  } else if (args[i] === "--yes") {
    skipPrompt = true;
  }
}

const today = todayInUserTz();
const since = sinceArg ?? (() => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString().slice(0, 10);
})();

if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error(`Invalid --since: ${since} (expected YYYY-MM-DD)`);
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

const { data: usersList, error: lerr } = await supabase.auth.admin.listUsers({
  page: 1,
  perPage: 200,
});
if (lerr) throw lerr;
const user = usersList.users.find((u) => u.email?.toLowerCase() === userEmail.toLowerCase());
if (!user) {
  console.error(`No auth user found with email ${userEmail}`);
  process.exit(1);
}
const userId = user.id;

// ── Withings token (uses lib/withings.ts which handles refresh) ──────────────
const accessToken = await getValidAccessToken(userId);
if (!accessToken) {
  console.error("No Withings tokens for this user. Connect Withings first.");
  process.exit(1);
}

// ── Re-fetch BEFORE clearing ─────────────────────────────────────────────────
const startEpoch = Math.floor(new Date(`${since}T00:00:00Z`).getTime() / 1000);
const endEpoch = Math.floor(Date.now() / 1000);

console.log(`Window: ${since} → ${today}  (user: ${userEmail})`);
console.log("Re-fetching Withings measurements …");

let measureGroups;
try {
  measureGroups = await getMeasures(accessToken, startEpoch, endEpoch);
} catch (e) {
  console.error(`Withings fetch failed; aborting before clear. ${String(e)}`);
  process.exit(1);
}
console.log(`  measurement groups: ${measureGroups.length}`);

// Build rows using only measurements (skip activity — exercise_min isn't in scope).
const byDate = mergeWithingsToRows(userId, measureGroups, []);
const rows = Array.from(byDate.values());
console.log(`  builder produced ${rows.length} day-rows`);

// ── Snapshot before ──────────────────────────────────────────────────────────
const SNAPSHOT_COLS =
  "date, weight_kg, body_fat_pct, fat_mass_kg, fat_free_mass_kg, " +
  "muscle_mass_kg, bone_mass_kg, hydration_kg";

type Snapshot = Record<string, Record<string, number | null>>;
async function snapshotWindow(): Promise<Snapshot> {
  const { data, error } = await supabase
    .from("daily_logs")
    .select(SNAPSHOT_COLS)
    .eq("user_id", userId)
    .gte("date", since)
    .lte("date", today);
  if (error) throw error;
  const out: Snapshot = {};
  for (const row of data ?? []) {
    const { date, ...cols } = row as { date: string; [k: string]: number | null };
    out[date] = cols;
  }
  return out;
}

const before = await snapshotWindow();
const beforeWithData = Object.entries(before).filter(
  ([, cols]) => cols.weight_kg !== null || cols.body_fat_pct !== null,
).length;
console.log(`Rows in window with Withings body-comp data: ${beforeWithData}`);

// ── Confirm prompt ───────────────────────────────────────────────────────────
if (!skipPrompt) {
  console.log("\nAbout to clear + repopulate the following columns:");
  console.log("  weight_kg, body_fat_pct, fat_mass_kg, fat_free_mass_kg,");
  console.log("  muscle_mass_kg, bone_mass_kg, hydration_kg");
  console.log("(exercise_min is NOT touched — see header comment.)");
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question("Proceed? [y/N] ")).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") {
    console.log("Aborted.");
    process.exit(0);
  }
}

// ── Clear ────────────────────────────────────────────────────────────────────
console.log("Clearing Withings body-comp columns …");
const { error: clearErr } = await supabase
  .from("daily_logs")
  .update({
    weight_kg: null,
    body_fat_pct: null,
    fat_mass_kg: null,
    fat_free_mass_kg: null,
    muscle_mass_kg: null,
    bone_mass_kg: null,
    hydration_kg: null,
    updated_at: new Date().toISOString(),
  })
  .eq("user_id", userId)
  .gte("date", since)
  .lte("date", today);
if (clearErr) {
  console.error(`Clear failed: ${clearErr.message}`);
  process.exit(1);
}

// ── Upsert ───────────────────────────────────────────────────────────────────
console.log("Upserting rebuilt rows …");
const CHUNK = 500;
let upserted = 0;
for (let i = 0; i < rows.length; i += CHUNK) {
  const chunk = rows.slice(i, i + CHUNK);
  const { error } = await supabase
    .from("daily_logs")
    .upsert(chunk, { onConflict: "user_id,date" });
  if (error) {
    console.error(`Upsert chunk failed: ${error.message}`);
    console.error("Cleared columns are NOT repopulated. To recover, re-run this script.");
    process.exit(1);
  }
  upserted += chunk.length;
}

// ── Diff ─────────────────────────────────────────────────────────────────────
const after = await snapshotWindow();
const allDates = new Set([...Object.keys(before), ...Object.keys(after)]);
let changed = 0;
const lines: string[] = [];
for (const d of [...allDates].sort()) {
  const b = before[d];
  const a = after[d];
  if (JSON.stringify(b) === JSON.stringify(a)) continue;
  changed += 1;
  if (!b || Object.values(b).every((v) => v === null)) {
    lines.push(`  ${d}  repopulated`);
  } else if (!a || Object.values(a).every((v) => v === null)) {
    lines.push(`  ${d}  cleared (data may have moved to another date in window)`);
  } else {
    const fields: string[] = [];
    for (const k of Object.keys(b)) {
      if (b[k] !== a[k]) fields.push(`${k}: ${b[k]} → ${a[k]}`);
    }
    lines.push(`  ${d}  mutated (${fields.slice(0, 3).join(", ")}${fields.length > 3 ? ", …" : ""})`);
  }
}

console.log("\nRekey complete:");
console.log(`  window:                    ${since} → ${today}`);
console.log(`  rows upserted:             ${upserted}`);
console.log(`  dates with changed values: ${changed}`);
for (const l of lines) console.log(l);
if (changed === 0) {
  console.log("\nThe bug never bit your data in this window — the rekey was a no-op.");
}
