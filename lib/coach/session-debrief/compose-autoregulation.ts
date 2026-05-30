// lib/coach/session-debrief/compose-autoregulation.ts
//
// Pulls today's daily_logs (HRV, recovery, sleep, strain) + the athlete's
// WHOOP baseline (from profiles.whoop_baselines) and produces a deterministic
// one-paragraph string interpretation. No AI — pure templating so the
// narrative-prompt can cite specific numbers without having to do its own
// math, and so the dedicated page can render the same string verbatim.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkoutDebriefPayload } from "@/lib/coach/session-debrief/payload";
import { readRolling30d, isMeaningfulDeviation } from "@/lib/whoop/baselines";
import type { MetricBaseline } from "@/lib/data/types";

type ComposeAutoregulationInput = {
  supabase: SupabaseClient;
  userId: string;
  workoutDate: string; // YYYY-MM-DD
};

type Baselines = {
  hrv: number | null;       // mean (rolling_30d preferred, legacy fallback)
  hrv_metric: MetricBaseline | null;  // null when establishing or pre-cron
  recovery: number | null;
  resting_hr: number | null;
};

export async function composeAutoregulation(
  input: ComposeAutoregulationInput,
): Promise<WorkoutDebriefPayload["autoregulation"]> {
  const { supabase, userId, workoutDate } = input;

  const { data: log, error: logErr } = await supabase
    .from("daily_logs")
    .select("hrv, recovery, sleep_hours, sleep_score, strain, resting_hr")
    .eq("user_id", userId)
    .eq("date", workoutDate)
    .maybeSingle();
  if (logErr) throw new Error(`daily_logs lookup failed: ${logErr.message}`);

  const { data: profile, error: pErr } = await supabase
    .from("profiles")
    .select("whoop_baselines")
    .eq("user_id", userId)
    .maybeSingle();
  if (pErr) throw new Error(`profile lookup failed: ${pErr.message}`);

  const wb = profile?.whoop_baselines as Record<string, unknown> | null;
  const r30 = readRolling30d(wb);
  type Legacy = {
    hrv_mean?: number; rhr_mean?: number;
    hrv_6mo_avg?: number; rhr_6mo_avg?: number;
    recovery_6mo_avg?: number;
  };
  const legacy = (wb as Legacy | null) ?? {};
  const baselines: Baselines = {
    hrv: r30?.hrv.mean ?? legacy.hrv_mean ?? legacy.hrv_6mo_avg ?? null,
    hrv_metric: r30?.hrv ?? null,
    recovery: legacy.recovery_6mo_avg ?? null,
    resting_hr: r30?.rhr.mean ?? legacy.rhr_mean ?? legacy.rhr_6mo_avg ?? null,
  };

  const today_hrv = log?.hrv ?? null;
  const today_recovery = log?.recovery ?? null;
  const today_sleep_hours = log?.sleep_hours ?? null;
  const today_strain = log?.strain ?? null;

  const bits: string[] = [];

  if (today_recovery != null) {
    const baseRec = baselines.recovery ?? null;
    if (baseRec != null) {
      const delta = today_recovery - baseRec;
      const band = today_recovery >= 67 ? "good" : today_recovery >= 34 ? "moderate" : "low";
      const dStr = delta >= 0 ? `+${Math.round(delta)}` : `${Math.round(delta)}`;
      bits.push(`Recovery ${today_recovery}% (${band} band; ${dStr} vs 14d baseline ${Math.round(baseRec)}%)`);
    } else {
      bits.push(`Recovery ${today_recovery}%`);
    }
  }

  if (today_hrv != null) {
    const baseHrv = baselines.hrv ?? null;
    if (baseHrv != null) {
      const delta = Math.round(today_hrv - baseHrv);
      const dStr = delta >= 0 ? `+${delta}ms` : `${delta}ms`;
      bits.push(`HRV ${Math.round(today_hrv)}ms (${dStr} vs baseline ${Math.round(baseHrv)}ms)`);
    } else {
      bits.push(`HRV ${Math.round(today_hrv)}ms`);
    }
  }

  if (today_sleep_hours != null) {
    bits.push(`Sleep ${today_sleep_hours.toFixed(1)}h`);
  }
  if (today_strain != null) {
    bits.push(`Strain ${today_strain.toFixed(1)}`);
  }

  let interpretation = bits.join(" · ") || "No autoregulation data for today.";

  // Add a single closing-sentence interpretation if recovery is low or HRV is
  // notably below baseline.
  if (today_recovery != null && today_recovery < 34) {
    interpretation += " This session was performed in a low-recovery band — expect lower top sets and longer rest needs.";
  } else if (
    today_hrv != null &&
    baselines.hrv != null &&
    ((baselines.hrv_metric != null &&
      baselines.hrv_metric.status !== "establishing" &&
      isMeaningfulDeviation(today_hrv, baselines.hrv_metric) &&
      today_hrv < baselines.hrv) ||
     (baselines.hrv_metric == null && today_hrv < baselines.hrv - 10))
  ) {
    interpretation += " HRV is meaningfully below baseline; treat any underperformance as fatigue-driven, not capacity-driven.";
  }

  return {
    today_hrv,
    today_recovery,
    today_sleep_hours,
    today_strain,
    interpretation,
  };
}
