// scripts/archive-whoop-daily.mts
// Read-only: dumps the current daily_logs recovery columns (WHOOP-written) for
// the last N days to a timestamped JSON, so the Task-10 Garmin backfill can
// overwrite them without silent data loss. Run BEFORE flipping metrics_source.
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { writeFileSync } from "node:fs";

const userId = process.env.AUDIT_USER_ID;
if (!userId) { console.error("set AUDIT_USER_ID"); process.exit(1); }
const days = Number(process.env.ARCHIVE_DAYS ?? "35");

const sr = createSupabaseServiceRoleClient();
const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
const { data, error } = await sr
  .from("daily_logs")
  .select("date,source,hrv,resting_hr,recovery,sleep_hours,sleep_score,deep_sleep_hours,rem_sleep_hours,respiratory_rate,spo2,skin_temp_c")
  .eq("user_id", userId).gte("date", since).order("date");
if (error) throw error;

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const path = `docs/superpowers/whoop-daily-archive-${stamp}.json`;
writeFileSync(path, JSON.stringify({ user_id: userId, since, rows: data }, null, 2));
console.log(`archived ${data?.length ?? 0} rows → ${path}`);
