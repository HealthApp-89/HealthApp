// lib/coach/recovery-intelligence/compose-sleep-consistency.ts
//
// 28 daily bedtime + wake points expressed as "minutes after 18:00 local",
// so a bedtime of 23:30 → 330, 01:00 → 420, 02:30 → 510. Wakes around 07:00
// → 780. Anchoring at 18:00 keeps athletes who go to bed before midnight
// and after midnight on a continuous y-axis (no wrap).
//
// Also computes the bedtime SD over the last 14 days for the
// bedtime-drift trigger and the card subtitle.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BedtimePoint } from "./types";
import { BEDTIME_WINDOW_DAYS } from "./thresholds";

const WINDOW_DAYS = 28;
const SELECT_COLS = "date,sleep_start_at,sleep_end_at";

function minutesAfter18(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  // Local TZ: Supabase returns timestamptz; toLocale parses into runtime TZ.
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  // Anchor 18:00 = 0. Wraps from previous day handled below.
  let m = minutes - 18 * 60;
  if (m < 0) m += 24 * 60; // 06:00 → 720 (= morning of "today")
  return m;
}

export type SleepConsistencyOut = {
  series: BedtimePoint[];
  bedtime_mean_minutes: number | null;
  bedtime_sd_minutes: number | null;
};

export async function composeSleepConsistency(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<SleepConsistencyOut> {
  const { supabase, userId, today } = args;

  const end = new Date(`${today}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (WINDOW_DAYS - 1));
  const startIso = start.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("daily_logs")
    .select(SELECT_COLS)
    .eq("user_id", userId)
    .gte("date", startIso)
    .lte("date", today)
    .order("date", { ascending: true });

  if (error) throw error;

  type Row = { date: string; sleep_start_at: string | null; sleep_end_at: string | null };
  const byDate = new Map<string, Row>();
  for (const r of (data ?? []) as Row[]) byDate.set(r.date, r);

  const series: BedtimePoint[] = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const row = byDate.get(iso);
    series.push({
      date: iso,
      bedtime_minutes_after_18: minutesAfter18(row?.sleep_start_at ?? null),
      wake_minutes_after_18:    minutesAfter18(row?.sleep_end_at   ?? null),
    });
  }

  // Last 14d bedtime stats.
  const last14 = series.slice(-BEDTIME_WINDOW_DAYS)
    .map((p) => p.bedtime_minutes_after_18)
    .filter((m): m is number => m != null);

  let mean: number | null = null;
  let sd: number | null = null;
  if (last14.length >= 5) {
    mean = last14.reduce((a, b) => a + b, 0) / last14.length;
    const variance = last14.reduce((acc, x) => acc + (x - mean!) ** 2, 0) / last14.length;
    sd = Math.sqrt(variance);
  }
  return { series, bedtime_mean_minutes: mean, bedtime_sd_minutes: sd };
}
