// lib/coach/proactive/check-protein-floor.ts
//
// Two triggers, mutually exclusive:
//   - GLP-1 active mode → glp1_protein_floor (higher threshold 1.8 g/kg,
//     5-day window, fires on 3+ misses).
//   - Otherwise → protein_under (60% hit rate over last 7 logged days).
// Reads profiles.glp1_status to pick the branch.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoachTrendsPayload, ProactiveEvent } from "@/lib/data/types";
import {
  PROTEIN_UNDER_HIT_RATE,
  PROTEIN_UNDER_MIN_LOGGED,
  GLP1_PROTEIN_FLOOR_G_PER_KG,
  GLP1_PROTEIN_MISS_DAYS,
} from "@/lib/coach/nutrition-intelligence/thresholds";

export async function checkProteinFloor(
  trends: CoachTrendsPayload,
  args: { supabase: SupabaseClient; userId: string; today: string },
): Promise<ProactiveEvent[]> {
  const events: ProactiveEvent[] = [];
  const { supabase, userId, today } = args;

  // Pull current GLP-1 status from profiles.
  const { data: profile } = await supabase
    .from("profiles")
    .select("glp1_status, weight_kg")
    .eq("id", userId)
    .maybeSingle();
  const glp1Status = (profile as { glp1_status?: string } | null)?.glp1_status ?? "none";
  const bw = (profile as { weight_kg?: number | null } | null)?.weight_kg ?? null;

  if (glp1Status === "active" && bw != null && bw > 0) {
    // GLP-1 active branch — fetch last 5 days of daily_logs.protein_g.
    const fiveAgo = shiftDays(today, -5);
    const { data: logs } = await supabase
      .from("daily_logs")
      .select("date, protein_g")
      .eq("user_id", userId)
      .gte("date", fiveAgo)
      .lte("date", today)
      .order("date", { ascending: true });
    const floor = GLP1_PROTEIN_FLOOR_G_PER_KG * bw;
    let misses = 0;
    let observed = 0;
    for (const r of (logs as Array<{ protein_g: number | null }> | null) ?? []) {
      if (r.protein_g == null) continue;
      observed += 1;
      if (r.protein_g < floor) misses += 1;
    }
    if (misses >= GLP1_PROTEIN_MISS_DAYS) {
      events.push({
        trigger_type: "glp1_protein_floor",
        trigger_key: "glp1_protein_floor",
        payload: { misses, observed, floor_g: floor, bw_kg: bw },
      });
    }
    return events;
  }

  // Classical branch — derive 7d hit rate from trends.nutrition.protein.
  // The payload already carries 4w hit-rate; we need a tighter 7d cut.
  const proteinTarget = trends.nutrition.protein.target_g;
  if (proteinTarget == null) return events;

  const sevenAgo = shiftDays(today, -7);
  const { data: logs7 } = await supabase
    .from("daily_logs")
    .select("date, protein_g")
    .eq("user_id", userId)
    .gte("date", sevenAgo)
    .lte("date", today);
  let logged = 0;
  let hit = 0;
  for (const r of (logs7 as Array<{ protein_g: number | null }> | null) ?? []) {
    if (r.protein_g == null) continue;
    logged += 1;
    if (r.protein_g >= proteinTarget) hit += 1;
  }
  if (logged < PROTEIN_UNDER_MIN_LOGGED) return events;
  const rate = hit / logged;
  if (rate < PROTEIN_UNDER_HIT_RATE) {
    events.push({
      trigger_type: "protein_under",
      trigger_key: "protein_under",
      payload: { hit, logged, hit_rate: rate, target_g: proteinTarget },
    });
  }
  return events;
}

function shiftDays(d: string, days: number): string {
  const dt = new Date(`${d}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
