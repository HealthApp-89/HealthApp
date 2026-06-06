// lib/coach/weekly-review/compute-on-pace.ts
//
// Replaces the TODO(v2) stub in index.ts that returned null. Reads
// training_blocks.target_value + target_metric + target_hit_at_week, plus
// the athlete's recent working sets, and computes whether the block is on
// pace to hit target by the final week.
//
// Reuses lib/coach/prescription/block-phase-rule.ts:evaluateBlockPhase so
// the on_pace verdict and Carter's framework_state block are derived from
// the same code path. Mapping:
//   pre_target / consolidation / deload_week → on_pace = true
//   off_pace                                 → on_pace = false
//
// Query pattern: workouts → exercises → exercise_sets (established codebase
// convention — Supabase PostgREST does not support querying upward from
// exercise_sets through exercises to workouts in this project's setup).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { TrainingBlock, TargetMetric } from "@/lib/data/types";
import type { WorkoutSetSample } from "@/lib/coach/prescription/types";
import { evaluateBlockPhase } from "@/lib/coach/prescription/block-phase-rule";
import {
  currentComparisonValueForLift,
  PRIMARY_LIFT_NAME_PATTERNS,
} from "@/lib/coach/prescription/current-comparison-value";
import { bestComparisonValue } from "@/lib/coach/e1rm";

// ── types ─────────────────────────────────────────────────────────────────────

type RawSet = { kg: number | null; reps: number | null; warmup: boolean | null; failure: boolean | null };
type RawExercise = { name: string; exercise_sets: RawSet[] | null };
type RawWorkout = { date: string; exercises: RawExercise[] | null };

// ── public API ────────────────────────────────────────────────────────────────

export async function computeOnPace(opts: {
  supabase: SupabaseClient;
  userId: string;
  block: TrainingBlock | null;
  todayIso: string;
  rirTarget?: number | null;
}): Promise<boolean | null> {
  const { supabase, userId, block, todayIso } = opts;
  if (!block || block.primary_lift == null || block.target_value == null) {
    return null;
  }

  const rirTarget = opts.rirTarget ?? 2; // sensible mid-block default

  // Recent working sets — last 28 days mirrors the maintenance-baseline window.
  const sinceIso = subtractDaysIso(todayIso, 28);
  const { data } = await supabase
    .from("workouts")
    .select("date, exercises(name, exercise_sets(kg, reps, warmup, failure))")
    .eq("user_id", userId)
    .gte("date", sinceIso)
    .order("date", { ascending: false });

  const rows = (data ?? []) as unknown as RawWorkout[];

  // Filter to primary-lift sets only for the OLS slope; keep all sets for
  // currentComparisonValueForLift which does its own internal name matching.
  const patterns = PRIMARY_LIFT_NAME_PATTERNS[block.primary_lift];
  const lowerPatterns = new Set(patterns.map((p) => p.toLowerCase()));

  const recentSets: WorkoutSetSample[] = [];
  for (const w of rows) {
    for (const ex of w.exercises ?? []) {
      for (const s of ex.exercise_sets ?? []) {
        if (s.kg == null || s.reps == null) continue;
        if (!lowerPatterns.has(ex.name.toLowerCase())) continue;
        recentSets.push({
          exercise_name: ex.name,
          exercise_key: null,
          kg: s.kg,
          reps: s.reps,
          warmup: !!s.warmup,
          failure: !!s.failure,
          performed_on: w.date,
        });
      }
    }
  }

  const currentWorkingKg = currentComparisonValueForLift({
    lift: block.primary_lift,
    metric: block.target_metric ?? "working_weight",
    recentSets,
    rirTarget,
    todayIso,
  });

  const rate = estimateProgressionRatePerWeek(recentSets, block.target_metric ?? "working_weight");

  const phase = evaluateBlockPhase({
    block,
    currentWorkingKg,
    recentProgressionRatePerWeek: rate,
    todayIso,
  });

  return phase !== "off_pace";
}

// ── pure helpers ──────────────────────────────────────────────────────────────

/** OLS slope (kg / week) over per-week max comparison values.
 *  Returns null when there is insufficient data for a reliable estimate. */
function estimateProgressionRatePerWeek(
  sets: WorkoutSetSample[],
  targetMetric: TargetMetric,
): number | null {
  if (sets.length === 0) return null;

  // Group non-warmup sets by ISO-week key. Per-week max comparison value.
  const byWeek = new Map<string, WorkoutSetSample[]>();
  for (const s of sets) {
    if (s.warmup || !s.performed_on) continue;
    const wk = isoWeekKey(s.performed_on);
    const arr = byWeek.get(wk) ?? [];
    arr.push(s);
    byWeek.set(wk, arr);
  }

  // Sort entries chronologically (ISO week keys sort lexicographically).
  const points: Array<{ x: number; y: number }> = [];
  let i = 0;
  for (const [, wkSets] of [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const v = bestComparisonValue(wkSets, targetMetric);
    if (v != null) points.push({ x: i, y: v });
    i++;
  }

  if (points.length < 2) return null;

  const n = points.length;
  const meanX = points.reduce((a, p) => a + p.x, 0) / n;
  const meanY = points.reduce((a, p) => a + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) ** 2;
  }
  return den > 0 ? num / den : null;
}

/** Returns an ISO-week key ("YYYY-WW") for a YYYY-MM-DD string.
 *  Used only for grouping — exact ISO week number vs. simple year-week
 *  offset doesn't matter as long as the mapping is consistent within a run. */
function isoWeekKey(iso: string): string {
  const d = new Date(iso + "T12:00:00Z");
  const yr = d.getUTCFullYear();
  const start = new Date(Date.UTC(yr, 0, 1));
  const wk = Math.floor((d.getTime() - start.getTime()) / (7 * 86_400_000));
  return `${yr}-${String(wk).padStart(2, "0")}`;
}

function subtractDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
