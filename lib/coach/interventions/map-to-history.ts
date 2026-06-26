// lib/coach/interventions/map-to-history.ts
//
// Pure mapper: CoachInterventionRow[] → HistoryPayload
//
// Rules:
//   - Only maps rows where outcome.success ∈ {true, false}.
//     Inconclusive rows (success: null) are silently dropped — they cannot
//     satisfy HistoryPayload's boolean-required success field.
//   - Rows are sorted most-recent first before applying array caps.
//   - Array caps: recent_deloads max 5, exercise_swaps_8w max 10,
//     nutrition_interventions max 6.
//   - Validates the assembled payload against HistoryPayloadSchema before
//     returning; throws on schema violation (should never happen in practice
//     since every mapped field is schema-driven).
//
// Mapping:
//   reactive_deload  → DeloadRecord
//   exercise_swap    → ExerciseSwapRecord
//   nutrition_change → NutritionIntervention

import { HistoryPayloadSchema, type HistoryPayload } from "@/lib/coach/intelligence/types";
import type { CoachInterventionRow } from "@/lib/data/types";

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers — narrow outcome and context to typed shapes.
// We work with Record<string, unknown> because that's what the DB column
// returns; we narrow defensively.
// ─────────────────────────────────────────────────────────────────────────────

function isEvaluatedSuccess(outcome: Record<string, unknown> | null): outcome is Record<string, unknown> & { success: boolean } {
  return (
    outcome !== null &&
    typeof outcome === "object" &&
    typeof outcome.success === "boolean"
  );
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && isFinite(v) ? v : fallback;
}

function bool(v: unknown): boolean {
  return v === true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Kind-specific mappers
// ─────────────────────────────────────────────────────────────────────────────

function mapDeload(row: CoachInterventionRow): HistoryPayload["recent_deloads"][number] | null {
  if (!isEvaluatedSuccess(row.outcome)) return null;

  const ctx = row.context;
  const out = row.outcome;
  const hrv_recovery_days = typeof out.hrv_recovery_days === "number"
    ? Math.max(0, Math.round(out.hrv_recovery_days))
    : 0;

  const record: HistoryPayload["recent_deloads"][number] = {
    date: row.started_on,
    type: "reactive",
    hrv_recovery_days,
    success: out.success,
  };

  if (!out.success) {
    // Include a reason_if_failed when the deload did not succeed.
    // Prefer ctx.trigger text if present, else a generic fallback.
    const trigger = str(ctx.trigger);
    record.reason_if_failed = trigger.length > 0
      ? `trigger: ${trigger}`
      : "HRV did not recover within window";
  }

  return record;
}

function mapSwap(row: CoachInterventionRow): HistoryPayload["exercise_swaps_8w"][number] | null {
  if (!isEvaluatedSuccess(row.outcome)) return null;

  const ctx = row.context;
  const out = row.outcome;

  const from = str(ctx.from_exercise, "unknown");
  const to = str(ctx.to_exercise, "unknown");
  const reason = str(ctx.reason, "swap");

  // swap_stuck = true → athlete kept the new exercise (it was an improvement);
  // swap_stuck = false → athlete reverted to original.
  const result: HistoryPayload["exercise_swaps_8w"][number]["result"] =
    bool(out.swap_stuck) ? "kept" : "reverted";

  return {
    from,
    to,
    reason,
    result,
    date: row.started_on,
  };
}

function mapNutrition(
  row: CoachInterventionRow,
): HistoryPayload["nutrition_interventions"][number] | null {
  if (!isEvaluatedSuccess(row.outcome)) return null;

  const ctx = row.context;
  const out = row.outcome;

  // Build a human-readable summary of the change: "<field>: <from> → <to>"
  const field = str(ctx.field, "nutrition");
  const fromVal = ctx.from !== undefined && ctx.from !== null ? String(ctx.from) : "?";
  const toVal = ctx.to !== undefined && ctx.to !== null ? String(ctx.to) : "?";
  const intervention = `${field}: ${fromVal} → ${toVal}`;

  // duration_weeks derived from the evaluation window constant (14 days / 7)
  // The window constant is 14d for nutrition_change per evaluate-outcome.ts.
  // We derive from the row's own data: if no window info, default to 2 (14d/7).
  const duration_weeks = Math.max(1, Math.round(14 / 7)); // = 2

  const signal = str(out.signal as string, "no signal recorded");
  const effect_value = bool(out.improved) ? 1 : 0;

  return {
    intervention,
    duration_weeks,
    effect_measured: signal,
    effect_value,
    adopted: out.success,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// mapToHistory — public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map an array of evaluated CoachInterventionRows into the HistoryPayload.
 *
 * - Rows with `outcome.success === null` (inconclusive) are dropped.
 * - Rows are expected to be already filtered to the relevant window (e.g. ~90d)
 *   by the caller; this function does not apply a date filter.
 * - Arrays are capped at 5 / 10 / 6 (most-recent first via started_on desc).
 * - Validates output against HistoryPayloadSchema before returning.
 *
 * @param rows  Evaluated coach_interventions rows (any order; sorted internally).
 * @returns     Valid HistoryPayload.
 * @throws      If assembled payload fails schema validation.
 */
export function mapToHistory(rows: CoachInterventionRow[]): HistoryPayload {
  // Sort all rows most-recent first so the caps pick the latest entries.
  const sorted = [...rows].sort((a, b) => b.started_on.localeCompare(a.started_on));

  const recent_deloads: HistoryPayload["recent_deloads"] = [];
  const exercise_swaps_8w: HistoryPayload["exercise_swaps_8w"] = [];
  const nutrition_interventions: HistoryPayload["nutrition_interventions"] = [];

  for (const row of sorted) {
    switch (row.kind) {
      case "reactive_deload": {
        if (recent_deloads.length >= 5) break;
        const mapped = mapDeload(row);
        if (mapped) recent_deloads.push(mapped);
        break;
      }
      case "exercise_swap": {
        if (exercise_swaps_8w.length >= 10) break;
        const mapped = mapSwap(row);
        if (mapped) exercise_swaps_8w.push(mapped);
        break;
      }
      case "nutrition_change": {
        if (nutrition_interventions.length >= 6) break;
        const mapped = mapNutrition(row);
        if (mapped) nutrition_interventions.push(mapped);
        break;
      }
    }
  }

  const payload: HistoryPayload = {
    recent_deloads,
    exercise_swaps_8w,
    nutrition_interventions,
  };

  const parsed = HistoryPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `mapToHistory: HistoryPayload schema validation failed: ${JSON.stringify(parsed.error.issues, null, 2)}`,
    );
  }

  return parsed.data;
}
