// scripts/rekey-whoop.mts
//
// One-shot WHOOP re-key. Re-fetches recovery/cycle/sleep records from WHOOP,
// clears WHOOP-owned columns in daily_logs over the window, then upserts the
// freshly-built rows. Prints a date-level diff so you can see whether the bug
// actually moved any rows.
//
// Run from the repo root:
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/rekey-whoop.mts
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/rekey-whoop.mts --since 2026-04-05
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/rekey-whoop.mts --since 2026-04-05 --yes
//
// The alias-loader.mjs resolves "@/" path aliases (from tsconfig.json) at
// Node runtime, so that lib/*.ts files imported by this script work correctly.
//
// Required env (from .env.local):
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET
// Optional:
//   USER_TIMEZONE (default Asia/Dubai), SEED_USER_EMAIL (default abdelouahed.elbied@icloud.com)

import { createClient } from "@supabase/supabase-js";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { buildWhoopDayRows } from "../lib/whoop-day-rows.ts";
import type { WhoopRecovery, WhoopCycle, WhoopSleep } from "../lib/whoop.ts";
import { todayInUserTz } from "../lib/time.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const clientId = process.env.WHOOP_CLIENT_ID;
const clientSecret = process.env.WHOOP_CLIENT_SECRET;
const userEmail = process.env.SEED_USER_EMAIL || "abdelouahed.elbied@icloud.com";

if (!url || !key || !clientId || !clientSecret) {
  console.error(
    "Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET",
  );
  process.exit(1);
}

// ── CLI args ─────────────────────────────────────────────────────────────────
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

// ── Resolve user ─────────────────────────────────────────────────────────────
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

// ── Refresh WHOOP token ──────────────────────────────────────────────────────
const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const WHOOP_API_BASE = "https://api.prod.whoop.com/developer";

const { data: tokenRow, error: terr } = await supabase
  .from("whoop_tokens")
  .select("*")
  .eq("user_id", userId)
  .maybeSingle();
if (terr) throw terr;
if (!tokenRow) {
  console.error("No whoop_tokens row for this user. Connect WHOOP first.");
  process.exit(1);
}

let accessToken: string = tokenRow.access_token;
const expiresAt = new Date(tokenRow.expires_at).getTime();
if (Date.now() >= expiresAt - 60_000) {
  console.log("Access token near-expiry — refreshing.");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokenRow.refresh_token,
    client_id: clientId,
    client_secret: clientSecret,
    scope: "read:recovery read:sleep read:cycles read:workout read:profile offline",
  });
  const r = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    console.error(`Refresh failed: ${r.status} ${await r.text()}`);
    process.exit(1);
  }
  const refreshed = await r.json();
  accessToken = refreshed.access_token;
  const newExpires = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  const { error: serr } = await supabase
    .from("whoop_tokens")
    .update({
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at: newExpires,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
  if (serr) throw serr;
}

// ── Pagination ───────────────────────────────────────────────────────────────
async function whoopGetAll<T>(basePath: string, sinceIso: string): Promise<T[]> {
  const out: T[] = [];
  let nextToken: string | undefined;
  for (let i = 0; i < 200; i++) {
    const qs = new URLSearchParams({ start: sinceIso, limit: "25" });
    if (nextToken) qs.set("nextToken", nextToken);
    const r = await fetch(`${WHOOP_API_BASE}${basePath}?${qs}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) {
      throw new Error(`WHOOP GET ${basePath} failed: ${r.status} ${await r.text()}`);
    }
    const page = (await r.json()) as { records: T[]; next_token?: string };
    out.push(...(page.records ?? []));
    nextToken = page.next_token;
    if (!nextToken) break;
  }
  return out;
}

// ── Re-fetch BEFORE clearing (abort on error) ────────────────────────────────
const sinceIso = `${since}T00:00:00.000Z`;
console.log(`Window: ${since} → ${today}  (user: ${userEmail})`);
console.log("Re-fetching from WHOOP …");

let recovery: WhoopRecovery[];
let cycles: WhoopCycle[];
let sleep: WhoopSleep[];
try {
  [recovery, cycles, sleep] = await Promise.all([
    whoopGetAll<WhoopRecovery>("/v2/recovery", sinceIso),
    whoopGetAll<WhoopCycle>("/v2/cycle", sinceIso),
    whoopGetAll<WhoopSleep>("/v2/activity/sleep", sinceIso),
  ]);
} catch (e) {
  console.error(`WHOOP fetch failed; aborting before clear. ${String(e)}`);
  process.exit(1);
}
console.log(`  recovery: ${recovery.length}, cycles: ${cycles.length}, sleep: ${sleep.length}`);

const rows = buildWhoopDayRows(userId, recovery, cycles, sleep);
console.log(`  builder produced ${rows.length} day-rows`);

// ── Snapshot before-state ────────────────────────────────────────────────────
const SNAPSHOT_COLS =
  "date, hrv, resting_hr, recovery, sleep_hours, sleep_score, " +
  "deep_sleep_hours, rem_sleep_hours, strain, spo2, skin_temp_c, respiratory_rate";

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
  ([, cols]) => cols.hrv !== null || cols.strain !== null || cols.recovery !== null,
).length;
console.log(`Rows in window with WHOOP data: ${beforeWithData}`);

// ── Confirm prompt ───────────────────────────────────────────────────────────
if (!skipPrompt) {
  console.log("\nAbout to clear + repopulate the following columns:");
  console.log("  hrv, resting_hr, recovery, sleep_hours, sleep_score,");
  console.log("  deep_sleep_hours, rem_sleep_hours, strain, spo2, skin_temp_c, respiratory_rate");
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question("Proceed? [y/N] ")).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") {
    console.log("Aborted.");
    process.exit(0);
  }
}

// ── Clear WHOOP-owned columns ────────────────────────────────────────────────
console.log("Clearing WHOOP-owned columns …");
const { error: clearErr } = await supabase
  .from("daily_logs")
  .update({
    hrv: null,
    resting_hr: null,
    recovery: null,
    sleep_hours: null,
    sleep_score: null,
    deep_sleep_hours: null,
    rem_sleep_hours: null,
    strain: null,
    spo2: null,
    skin_temp_c: null,
    respiratory_rate: null,
    updated_at: new Date().toISOString(),
  })
  .eq("user_id", userId)
  .gte("date", since)
  .lte("date", today);
if (clearErr) {
  console.error(`Clear failed: ${clearErr.message}`);
  process.exit(1);
}

// ── Upsert freshly-keyed rows ────────────────────────────────────────────────
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
