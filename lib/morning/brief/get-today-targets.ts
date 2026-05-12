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
import type {
  IntakePayload,
  PlanPayload,
  ResolvedNutritionMode,
  Glp1Config,
  PhaseStep,
} from "@/lib/data/types";
import { todayInUserTz } from "@/lib/time";

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

  // session_plan is { Mon: "Chest", Tue: "Legs", ..., Sun: "REST" }
  const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const todayLabel = labels[daysSinceMonday];
  const session = (data.session_plan as Record<string, string>)[todayLabel] ?? "REST";
  return session.toUpperCase() !== "REST";
}

async function rolling7dDeficit(
  supabase: SupabaseClient,
  userId: string,
  today: string,
  tdee_estimate_kcal: number,
): Promise<{ avg_intake: number | null; avg_deficit: number | null }> {
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

  if (samples.length === 0) return { avg_intake: null, avg_deficit: null };
  const avg_intake = samples.reduce((a, b) => a + b, 0) / samples.length;
  const avg_deficit = tdee_estimate_kcal - avg_intake;
  return {
    avg_intake: Math.round(avg_intake),
    avg_deficit: Math.round(avg_deficit),
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

  const today = todayInUserTz();

  // Phase 2 path: plan_payload exists
  if (data.plan_payload) {
    const plan = data.plan_payload as PlanPayload;
    const glp1 = plan.nutrition.glp1 ?? null;
    const classical = plan.nutrition.classical_phases ?? null;
    const mode = resolveMode(glp1, classical);
    const is_training_day = await isTrainingDay(supabase, userId, today);

    if (mode === "glp1_active" && glp1) {
      const def = await rolling7dDeficit(supabase, userId, today, glp1.tdee_estimate_kcal);
      const threshold = Math.max(
        glp1.deficit_alarm_kcal,
        Math.round(glp1.tdee_estimate_kcal * glp1.deficit_alarm_pct),
      );
      return {
        kcal: plan.nutrition.kcal_target,
        protein_g: plan.nutrition.protein_g,
        carb_g: plan.nutrition.carb_g,
        fat_g: plan.nutrition.fat_g,
        bedtime: plan.sleep.bedtime_target,
        sleep_hours_target: (plan.sleep.target_hours_min + plan.sleep.target_hours_max) / 2,
        phase: plan.nutrition.phase,
        source: "plan",
        mode: "glp1_active",
        is_training_day,
        deficit_alarm: {
          threshold_kcal_per_day: threshold,
          rolling_7d_avg_intake: def.avg_intake,
          rolling_7d_avg_deficit: def.avg_deficit,
          triggered: def.avg_deficit !== null && def.avg_deficit > threshold,
        },
        hydration_target_ml: is_training_day ? glp1.hydration_training_day_ml : null,
        sodium_target_mg: is_training_day ? glp1.sodium_training_day_mg : null,
        today_phase_mode: null,
      };
    }

    if (mode === "glp1_tapering" && glp1) {
      const def = await rolling7dDeficit(supabase, userId, today, glp1.tdee_estimate_kcal);
      const threshold = Math.round(glp1.deficit_alarm_kcal * 0.85);  // relaxed during taper
      return {
        kcal: plan.nutrition.kcal_target,    // composer leaves this at active-phase value
        protein_g: plan.nutrition.protein_g,
        carb_g: plan.nutrition.carb_g,
        fat_g: plan.nutrition.fat_g,
        bedtime: plan.sleep.bedtime_target,
        sleep_hours_target: (plan.sleep.target_hours_min + plan.sleep.target_hours_max) / 2,
        phase: plan.nutrition.phase,
        source: "plan",
        mode: "glp1_tapering",
        is_training_day,
        deficit_alarm: {
          threshold_kcal_per_day: threshold,
          rolling_7d_avg_intake: def.avg_intake,
          rolling_7d_avg_deficit: def.avg_deficit,
          triggered: def.avg_deficit !== null && def.avg_deficit > threshold,
        },
        hydration_target_ml: is_training_day ? glp1.hydration_training_day_ml : null,
        sodium_target_mg: is_training_day ? glp1.sodium_training_day_mg : null,
        today_phase_mode: null,
      };
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

      return {
        kcal: step.kcal + kcalDelta,
        protein_g: step.protein_g,
        carb_g: step.carb_g + carbDelta,
        fat_g: step.fat_g + fatDelta,
        bedtime: plan.sleep.bedtime_target,
        sleep_hours_target: (plan.sleep.target_hours_min + plan.sleep.target_hours_max) / 2,
        phase:
          step.mode === "cut" ? "cut" :
          step.mode === "diet_break" ? "cut" :     // still in a cut context
          step.mode === "reverse" ? "maintain" :
          "maintain",
        source: "plan",
        mode: "classical",
        is_training_day,
        deficit_alarm: null,
        hydration_target_ml: null,
        sodium_target_mg: null,
        today_phase_mode: step.mode,
      };
    }

    // steady_state fallback: existing Phase 2 behavior
    return {
      kcal: plan.nutrition.kcal_target,
      protein_g: plan.nutrition.protein_g,
      carb_g: plan.nutrition.carb_g,
      fat_g: plan.nutrition.fat_g,
      bedtime: plan.sleep.bedtime_target,
      sleep_hours_target: (plan.sleep.target_hours_min + plan.sleep.target_hours_max) / 2,
      phase: plan.nutrition.phase,
      source: "plan",
      mode: "steady_state",
      is_training_day,
      deficit_alarm: null,
      hydration_target_ml: null,
      sodium_target_mg: null,
      today_phase_mode: null,
    };
  }

  // Phase 1 fallback: intake_payload only
  const payload = data.intake_payload as IntakePayload;
  return {
    kcal: payload.nutrition.current_kcal,
    protein_g: payload.nutrition.current_macros.protein_g,
    carb_g: payload.nutrition.current_macros.carb_g,
    fat_g: payload.nutrition.current_macros.fat_g,
    bedtime: payload.sleep_recovery.typical_bedtime,
    sleep_hours_target: payload.sleep_recovery.avg_sleep_hours,
    phase: payload.nutrition.current_phase,
    source: "intake",
    mode: "steady_state",
    is_training_day: false,
    deficit_alarm: null,
    hydration_target_ml: null,
    sodium_target_mg: null,
    today_phase_mode: null,
  };
}
