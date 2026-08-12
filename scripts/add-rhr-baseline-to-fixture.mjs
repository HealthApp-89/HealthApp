// Adds a `resting_hr_baseline` field to each fixture day, computed from the
// 90-day rolling window of daily_logs.resting_hr (a column Task 16 did NOT
// touch). Every existing field, including whoop_strain, is copied through
// unchanged — this file is the only surviving copy of those labels and must
// never be regenerated from the database.
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { restingBaseline, RESTING_BASELINE_DAYS } from "@/lib/coach/strain/resting-baseline";

const PATH = "scripts/fixtures/strain-calibration-2026.json";
const userId = process.env.AUDIT_USER_ID;
if (!userId) throw new Error("AUDIT_USER_ID is required");

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const fixture = JSON.parse(readFileSync(PATH, "utf8"));

const { data: logs, error } = await sb
  .from("daily_logs").select("date, resting_hr").eq("user_id", userId).order("date");
if (error) throw error;

let added = 0;
for (const day of fixture) {
  const start = new Date(Date.parse(`${day.date}T00:00:00Z`) - RESTING_BASELINE_DAYS * 86_400_000)
    .toISOString().slice(0, 10);
  const vals = logs.filter((r) => r.date >= start && r.date <= day.date).map((r) => r.resting_hr);
  day.resting_hr_baseline = restingBaseline(vals, day.resting_hr);
  added++;
}

const labels = fixture.filter((d) => typeof d.whoop_strain === "number").length;
if (labels !== fixture.length) throw new Error(`label loss: ${labels}/${fixture.length}`);
console.log(`added resting_hr_baseline to ${added} days; ${labels} labels intact`);
writeFileSync(PATH, JSON.stringify(fixture));
