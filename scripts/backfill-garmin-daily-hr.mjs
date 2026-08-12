// scripts/backfill-garmin-daily-hr.mjs
//
// Loads the JSON produced by sidecar/garmin/backfill_activities.py's
// DAILY_HR_DUMP_PATH pass and upserts garmin_daily.raw.hr_samples — the
// all-day native HR stream the strain calibration fixture (Task 14) needs for
// its baseline term. garmin_daily has zero rows before the app's Garmin
// cutover (2026-06-01), so April-May has no rows to touch here.
//
// Writes ONLY garmin_daily, and does so directly against Supabase — NOT via
// /api/ingest/garmin. That route also calls recomputeStrainForDay, which would
// overwrite daily_logs.strain for these exact dates with a Garmin-derived
// number, destroying the WHOOP-labelled values this whole backfill exists to
// preserve. daily_logs is never read or written by this script.
//
//   AUDIT_USER_ID=<uuid> DUMP_PATH=/tmp/daily-hr.json \
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//        --env-file=.env.local scripts/backfill-garmin-daily-hr.mjs --yes

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const userId = process.env.AUDIT_USER_ID;
if (!userId) throw new Error("AUDIT_USER_ID is required");
const dump = JSON.parse(readFileSync(process.env.DUMP_PATH, "utf8"));

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Guard against accidentally clobbering a real ingested day (post-cutover
// rows carry every other Garmin column too — a bare-bones upsert here would
// blow those away). This script is a pre-cutover, HR-only backfill.
const dates = dump.map((d) => d.date);
const { data: existing, error: existingErr } = await sb
  .from("garmin_daily")
  .select("date")
  .eq("user_id", userId)
  .in("date", dates);
if (existingErr) throw existingErr;
if ((existing ?? []).length > 0) {
  throw new Error(
    `${existing.length} garmin_daily row(s) already exist in this range (e.g. ${existing[0].date}) — ` +
      "this script only inserts fresh rows for the pre-cutover HR-only backfill. Investigate before proceeding.",
  );
}

const rows = dump.map((d) => ({
  user_id: userId,
  date: d.date,
  raw: { date: d.date, hr_samples: d.hr_samples ?? [] },
  updated_at: new Date().toISOString(),
}));

const withSamples = rows.filter((r) => (r.raw.hr_samples ?? []).length > 0).length;
console.log(`${rows.length} days to upsert into garmin_daily.raw.hr_samples; ${withSamples} carry samples`);
const byMonth = {};
for (const r of rows) byMonth[r.date.slice(0, 7)] = (byMonth[r.date.slice(0, 7)] ?? 0) + 1;
console.table(byMonth);

if (!process.argv.includes("--yes")) {
  console.log("dry run — pass --yes to write");
  process.exit(0);
}

for (let i = 0; i < rows.length; i += 25) {
  const chunk = rows.slice(i, i + 25);
  const { error } = await sb.from("garmin_daily").upsert(chunk, { onConflict: "user_id,date" });
  if (error) throw error;
  console.log(`upserted ${i + chunk.length}/${rows.length}`);
}
console.log("done");
