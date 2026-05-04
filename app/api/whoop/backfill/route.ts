import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import {
  getValidAccessToken,
  whoopGetAll,
  type WhoopRecovery,
  type WhoopCycle,
  type WhoopSleep,
} from "@/lib/whoop";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type DayRow = {
  user_id: string;
  date: string;
  hrv?: number | null;
  resting_hr?: number | null;
  recovery?: number | null;
  spo2?: number | null;
  skin_temp_c?: number | null;
  respiratory_rate?: number | null;
  strain?: number | null;
  sleep_hours?: number | null;
  sleep_score?: number | null;
  deep_sleep_hours?: number | null;
  rem_sleep_hours?: number | null;
  source: string;
  updated_at: string;
};

/** POST /api/whoop/backfill?since=YYYY-MM-DD
 *  Pulls every recovery / cycle / sleep record from WHOOP between `since` and now,
 *  upserts them into daily_logs. Default since = 2 years ago. Manual fields
 *  (notes, weight_kg, steps, calories, body_fat_pct) are NOT touched. */
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const sinceParam = url.searchParams.get("since");
  const since = sinceParam
    ? new Date(sinceParam + "T00:00:00Z")
    : new Date(Date.now() - 730 * 86_400_000);
  const sinceIso = since.toISOString();

  const accessToken = await getValidAccessToken(user.id);
  if (!accessToken) {
    return NextResponse.json({ ok: false, reason: "no_tokens" }, { status: 400 });
  }

  let recovery: WhoopRecovery[] = [];
  let cycles: WhoopCycle[] = [];
  let sleep: WhoopSleep[] = [];
  try {
    [recovery, cycles, sleep] = await Promise.all([
      whoopGetAll<WhoopRecovery>(accessToken, "/v2/recovery", { start: sinceIso }),
      whoopGetAll<WhoopCycle>(accessToken, "/v2/cycle", { start: sinceIso }),
      whoopGetAll<WhoopSleep>(accessToken, "/v2/activity/sleep", { start: sinceIso }),
    ]);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }

  const byDate = new Map<string, DayRow>();
  const ensure = (date: string): DayRow => {
    let row = byDate.get(date);
    if (!row) {
      row = { user_id: user.id, date, source: "whoop", updated_at: new Date().toISOString() };
      byDate.set(date, row);
    }
    return row;
  };

  // Build a sleep_id → wake-up date index so recovery lands on the day it's
  // actually about, not the day WHOOP happened to write the record.
  const sleepIdToDate = new Map<string, string>();
  for (const s of sleep) sleepIdToDate.set(s.id, s.end.slice(0, 10));

  for (const r of recovery) {
    if (!r.score) continue;
    const date = sleepIdToDate.get(r.sleep_id) ?? r.created_at.slice(0, 10);
    const row = ensure(date);
    row.hrv = r.score.hrv_rmssd_milli;
    row.resting_hr = r.score.resting_heart_rate;
    row.recovery = r.score.recovery_score;
    row.spo2 = r.score.spo2_percentage ?? null;
    row.skin_temp_c = r.score.skin_temp_celsius ?? null;
  }
  for (const c of cycles) {
    if (!c.score) continue;
    const date = c.start.slice(0, 10);
    const row = ensure(date);
    row.strain = c.score.strain;
  }
  for (const s of sleep) {
    if (!s.score) continue;
    const date = s.end.slice(0, 10);
    const row = ensure(date);
    const stages = s.score.stage_summary;
    if (stages) {
      // "Asleep" excludes both `awake` AND `no_data` (sensor-gap) windows —
      // earlier code subtracted only awake, silently inflating the total.
      const asleepMs =
        stages.total_light_sleep_time_milli +
        stages.total_slow_wave_sleep_time_milli +
        stages.total_rem_sleep_time_milli;
      row.sleep_hours = +(asleepMs / 3_600_000).toFixed(2);
      row.deep_sleep_hours = +(stages.total_slow_wave_sleep_time_milli / 3_600_000).toFixed(2);
      row.rem_sleep_hours = +(stages.total_rem_sleep_time_milli / 3_600_000).toFixed(2);
    }
    if (s.score.sleep_performance_percentage != null)
      row.sleep_score = s.score.sleep_performance_percentage;
    if ((s.score as { respiratory_rate?: number }).respiratory_rate != null) {
      row.respiratory_rate = (s.score as { respiratory_rate?: number }).respiratory_rate ?? null;
    }
  }

  if (byDate.size === 0) {
    return NextResponse.json({
      ok: true,
      upserted: 0,
      counts: { recovery: recovery.length, cycles: cycles.length, sleep: sleep.length },
    });
  }

  // Use service-role for the upsert to keep this fast and predictable
  const sr = createSupabaseServiceRoleClient();
  const rows = [...byDate.values()];
  const CHUNK = 500;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await sr.from("daily_logs").upsert(chunk, { onConflict: "user_id,date" });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    upserted += chunk.length;
  }

  return NextResponse.json({
    ok: true,
    since: sinceIso.slice(0, 10),
    upserted,
    counts: { recovery: recovery.length, cycles: cycles.length, sleep: sleep.length },
  });
}
