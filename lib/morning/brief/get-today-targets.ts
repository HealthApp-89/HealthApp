// lib/morning/brief/get-today-targets.ts
//
// Phase-1/Phase-2 abstraction for daily targets. Insulates the brief
// renderer from where the macros / sleep target come from.
//
// Phase 1: reads from athlete_profile_documents.intake_payload (current
//   self-reported targets the user set during /onboarding).
// Phase 2: reads from plan_payload.nutrition / plan_payload.sleep
//   (AI-generated prescribed targets) when an active plan exists.
//
// The function signature is stable across phases. Brief consumers don't
// know which source is feeding them, but the `source` discriminator is
// exposed so Advice-block phrasing can adapt ("your plan says…" vs
// "your intake baseline says…").
//
// GLP-1-aware nutrition (Task 4): resolves the active nutrition mode
// (glp1_active | glp1_tapering | classical | steady_state) and, for
// GLP-1 modes, computes a 7-day rolling deficit alarm. For classical
// mode, finds the active PhaseStep by elapsed weeks since
// acknowledged_at and applies training_day_uplift / rest_day_delta
// at read time.

import type { SupabaseClient } from "@supabase/supabase-js";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import { weekdayInUserTz } from "@/lib/time";
import type {
  IntakePayload,
  PlanPayload,
  ResolvedNutritionMode,
  Glp1Config,
  PhaseStep,
} from "@/lib/data/types";
import { todayInUserTz } from "@/lib/time";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { type MealRatios, DEFAULT_MEAL_RATIOS } from "@/lib/food/meal-targets";
export type { MealRatios };

export type TodayTargetsSourceMap = {
  kcal: "override" | "plan" | "intake";
  macros: "override" | "plan" | "intake";
  meal_ratios: "override" | "default";
};

export type TodayTargets = {
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  bedtime: string;             // "HH:mm"
  sleep_hours_target: number;  // midpoint of plan's min/max band when plan exists
  phase: "cut" | "maintain" | "lean_bulk" | "recomp" | "unsure";
  /** Which artifact fed these numbers. */
  source: "plan" | "intake";

  // ── GLP-1-aware nutrition fields (Task 4) ──
  mode: ResolvedNutritionMode;
  is_training_day: boolean;
  /** Adherence-based alarm (GLP-1 modes only).
   *  Semantics: fires when the 7-day average intake is more than
   *  `threshold_kcal_per_day` below the user's RESOLVED kcal target
   *  (post-override). The target is treated as the contract; the alarm
   *  policies drift from it, not the existence of a deficit the user
   *  chose. Reframed 2026-05-27 (was TDEE-based, fired on every cut
   *  whose target itself exceeded the safety floor).
   *  - rolling_7d_avg_deficit: target − avg_intake (positive = undereating).
   *  - threshold_kcal_per_day: the grace value; intakes within ±this are fine. */
  deficit_alarm: {
    threshold_kcal_per_day: number;
    rolling_7d_avg_intake: number | null;
    rolling_7d_avg_deficit: number | null;
    triggered: boolean;
  } | null;
  hydration_target_ml: number | null;
  sodium_target_mg: number | null;
  /** When mode === "classical", the active PhaseStep's mode
   *  (cut | diet_break | reverse | maintain). null otherwise.
   *  Consumed by the Advice prompt for diet-break / reverse context. */
  today_phase_mode: PhaseStep["mode"] | null;
  meal_ratios: MealRatios;
  source_per_field: TodayTargetsSourceMap;
};

function resolveMode(
  glp1: Glp1Config | null,
  classical_phases: PhaseStep[] | null,
): ResolvedNutritionMode {
  if (glp1) {
    return glp1.taper_started_on ? "glp1_tapering" : "glp1_active";
  }
  if (classical_phases?.length) return "classical";
  return "steady_state";
}

async function isTrainingDay(
  supabase: SupabaseClient,
  userId: string,
  today: string,
  tz: string,
): Promise<boolean> {
  // Week start: Monday-anchored. Compute the Monday of the current week.
  const todayD = new Date(`${today}T00:00:00Z`);
  const dayOfWeek = todayD.getUTCDay();             // 0=Sun, 1=Mon, ...
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const mondayD = new Date(todayD);
  mondayD.setUTCDate(mondayD.getUTCDate() - daysSinceMonday);
  const weekStart = mondayD.toISOString().slice(0, 10);

  const { data } = await supabase
    .from("training_weeks")
    .select("session_plan")
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (!data?.session_plan) return false;

  // session_plan keys may be 3-letter ("Mon") or full ("Monday"); read
  // via readSessionForDay so both shapes resolve. weekdayInUserTz returns
  // the full-name form ("Monday") which is what the AI bot writes.
  const todayLabel = weekdayInUserTz(todayD, tz);
  const session = readSessionForDay(
    data.session_plan as Record<string, string>,
    todayLabel,
  ) ?? "REST";
  return session.toUpperCase() !== "REST";
}

async function rolling7dAvgIntake(
  supabase: SupabaseClient,
  userId: string,
  today: string,
): Promise<number | null> {
  const sevenDaysAgo = new Date(`${today}T00:00:00Z`);
  sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
  const since = sevenDaysAgo.toISOString().slice(0, 10);

  const { data: logs } = await supabase
    .from("daily_logs")
    .select("date, calories_eaten")
    .eq("user_id", userId)
    .gte("date", since)
    .lt("date", today)
    .order("date", { ascending: false });

  const samples = (logs ?? [])
    .map((r) => r.calories_eaten)
    .filter((v): v is number => typeof v === "number" && v > 0);

  if (samples.length === 0) return null;
  return Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
}

/** Grace band: intakes within ±this of the resolved target are considered
 *  on-plan. Outside the band (avg intake > grace BELOW target) triggers
 *  the alarm. Chosen at 300 kcal/day to absorb normal day-to-day variance
 *  without nagging users hitting their target. */
const ADHERENCE_GRACE_KCAL = 300;

function buildAdherenceAlarm(
  targetKcal: number,
  avgIntake: number | null,
): TodayTargets["deficit_alarm"] {
  // target − intake: positive = undereating, negative = overeating.
  const under = avgIntake === null ? null : targetKcal - avgIntake;
  return {
    threshold_kcal_per_day: ADHERENCE_GRACE_KCAL,
    rolling_7d_avg_intake: avgIntake,
    rolling_7d_avg_deficit: under,
    triggered: under !== null && under > ADHERENCE_GRACE_KCAL,
  };
}

/** Returns the effective kcal target AFTER overrides are applied. Mirror
 *  of the kcal resolution inside applyOverrides, hoisted so the alarm can
 *  be computed against the post-override target. */
function resolveEffectiveKcal(baseKcal: number, overrides: NutritionOverrides): number {
  return overrides?.kcal ?? baseKcal;
}

type NutritionOverrides = {
  kcal?: number;
  macro_ratios?: { protein_pct: number; carbs_pct: number; fat_pct: number };
  meal_ratios?: MealRatios;
} | null;

async function getOverrides(
  supabase: SupabaseClient,
  userId: string,
): Promise<NutritionOverrides> {
  const { data, error } = await supabase
    .from("profiles")
    .select("nutrition_overrides")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data?.nutrition_overrides ?? null) as NutritionOverrides;
}

function applyOverrides(
  base: Omit<TodayTargets, "meal_ratios" | "source_per_field">,
  overrides: NutritionOverrides,
): TodayTargets {
  // Per-field override semantics:
  //  - override.kcal alone changes only kcal; protein_g/carb_g/fat_g stay
  //    at the base values (acceptable UX: the user opted into manual
  //    control, the meal-split display surfaces the discrepancy).
  //  - override.macro_ratios recomputes grams against the effective kcal.
  //  - override.meal_ratios is orthogonal to kcal/macros.
  const finalKcal = overrides?.kcal ?? base.kcal;

  let protein_g = base.protein_g;
  let carb_g = base.carb_g;
  let fat_g = base.fat_g;
  if (overrides?.macro_ratios) {
    protein_g = Math.round((finalKcal * overrides.macro_ratios.protein_pct) / 4);
    carb_g    = Math.round((finalKcal * overrides.macro_ratios.carbs_pct)   / 4);
    fat_g     = Math.round((finalKcal * overrides.macro_ratios.fat_pct)     / 9);
  }

  const meal_ratios = overrides?.meal_ratios ?? DEFAULT_MEAL_RATIOS;

  const source_per_field: TodayTargetsSourceMap = {
    kcal:        overrides?.kcal !== undefined         ? "override" : (base.source as "plan" | "intake"),
    macros:      overrides?.macro_ratios !== undefined ? "override" : (base.source as "plan" | "intake"),
    meal_ratios: overrides?.meal_ratios !== undefined  ? "override" : "default",
  };

  return {
    ...base,
    kcal: finalKcal,
    protein_g,
    carb_g,
    fat_g,
    meal_ratios,
    source_per_field,
  };
}

/** Returns null when the user has no active athlete_profile_documents row
 *  (i.e., they haven't completed Phase 1 onboarding yet). Callers should
 *  degrade gracefully — the brief still renders with placeholder macros. */
export async function getTodayTargets(
  supabase: SupabaseClient,
  userId: string,
): Promise<TodayTargets | null> {
  const { data, error } = await supabase
    .from("athlete_profile_documents")
    .select("intake_payload, plan_payload, acknowledged_at")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const overrides = await getOverrides(supabase, userId);
  const tz = await getUserTimezone(userId);
  const today = todayInUserTz(new Date(), tz);

  // Phase 2 path: plan_payload exists
  if (data.plan_payload) {
    const plan = data.plan_payload as PlanPayload;
    const glp1 = plan.nutrition.glp1 ?? null;
    const classical = plan.nutrition.classical_phases ?? null;
    const mode = resolveMode(glp1, classical);
    const is_training_day = await isTrainingDay(supabase, userId, today, tz);

    if (mode === "glp1_active" && glp1) {
      // Alarm fires when avg intake drifts more than ADHERENCE_GRACE_KCAL
      // below the user's RESOLVED kcal target (post-override). The target
      // is the contract; the alarm policies drift from it, not the
      // existence of a deficit the user chose to set up.
      const effectiveKcal = resolveEffectiveKcal(plan.nutrition.kcal_target, overrides);
      const avgIntake = await rolling7dAvgIntake(supabase, userId, today);
      const base = {
        kcal: plan.nutrition.kcal_target,
        protein_g: plan.nutrition.protein_g,
        carb_g: plan.nutrition.carb_g,
        fat_g: plan.nutrition.fat_g,
        bedtime: plan.sleep.bedtime_target,
        sleep_hours_target: (plan.sleep.target_hours_min + plan.sleep.target_hours_max) / 2,
        phase: plan.nutrition.phase,
        source: "plan" as const,
        mode: "glp1_active" as const,
        is_training_day,
        deficit_alarm: buildAdherenceAlarm(effectiveKcal, avgIntake),
        hydration_target_ml: is_training_day ? glp1.hydration_training_day_ml : null,
        sodium_target_mg: is_training_day ? glp1.sodium_training_day_mg : null,
        today_phase_mode: null,
      };
      return applyOverrides(base, overrides);
    }

    if (mode === "glp1_tapering" && glp1) {
      const effectiveKcal = resolveEffectiveKcal(plan.nutrition.kcal_target, overrides);
      const avgIntake = await rolling7dAvgIntake(supabase, userId, today);
      const base = {
        kcal: plan.nutrition.kcal_target,    // composer leaves this at active-phase value
        protein_g: plan.nutrition.protein_g,
        carb_g: plan.nutrition.carb_g,
        fat_g: plan.nutrition.fat_g,
        bedtime: plan.sleep.bedtime_target,
        sleep_hours_target: (plan.sleep.target_hours_min + plan.sleep.target_hours_max) / 2,
        phase: plan.nutrition.phase,
        source: "plan" as const,
        mode: "glp1_tapering" as const,
        is_training_day,
        deficit_alarm: buildAdherenceAlarm(effectiveKcal, avgIntake),
        hydration_target_ml: is_training_day ? glp1.hydration_training_day_ml : null,
        sodium_target_mg: is_training_day ? glp1.sodium_training_day_mg : null,
        today_phase_mode: null,
      };
      return applyOverrides(base, overrides);
    }

    if (mode === "classical" && classical) {
      const ack = data.acknowledged_at;
      const elapsedWeeks = ack
        ? Math.floor((Date.parse(today) - Date.parse(ack)) / (7 * 86_400_000))
        : 0;
      const step =
        classical.find((s) => s.start_week <= elapsedWeeks && elapsedWeeks < s.end_week) ??
        classical[classical.length - 1];

      // training_day_uplift / rest_day_delta only apply during sustained cut
      // blocks. Diet-break and reverse phases own their full macro budget;
      // applying a +200 kcal training uplift on top of a +400 diet-break kcal
      // would compound to +600 (nutritionally wrong, contradicts the spec's
      // "+400 to carbs" framing). Maintain phase also runs uplift-free.
      const applyDeltas = step.mode === "cut";
      const uplift = applyDeltas ? plan.nutrition.training_day_uplift : null;
      const restDelta = applyDeltas ? plan.nutrition.rest_day_delta : null;
      const kcalDelta = is_training_day ? (uplift?.kcal ?? 0) : (restDelta?.kcal ?? 0);
      const carbDelta = is_training_day ? (uplift?.carb_g ?? 0) : (restDelta?.carb_g ?? 0);
      const fatDelta = is_training_day ? 0 : (restDelta?.fat_g ?? 0);

      const base = {
        kcal: step.kcal + kcalDelta,
        protein_g: step.protein_g,
        carb_g: step.carb_g + carbDelta,
        fat_g: step.fat_g + fatDelta,
        bedtime: plan.sleep.bedtime_target,
        sleep_hours_target: (plan.sleep.target_hours_min + plan.sleep.target_hours_max) / 2,
        phase:
          step.mode === "cut" ? "cut" as const :
          step.mode === "diet_break" ? "cut" as const :     // still in a cut context
          step.mode === "reverse" ? "maintain" as const :
          "maintain" as const,
        source: "plan" as const,
        mode: "classical" as const,
        is_training_day,
        deficit_alarm: null,
        hydration_target_ml: null,
        sodium_target_mg: null,
        today_phase_mode: step.mode,
      };
      return applyOverrides(base, overrides);
    }

    // steady_state fallback: existing Phase 2 behavior
    const base = {
      kcal: plan.nutrition.kcal_target,
      protein_g: plan.nutrition.protein_g,
      carb_g: plan.nutrition.carb_g,
      fat_g: plan.nutrition.fat_g,
      bedtime: plan.sleep.bedtime_target,
      sleep_hours_target: (plan.sleep.target_hours_min + plan.sleep.target_hours_max) / 2,
      phase: plan.nutrition.phase,
      source: "plan" as const,
      mode: "steady_state" as const,
      is_training_day,
      deficit_alarm: null,
      hydration_target_ml: null,
      sodium_target_mg: null,
      today_phase_mode: null,
    };
    return applyOverrides(base, overrides);
  }

  // Phase 1 fallback: intake_payload only
  const payload = data.intake_payload as IntakePayload;
  const base = {
    kcal: payload.nutrition.current_kcal,
    protein_g: payload.nutrition.current_macros.protein_g,
    carb_g: payload.nutrition.current_macros.carb_g,
    fat_g: payload.nutrition.current_macros.fat_g,
    bedtime: payload.sleep_recovery.typical_bedtime,
    sleep_hours_target: payload.sleep_recovery.avg_sleep_hours,
    phase: payload.nutrition.current_phase,
    source: "intake" as const,
    mode: "steady_state" as const,
    is_training_day: false,
    deficit_alarm: null,
    hydration_target_ml: null,
    sodium_target_mg: null,
    today_phase_mode: null,
  };
  return applyOverrides(base, overrides);
}
