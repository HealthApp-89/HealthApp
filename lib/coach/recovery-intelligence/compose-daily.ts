// lib/coach/recovery-intelligence/compose-daily.ts
//
// Pure-ish: takes a Supabase client + userId + today, returns the 28d
// daily series in chronological order (oldest first). Missing-row dates
// are returned as fully-null points so charts can keep a continuous x-axis.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RecoveryDailyPoint } from "./types";

const DAILY_WINDOW_DAYS = 28;

const SELECT_COLS =
  "date,hrv,resting_hr,recovery,sleep_hours,sleep_score,deep_sleep_hours,rem_sleep_hours,strain,spo2,skin_temp_c,respiratory_rate,body_battery_low,body_battery_peak,stress_avg,stress_qualifier,sleep_start_at,sleep_end_at";

export async function composeDaily(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;     // YYYY-MM-DD in user TZ
}): Promise<RecoveryDailyPoint[]> {
  const { supabase, userId, today } = args;

  // Compute window bounds inclusive of `today` going back 27 days = 28 total.
  const end = new Date(`${today}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (DAILY_WINDOW_DAYS - 1));
  const startIso = start.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("daily_logs")
    .select(SELECT_COLS)
    .eq("user_id", userId)
    .gte("date", startIso)
    .lte("date", today)
    .order("date", { ascending: true });

  if (error) throw error;

  const byDate = new Map<string, RecoveryDailyPoint>();
  for (const row of (data ?? []) as RecoveryDailyPoint[]) {
    byDate.set(row.date, row);
  }

  // Densify: emit one row per date in the window, filling gaps with nulls.
  const out: RecoveryDailyPoint[] = [];
  for (let i = 0; i < DAILY_WINDOW_DAYS; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    out.push(
      byDate.get(iso) ?? {
        date: iso,
        hrv: null, resting_hr: null, recovery: null,
        sleep_hours: null, sleep_score: null,
        deep_sleep_hours: null, rem_sleep_hours: null,
        strain: null, spo2: null, skin_temp_c: null,
        respiratory_rate: null,
        body_battery_low: null, body_battery_peak: null,
        stress_avg: null, stress_qualifier: null,
        sleep_start_at: null, sleep_end_at: null,
      },
    );
  }
  return out;
}
