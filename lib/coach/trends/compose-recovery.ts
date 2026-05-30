// lib/coach/trends/compose-recovery.ts
//
// Sleep / HRV / RHR rolling averages. HRV baseline from profiles.whoop_baselines.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RecoveryTrend } from "@/lib/data/types";
import { readRolling30d } from "@/lib/whoop/baselines";

export async function composeRecovery(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<RecoveryTrend> {
  const { supabase, userId, today } = args;
  const windowStart12w = shiftDays(today, -7 * 12);
  const window4wCutoff = shiftDays(today, -28);

  const { data: logs, error } = await supabase
    .from("daily_logs")
    .select("date, sleep_hours, sleep_score, hrv, resting_hr")
    .eq("user_id", userId)
    .gte("date", windowStart12w)
    .lte("date", today)
    .order("date", { ascending: true });
  if (error) throw error;

  type Row = {
    date: string;
    sleep_hours: number | null;
    sleep_score: number | null;
    hrv: number | null;
    resting_hr: number | null;
  };
  const rows = (logs as Row[] | null) ?? [];

  const { data: profile } = await supabase
    .from("profiles")
    .select("whoop_baselines")
    .eq("user_id", userId)
    .maybeSingle();
  const wb = (profile?.whoop_baselines as Record<string, unknown> | null) ?? null;
  // Prefer rolling 30d mean (live anchor, reflects current training modality);
  // fall back to legacy hrv_mean / hrv_6mo_avg for resilience during the first
  // cron run. See lib/whoop/baselines.ts and the 2026-05-30 baselines spec.
  const r30 = readRolling30d(wb);
  const hrvBaseline =
    r30?.hrv.mean ??
    (wb?.hrv_mean as number | undefined) ??
    (wb?.hrv_6mo_avg as number | undefined) ??
    null;

  const avg = (xs: number[]) =>
    xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : null;

  const rows4w = rows.filter((r) => r.date >= window4wCutoff);

  const sleep4w = avg(rows4w.filter((r) => r.sleep_hours != null).map((r) => r.sleep_hours as number));
  const sleep12w = avg(rows.filter((r) => r.sleep_hours != null).map((r) => r.sleep_hours as number));
  const eff4w = avg(rows4w.filter((r) => r.sleep_score != null).map((r) => r.sleep_score as number));
  const eff12w = avg(rows.filter((r) => r.sleep_score != null).map((r) => r.sleep_score as number));

  const hrv4w = avg(rows4w.filter((r) => r.hrv != null).map((r) => r.hrv as number));
  const hrv12w = avg(rows.filter((r) => r.hrv != null).map((r) => r.hrv as number));

  const rhr4w = avg(rows4w.filter((r) => r.resting_hr != null).map((r) => r.resting_hr as number));
  const rhr12w = avg(rows.filter((r) => r.resting_hr != null).map((r) => r.resting_hr as number));
  const rhrPrior = avg(
    rows.filter((r) => r.date < window4wCutoff && r.resting_hr != null)
      .slice(-28)
      .map((r) => r.resting_hr as number),
  );

  return {
    schema_version: 1,
    sleep: {
      avg_h_4w: sleep4w,
      avg_h_12w: sleep12w,
      avg_efficiency_pct_4w: eff4w,
      avg_efficiency_pct_12w: eff12w,
    },
    hrv: {
      avg_4w: hrv4w,
      avg_12w: hrv12w,
      baseline_30d: hrvBaseline,
      vs_baseline_pct_4w: hrv4w != null && hrvBaseline != null && hrvBaseline > 0
        ? (hrv4w - hrvBaseline) / hrvBaseline
        : null,
    },
    rhr: {
      avg_bpm_4w: rhr4w,
      avg_bpm_12w: rhr12w,
      delta_4w_bpm: rhr4w != null && rhrPrior != null ? rhr4w - rhrPrior : null,
    },
  };
}

function shiftDays(d: string, days: number): string {
  const dt = new Date(d + "T12:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
