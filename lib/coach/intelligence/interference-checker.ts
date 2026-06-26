// lib/coach/intelligence/interference-checker.ts
//
// Strength-Endurance Interference Checker (Layer 2) — correlates endurance
// training load (TSS acute:chronic ratio) with main-lift e1RM trend to detect
// when endurance volume is suppressing strength gains.
//
// At the athlete's current Phase 1 volume (~1h/wk Z2, steady TSS ratio ≈ 1.0)
// this will report 'none' — that is the correct and expected steady-state
// output. The structure wakes up when triathlon ramp begins.
//
// Pure function — no Supabase calls, no side effects.
// Deterministic: identical input → identical output (inputs sorted internally).
//
// e1RM helper: uses brzycki() from lib/coach/e1rm.ts, which is the codebase's
// canonical formula and is consistent with bestComparisonValue(). Epley is
// available in the same module but Brzycki is the codebase default.
//
// Main-lift matching: uses a case-insensitive substring check against the
// canonical main-lift keywords (Squat, Bench Press, Deadlift, RDL, OHP).
// lib/coach/big-four.ts exports BIG_FOUR with exact Barbell names, but this
// composer also needs RDL, so we maintain a local MAIN_LIFT_KEYWORDS list
// that is a superset. BIG_FOUR_SET is reused as a cross-check comment.
//
// No-workouts judgment call: when lift data is missing (lift_trend =
// 'insufficient_data') we never escalate interference past 'none' even if the
// TSS ratio is elevated, because we can't confirm flat/declining lifts. A
// 'monitor' driver is added when ratio > 1.2 to surface the data gap.

import { z } from "zod";
import { brzycki } from "@/lib/coach/e1rm";
import type { WorkoutSession } from "@/lib/data/workouts";

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

export type InterferenceInput = {
  /** Last 28 days of daily_logs (date + endurance_load). Any order; sorted internally. */
  dailyLogs: { date: string; endurance_load: number | null }[];
  /** Last ~28 days of workout sessions for lift trend. Any order; sorted internally. */
  workouts: WorkoutSession[];
};

// ---------------------------------------------------------------------------
// Result type + Zod schema
// ---------------------------------------------------------------------------

export const InterferenceResultSchema = z.object({
  interference_level: z.enum(["none", "mild", "high"]),
  /** Acute:chronic weekly TSS ratio; null when no endurance data exists. */
  tss_ratio_7d_28d: z.number().nullable(),
  lift_trend: z.enum(["progressing", "flat", "declining", "insufficient_data"]),
  action: z.enum(["monitor", "reduce_endurance_volume", "reduce_lifting_volume"]).nullable(),
  /** Observed factors only — no fabricated drivers. */
  drivers: z.array(z.string()),
  /** One-sentence concrete plain-English summary. */
  narrative: z.string().min(1),
});

export type InterferenceResult = z.infer<typeof InterferenceResultSchema>;

// ---------------------------------------------------------------------------
// Main-lift keyword matching
// ---------------------------------------------------------------------------

/**
 * Case-insensitive keywords to identify main lifts.
 * Superset of BIG_FOUR (adds RDL, OHP as keyword alternatives).
 * Note: "Bench Press" matches "Decline Bench Press (Barbell)" via substring.
 */
const MAIN_LIFT_KEYWORDS = [
  "squat",
  "bench press",
  "deadlift",
  "rdl",
  "ohp",
  "overhead press",
] as const;

function isMainLift(exerciseName: string): boolean {
  const lower = exerciseName.toLowerCase();
  return MAIN_LIFT_KEYWORDS.some((kw) => lower.includes(kw));
}

// ---------------------------------------------------------------------------
// TSS ratio computation
// ---------------------------------------------------------------------------

/**
 * Compute the acute:chronic weekly TSS ratio.
 *
 * acute  = sum of endurance_load over the 7 most-recent days.
 * chronic = (sum of endurance_load over 28 days) / 4 → avg weekly.
 * ratio  = acute / chronic; null when chronic is 0 or all loads are null/0.
 */
function computeTssRatio(
  logs: { date: string; endurance_load: number | null }[],
): number | null {
  if (logs.length === 0) return null;

  // Logs are sorted newest-first (caller sorts before calling)
  const total28d = logs.reduce((sum, l) => sum + (l.endurance_load ?? 0), 0);
  if (total28d === 0) return null;

  const recent7 = logs.slice(0, 7);
  const weeklyTSS_7d = recent7.reduce((sum, l) => sum + (l.endurance_load ?? 0), 0);
  const avgWeeklyTSS_28d = total28d / 4;

  return weeklyTSS_7d / avgWeeklyTSS_28d;
}

// ---------------------------------------------------------------------------
// Lift trend computation
// ---------------------------------------------------------------------------

/**
 * Compute the best non-warmup e1RM (Brzycki) for each main-lift appearance
 * per workout session, then compare avg e1RM in the recent 14d vs prior 14d.
 *
 * Returns:
 *   'progressing'       — recent avg e1RM > prior avg e1RM * 1.01
 *   'declining'         — recent avg e1RM < prior avg e1RM * 0.98
 *   'flat'              — within ±1% / ±2% band
 *   'insufficient_data' — fewer than 2 distinct data points across the window
 *
 * The comparison date anchor is the most-recent log date (or today if no logs).
 * Logs are passed to derive the anchor date.
 */
function computeLiftTrend(
  workouts: WorkoutSession[],
  anchorDate: string,
): {
  trend: InterferenceResult["lift_trend"];
  recentAvgE1rm: number | null;
  priorAvgE1rm: number | null;
  bestLiftName: string | null;
} {
  if (workouts.length === 0) {
    return { trend: "insufficient_data", recentAvgE1rm: null, priorAvgE1rm: null, bestLiftName: null };
  }

  const anchorMs = new Date(anchorDate).getTime();
  const MS_PER_DAY = 86_400_000;

  // Collect per-session best main-lift e1RM, bucketed into recent 14d vs prior 14d.
  const recentE1rms: number[] = [];
  const priorE1rms: number[] = [];

  for (const session of workouts) {
    const sessionMs = new Date(session.date).getTime();
    const daysAgo = (anchorMs - sessionMs) / MS_PER_DAY;

    // Only consider sessions within the 28d window
    if (daysAgo < 0 || daysAgo > 28) continue;

    // Find best non-warmup e1RM across all main-lift exercises in the session
    let sessionBestE1rm: number | null = null;
    for (const exercise of session.exercises) {
      if (!isMainLift(exercise.name)) continue;
      for (const set of exercise.sets) {
        if (set.warmup) continue;
        if (set.kg == null || set.kg <= 0) continue;
        if (set.reps == null || set.reps < 1 || set.reps > 12) continue;
        const e1rm = brzycki(set.kg, set.reps);
        if (e1rm == null) continue;
        if (sessionBestE1rm === null || e1rm > sessionBestE1rm) {
          sessionBestE1rm = e1rm;
        }
      }
    }

    if (sessionBestE1rm === null) continue;

    if (daysAgo < 14) {
      // recent 14d (days 0–13)
      recentE1rms.push(sessionBestE1rm);
    } else {
      // prior 14d (days 14–27)
      priorE1rms.push(sessionBestE1rm);
    }
  }

  const totalDataPoints = recentE1rms.length + priorE1rms.length;
  if (totalDataPoints < 2) {
    return { trend: "insufficient_data", recentAvgE1rm: null, priorAvgE1rm: null, bestLiftName: null };
  }

  // If we have data in only one window, also insufficient for comparison
  if (recentE1rms.length === 0 || priorE1rms.length === 0) {
    return { trend: "insufficient_data", recentAvgE1rm: null, priorAvgE1rm: null, bestLiftName: null };
  }

  const recentAvg = recentE1rms.reduce((s, v) => s + v, 0) / recentE1rms.length;
  const priorAvg = priorE1rms.reduce((s, v) => s + v, 0) / priorE1rms.length;

  let trend: InterferenceResult["lift_trend"];
  if (recentAvg > priorAvg * 1.01) {
    trend = "progressing";
  } else if (recentAvg < priorAvg * 0.98) {
    trend = "declining";
  } else {
    trend = "flat";
  }

  // Find the best lift name for narrative
  let bestLiftName: string | null = null;
  for (const session of workouts) {
    for (const exercise of session.exercises) {
      if (isMainLift(exercise.name)) {
        bestLiftName = exercise.name;
        break;
      }
    }
    if (bestLiftName) break;
  }

  return { trend, recentAvgE1rm: recentAvg, priorAvgE1rm: priorAvg, bestLiftName };
}

// ---------------------------------------------------------------------------
// Main composer
// ---------------------------------------------------------------------------

/**
 * Compose an InterferenceResult from 28 days of daily logs and workout history.
 *
 * @param input.dailyLogs  Last 28 days of daily_logs rows — any order; sorted internally.
 * @param input.workouts   Last ~28 days of workout sessions — any order; sorted internally.
 * @returns InterferenceResult validated against InterferenceResultSchema.
 */
export function composeInterference(input: InterferenceInput): InterferenceResult {
  const { dailyLogs, workouts } = input;

  // ── Edge case: completely empty input ────────────────────────────────────
  if (dailyLogs.length === 0 && workouts.length === 0) {
    const empty: InterferenceResult = {
      interference_level: "none",
      tss_ratio_7d_28d: null,
      lift_trend: "insufficient_data",
      action: null,
      drivers: [],
      narrative: "No training data available to assess interference.",
    };
    const parsed = InterferenceResultSchema.safeParse(empty);
    if (!parsed.success) {
      throw new Error(
        `composeInterference: empty-input output failed schema validation — ${JSON.stringify(parsed.error.issues)}`,
      );
    }
    return parsed.data;
  }

  // ── Sort inputs defensively: most-recent-first ───────────────────────────
  const sortedLogs = [...dailyLogs].sort((a, b) => b.date.localeCompare(a.date));
  const sortedWorkouts = [...workouts].sort((a, b) => b.date.localeCompare(a.date));

  // Derive anchor date from most-recent log (or most-recent workout if no logs).
  // The final fallback is unreachable: the early-return guard at the top of this
  // function already handles the case where BOTH inputs are empty. A literal
  // placeholder avoids a raw new Date() call (timezone-audit gate).
  const anchorDate =
    sortedLogs.length > 0
      ? sortedLogs[0].date
      : sortedWorkouts.length > 0
        ? sortedWorkouts[0].date
        : "1970-01-01"; // unreachable — empty-input case returned early above

  // ── TSS ratio ─────────────────────────────────────────────────────────────
  const tss_ratio_7d_28d = computeTssRatio(sortedLogs);
  const hasEnduranceData = tss_ratio_7d_28d !== null;

  // ── Lift trend ────────────────────────────────────────────────────────────
  const { trend: lift_trend, recentAvgE1rm, priorAvgE1rm, bestLiftName } =
    computeLiftTrend(sortedWorkouts, anchorDate);

  const hasLiftData = lift_trend !== "insufficient_data";

  // ── Interference level + action ──────────────────────────────────────────
  //
  // Rules from the brief (in priority order):
  //   high:  ratio > 1.4  AND (flat | declining)         → reduce_endurance_volume
  //   mild:  ratio ∈ (1.2, 1.4] AND (flat | declining)  → monitor
  //   mild:  ratio > 1.4  AND progressing                 → monitor (watch)
  //   none:  otherwise
  //
  // Special case: if lift data is missing (insufficient_data), never escalate
  // past 'none' — we can't confirm flat/declining. Add a monitoring driver if
  // ratio > 1.2 to surface the data gap.

  let interference_level: InterferenceResult["interference_level"] = "none";
  let action: InterferenceResult["action"] = null;

  if (hasEnduranceData && hasLiftData) {
    const ratio = tss_ratio_7d_28d!;
    const isLoadSpiked_high = ratio > 1.4;
    const isLoadSpiked_mild = ratio > 1.2 && ratio <= 1.4;
    const isLiftStalled = lift_trend === "flat" || lift_trend === "declining";

    if (isLoadSpiked_high && isLiftStalled) {
      interference_level = "high";
      action = "reduce_endurance_volume";
    } else if (isLoadSpiked_mild && isLiftStalled) {
      interference_level = "mild";
      action = "monitor";
    } else if (isLoadSpiked_high && lift_trend === "progressing") {
      // Load spiked but lifts still moving — watch closely
      interference_level = "mild";
      action = "monitor";
    }
    // All other cases: none, action null
  } else if (hasEnduranceData && !hasLiftData) {
    // Has endurance data but no lift data — keep 'none', add informational driver
    // if ratio is elevated, since we can't confirm flat/declining lifts.
    // (See module docstring for judgment call rationale.)
  }

  // ── Driver accumulation ───────────────────────────────────────────────────
  const drivers: string[] = [];

  if (!hasEnduranceData) {
    drivers.push("No endurance load logged in the last 28 days.");
  } else {
    const ratioRounded = Math.round(tss_ratio_7d_28d! * 100) / 100;
    if (interference_level === "high" || interference_level === "mild") {
      const weeklyTSS7d =
        sortedLogs
          .slice(0, 7)
          .reduce((sum, l) => sum + (l.endurance_load ?? 0), 0);
      const avgWeekly28d =
        sortedLogs.reduce((sum, l) => sum + (l.endurance_load ?? 0), 0) / 4;
      const pctAbove = Math.round((ratioRounded - 1) * 100);
      drivers.push(
        `Endurance load up ${pctAbove}% week-over-week (acute:chronic ${ratioRounded.toFixed(2)}, 7d TSS ${Math.round(weeklyTSS7d)} vs 28d avg ${Math.round(avgWeekly28d)}/wk).`,
      );
    }
    // For steady state, only add driver if ratio deviates meaningfully
    if (interference_level === "none" && tss_ratio_7d_28d! > 1.1) {
      drivers.push(
        `Endurance load slightly elevated (acute:chronic ${(Math.round(tss_ratio_7d_28d! * 100) / 100).toFixed(2)}) but within acceptable range.`,
      );
    }
  }

  if (hasLiftData && recentAvgE1rm !== null && priorAvgE1rm !== null) {
    const liftLabel = bestLiftName ?? "main lift";
    const recentRounded = Math.round(recentAvgE1rm * 10) / 10;
    const priorRounded = Math.round(priorAvgE1rm * 10) / 10;
    if (lift_trend === "flat" && interference_level !== "none") {
      drivers.push(
        `${liftLabel} e1RM flat: recent 14d avg ${recentRounded} kg vs prior 14d avg ${priorRounded} kg.`,
      );
    } else if (lift_trend === "declining" && interference_level !== "none") {
      const drop = Math.round((priorRounded - recentRounded) * 10) / 10;
      drivers.push(
        `${liftLabel} e1RM declining: recent 14d avg ${recentRounded} kg vs prior 14d avg ${priorRounded} kg (−${drop} kg).`,
      );
    }
  }

  if (!hasLiftData && hasEnduranceData && tss_ratio_7d_28d! > 1.2) {
    drivers.push(
      `Endurance load elevated (acute:chronic ${(Math.round(tss_ratio_7d_28d! * 100) / 100).toFixed(2)}) but lift data insufficient to confirm interference — log workouts to enable interference detection.`,
    );
  }

  // ── Narrative ──────────────────────────────────────────────────────────────
  let narrative: string;

  const ratioStr = tss_ratio_7d_28d !== null
    ? `acute:chronic ${(Math.round(tss_ratio_7d_28d * 100) / 100).toFixed(2)}`
    : null;

  if (!hasEnduranceData) {
    narrative =
      lift_trend === "insufficient_data"
        ? "No endurance load logged and no lift data available — interference cannot be assessed."
        : lift_trend === "progressing"
          ? "No endurance load logged; strength is progressing — no interference."
          : "No endurance load logged; cannot attribute any lift stall to endurance interference.";
  } else if (interference_level === "high") {
    const liftLabel = bestLiftName ?? "main lift";
    const ratioRounded = (Math.round(tss_ratio_7d_28d! * 100) / 100).toFixed(2);
    narrative = `Endurance load up ${Math.round((tss_ratio_7d_28d! - 1) * 100)}% week-over-week (${ratioStr}) while ${liftLabel} e1RM is ${lift_trend} — reduce Z2 volume or expect strength stall.`;
  } else if (interference_level === "mild") {
    if (lift_trend === "progressing") {
      narrative = `Endurance load spiked (${ratioStr}) but lifts are still progressing — watch closely over the next 2 weeks.`;
    } else {
      const liftLabel = bestLiftName ?? "main lift";
      narrative = `Endurance load moderately elevated (${ratioStr}) with ${liftLabel} e1RM ${lift_trend} — monitor and consider dialing back Z2 if lifts stall further.`;
    }
  } else {
    // none
    if (tss_ratio_7d_28d !== null) {
      const ratioRounded = (Math.round(tss_ratio_7d_28d * 100) / 100).toFixed(2);
      narrative = `Endurance at maintenance volume (${ratioStr}); no interference with strength.`;
    } else {
      narrative = lift_trend === "insufficient_data"
        ? "No endurance or lift data available — no interference to report."
        : "No endurance load logged; no interference with strength.";
    }
  }

  // ── Build and validate result ─────────────────────────────────────────────
  const result: InterferenceResult = {
    interference_level,
    tss_ratio_7d_28d,
    lift_trend,
    action,
    drivers,
    narrative,
  };

  const parsed = InterferenceResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new Error(
      `composeInterference: output failed schema validation — ${JSON.stringify(parsed.error.issues)}`,
    );
  }

  return parsed.data;
}
