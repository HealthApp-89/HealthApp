// lib/coach/recovery-intelligence/compose-weekly.ts
//
// Returns 12 weekly buckets (Mon→Sun) covering today + the 11 prior weeks.
// Aggregates: avg of HRV/RHR/recovery/strain/sleep_h/sleep_score, plus
// recovery-tier counts (low/ok/high) for the stacked-bar viz (A8).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { WeeklyAggregate } from "./types";
import { RECOVERY_LOW_TIER, RECOVERY_HIGH_TIER } from "./thresholds";

const WEEKLY_WINDOW_WEEKS = 12;
const SELECT_COLS = "date,hrv,resting_hr,recovery,strain,sleep_hours,sleep_score";

function mondayOf(d: Date): Date {
  // JS: 0=Sun, 1=Mon, …, 6=Sat. Snap back to Monday.
  const day = d.getUTCDay();
  const diff = (day + 6) % 7; // Sun→6, Mon→0, Tue→1, …
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() - diff);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

function avg(xs: Array<number | null>): number | null {
  const v = xs.filter((x): x is number => x != null);
  if (v.length === 0) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

export async function composeWeekly(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<WeeklyAggregate[]> {
  const { supabase, userId, today } = args;

  const todayD = new Date(`${today}T00:00:00Z`);
  const thisWeekStart = mondayOf(todayD);
  const oldestWeekStart = new Date(thisWeekStart);
  oldestWeekStart.setUTCDate(oldestWeekStart.getUTCDate() - 7 * (WEEKLY_WINDOW_WEEKS - 1));
  const startIso = oldestWeekStart.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("daily_logs")
    .select(SELECT_COLS)
    .eq("user_id", userId)
    .gte("date", startIso)
    .lte("date", today)
    .order("date", { ascending: true });

  if (error) throw error;

  const byWeek = new Map<string, typeof data>();
  for (const row of data ?? []) {
    const wkStart = mondayOf(new Date(`${row.date}T00:00:00Z`)).toISOString().slice(0, 10);
    if (!byWeek.has(wkStart)) byWeek.set(wkStart, []);
    byWeek.get(wkStart)!.push(row);
  }

  const out: WeeklyAggregate[] = [];
  for (let i = 0; i < WEEKLY_WINDOW_WEEKS; i++) {
    const wkStart = new Date(oldestWeekStart);
    wkStart.setUTCDate(wkStart.getUTCDate() + 7 * i);
    const iso = wkStart.toISOString().slice(0, 10);
    const rows = byWeek.get(iso) ?? [];
    out.push({
      week_start: iso,
      hrv_avg:         avg(rows.map((r) => r.hrv)),
      rhr_avg:         avg(rows.map((r) => r.resting_hr)),
      recovery_avg:    avg(rows.map((r) => r.recovery)),
      strain_avg:      avg(rows.map((r) => r.strain)),
      sleep_hours_avg: avg(rows.map((r) => r.sleep_hours)),
      sleep_score_avg: avg(rows.map((r) => r.sleep_score)),
      recovery_low_days:  rows.filter((r) => r.recovery != null && r.recovery <  RECOVERY_LOW_TIER ).length,
      recovery_ok_days:   rows.filter((r) => r.recovery != null && r.recovery >= RECOVERY_LOW_TIER && r.recovery < RECOVERY_HIGH_TIER).length,
      recovery_high_days: rows.filter((r) => r.recovery != null && r.recovery >= RECOVERY_HIGH_TIER).length,
    });
  }
  return out;
}
