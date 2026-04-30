// Pull every recovery / cycle / sleep record from WHOOP for a user and
// upsert into daily_logs. Manual fields are preserved.
//
// Usage:
//   node scripts/backfill-whoop.mjs            # default: 2 years back
//   SINCE=2022-01-01 node scripts/backfill-whoop.mjs
//   SEED_USER_EMAIL=other@example.com node scripts/backfill-whoop.mjs

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const clientId = process.env.WHOOP_CLIENT_ID;
const clientSecret = process.env.WHOOP_CLIENT_SECRET;
const userEmail = process.env.SEED_USER_EMAIL || "abdelouahed.elbied@icloud.com";
const sinceArg = process.env.SINCE;

if (!url || !key || !clientId || !clientSecret) {
  console.error(
    "Missing env: need NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET",
  );
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const WHOOP_API_BASE = "https://api.prod.whoop.com/developer";

// ── Find user ────────────────────────────────────────────────────────────────
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
console.log(`Backfilling for user ${userEmail} (${userId})`);

// ── Load + refresh WHOOP tokens ─────────────────────────────────────────────
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

let accessToken = tokenRow.access_token;
const expiresAt = new Date(tokenRow.expires_at).getTime();
if (Date.now() >= expiresAt - 60_000) {
  console.log("Access token expired or near-expiry — refreshing.");
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

// ── Pagination helper ───────────────────────────────────────────────────────
async function whoopGetAll(basePath, sinceIso, maxPages = 200) {
  const out = [];
  let nextToken;
  for (let i = 0; i < maxPages; i++) {
    const qs = new URLSearchParams({ start: sinceIso, limit: "25" });
    if (nextToken) qs.set("nextToken", nextToken);
    const path = `${basePath}?${qs}`;
    const r = await fetch(`${WHOOP_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) {
      throw new Error(`WHOOP GET ${path} failed: ${r.status} ${await r.text()}`);
    }
    const page = await r.json();
    out.push(...(page.records ?? []));
    nextToken = page.next_token;
    process.stdout.write(`.`); // progress dot per page
    if (!nextToken) break;
  }
  process.stdout.write(`\n`);
  return out;
}

const since = sinceArg ? new Date(sinceArg + "T00:00:00Z") : new Date(Date.now() - 730 * 86_400_000);
const sinceIso = since.toISOString();
console.log(`Pulling since ${sinceIso.slice(0, 10)} …`);

console.log("→ /v2/recovery");
const recovery = await whoopGetAll("/v2/recovery", sinceIso);
console.log(`  ${recovery.length} records`);

console.log("→ /v2/cycle");
const cycles = await whoopGetAll("/v2/cycle", sinceIso);
console.log(`  ${cycles.length} records`);

console.log("→ /v2/activity/sleep");
const sleep = await whoopGetAll("/v2/activity/sleep", sinceIso);
console.log(`  ${sleep.length} records`);

// ── Merge by date ───────────────────────────────────────────────────────────
const byDate = new Map();
const ensure = (date) => {
  let row = byDate.get(date);
  if (!row) {
    row = { user_id: userId, date, source: "whoop", updated_at: new Date().toISOString() };
    byDate.set(date, row);
  }
  return row;
};

for (const r of recovery) {
  if (!r.score) continue;
  const date = (r.created_at || "").slice(0, 10);
  if (!date) continue;
  const row = ensure(date);
  row.hrv = r.score.hrv_rmssd_milli ?? null;
  row.resting_hr = r.score.resting_heart_rate ?? null;
  row.recovery = r.score.recovery_score ?? null;
  if (r.score.spo2_percentage != null) row.spo2 = r.score.spo2_percentage;
  if (r.score.skin_temp_celsius != null) row.skin_temp_c = r.score.skin_temp_celsius;
}
for (const c of cycles) {
  if (!c.score) continue;
  const date = (c.start || "").slice(0, 10);
  if (!date) continue;
  const row = ensure(date);
  row.strain = c.score.strain ?? null;
}
for (const s of sleep) {
  if (!s.score) continue;
  const date = (s.end || "").slice(0, 10);
  if (!date) continue;
  const row = ensure(date);
  const stages = s.score.stage_summary;
  if (stages) {
    const inBed = stages.total_in_bed_time_milli - stages.total_awake_time_milli;
    row.sleep_hours = +(inBed / 3_600_000).toFixed(2);
    row.deep_sleep_hours = +(stages.total_slow_wave_sleep_time_milli / 3_600_000).toFixed(2);
    row.rem_sleep_hours = +(stages.total_rem_sleep_time_milli / 3_600_000).toFixed(2);
  }
  if (s.score.sleep_performance_percentage != null) {
    row.sleep_score = s.score.sleep_performance_percentage;
  }
  if (s.score.respiratory_rate != null) {
    row.respiratory_rate = s.score.respiratory_rate;
  }
}

const rows = [...byDate.values()];
console.log(`Merged into ${rows.length} unique days; upserting …`);

const CHUNK = 500;
let done = 0;
for (let i = 0; i < rows.length; i += CHUNK) {
  const chunk = rows.slice(i, i + CHUNK);
  const { error } = await supabase
    .from("daily_logs")
    .upsert(chunk, { onConflict: "user_id,date" });
  if (error) {
    console.error("upsert failed:", error);
    process.exit(1);
  }
  done += chunk.length;
}
console.log(`✓ Upserted ${done} day-rows.`);

// Earliest and latest dates for sanity
const sorted = [...byDate.keys()].sort();
console.log(`  earliest: ${sorted[0]}`);
console.log(`  latest:   ${sorted[sorted.length - 1]}`);
