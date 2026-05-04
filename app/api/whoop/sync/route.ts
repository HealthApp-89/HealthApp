import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import {
  getValidAccessToken,
  whoopGet,
  type WhoopRecovery,
  type WhoopCycle,
  type WhoopSleep,
} from "@/lib/whoop";

const MS_PER_DAY = 86_400_000;

type SyncCounts = {
  recovery_seen: number;
  recovery_scored: number;
  recovery_pending: number;
  recovery_unscorable: number;
  cycles_seen: number;
  cycles_scored: number;
  sleep_seen: number;
  sleep_scored: number;
  upserted: number;
};

async function syncForUser(userId: string) {
  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) return { ok: false, reason: "no_tokens" };

  const since = new Date(Date.now() - 14 * MS_PER_DAY).toISOString();
  const qs = `?start=${encodeURIComponent(since)}&limit=25`;

  const [recovery, cycles, sleep] = await Promise.all([
    whoopGet<{ records: WhoopRecovery[] }>(accessToken, `/v2/recovery${qs}`),
    whoopGet<{ records: WhoopCycle[] }>(accessToken, `/v2/cycle${qs}`),
    whoopGet<{ records: WhoopSleep[] }>(accessToken, `/v2/activity/sleep${qs}`),
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

  const counts: SyncCounts = {
    recovery_seen: recovery.records.length,
    recovery_scored: 0,
    recovery_pending: 0,
    recovery_unscorable: 0,
    cycles_seen: cycles.records.length,
    cycles_scored: 0,
    sleep_seen: sleep.records.length,
    sleep_scored: 0,
    upserted: 0,
  };

  // Build a sleep_id → wake-up date index so recovery rows land on the day
  // they're actually about, not the day WHOOP happened to write the record.
  const sleepIdToDate = new Map<string, string>();
  for (const s of sleep.records) {
    sleepIdToDate.set(s.id, s.end.slice(0, 10));
  }

  for (const r of recovery.records) {
    if (r.score_state === "PENDING_SCORE") counts.recovery_pending += 1;
    else if (r.score_state === "UNSCORABLE") counts.recovery_unscorable += 1;
    if (!r.score) continue;
    counts.recovery_scored += 1;
    // Prefer the linked sleep's end-date; fall back to created_at if WHOOP
    // hasn't returned the matching sleep in this window.
    const date = sleepIdToDate.get(r.sleep_id) ?? r.created_at.slice(0, 10);
    const row = ensure(date);
    row.hrv = r.score.hrv_rmssd_milli;
    row.resting_hr = r.score.resting_heart_rate;
    row.recovery = r.score.recovery_score;
    row.spo2 = r.score.spo2_percentage ?? null;
    row.skin_temp_c = r.score.skin_temp_celsius ?? null;
  }
  for (const c of cycles.records) {
    if (!c.score) continue;
    counts.cycles_scored += 1;
    const date = c.start.slice(0, 10);
    const row = ensure(date);
    row.strain = c.score.strain;
  }
  for (const s of sleep.records) {
    if (!s.score) continue;
    counts.sleep_scored += 1;
    const date = s.end.slice(0, 10);
    const row = ensure(date);
    const stages = s.score.stage_summary;
    if (stages) {
      // "Asleep" excludes both `awake` AND `no_data` (sensor-gap) windows.
      // Earlier code subtracted only awake, which silently inflated the total
      // by the no-data minutes (typically 1-5 min/night).
      const asleepMs =
        stages.total_light_sleep_time_milli +
        stages.total_slow_wave_sleep_time_milli +
        stages.total_rem_sleep_time_milli;
      row.sleep_hours = +(asleepMs / 3_600_000).toFixed(2);
      row.deep_sleep_hours = +(stages.total_slow_wave_sleep_time_milli / 3_600_000).toFixed(2);
      row.rem_sleep_hours = +(stages.total_rem_sleep_time_milli / 3_600_000).toFixed(2);
    }
    if (s.score.sleep_performance_percentage != null) row.sleep_score = s.score.sleep_performance_percentage;
  }

  if (byDate.size === 0) return { ok: true, ...counts };

  const supabase = createSupabaseServiceRoleClient();
  const { error } = await supabase
    .from("daily_logs")
    .upsert(Array.from(byDate.values()), { onConflict: "user_id,date" });
  if (error) throw error;
  counts.upserted = byDate.size;
  // Invalidate ISR caches so the dashboard / trends / coach pick up new
  // WHOOP data immediately instead of waiting up to 60s for revalidation.
  revalidatePath("/");
  revalidatePath("/trends");
  revalidatePath("/coach");
  return { ok: true, ...counts };
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
