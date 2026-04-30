import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import {
  getValidAccessToken,
  whoopGet,
  type WhoopRecovery,
  type WhoopCycle,
  type WhoopSleep,
} from "@/lib/whoop";

const MS_PER_DAY = 86_400_000;

async function syncForUser(userId: string) {
  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) return { ok: false, reason: "no_tokens" };

  const since = new Date(Date.now() - 14 * MS_PER_DAY).toISOString();
  const qs = `?start=${encodeURIComponent(since)}&limit=25`;

  const [recovery, cycles, sleep] = await Promise.all([
    whoopGet<{ records: WhoopRecovery[] }>(accessToken, `/v1/recovery${qs}`),
    whoopGet<{ records: WhoopCycle[] }>(accessToken, `/v1/cycle${qs}`),
    whoopGet<{ records: WhoopSleep[] }>(accessToken, `/v1/activity/sleep${qs}`),
  ]);

  type DayRow = {
    user_id: string;
    date: string;
    hrv?: number | null;
    resting_hr?: number | null;
    recovery?: number | null;
    spo2?: number | null;
    skin_temp_c?: number | null;
    strain?: number | null;
    sleep_hours?: number | null;
    sleep_score?: number | null;
    deep_sleep_hours?: number | null;
    rem_sleep_hours?: number | null;
    source: string;
    updated_at: string;
  };
  const byDate = new Map<string, DayRow>();
  const ensure = (date: string): DayRow => {
    let row = byDate.get(date);
    if (!row) {
      row = { user_id: userId, date, source: "whoop", updated_at: new Date().toISOString() };
      byDate.set(date, row);
    }
    return row;
  };

  for (const r of recovery.records) {
    if (!r.score) continue;
    const date = r.created_at.slice(0, 10);
    const row = ensure(date);
    row.hrv = r.score.hrv_rmssd_milli;
    row.resting_hr = r.score.resting_heart_rate;
    row.recovery = r.score.recovery_score;
    row.spo2 = r.score.spo2_percentage ?? null;
    row.skin_temp_c = r.score.skin_temp_celsius ?? null;
  }
  for (const c of cycles.records) {
    if (!c.score) continue;
    const date = c.start.slice(0, 10);
    const row = ensure(date);
    row.strain = c.score.strain;
  }
  for (const s of sleep.records) {
    if (!s.score) continue;
    const date = s.end.slice(0, 10);
    const row = ensure(date);
    const stages = s.score.stage_summary;
    if (stages) {
      const inBed = stages.total_in_bed_time_milli - stages.total_awake_time_milli;
      row.sleep_hours = +(inBed / 3600_000).toFixed(2);
      row.deep_sleep_hours = +(stages.total_slow_wave_sleep_time_milli / 3600_000).toFixed(2);
      row.rem_sleep_hours = +(stages.total_rem_sleep_time_milli / 3600_000).toFixed(2);
    }
    if (s.score.sleep_performance_percentage != null) row.sleep_score = s.score.sleep_performance_percentage;
  }

  if (byDate.size === 0) return { ok: true, upserted: 0 };

  const supabase = createSupabaseServiceRoleClient();
  const { error } = await supabase
    .from("daily_logs")
    .upsert(Array.from(byDate.values()), { onConflict: "user_id,date" });
  if (error) throw error;
  return { ok: true, upserted: byDate.size };
}

export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const isCron = cronSecret && auth === `Bearer ${cronSecret}`;

  if (isCron) {
    // Cron path: sync every user that has WHOOP tokens
    const supabase = createSupabaseServiceRoleClient();
    const { data: tokenRows } = await supabase.from("whoop_tokens").select("user_id");
    const results: Record<string, unknown> = {};
    for (const { user_id } of tokenRows ?? []) {
      try { results[user_id] = await syncForUser(user_id); }
      catch (e) { results[user_id] = { ok: false, error: String(e) }; }
    }
    return NextResponse.json({ cron: true, results });
  }

  // User-initiated path: sync just the signed-in user
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  try {
    const result = await syncForUser(user.id);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
