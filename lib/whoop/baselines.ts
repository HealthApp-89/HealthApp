// lib/whoop/baselines.ts
//
// Trailing 30-day rolling baselines for the five recovery metrics (HRV, RHR,
// recovery score, sleep performance, respiratory rate) that drive autoregulation
// and proactive-trigger decisions. Post-cutover (2026-07-01), these recompute
// from daily_logs (Garmin-sourced) for users on metrics_source='garmin'.
// Refreshed daily by /api/whoop/baselines/sync at 10:30 UTC. See spec:
// docs/superpowers/specs/2026-05-30-whoop-rolling-baselines-design.md

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  BaselineStatus,
  MetricBaseline,
  Rolling30dBaselines,
  WhoopBaselinesJsonb,
} from "@/lib/data/types";

const WINDOW_DAYS = 30;
const PARTIAL_THRESHOLD = 14;

/** Source columns on daily_logs. Order: HRV, RHR, recovery score,
 *  sleep performance, respiratory rate. Stay in lockstep with the
 *  Rolling30dBaselines key order. */
const SOURCE_COLUMNS = [
  "hrv",
  "resting_hr",
  "recovery",
  "sleep_score",
  "respiratory_rate",
] as const;

type Row = {
  hrv: number | null;
  resting_hr: number | null;
  recovery: number | null;
  sleep_score: number | null;
  respiratory_rate: number | null;
};

function shiftDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function computeMetric(values: Array<number | null>): MetricBaseline {
  const xs = values.filter((v): v is number => v != null);
  const days = xs.length;
  let status: BaselineStatus;
  if (days < PARTIAL_THRESHOLD) status = "establishing";
  else if (days < WINDOW_DAYS) status = "partial";
  else status = "stable";

  if (status === "establishing") {
    return { mean: null, sd: null, days, status };
  }
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance =
    xs.reduce((acc, x) => acc + (x - mean) ** 2, 0) / xs.length;
  const sd = Math.sqrt(variance);
  return { mean, sd, days, status };
}

/** Compute rolling 30-day baselines for one user, as of `asOf`. The window
 *  is [asOf - 30 days, asOf) — exclusive of today because today's data may
 *  be incomplete (WHOOP sync runs twice daily; first call may land before
 *  the second). */
export async function computeWhoopBaselines(args: {
  supabase: SupabaseClient;
  userId: string;
  asOf: Date;
}): Promise<Rolling30dBaselines> {
  const { supabase, userId, asOf } = args;
  const windowStart = ymd(shiftDays(asOf, -WINDOW_DAYS));
  const windowEnd = ymd(asOf); // exclusive via .lt

  const { data, error } = await supabase
    .from("daily_logs")
    .select(SOURCE_COLUMNS.join(","))
    .eq("user_id", userId)
    .gte("date", windowStart)
    .lt("date", windowEnd)
    .order("date", { ascending: true });
  if (error) throw error;
  const rows = (data as unknown as Row[] | null) ?? [];

  return {
    computed_at: new Date().toISOString(),
    hrv: computeMetric(rows.map((r) => r.hrv)),
    rhr: computeMetric(rows.map((r) => r.resting_hr)),
    recovery: computeMetric(rows.map((r) => r.recovery)),
    sleep_performance: computeMetric(rows.map((r) => r.sleep_score)),
    resp_rate: computeMetric(rows.map((r) => r.respiratory_rate)),
  };
}

/** Merge rolling_30d into the existing profiles.whoop_baselines jsonb,
 *  preserving all legacy keys (biographical context). Service-role only. */
export async function persistBaselines(args: {
  supabase: SupabaseClient;
  userId: string;
  baselines: Rolling30dBaselines;
}): Promise<void> {
  const { supabase, userId, baselines } = args;
  const { data: profile, error: readErr } = await supabase
    .from("profiles")
    .select("whoop_baselines")
    .eq("user_id", userId)
    .maybeSingle();
  if (readErr) throw readErr;

  const existing = (profile?.whoop_baselines as WhoopBaselinesJsonb | null) ?? {};
  const merged: WhoopBaselinesJsonb = { ...existing, rolling_30d: baselines };

  const { error: writeErr } = await supabase
    .from("profiles")
    .update({ whoop_baselines: merged })
    .eq("user_id", userId);
  if (writeErr) throw writeErr;
}

/** Hopkins/Buchheit "smallest worthwhile change" gate. Treats deviations
 *  within ±0.5 × SD as noise. Returns false when the baseline is unusable
 *  (establishing, missing mean, or zero SD). Consumers should fall through
 *  to their absolute thresholds when this returns false but a comparison
 *  is still desired. */
export function isMeaningfulDeviation(
  today: number | null,
  baseline: MetricBaseline | null | undefined,
): boolean {
  if (today == null) return false;
  if (!baseline || baseline.mean == null || baseline.sd == null) return false;
  if (baseline.sd === 0) return false;
  return Math.abs(today - baseline.mean) > 0.5 * baseline.sd;
}

/** Convenience reader: pull rolling_30d from a free-form whoop_baselines
 *  jsonb. Returns null if the cron hasn't populated it yet. Use this at
 *  every consumer site to keep the access pattern uniform. */
export function readRolling30d(
  whoopBaselines: Record<string, unknown> | null | undefined,
): Rolling30dBaselines | null {
  if (!whoopBaselines) return null;
  const r = (whoopBaselines as WhoopBaselinesJsonb).rolling_30d;
  return r ?? null;
}
