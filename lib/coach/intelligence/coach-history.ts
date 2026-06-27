// lib/coach/intelligence/coach-history.ts
//
// Coach History Composer — maps evaluated intervention rows to the HistoryPayload.
//
// Phase 1 returned empty arrays.
// Phase 2 (this task) delegates to mapToHistory() which reads real
// coach_interventions rows and maps them to the typed sub-schemas.
//
// Signature: composeCoachHistory(workouts, dailyLogs, interventionRows): HistoryPayload
//
// workouts and dailyLogs are kept in the signature for future inference
// (e.g. auto-detecting planned deloads from workout gaps) but are unused now.
// The single caller (orchestrator) passes them through; the live data comes
// from interventionRows.

import type { WorkoutSession } from "@/lib/data/workouts";
import type { CoachInterventionRow } from "@/lib/data/types";
import { mapToHistory } from "@/lib/coach/interventions/map-to-history";
import type { HistoryPayload } from "./types";

/** Daily log row shape (kept for future inference work) */
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
 * Compose the history layer payload from evaluated intervention rows.
 *
 * Delegates to mapToHistory() to map rows where outcome.success ∈ {true, false}.
 * Inconclusive rows (success: null) are dropped by mapToHistory.
 *
 * @param _workouts        Workout sessions (available for future inference; unused now)
 * @param _dailyLogs       Daily log rows (available for future inference; unused now)
 * @param interventionRows Evaluated coach_interventions rows (filtered to ~90d by orchestrator)
 * @returns HistoryPayload with mapped intervention records
 * @throws If mapToHistory fails schema validation (should not happen in practice)
 */
export function composeCoachHistory(
  _workouts: WorkoutSession[],
  _dailyLogs: DailyLogRow[],
  interventionRows: CoachInterventionRow[],
): HistoryPayload {
  return mapToHistory(interventionRows);
}
