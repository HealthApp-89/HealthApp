// lib/coach/trends/index.ts
//
// Orchestrator: parallel-fetch supabase reads via the 6 composers,
// pick a headline insight from severity priority, return CoachTrendsPayload.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoachTrendsPayload, Injury } from "@/lib/data/types";
import { composeStrength } from "./compose-strength";
import { composeBody } from "./compose-body";
import { composeNutrition } from "./compose-nutrition";
import { composeRecovery } from "./compose-recovery";
import { composeCross } from "./compose-cross";
import { composeFoodQuality } from "@/lib/coach/nutrition-intelligence/compose-food-quality";
import {
  RECOMP_SUCCESS_LBM_DELTA_KG,
  RECOMP_SUCCESS_BF_DELTA_PTS,
  RECOMP_DRIFT_WEIGHT_TOL_KG,
  RECOMP_DRIFT_BF_DELTA_PTS,
} from "@/lib/coach/nutrition-intelligence/thresholds";

export async function generateCoachTrends(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<CoachTrendsPayload> {
  const { supabase, userId } = args;

  // Fetch injuries once without status filter so injury-gated windows cover
  // resolved injuries whose span still overlaps the analysis window. Ordered
  // onset_date desc so liftInjuryFor's first-match tie-break picks the
  // most-recent-onset injury (matches the Task 1 contract).
  const injuriesPromise = supabase
    .from("injuries")
    .select("*")
    .eq("user_id", userId)
    .lte("onset_date", args.today)
    .order("onset_date", { ascending: false })
    .then(({ data, error }) => {
      if (error) {
        // Degrade gracefully — injury gating is supplementary; don't break trends.
        console.warn("[generateCoachTrends] injuries fetch failed", error);
        return [] as Injury[];
      }
      return (data ?? []) as Injury[];
    });

  const [injuries, body, nutrition, recovery, food_quality, cross_insights] = await Promise.all([
    injuriesPromise,
    composeBody(args),
    composeNutrition(args),
    composeRecovery(args),
    composeFoodQuality(args),
    composeCross(args),
  ]);

  const strength = await composeStrength({ ...args, injuries });

  return {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    strength,
    body,
    nutrition,
    recovery,
    food_quality,
    cross_insights,
    headline: pickHeadline({ strength, body, recovery }),
  };
}

export function pickHeadline(input: {
  strength: CoachTrendsPayload["strength"];
  body: CoachTrendsPayload["body"];
  recovery: CoachTrendsPayload["recovery"];
}): CoachTrendsPayload["headline"] {
  // 1. Recomp success (positive) — wins over any negative headline because
  //    it's earned good news the athlete should see immediately.
  const lbm4w = input.body.lbm.delta_4w_kg;
  const bf4w  = input.body.body_fat_pct.delta_4w_pct;
  if (
    lbm4w != null && lbm4w >= RECOMP_SUCCESS_LBM_DELTA_KG &&
    bf4w  != null && bf4w  <= RECOMP_SUCCESS_BF_DELTA_PTS
  ) {
    return {
      severity: "ok",
      title: "Recomp working",
      body_md: `LBM +${lbm4w.toFixed(1)} kg, body fat ${Math.abs(bf4w).toFixed(1)} pts down over 4 weeks. Whatever the lever is, keep it.`,
    };
  }

  // Exclude injury-gated lifts — flat e1RM during recovery is expected, not actionable.
  const plateauedLifts = input.strength.per_lift.filter((p) => p.plateau_active && !p.injury_gated);
  if (plateauedLifts.length > 0) {
    const longest = plateauedLifts.reduce((a, b) =>
      b.plateau_weeks_flat > a.plateau_weeks_flat ? b : a,
    );
    const short = longest.lift.replace(/\s*\([^)]+\)/, "");
    return {
      severity: "warn",
      title: `${short} plateau — ${longest.plateau_weeks_flat} weeks flat`,
      body_md: `e1RM has not moved on ${short} for ${longest.plateau_weeks_flat} weeks. Coach will propose a rep-shift or deload at the next weekly review.`,
    };
  }

  // 2. Recomp drift — scale flat + BF% up.
  const wRate4w = input.body.weight.rate_kg_per_wk_4w;
  if (
    wRate4w != null && Math.abs(wRate4w * 4) <= RECOMP_DRIFT_WEIGHT_TOL_KG &&
    bf4w != null && bf4w >= RECOMP_DRIFT_BF_DELTA_PTS
  ) {
    return {
      severity: "warn",
      title: `Recomp drift — body fat +${bf4w.toFixed(1)} pts`,
      body_md: "Scale weight is roughly flat over 4 weeks but body fat ticked up. The deficit isn't deep enough at maintenance protein — check the Nutrition section for the full picture.",
    };
  }

  if (input.body.weight.in_band === false && input.body.weight.rate_kg_per_wk_4w != null) {
    const rate = input.body.weight.rate_kg_per_wk_4w;
    const aggressive = rate < input.body.weight.target_band.lower;
    return {
      severity: "warn",
      title: aggressive
        ? `Weight dropping ${rate.toFixed(1)} kg/wk — aggressive`
        : `Weight ${rate >= 0 ? "rising" : "falling slowly"} (${rate.toFixed(1)} kg/wk)`,
      body_md: aggressive
        ? "Loss rate is below the target band. Risk of LBM and strength loss — coach may hold loads at the next review."
        : "Loss rate is above the target band. If a cut is intended, deficit needs deepening; if maintenance, you're on track.",
    };
  }

  if (input.recovery.hrv.vs_baseline_pct_4w != null && input.recovery.hrv.vs_baseline_pct_4w < -0.05) {
    const pct = Math.abs(input.recovery.hrv.vs_baseline_pct_4w * 100);
    return {
      severity: "warn",
      title: `HRV ${pct.toFixed(0)}% below baseline`,
      body_md: "Average HRV over the last 4 weeks is below your 30-day baseline. Sleep, stress, or training load are candidates — check the Recovery section.",
    };
  }

  return {
    severity: "ok",
    title: "On track",
    body_md: "No plateau, weight loss in band, recovery near baseline. Stay the course.",
  };
}
