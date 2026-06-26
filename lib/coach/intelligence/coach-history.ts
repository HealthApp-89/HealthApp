// lib/coach/intelligence/coach-history.ts
//
// Coach History Composer — detects deload outcomes, exercise swaps, nutrition experiments.
// Phase 1 returns empty arrays; the structure enables Layer 1 snapshot integration.
//
// Signature: composeCoachHistory(workouts, dailyLogs): HistoryPayload
// Returns: { recent_deloads: [], exercise_swaps_8w: [], nutrition_interventions: [] }
// Validates against HistoryPayload schema before returning.

import { HistoryPayloadSchema, type HistoryPayload } from "./types";
import type { WorkoutSession } from "@/lib/data/workouts";

/** Daily log row shape consumed by the history composer */
type DailyLogRow = {
  date: string;
  hrv: number | null;
  resting_hr: number | null;
  recovery: number | null;
  sleep_hours: number | null;
  sleep_score: number | null;
  deep_sleep_hours: number | null;
  strain: number | null;
  steps: number | null;
  calories_eaten: number | null;
  weight_kg: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
};

/**
 * Compose the history layer payload — detects deload outcomes, exercise swaps, nutrition experiments.
 *
 * Phase 1: Returns empty arrays. The structure allows Task 5 to wire the history layer
 * into the snapshot without import errors. Detection logic is Phase 2 work.
 *
 * @param _workouts - Workout sessions (intentionally unused in Phase 1)
 * @param _dailyLogs - Daily log rows (intentionally unused in Phase 1)
 * @returns HistoryPayload with all arrays empty
 * @throws If the return value fails HistoryPayload schema validation
 */
export function composeCoachHistory(
  _workouts: WorkoutSession[],
  _dailyLogs: DailyLogRow[],
): HistoryPayload {
  const payload: HistoryPayload = {
    recent_deloads: [],
    exercise_swaps_8w: [],
    nutrition_interventions: [],
  };

  // Validate against schema before returning
  const parsed = HistoryPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `HistoryPayload schema validation failed: ${JSON.stringify(parsed.error.issues, null, 2)}`,
    );
  }

  return payload;
}
