// lib/whoop-day-rows.ts
//
// Pure builder for `daily_logs` rows from WHOOP records. Both the sync and
// backfill routes call this; the rekey script does too. All date keying is
// user-local: cycles use their own `timezone_offset`, sleep/recovery inherit
// from the containing cycle (via buildCycleTzLookup), with USER_TIMEZONE as
// the fallback.

import type { WhoopRecovery, WhoopCycle, WhoopSleep } from "@/lib/whoop";
import { buildCycleTzLookup } from "@/lib/whoop-tz";
import { ymdInUserTz, ymdInZoneOffset } from "@/lib/time";

export type WhoopDayRow = {
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

/** Build the per-day rows from WHOOP records. Order matters:
 *  1. Cycles → strain (also feeds the cycle-tz lookup for sleeps/recoveries).
 *  2. Sleeps → sleep_*, builds sleepIdToDate using cycle-tz lookup.
 *  3. Recoveries → hrv/resting_hr/recovery/spo2/skin_temp_c, keyed by linked
 *     sleep's date (or USER_TIMEZONE-keyed `created_at` fallback).
 *
 *  Returns an array of rows ready for `daily_logs` upsert. */
export function buildWhoopDayRows(
  userId: string,
  recovery: WhoopRecovery[],
  cycles: WhoopCycle[],
  sleep: WhoopSleep[],
): WhoopDayRow[] {
  const lookupCycleTz = buildCycleTzLookup(cycles);
  const byDate = new Map<string, WhoopDayRow>();
  const ensure = (date: string): WhoopDayRow => {
    let row = byDate.get(date);
    if (!row) {
      row = {
        user_id: userId,
        date,
        source: "whoop",
        updated_at: new Date().toISOString(),
      };
      byDate.set(date, row);
    }
    return row;
  };

  // 1. Cycles → strain
  for (const c of cycles) {
    if (!c.score) continue;
    const date = ymdInZoneOffset(new Date(c.start), c.timezone_offset);
    const row = ensure(date);
    row.strain = c.score.strain;
  }

  // 2. Sleeps → sleep_*, also populate sleepIdToDate
  const sleepIdToDate = new Map<string, string>();
  for (const s of sleep) {
    const cycleTz = lookupCycleTz(new Date(s.end));
    const date = cycleTz
      ? ymdInZoneOffset(new Date(s.end), cycleTz)
      : ymdInUserTz(new Date(s.end));
    sleepIdToDate.set(s.id, date);
    if (!s.score) continue;
    const row = ensure(date);
    const stages = s.score.stage_summary;
    if (stages) {
      // "Asleep" excludes both `awake` AND `no_data` (sensor-gap) windows —
      // see app/api/whoop/sync/route.ts for the original comment.
      const asleepMs =
        stages.total_light_sleep_time_milli +
        stages.total_slow_wave_sleep_time_milli +
        stages.total_rem_sleep_time_milli;
      row.sleep_hours = +(asleepMs / 3_600_000).toFixed(2);
      row.deep_sleep_hours = +(stages.total_slow_wave_sleep_time_milli / 3_600_000).toFixed(2);
      row.rem_sleep_hours = +(stages.total_rem_sleep_time_milli / 3_600_000).toFixed(2);
    }
    if (s.score.sleep_performance_percentage != null) {
      row.sleep_score = s.score.sleep_performance_percentage;
    }
    const respRate = (s.score as { respiratory_rate?: number }).respiratory_rate;
    if (respRate != null) {
      row.respiratory_rate = respRate;
    }
  }

  // 3. Recoveries → hrv, resting_hr, recovery, spo2, skin_temp_c
  for (const r of recovery) {
    if (!r.score) continue;
    const date =
      sleepIdToDate.get(r.sleep_id) ??
      ymdInUserTz(new Date(r.created_at));
    const row = ensure(date);
    row.hrv = r.score.hrv_rmssd_milli;
    row.resting_hr = r.score.resting_heart_rate;
    row.recovery = r.score.recovery_score;
    row.spo2 = r.score.spo2_percentage ?? null;
    row.skin_temp_c = r.score.skin_temp_celsius ?? null;
  }

  return Array.from(byDate.values());
}
