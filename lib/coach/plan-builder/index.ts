// lib/coach/plan-builder/index.ts
//
// Orchestrates plan_payload generation:
//   1. Fetch supporting data in parallel (latest bodyweight, recent e1RMs,
//      active block, profile basics, rolling 7d kcal).
//   2. Run sanity checks (deterministic) — caller decides whether to surface
//      them in chat or proceed.
//   3. Compose all 8 sections (deterministic).
//   4. Single AI call to populate narrative fields (goal_summary,
//      strength_notes, nutrition_notes).
//   5. Return full PlanPayload.
//
// Cost: ~$0.018 per call (one Sonnet 4.6 call for narrative).

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  IntakePayload,
  PlanPayload,
  Profile,
  TrainingBlock,
  SanityFinding,
} from "@/lib/data/types";
import type { Workout } from "@/lib/coach/muscle-volume";
import { runSanityChecks } from "@/lib/coach/plan-builder/sanity-check";
import { planIntelligenceChecks } from "@/lib/coach/plan-builder/plan-intelligence-checks";
import { applyFlagResolutions, DEFAULT_COMPOSER_INPUTS } from "@/lib/coach/plan-builder/apply-flag-resolutions";
import { composeSnapshot } from "@/lib/coach/plan-builder/compose-snapshot";
import { composeGoal } from "@/lib/coach/plan-builder/compose-goal";
import { composePeriodization } from "@/lib/coach/plan-builder/compose-periodization";
import { composeStrengthTemplate, type RecentE1RMsForStrength } from "@/lib/coach/plan-builder/compose-strength";
import { composeNutrition } from "@/lib/coach/plan-builder/compose-nutrition";
import { composeSleep } from "@/lib/coach/plan-builder/compose-sleep";
import { composeRecovery } from "@/lib/coach/plan-builder/compose-recovery";
import { composeCoachingAgreement } from "@/lib/coach/plan-builder/compose-coaching-agreement";
import { generatePlanNarrative } from "@/lib/coach/plan-builder/narrative-prompt";
import { buildAthleteIntelligence } from "@/lib/coach/intelligence/index";
import { summarizeResponsiveness } from "@/lib/coach/interventions/responsiveness";
import { todayInUserTz } from "@/lib/time";
import { getUserTimezone } from "@/lib/time/get-user-tz";

export type BuildPlanResult = {
  plan_payload: PlanPayload;
  /** Sanity findings detected during build. Caller surfaces in chat Beat 1
   *  OR returns an error if findings exist and haven't been addressed
   *  (overridden or corrected). */
  sanity_findings: SanityFinding[];
};

export async function buildPlanPayload(
  supabase: SupabaseClient,
  userId: string,
  intake: IntakePayload,
): Promise<BuildPlanResult> {
  const tz = await getUserTimezone(userId);
  const today = todayInUserTz(new Date(), tz);

  // Parallel fetches — intelligence is graceful (.catch(() => null) so failure
  // never breaks plan generation; planIntelligenceChecks returns [] on null).
  const [profileRes, recentLogsRes, recentWorkoutData, activeBlockRes, intelligence] = await Promise.all([
    supabase
      .from("profiles")
      .select("name, age, height_cm")
      .eq("user_id", userId)
      .maybeSingle(),
    supabase
      .from("daily_logs")
      .select("date, weight_kg, calories_eaten")
      .eq("user_id", userId)
      .order("date", { ascending: false })
      .limit(30),
    fetchRecentWorkoutData(supabase, userId),
    supabase
      .from("training_blocks")
      .select("primary_lift")
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle(),
    // Graceful: if buildAthleteIntelligence fails (or returns a safe-default
    // that still breaks caller logic), we catch and degrade to null.
    // planIntelligenceChecks returns [] when intelligence === null, so no flags
    // fire and plan generation proceeds exactly as before.
    buildAthleteIntelligence(supabase, userId, tz).catch(() => null),
  ]);

  if (profileRes.error) throw profileRes.error;
  if (recentLogsRes.error) throw recentLogsRes.error;
  if (activeBlockRes.error) throw activeBlockRes.error;
  // recentWorkoutData: fetchRecentWorkoutData throws internally on Supabase error;
  // its rejection bubbles up via Promise.all, no extra check needed.

  const profile = profileRes.data as Pick<Profile, "name" | "age" | "height_cm"> | null;
  const recentLogs = recentLogsRes.data ?? [];
  const activeBlock = activeBlockRes.data as Pick<TrainingBlock, "primary_lift"> | null;

  // Latest bodyweight: first non-null weight_kg in the 30-day window
  const latestWeight = recentLogs.find((r) => r.weight_kg !== null)?.weight_kg ?? null;
  const currentBodyweight = latestWeight ?? null;

  // Rolling 7d kcal avg
  const last7 = recentLogs.slice(0, 7);
  const kcalSamples = last7
    .map((r) => r.calories_eaten)
    .filter((v): v is number => typeof v === "number" && v > 0);
  const rolling7dKcal =
    kcalSamples.length > 0
      ? kcalSamples.reduce((a, b) => a + b, 0) / kcalSamples.length
      : null;

  // Responsiveness rollup from coach_interventions (guarded: null if fetch fails
  // or intelligence is null). Used by planIntelligenceChecks for responsiveness_note.
  let responsiveness = null;
  if (intelligence !== null) {
    try {
      const ninety = new Date(`${today}T00:00:00Z`);
      ninety.setUTCDate(ninety.getUTCDate() - 90);
      const since90 = ninety.toISOString().slice(0, 10);
      const { data: interventionRows } = await supabase
        .from("coach_interventions")
        .select("id, user_id, kind, source, started_on, context, outcome, outcome_evaluated_at, created_at")
        .eq("user_id", userId)
        .not("outcome", "is", null)
        .gte("started_on", since90)
        .order("started_on", { ascending: false });
      responsiveness = summarizeResponsiveness(interventionRows ?? [], today);
    } catch {
      // Graceful: missing/failed interventions table → no responsiveness notes,
      // but flags can still fire (they just omit responsiveness_note).
      responsiveness = null;
    }
  }

  // Sanity checks (original 4 deterministic checks)
  const sanityFindings = runSanityChecks({
    intake,
    current_bodyweight_kg: currentBodyweight,
    rolling_7d_kcal: rolling7dKcal,
    today,
  });

  // Intelligence-layer plan flags (may be [] if intelligence is null or no
  // flag's data is conclusive — graceful degradation is load-bearing).
  const flagFindings = planIntelligenceChecks({ intake, intelligence, responsiveness });
  const allFindings = [...sanityFindings, ...flagFindings];

  // Apply accepted flag resolutions to composer inputs BEFORE invoking composers.
  // "override" / absent → unchanged (DEFAULT_COMPOSER_INPUTS pass-through).
  const composerInputs = applyFlagResolutions(
    DEFAULT_COMPOSER_INPUTS,
    allFindings,
    intake.plan_flag_resolutions,
  );

  // Bodyweight needed for nutrition composer.
  //
  // Signal chain:
  //   1. currentBodyweight — most recent non-null weight_kg from the 30-day
  //      daily_logs window (primary; already fetched above).
  //   2. intelligence.body_comp_direction — does NOT carry an absolute weight
  //      (only a per-week slope). No second source available from the payload.
  //   3. Numeric default (85 kg) — only when genuinely nothing is logged.
  //      console.warn so the default is auditable in Vercel logs.
  //
  // The common path (currentBodyweight present) is byte-identical to before.
  const BODYWEIGHT_DEFAULT_KG = 85;
  if (currentBodyweight === null) {
    console.warn(
      `[buildPlanPayload] userId=${userId}: no weight logged in last 30d — ` +
        `falling back to ${BODYWEIGHT_DEFAULT_KG} kg for nutrition composer. ` +
        `Athlete should log a weigh-in before committing the plan.`,
    );
  }
  const bodyweightForComposers = currentBodyweight ?? BODYWEIGHT_DEFAULT_KG;

  // Extract constraints + identity from intelligence (null when intelligence unavailable).
  // Both optional → composeStrengthTemplate gracefully omits constraint-aware selection.
  const constraints = intelligence?.constraints ?? null;
  const identity = intelligence?.identity ?? null;

  // Deterministic skeleton
  const athlete_snapshot = composeSnapshot(intake, profile);
  const goal = composeGoal(intake);
  const periodization = composePeriodization(intake);

  // Thread strengthVolumeMultiplier + constraint/identity into composeStrengthTemplate.
  // When no flags accepted, multiplier = 1.0 → byte-identical to prior behavior.
  // When constraints/identity absent, exercise selection is unchanged.
  const { strength, adjustments: exerciseAdjustments } = composeStrengthTemplate(
    intake,
    activeBlock,
    recentWorkoutData.e1rms,
    recentWorkoutData.workouts,
    {
      strengthVolumeMultiplier: composerInputs.strengthVolumeMultiplier,
      constraints,
      identity,
    },
  );

  // TODO Task 4: thread acknowledged_on from caller (commit_plan tool has the
  // active profile version's acknowledged_on; resolveMode handles null gracefully).
  // nutritionProteinFloorGPerKg and nutritionRampWeeks now threaded into composeNutrition.
  // When no flags accepted: floor = 1.6 (default), rampWeeks = 0 → byte-identical to prior behavior.
  const nutrition = composeNutrition({
    intake,
    goal,
    bodyweight_kg: bodyweightForComposers,
    acknowledged_on: null,
    nutritionProteinFloorGPerKg: composerInputs.nutritionProteinFloorGPerKg,
    nutritionRampWeeks: composerInputs.nutritionRampWeeks,
  });
  const sleep = composeSleep(intake);
  const recovery = composeRecovery(intake);
  const coaching_agreement = composeCoachingAgreement(intake);

  // AI narrative pass
  const narrative = await generatePlanNarrative({
    intake,
    skeleton: { goal, strength, nutrition, sleep, recovery, coaching_agreement },
    adjustments: exerciseAdjustments,
  });

  const plan_payload: PlanPayload = {
    schema_version: 1,
    athlete_snapshot,
    goal: { ...goal, narrative_summary: narrative.goal_summary },
    periodization,
    strength: { ...strength, notes: narrative.strength_notes },
    nutrition: { ...nutrition, notes: narrative.nutrition_notes },
    sleep,
    recovery,
    coaching_agreement,
    // Constraint/identity exercise adjustments — empty array when none applied.
    adjustments: exerciseAdjustments,
  };

  return { plan_payload, sanity_findings: allFindings };
}

async function fetchRecentWorkoutData(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ e1rms: RecentE1RMsForStrength; workouts: Workout[] }> {
  const eightWeeksAgo = new Date();
  eightWeeksAgo.setUTCDate(eightWeeksAgo.getUTCDate() - 56);
  const since = eightWeeksAgo.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("workouts")
    .select(
      "date, exercises (name, sets:exercise_sets (kg, reps, warmup))",
    )
    .eq("user_id", userId)
    .gte("date", since);
  if (error) throw error;

  // Shape for muscle-volume composer
  const workouts: Workout[] = (data ?? []).map((w: any) => ({
    date: w.date,
    exercises: (w.exercises ?? []).map((e: any) => ({
      name: e.name,
      sets: (e.sets ?? []).map((s: any) => ({
        kg: s.kg,
        reps: s.reps,
        warmup: s.warmup,
      })),
    })),
  }));

  // Existing e1RM extraction (preserve verbatim from the prior function)
  const regex: Record<keyof RecentE1RMsForStrength, RegExp> = {
    squat: /\b(back\s+squat|squat)\b/i,
    bench: /\b(bench\s+press|bench)\b/i,
    deadlift: /\b(deadlift|conventional\s+deadlift|sumo\s+deadlift)\b/i,
    ohp: /\b(overhead\s+press|ohp|military\s+press|strict\s+press)\b/i,
  };

  const e1rms: RecentE1RMsForStrength = {
    squat: null,
    bench: null,
    deadlift: null,
    ohp: null,
  };

  for (const w of workouts) {
    for (const e of w.exercises) {
      const lift = (
        Object.entries(regex) as Array<[keyof RecentE1RMsForStrength, RegExp]>
      ).find(([, re]) => re.test(e.name))?.[0];
      if (!lift) continue;
      for (const s of e.sets) {
        if (s.warmup) continue;
        if (s.kg === null || s.reps === null) continue;
        if (s.reps > 12) continue;
        const e1rm = Math.round(s.kg * (1 + s.reps / 30));
        if (e1rms[lift] === null || e1rm > e1rms[lift]!) e1rms[lift] = e1rm;
      }
    }
  }

  return { e1rms, workouts };
}
