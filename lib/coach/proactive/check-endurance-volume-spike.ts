// lib/coach/proactive/check-endurance-volume-spike.ts
//
// Endurance-pillar trigger (Phase 1: dormant).
//
// Fires when BOTH gates are open:
//   - 7d endurance load (sum of daily_logs.endurance_load over [today-7, today])
//     is > 1.4× the 28-day weekly average (i.e. > 1.4× (sum_28d / 4)).
//   - Today's HRV is below the rolling-30d baseline by more than 0.5×SD
//     (Hopkins / Buchheit "smallest worthwhile change" — same gate
//     `isMeaningfulDeviation` enforces, but signed for "below").
//
// At Phase 1's ~1h/wk volume the first gate effectively cannot fire (TSS is
// trivially low and rarely spikes by 40% over its own 4-week average), so
// this trigger stays dormant until triathlon scales the load. Once weekly
// TSS climbs into 200+ territory, normal week-to-week variance starts
// crossing the 1.4× ratio and the trigger wakes up automatically.
//
// Pure async check — returns ProactiveEvent[] for the orchestrator to dedup
// and persist. No render-time logic here.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProactiveEvent } from "@/lib/data/types";
import { readRolling30d } from "@/lib/whoop/baselines";

const TSS_SPIKE_RATIO = 1.4;
const HRV_Z_THRESHOLD = -0.5; // Hopkins SWC; below this is meaningful

function shiftDays(d: string, days: number): string {
  const dt = new Date(`${d}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export async function checkEnduranceVolumeSpike(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<ProactiveEvent[]> {
  const { supabase, userId, today } = args;

  // 28-day window of (date, endurance_load, hrv). One query covers both gates.
  const windowStart = shiftDays(today, -27); // inclusive: 28 days [start, today]
  const sevenStart = shiftDays(today, -6); // inclusive 7-day window

  const { data: rows } = await supabase
    .from("daily_logs")
    .select("date, endurance_load, hrv")
    .eq("user_id", userId)
    .gte("date", windowStart)
    .lte("date", today);

  const all = (rows as Array<{ date: string; endurance_load: number | null; hrv: number | null }> | null) ?? [];
  if (all.length === 0) return [];

  const tss7 = all
    .filter((r) => r.date >= sevenStart)
    .reduce((s, r) => s + (Number(r.endurance_load) || 0), 0);
  const tss28 = all.reduce((s, r) => s + (Number(r.endurance_load) || 0), 0);
  // Weekly average over the 28-day window.
  const avgWeekly = tss28 / 4;

  if (avgWeekly <= 0) return []; // dormant by definition — no historical load
  const ratio = tss7 / avgWeekly;
  if (ratio < TSS_SPIKE_RATIO) return [];

  // HRV gate — today's HRV vs rolling_30d baseline, signed.
  const { data: profile } = await supabase
    .from("profiles")
    .select("whoop_baselines")
    .eq("user_id", userId)
    .maybeSingle();
  const rolling = readRolling30d(
    (profile as { whoop_baselines?: Record<string, unknown> | null } | null)?.whoop_baselines,
  );
  const hrvBaseline = rolling?.hrv ?? null;
  if (!hrvBaseline || hrvBaseline.mean == null || hrvBaseline.sd == null || hrvBaseline.sd <= 0) {
    return [];
  }
  const todayRow = all.find((r) => r.date === today);
  const todayHrv = todayRow?.hrv ?? null;
  if (todayHrv == null) return [];

  const z = (todayHrv - hrvBaseline.mean) / hrvBaseline.sd;
  if (z >= HRV_Z_THRESHOLD) return [];

  return [
    {
      trigger_type: "endurance_volume_recovery_mismatch",
      trigger_key: "endurance_volume_recovery_mismatch",
      payload: {
        tss_7d: tss7,
        tss_28d: tss28,
        avg_weekly_tss_28d: avgWeekly,
        ratio_7d_vs_avg: ratio,
        hrv_today: todayHrv,
        hrv_baseline_mean: hrvBaseline.mean,
        hrv_baseline_sd: hrvBaseline.sd,
        hrv_z: z,
      },
    },
  ];
}
