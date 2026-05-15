// lib/coach/weekly-review/compose-targets.ts
//
// §7 targets — nutrition + sleep + recovery for the upcoming week.
// Reads the active plan_payload.nutrition / plan_payload.sleep if the
// athlete has a committed plan; falls back to intake_payload via the
// shared get-today-targets abstraction.
//
// Signature note (diverges from plan code block): getTodayTargets takes
// positional args `(supabase, userId)` and may return null when the user
// has no active athlete_profile_documents row. Field names on TodayTargets
// are `carb_g` (singular) and `sleep_hours_target` — we map those into the
// WeeklyReviewPayload.targets shape (`carbs_g`, `sleep.hours`) here.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getTodayTargets } from "@/lib/morning/brief/get-today-targets";
import type { WeeklyReviewPayload } from "@/lib/data/types";

type TargetsOutput = WeeklyReviewPayload["targets"];

/** Soft sleep-efficiency default when the user has no per-user target stored.
 *  WeeklyReviewPayload.targets.sleep.efficiency_pct is non-nullable; 87% is
 *  the spec's working default until a user-tunable target lands. */
const DEFAULT_SLEEP_EFFICIENCY_PCT = 87;
/** Fallback macro/sleep block when the user has no active plan or intake. */
const PLACEHOLDER_NUTRITION = {
  kcal: 0,
  protein_g: 0,
  carbs_g: 0,
  fat_g: 0,
} satisfies TargetsOutput["nutrition"];
const PLACEHOLDER_SLEEP_HOURS = 7.5;

export async function composeTargets(args: {
  supabase: SupabaseClient;
  userId: string;
  /** Monday YYYY-MM-DD of the upcoming week. (Reserved; not used yet — the
   *  underlying targets helper resolves "today" via user-tz. Kept on the
   *  signature so the orchestrator can pass it and a future refactor can
   *  switch from "today" to a per-week resolution without changing callers.) */
  nextWeekStart: string;
  /** From compose-prescription — used to derive a recovery focus tagline
   *  (mobility / soft-tissue) without an extra DB read. */
  sessionPlan: Record<string, string>;
}): Promise<TargetsOutput> {
  const { supabase, userId, sessionPlan } = args;
  void args.nextWeekStart; // reserved, see jsdoc

  const today = await getTodayTargets(supabase, userId);

  // Recovery focus: derive from session_plan
  const recoveryFocus: string[] = [];
  const sessions = Object.values(sessionPlan);
  const hasMobility = sessions.some((s) =>
    s.toLowerCase().includes("mobility"),
  );
  if (hasMobility) recoveryFocus.push("mobility");
  const trainingDays = sessions.filter(
    (s) =>
      s &&
      !s.toLowerCase().includes("rest") &&
      !s.toLowerCase().includes("mobility"),
  ).length;
  if (trainingDays >= 4) recoveryFocus.push("soft-tissue post-leg");

  if (today === null) {
    // No active profile yet (pre-onboarding). Surface placeholders so the
    // payload still validates against WeeklyReviewPayload — the orchestrator
    // is responsible for deciding whether to surface this to the user.
    return {
      nutrition: { ...PLACEHOLDER_NUTRITION },
      sleep: {
        hours: PLACEHOLDER_SLEEP_HOURS,
        efficiency_pct: DEFAULT_SLEEP_EFFICIENCY_PCT,
      },
      recovery_focus: recoveryFocus,
    };
  }

  return {
    nutrition: {
      kcal: today.kcal,
      protein_g: today.protein_g,
      carbs_g: today.carb_g, // map carb_g → carbs_g on the payload shape
      fat_g: today.fat_g,
    },
    sleep: {
      hours: today.sleep_hours_target,
      efficiency_pct: DEFAULT_SLEEP_EFFICIENCY_PCT,
    },
    recovery_focus: recoveryFocus,
  };
}
