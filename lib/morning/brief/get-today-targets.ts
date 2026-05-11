// lib/morning/brief/get-today-targets.ts
//
// Phase-1/Phase-2 abstraction for daily targets. Insulates the brief
// renderer from where the macros / sleep target come from.
//
// Phase 1: reads from athlete_profile_documents.intake_payload (current
//   self-reported targets the user set during /onboarding).
// Phase 2: will swap to plan_payload.nutrition / plan_payload.sleep
//   (AI-generated prescribed targets).
//
// The function signature is stable across phases. Brief consumers don't
// know which source is feeding them.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { IntakePayload } from "@/lib/data/types";

export type TodayTargets = {
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  bedtime: string;             // "HH:mm"
  sleep_hours_target: number;
  phase: "cut" | "maintain" | "lean_bulk" | "recomp" | "unsure";
};

/** Returns null when the user has no active athlete_profile_documents row
 *  (i.e., they haven't completed Phase 1 onboarding yet). Callers should
 *  degrade gracefully — the brief still renders with placeholder macros. */
export async function getTodayTargets(
  supabase: SupabaseClient,
  userId: string,
): Promise<TodayTargets | null> {
  const { data, error } = await supabase
    .from("athlete_profile_documents")
    .select("intake_payload")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const payload = data.intake_payload as IntakePayload;
  return {
    kcal: payload.nutrition.current_kcal,
    protein_g: payload.nutrition.current_macros.protein_g,
    carb_g: payload.nutrition.current_macros.carb_g,
    fat_g: payload.nutrition.current_macros.fat_g,
    bedtime: payload.sleep_recovery.typical_bedtime,
    sleep_hours_target: payload.sleep_recovery.avg_sleep_hours,
    phase: payload.nutrition.current_phase,
  };
}
