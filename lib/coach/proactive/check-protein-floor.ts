// lib/coach/proactive/check-protein-floor.ts
//
// Two triggers, mutually exclusive:
//   - GLP-1 active mode → glp1_protein_floor (higher threshold 1.8 g/kg,
//     5-day window, fires on 3+ misses).
//   - Otherwise → protein_under (60% hit rate over last 7 logged days).
// Resolves GLP-1 mode via getTodayTargets (which reads from
// athlete_profile_documents.plan_payload.nutrition.glp1). Body weight
// comes from the most recent daily_logs.weight_kg row.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoachTrendsPayload, ProactiveEvent } from "@/lib/data/types";
import { getTodayTargets } from "@/lib/morning/brief/get-today-targets";
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

  // Resolve GLP-1 mode via the canonical helper (reads athlete_profile_documents).
  const targets = await getTodayTargets(supabase, userId);
  const isGlp1Active = targets?.mode === "glp1_active";

  if (isGlp1Active) {
    // Fetch current body weight from most recent daily_logs row.
    const { data: bwRow } = await supabase
      .from("daily_logs")
      .select("weight_kg")
      .eq("user_id", userId)
      .not("weight_kg", "is", null)
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle();
    const bw = (bwRow as { weight_kg?: number | null } | null)?.weight_kg ?? null;
    if (bw == null || bw <= 0) return events;  // no weight, can't compute floor

    // Last 5 days of daily_logs.protein_g.
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

  // Classical branch — 7d hit rate against the protein target.
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
