// scripts/backfill-garmin-activities.mjs
//
// Loads the JSON produced by sidecar/garmin/backfill_activities.py and upserts
// garmin_activities. Idempotent on (user_id, external_id). Read-only against
// Garmin; the only writes are to this one table.
//
//   AUDIT_USER_ID=<uuid> DUMP_PATH=/tmp/acts.json \
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//        --env-file=.env.local scripts/backfill-garmin-activities.mjs --yes

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { resolveHrSource, toHrSamples } from "@/lib/coach/strain/activity-load";
import { banisterOverIntervals, medianGapSeconds } from "@/lib/coach/strain/trimp";

const userId = process.env.AUDIT_USER_ID;
if (!userId) throw new Error("AUDIT_USER_ID is required");
const dump = JSON.parse(readFileSync(process.env.DUMP_PATH, "utf8"));

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Both reads fail LOUDLY. Silently falling through to hrMax=190 / rhr=50 is
// how a run reports success while having used the wrong constants throughout —
// it already happened once: a report claimed age was unset and 190 was used,
// when age was 36 and 183 was used correctly. Nobody could tell either way,
// because the script printed neither.
const { data: profile, error: profileErr } = await sb
  .from("profiles").select("age").eq("user_id", userId).maybeSingle();
if (profileErr) throw profileErr;
if (!profile) throw new Error(`no profiles row for ${userId} — wrong AUDIT_USER_ID or wrong environment`);
const hrMax = profile.age ? Math.round(208 - 0.7 * profile.age) : 190;

const { data: logs, error: logsErr } = await sb
  .from("daily_logs")
  .select("date, resting_hr")
  .eq("user_id", userId);
if (logsErr) throw logsErr;
const rhrBy = new Map((logs ?? []).map((r) => [r.date, r.resting_hr ?? 50]));

console.log(
  `hrMax=${hrMax} (age=${profile.age ?? "unset"}), ` +
    `resting_hr known for ${rhrBy.size} days`,
);

const rows = dump.map((a) => {
  const samples = toHrSamples(a.hr_samples ?? null);
  return {
    user_id: userId,
    external_id: a.external_id,
    local_date: a.local_date,
    activity_type: a.activity_type ?? null,
    started_at: a.started_at,
    duration_s: Math.round(a.duration_s ?? 0),
    avg_hr: a.avg_hr ?? null,
    max_hr: a.max_hr ?? null,
    device_id: a.device_id ?? null,
    hr_source: resolveHrSource(a.device_id ?? null),
    hr_sample_count: samples.length,
    hr_median_gap_s: medianGapSeconds(samples),
    zone_seconds: a.zone_seconds ?? null,
    garmin_load: a.garmin_load ?? null,
    aerobic_te: a.aerobic_te ?? null,
    anaerobic_te: a.anaerobic_te ?? null,
    body_battery_diff: a.body_battery_diff ?? null,
    trimp: banisterOverIntervals(samples, rhrBy.get(a.local_date) ?? 50, hrMax),
    hr_samples: a.hr_samples ?? null,
    updated_at: new Date().toISOString(),
  };
});

const defaulted = rows.filter((r) => !rhrBy.has(r.local_date)).length;
console.log(`${rows.length} activities to upsert; ${defaulted} on days with no resting_hr (using 50)`);
const byMonth = {};
for (const r of rows) byMonth[r.local_date.slice(0, 7)] = (byMonth[r.local_date.slice(0, 7)] ?? 0) + 1;
console.table(byMonth);

if (!process.argv.includes("--yes")) {
  console.log("dry run — pass --yes to write");
  process.exit(0);
}

for (let i = 0; i < rows.length; i += 25) {
  const chunk = rows.slice(i, i + 25);
  const { error } = await sb.from("garmin_activities").upsert(chunk, { onConflict: "user_id,external_id" });
  if (error) throw error;
  console.log(`upserted ${i + chunk.length}/${rows.length}`);
}
console.log("done");
