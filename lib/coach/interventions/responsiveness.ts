// lib/coach/interventions/responsiveness.ts
//
// Pure function: summarizeResponsiveness(rows) → ResponsivenessRollup
//
// Consumes evaluated CoachInterventionRow[] (success ∈ {true, false};
// inconclusive rows with success: null are silently skipped).
//
// Emits three string-array buckets used by renderResponsivenessLines()
// to extend the ### Coach History block in the ATHLETE INTELLIGENCE snapshot:
//
//   high_roi:      kinds with ≥2 successes — short phrase per kind
//                  e.g. "reactive deloads: 3/3 recovered"
//   low_signal:    kinds with ≥2 attempts AND 0 successes
//                  e.g. "exercise swaps: 2 attempts, 0 successes"
//   recent_wins:   success:true rows in last ~10 days as short phrases
//                  e.g. "reactive deload 2026-06-20 → HRV recovered in 5d"
//
// No AI calls — pure templating.

import type { CoachInterventionRow } from "@/lib/data/types";

// ─────────────────────────────────────────────────────────────────────────────
// Output type
// ─────────────────────────────────────────────────────────────────────────────

export type ResponsivenessRollup = {
  /** Kinds with ≥2 successes. Short phrase each. */
  high_roi: string[];
  /** Kinds with ≥2 attempts AND 0 successes. Short phrase each. */
  low_signal: string[];
  /** Success rows in last ~10 days as short human-readable phrases. */
  recent_wins: string[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Window (days) for "recent" wins. */
const RECENT_WIN_DAYS = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Per-kind label helpers
// ─────────────────────────────────────────────────────────────────────────────

function kindLabel(kind: CoachInterventionRow["kind"]): string {
  switch (kind) {
    case "reactive_deload":  return "reactive deload";
    case "exercise_swap":    return "exercise swap";
    case "nutrition_change": return "nutrition change";
  }
}

function kindLabelPlural(kind: CoachInterventionRow["kind"]): string {
  switch (kind) {
    case "reactive_deload":  return "reactive deloads";
    case "exercise_swap":    return "exercise swaps";
    case "nutrition_change": return "nutrition changes";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-kind win phrase
// ─────────────────────────────────────────────────────────────────────────────

function buildWinPhrase(row: CoachInterventionRow): string {
  const label = kindLabel(row.kind);
  const date = row.started_on; // YYYY-MM-DD

  switch (row.kind) {
    case "reactive_deload": {
      const hrv_days = typeof row.outcome?.hrv_recovery_days === "number"
        ? row.outcome.hrv_recovery_days
        : null;
      const suffix = hrv_days !== null && hrv_days > 0
        ? ` → HRV recovered in ${hrv_days}d`
        : ` → HRV recovered`;
      return `${label} ${date}${suffix}`;
    }
    case "exercise_swap": {
      const from = typeof row.context?.from_exercise === "string" ? row.context.from_exercise : "";
      const to   = typeof row.context?.to_exercise === "string"   ? row.context.to_exercise   : "";
      const arrow = from && to ? ` (${from} → ${to})` : "";
      return `${label} ${date}${arrow} → kept`;
    }
    case "nutrition_change": {
      const field = typeof row.context?.field === "string" ? row.context.field : "";
      const signal = typeof row.outcome?.signal === "string" ? row.outcome.signal : "";
      const detail = field ? ` (${field})` : "";
      const signalSuffix = signal ? ` → ${signal}` : ` → improved`;
      return `${label} ${date}${detail}${signalSuffix}`;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// summarizeResponsiveness — public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Summarize evaluated intervention rows into a ResponsivenessRollup.
 *
 * Rules:
 * - Only evaluates rows where outcome.success ∈ {true, false}; skips null.
 * - Groups by kind, counts attempts + successes.
 * - high_roi:    kinds with ≥2 successes — phrase "reactive deloads: 3/5 recovered"
 * - low_signal:  kinds with ≥2 attempts AND 0 successes
 * - recent_wins: success=true rows started within last RECENT_WIN_DAYS days
 *                relative to today (ISO string); sorted most-recent first.
 *
 * @param rows   Evaluated CoachInterventionRow[] (any order; sorted internally).
 * @param today  YYYY-MM-DD anchor for "recent" window. Defaults to "" (skips recent_wins).
 */
export function summarizeResponsiveness(
  rows: CoachInterventionRow[],
  today: string = "",
): ResponsivenessRollup {
  type Stats = { attempts: number; successes: number };
  const byKind: Record<CoachInterventionRow["kind"], Stats> = {
    reactive_deload:  { attempts: 0, successes: 0 },
    exercise_swap:    { attempts: 0, successes: 0 },
    nutrition_change: { attempts: 0, successes: 0 },
  };

  // Sort most-recent first so recent_wins list is ordered newest first.
  const sorted = [...rows].sort((a, b) => b.started_on.localeCompare(a.started_on));

  // Compute recent threshold date string.
  let recentThreshold = "";
  if (today) {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - RECENT_WIN_DAYS);
    recentThreshold = d.toISOString().slice(0, 10);
  }

  const recent_wins: string[] = [];

  for (const row of sorted) {
    const outcome = row.outcome;
    if (!outcome || typeof outcome.success !== "boolean") continue;

    const kind = row.kind;
    byKind[kind].attempts += 1;
    if (outcome.success === true) {
      byKind[kind].successes += 1;

      // Collect recent wins.
      if (recentThreshold && row.started_on >= recentThreshold) {
        recent_wins.push(buildWinPhrase(row));
      }
    }
  }

  // Build high_roi: kinds with ≥2 successes.
  const high_roi: string[] = [];
  // Build low_signal: kinds with ≥2 attempts AND 0 successes.
  const low_signal: string[] = [];

  // Stable ordering: deload → swap → nutrition.
  const kinds: CoachInterventionRow["kind"][] = [
    "reactive_deload",
    "exercise_swap",
    "nutrition_change",
  ];

  for (const kind of kinds) {
    const { attempts, successes } = byKind[kind];

    if (successes >= 2) {
      high_roi.push(`${kindLabelPlural(kind)}: ${successes}/${attempts} recovered`);
    } else if (attempts >= 2 && successes === 0) {
      low_signal.push(`${kindLabelPlural(kind)}: ${attempts} attempts, 0 successes`);
    }
  }

  return { high_roi, low_signal, recent_wins };
}

// ─────────────────────────────────────────────────────────────────────────────
// renderResponsivenessLines — snapshot helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render the ResponsivenessRollup as a compact set of bullet lines to append
 * inside the ### Coach History block.
 *
 * Returns an empty array when all three buckets are empty (caller omits block).
 * Each line is a plain string WITHOUT a leading newline — the caller joins with "\n".
 */
export function renderResponsivenessLines(rollup: ResponsivenessRollup): string[] {
  const lines: string[] = [];

  if (rollup.high_roi.length > 0) {
    lines.push(`- Responsive to: ${rollup.high_roi.join("; ")}`);
  }
  if (rollup.low_signal.length > 0) {
    lines.push(`- Low signal: ${rollup.low_signal.join("; ")}`);
  }
  if (rollup.recent_wins.length > 0) {
    lines.push(`- Recent wins: ${rollup.recent_wins.join("; ")}`);
  }

  return lines;
}
