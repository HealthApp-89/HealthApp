// lib/coach/trends/index.ts
//
// Orchestrator: parallel-fetch supabase reads via the 5 composers,
// pick a headline insight from severity priority, return CoachTrendsPayload.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoachTrendsPayload } from "@/lib/data/types";
import { composeStrength } from "./compose-strength";
import { composeBody } from "./compose-body";
import { composeNutrition } from "./compose-nutrition";
import { composeRecovery } from "./compose-recovery";
import { composeCross } from "./compose-cross";

export async function generateCoachTrends(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<CoachTrendsPayload> {
  const [strength, body, nutrition, recovery, cross_insights] = await Promise.all([
    composeStrength(args),
    composeBody(args),
    composeNutrition(args),
    composeRecovery(args),
    composeCross(args),
  ]);

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    strength,
    body,
    nutrition,
    recovery,
    cross_insights,
    headline: pickHeadline({ strength, body, recovery }),
  };
}

function pickHeadline(input: {
  strength: CoachTrendsPayload["strength"];
  body: CoachTrendsPayload["body"];
  recovery: CoachTrendsPayload["recovery"];
}): CoachTrendsPayload["headline"] {
  const plateauedLifts = input.strength.per_lift.filter((p) => p.plateau_active);
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
