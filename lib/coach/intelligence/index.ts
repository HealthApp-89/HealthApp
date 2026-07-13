// lib/coach/intelligence/index.ts
//
// Intelligence Orchestrator — Task 10.
//
// buildAthleteIntelligence(supabase, userId, tz)
//   ↳ Fetches all data windows in a single Promise.all
//   ↳ Calls assembleIntelligence(data) — pure, testable without mocks
//   ↳ Returns validated AthleteIntelligencePayload
//
// assembleIntelligence(data)
//   ↳ Pure function: runs all 7 composers, zod-validates, returns payload.
//   ↳ Tested directly in orchestrator.test.ts with fixture data.
//
// Resilience contract:
//   The orchestrator wraps the whole flow in a try/catch. An unexpected
//   composer failure returns a minimal valid safe-default payload so the
//   snapshot still renders. Coaches get a snapshot even when intelligence fails.
//
// Timezone gate:
//   generated_on is derived via todayInUserTz (tz-aware).
//   No raw Date-to-string shortcut calls anywhere in this file.

import type { SupabaseClient } from "@supabase/supabase-js";
import { todayInUserTz } from "@/lib/time";
import { loadWorkouts } from "@/lib/data/workouts-server";
import type { WorkoutSession } from "@/lib/data/workouts";
import type { FoodLogEntry } from "@/lib/food/types";
import type { Rolling30dBaselines, IntakePayload, WhoopBaselinesJsonb, CoachInterventionRow, Injury } from "@/lib/data/types";
import { fetchActiveInjuries } from "@/lib/coach/injuries";
import { getTodayTargets } from "@/lib/morning/brief/get-today-targets";

// Layer 1 composers
import { composeAthleteIdentity } from "./athlete-identity";
import { composeConstraints } from "./constraints-summary";
import { composeCoachHistory } from "./coach-history";

// Layer 2 composers
import { composeRecoveryReadiness } from "./recovery-readiness";
import { composeNutritionPerformance } from "./nutrition-performance-linker";
import { composeInterference } from "./interference-checker";
import { composeBodyCompDirection } from "./body-comp-direction";

// Types
import {
  AthleteIntelligencePayloadSchema,
  type AthleteIntelligencePayload,
  type IdentityPayload,
  type ConstraintPayload,
  type HistoryPayload,
} from "./types";
import type { RecoveryReadinessResult } from "./recovery-readiness";
import type { NutritionPerformanceResult } from "./nutrition-performance-linker";
import type { InterferenceResult } from "./interference-checker";
import type { BodyCompDirectionResult } from "./body-comp-direction";

// ─────────────────────────────────────────────────────────────────────────────
// Safe defaults — returned when the orchestrator catches an unexpected error.
// These are valid AthleteIntelligencePayload values that let the snapshot
// render without crashing.
// ─────────────────────────────────────────────────────────────────────────────

const SAFE_IDENTITY: IdentityPayload = {
  top_exercises: { lower: [], upper: [], pulls: [], isolation: [] },
  eating_identity: {
    top_proteins: [],
    top_carbs: [],
    top_fats: [],
    cuisines: [],
    monotone_flags: [],
  },
  training_style_signature: {
    volume_preference: "low",
    // Phase 2 — not yet derived; null until computed
    intensity_distribution_percent: null,
    // Phase 2 — not yet derived; null until computed
    recovery_speed_days: null,
    // Phase 2 — not yet derived; null until computed
    session_duration_preference_min: null,
  },
};

const SAFE_CONSTRAINTS: ConstraintPayload = {
  active_injuries: [],
  exercise_exclusions: [],
  equipment_access: "commercial_gym",
  schedule_constraints: [],
};

const SAFE_HISTORY: HistoryPayload = {
  recent_deloads: [],
  exercise_swaps_8w: [],
  nutrition_interventions: [],
};

const SAFE_RECOVERY_READINESS: RecoveryReadinessResult = {
  status: "stalled",
  confidence: 0.3,
  drivers: [],
  recommendation: "continue_training",
  narrative: "Recovery data unavailable.",
};

const SAFE_NUTRITION_PERFORMANCE: NutritionPerformanceResult = {
  protein_status: "adequate",
  carb_timing_suboptimal: false,
  deficit_severity: "not_in_deficit",
  predicted_muscle_loss_risk: "low",
  drivers: [],
  narrative: "Nutrition data unavailable.",
};

const SAFE_INTERFERENCE: InterferenceResult = {
  interference_level: "none",
  tss_ratio_7d_28d: null,
  lift_trend: "insufficient_data",
  action: null,
  drivers: [],
  narrative: "No training data to assess interference.",
};

const SAFE_BODY_COMP: BodyCompDirectionResult = {
  direction: "unknown",
  confidence: 0.3,
  weeks_of_data: 0,
  weight_trend_kg_per_week: null,
  bodyfat_trend_pct_per_week: null,
  lift_trend: "insufficient_data",
  drivers: [],
  narrative: "Body composition data unavailable.",
};

// ─────────────────────────────────────────────────────────────────────────────
// Adapter: IntakePayload → composeConstraints input shape
// ─────────────────────────────────────────────────────────────────────────────
//
// The real data lives in athleteProfileRow.intake_payload (IntakePayload),
// not in separate document columns. We map the relevant intake fields.
// Moved from snapshot.ts so the orchestrator owns the adapter and snapshot.ts
// stays clean.

function buildLifestyleConstraints(intake: IntakePayload): string[] {
  const constraints: string[] = [];
  const days = intake.lifestyle.days_available;
  const daysAvailableCount = [
    days.mon,
    days.tue,
    days.wed,
    days.thu,
    days.fri,
    days.sat,
    days.sun,
  ].filter(Boolean).length;
  if (daysAvailableCount <= 3) {
    constraints.push("3 sessions per week max");
  }
  const latest = intake.lifestyle.latest_session_time;
  if (latest && latest <= "20:00") {
    constraints.push("evening training window");
  }
  if (
    intake.lifestyle.travel_frequency === "weekly" ||
    intake.lifestyle.travel_frequency === "monthly"
  ) {
    constraints.push("travel disrupts schedule");
  }
  return constraints;
}

function adaptIntakeToConstraintsProfile(intake: IntakePayload) {
  return {
    athlete_profile_documents: [
      {
        current_injuries: (intake.health.active_injuries ?? []).map((inj) => ({
          area: inj.joint,
          severity: "mild",
          weeks_since_onset: 0,
          exercises_to_avoid: inj.restriction ? [inj.restriction] : undefined,
        })),
        gym_type:
          intake.training.equipment.barbell ||
          intake.training.equipment.rack ||
          intake.training.equipment.cables ||
          intake.training.equipment.machines
            ? "commercial"
            : "home",
        lifestyle_constraints: buildLifestyleConstraints(intake),
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Input type for assembleIntelligence (pure, testable)
// ─────────────────────────────────────────────────────────────────────────────

export type IntelligenceData = {
  workouts: WorkoutSession[];
  /** Last 56 days of daily_logs including body comp + endurance_load columns */
  dailyLogs: Array<{
    date: string;
    hrv: number | null;
    resting_hr: number | null;
    recovery: number | null;
    sleep_hours: number | null;
    sleep_score: number | null;
    deep_sleep_hours: number | null;
    strain: number | null;
    steps?: number | null;
    weight_kg: number | null;
    body_fat_pct: number | null;
    fat_free_mass_kg: number | null;
    calories_eaten: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    endurance_load: number | null;
  }>;
  foodLogEntries: FoodLogEntry[];
  baselines: Rolling30dBaselines | null;
  intake: IntakePayload | null;
  targets: {
    kcal: number;
    protein_g: number;
    phase: "cut" | "maintain" | "lean_bulk" | "recomp" | "unsure";
  } | null;
  /**
   * Evaluated coach_interventions rows (last ~90d, outcome IS NOT NULL).
   * Defaults to empty array when no table exists or fetch fails.
   */
  interventionRows: CoachInterventionRow[];
  /** Active injury rows from the injuries table — merged into constraints block. */
  liveInjuries: Injury[];
  /** ISO date string derived from tz-aware "today" — used as generated_on anchor */
  today: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// assembleIntelligence — pure, testable assembly of all 7 composers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pure function: runs all 7 composers on already-fetched data and assembles
 * the validated AthleteIntelligencePayload.
 *
 * Extracted from buildAthleteIntelligence so it can be unit-tested with
 * fixture data without needing a Supabase mock.
 *
 * @throws if Zod validation fails on the assembled payload (should not happen
 *   in practice since each composer validates its own output before returning).
 */
export function assembleIntelligence(data: IntelligenceData): AthleteIntelligencePayload {
  const {
    workouts,
    dailyLogs,
    foodLogEntries,
    baselines,
    intake,
    targets,
    interventionRows,
    liveInjuries,
    today,
  } = data;

  // ── 90-day window for identity + history (composers sort internally) ────────
  // dailyLogs already contains up to 56d; workouts is full history. Filter to
  // 90d relative to today for the identity/history composers.
  const ninetyDaysAgoMs = new Date(`${today}T00:00:00Z`).getTime() - 90 * 86_400_000;
  const since90d = new Date(ninetyDaysAgoMs).toISOString().slice(0, 10);
  const workouts90d = workouts.filter((w) => w.date >= since90d);

  // ── Layer 1 composers ───────────────────────────────────────────────────────
  const identity = composeAthleteIdentity(workouts90d, foodLogEntries);

  const adaptedProfile = intake ? adaptIntakeToConstraintsProfile(intake) : null;
  const constraints = composeConstraints(adaptedProfile, liveInjuries, today);

  // coach-history requires steps: number | null (not optional) — normalize.
  const historyLogs = dailyLogs.map((l) => ({
    date: l.date,
    hrv: l.hrv,
    resting_hr: l.resting_hr,
    recovery: l.recovery,
    sleep_hours: l.sleep_hours,
    sleep_score: l.sleep_score,
    deep_sleep_hours: l.deep_sleep_hours,
    strain: l.strain,
    steps: l.steps ?? null,
    calories_eaten: l.calories_eaten,
    weight_kg: l.weight_kg,
    protein_g: l.protein_g,
    carbs_g: l.carbs_g,
    fat_g: l.fat_g,
  }));
  const history = composeCoachHistory(workouts90d, historyLogs, interventionRows);

  // ── Layer 2 composers ───────────────────────────────────────────────────────

  // Recovery readiness: last 7 days of daily_logs
  const logs7d = [...dailyLogs]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 7);
  const recovery_readiness = composeRecoveryReadiness(logs7d, baselines);

  // Nutrition vs performance: last 14 days of logs + workouts
  const logs14d = [...dailyLogs]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 14);
  const mostRecentWeight = dailyLogs
    .filter((l) => l.weight_kg !== null)
    .sort((a, b) => b.date.localeCompare(a.date))[0]?.weight_kg ?? null;

  const nutrition_performance = composeNutritionPerformance({
    dailyLogs: logs14d,
    workouts,
    targets: targets ?? { kcal: 2000, protein_g: 160, phase: "unsure" },
    bodyweight_kg: mostRecentWeight,
  });

  // Strength-endurance interference: last 28 days
  // last 28d — computeTssRatio's chronic baseline assumes a 28-day window
  const interference = composeInterference({
    dailyLogs: dailyLogs.slice(0, 28).map((d) => ({
      date: d.date,
      endurance_load: d.endurance_load,
    })),
    workouts,
  });

  // Body comp direction: last 56 days (full dailyLogs window)
  const body_comp_direction = composeBodyCompDirection({
    dailyLogs: dailyLogs.map((d) => ({
      date: d.date,
      weight_kg: d.weight_kg,
      body_fat_pct: d.body_fat_pct,
      fat_free_mass_kg: d.fat_free_mass_kg,
      protein_g: d.protein_g,
    })),
    workouts,
    bodyweight_kg: mostRecentWeight,
  });

  // ── Assemble + validate ────────────────────────────────────────────────────
  // generated_on: derive an ISO 8601 datetime from the tz-safe today string.
  // We append "T00:00:00.000Z" to make it a valid ISO 8601 datetime for the
  // Zod ISODatetime schema. The tz helper already gave us the correct local
  // calendar date; appending UTC midnight is appropriate for a "generated on
  // YYYY-MM-DD" field whose purpose is date-level identification, not
  // sub-second precision.
  const generated_on = `${today}T00:00:00.000Z`;

  const payload = {
    identity,
    constraints,
    history,
    recovery_readiness,
    nutrition_performance,
    interference,
    body_comp_direction,
    generated_on,
  };

  // Validate the assembled payload.
  const parsed = AthleteIntelligencePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `assembleIntelligence: payload failed schema validation — ${JSON.stringify(parsed.error.issues)}`,
    );
  }

  return parsed.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildAthleteIntelligence — composition root (does I/O, calls assembleIntelligence)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch all required data windows and assemble the AthleteIntelligencePayload.
 *
 * Resilience: wrapped in try/catch. On unexpected failure returns a minimal
 * valid safe-default payload so the snapshot can still render.
 *
 * @param supabase  RLS-respecting server client.
 * @param userId    Auth user ID.
 * @param tz        IANA timezone (from profiles.timezone).
 */
export async function buildAthleteIntelligence(
  supabase: SupabaseClient,
  userId: string,
  tz: string,
): Promise<AthleteIntelligencePayload> {
  try {
    const today = todayInUserTz(new Date(), tz);

    // Compute date bounds server-side (tz-aware today is the anchor).
    const d56 = new Date(`${today}T00:00:00Z`);
    d56.setUTCDate(d56.getUTCDate() - 56);
    const since56d = d56.toISOString().slice(0, 10);

    const d90 = new Date(`${today}T00:00:00Z`);
    d90.setUTCDate(d90.getUTCDate() - 90);
    const since90d = d90.toISOString().slice(0, 10);

    // ── Parallel data fetch ──────────────────────────────────────────────────
    const [
      workouts,
      { data: logsData },
      { data: profileData },
      { data: athleteProfileData },
      todayTargets,
      { data: foodLogData },
      { data: interventionsData },
      liveInjuries,
    ] = await Promise.all([
      // All workouts — identity and interference composers filter/slice internally.
      loadWorkouts(userId),

      // 56-day daily_logs with all columns needed by Layer 2 composers.
      supabase
        .from("daily_logs")
        .select(
          "date, hrv, resting_hr, recovery, sleep_hours, sleep_score, deep_sleep_hours, strain, steps, weight_kg, body_fat_pct, fat_free_mass_kg, calories_eaten, protein_g, carbs_g, fat_g, endurance_load",
        )
        .eq("user_id", userId)
        .gte("date", since56d)
        .lte("date", today)
        .order("date", { ascending: false }),

      // Profile: whoop_baselines (rolling_30d lives here).
      supabase
        .from("profiles")
        .select("whoop_baselines")
        .eq("user_id", userId)
        .maybeSingle(),

      // Active athlete profile: intake_payload for constraints adapter.
      supabase
        .from("athlete_profile_documents")
        .select("intake_payload")
        .eq("user_id", userId)
        .eq("status", "active")
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle(),

      // Today's targets (override → plan → intake resolution chain).
      getTodayTargets(supabase, userId),

      // 90-day food log entries for eating identity.
      supabase
        .from("food_log_entries")
        .select(
          "id, user_id, eaten_at, kind, meal_slot, raw_input, items, totals, is_estimated, is_favorite, status, created_at, updated_at",
        )
        .eq("user_id", userId)
        .eq("status", "committed")
        .gte("eaten_at", since90d + "T00:00:00Z")
        .order("eaten_at", { ascending: false }),

      // Last 90 days of evaluated coach_interventions (outcome IS NOT NULL).
      // Inconclusive rows (outcome.success = null) are filtered at the mapper level,
      // not here — we fetch all evaluated rows and let mapToHistory decide.
      supabase
        .from("coach_interventions")
        .select("id, user_id, kind, source, started_on, context, outcome, outcome_evaluated_at, created_at")
        .eq("user_id", userId)
        .not("outcome", "is", null)
        .gte("started_on", since90d)
        .order("started_on", { ascending: false }),

      // Active live injuries — merged into the constraints block.
      // Deliberate asymmetry: the injuries table is new (migration 0052) and live
      // injuries are an additive field — a fetch failure must degrade to "no live injuries"
      // rather than let the outer catch zero the ENTIRE intelligence payload.
      fetchActiveInjuries(supabase, userId).catch((err) => {
        console.warn("[buildAthleteIntelligence] fetchActiveInjuries failed — continuing without live injuries:", err);
        return [] as Injury[];
      }),
    ]);

    // ── Extract baselines ────────────────────────────────────────────────────
    const whoopBaselines = (profileData?.whoop_baselines ?? null) as WhoopBaselinesJsonb | null;
    const baselines = whoopBaselines?.rolling_30d ?? null;

    // ── Extract intake_payload ───────────────────────────────────────────────
    const intake = (athleteProfileData?.intake_payload ?? null) as IntakePayload | null;

    // ── Targets for nutrition-performance composer ───────────────────────────
    const targets = todayTargets
      ? {
          kcal: todayTargets.kcal,
          protein_g: todayTargets.protein_g,
          phase: todayTargets.phase,
        }
      : null;

    // ── Assemble payload via pure function ───────────────────────────────────
    return assembleIntelligence({
      workouts,
      dailyLogs: (logsData ?? []) as IntelligenceData["dailyLogs"],
      foodLogEntries: (foodLogData ?? []) as FoodLogEntry[],
      baselines,
      intake,
      targets,
      interventionRows: (interventionsData ?? []) as CoachInterventionRow[],
      liveInjuries,
      today,
    });
  } catch (err) {
    // Resilience: intelligence failure must NOT break the snapshot.
    // Return a minimal valid payload so callers can degrade gracefully.
    console.error("[buildAthleteIntelligence] error — returning safe default:", err);

    // Safe-default generated_on: tz-aware today or ISO epoch as last resort.
    let generated_on: string;
    try {
      generated_on = `${todayInUserTz(new Date(), tz)}T00:00:00.000Z`;
    } catch {
      generated_on = "1970-01-01T00:00:00.000Z";
    }

    return {
      identity: SAFE_IDENTITY,
      constraints: SAFE_CONSTRAINTS,
      history: SAFE_HISTORY,
      recovery_readiness: SAFE_RECOVERY_READINESS,
      nutrition_performance: SAFE_NUTRITION_PERFORMANCE,
      interference: SAFE_INTERFERENCE,
      body_comp_direction: SAFE_BODY_COMP,
      generated_on,
    };
  }
}
