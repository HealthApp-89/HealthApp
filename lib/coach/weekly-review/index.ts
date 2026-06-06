// lib/coach/weekly-review/index.ts
//
// Orchestrator: fetch inputs in parallel, call composers, one AI narrative
// call, return { payload, narrative_md }. No DB writes — caller persists.
//
// Schema adaptations from the plan code block (verified against
// supabase/migrations/0008_weekly_planning.sql + lib/data/types.ts):
//   • training_blocks has no `active` boolean — gating is via `status = 'active'`
//     (single-active-per-user unique index in the migration).
//   • training_blocks has no `total_weeks` column — compute from
//     (end_date − start_date) / 7 days. (Comment on TrainingBlock.end_date in
//     types.ts: "always start + 34 days (week-5 Sunday)" → 5-week canonical.)
//   • training_blocks has no `research_phase` — it lives on training_weeks.
//     Read the recap-week's research_phase from training_weeks.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  TrainingBlock,
  WeeklyReviewPayload,
  WeeklyReviewRow,
} from "@/lib/data/types";
import { composeRecap } from "./compose-recap";
import { composeReconfirm } from "./compose-reconfirm";
import { composeTrends } from "./compose-trends";
import { composeVolume } from "./compose-volume";
import { composeTargets } from "./compose-targets";
import { renderNarrative } from "./narrative-prompt";
import { computeOnPace } from "./compute-on-pace";
import { readNextWeekPrescription } from "./read-prescription";
import { buildPerLiftFromEngine } from "./payload-mapper";
import { evaluateBlockPhase } from "@/lib/coach/prescription/block-phase-rule";
import {
  currentComparisonValueForLift,
  PRIMARY_LIFT_NAME_PATTERNS,
} from "@/lib/coach/prescription/current-comparison-value";
import type { BlockPhase, WorkoutSetSample } from "@/lib/coach/prescription/types";

export async function generateWeeklyReview(args: {
  supabase: SupabaseClient;
  userId: string;
  weekStart: string;
  late: boolean;
}): Promise<{
  payload: WeeklyReviewPayload;
  narrative_md: string;
  blockId: string;
}> {
  const { supabase, userId, weekStart, late } = args;

  // Pull active block + training_week for context.
  const { data: block } = await supabase
    .from("training_blocks")
    .select("id, user_id, status, goal_text, start_date, end_date, primary_lift, target_metric, target_value, target_hit_at_week, target_unit, diet_goal, endurance_focus, created_at, completed_at, updated_at")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  if (!block) throw new Error("No active training block");

  const totalWeeks = computeTotalWeeks(block.start_date, block.end_date);
  const weekN = computeWeekN(block.start_date, weekStart);

  const { data: trainingWeek } = await supabase
    .from("training_weeks")
    .select("session_plan, original_session_plan, rir_target, weekly_focus, research_phase")
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();

  // Fetch the upcoming week's row early so blockPhaseNext can use its
  // rir_target rather than the current week's value (which may differ if
  // Carter already committed a new plan for next week).
  const nextWeekStart = shiftDays(weekStart, 7);
  const { data: upcomingWeek } = await supabase
    .from("training_weeks")
    .select("session_plan, weekly_focus, rir_target")
    .eq("user_id", userId)
    .eq("week_start", nextWeekStart)
    .maybeSingle();

  // Phase derivation: BlockPhase via evaluateBlockPhase, the canonical engine
  // path. blockPhaseNow anchors at the recap week (weekStart); blockPhaseNext
  // anchors at next Monday. Same code path Carter's framework-state block and
  // the Sunday cron see, so the review's header agrees with the rest of the
  // surface.
  const blockPhaseNow: BlockPhase = await deriveBlockPhase({
    supabase,
    userId,
    block: block as TrainingBlock,
    todayIso: weekStart,
    rirTarget: trainingWeek?.rir_target ?? null,
  });
  const blockPhaseNext: BlockPhase = await deriveBlockPhase({
    supabase,
    userId,
    block: block as TrainingBlock,
    todayIso: nextWeekStart,
    rirTarget: upcomingWeek?.rir_target ?? trainingWeek?.rir_target ?? null,
  });

  const plannedSessions: Record<string, string> =
    (trainingWeek?.original_session_plan as Record<string, string> | null) ??
    (trainingWeek?.session_plan as Record<string, string> | null) ??
    {};

  // Prior week's review (for rir_miss_consecutive carry-over).
  // Only `payload` is actually read downstream; narrowing keeps the wire
  // payload small and the dependency surface honest.
  const priorMonday = shiftDays(weekStart, -7);
  const { data: priorReview } = await supabase
    .from("weekly_reviews")
    .select("id, payload, version, status")
    .eq("user_id", userId)
    .eq("week_start", priorMonday)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  const [recap, trends, volume] = await Promise.all([
    composeRecap({
      supabase,
      userId,
      weekStart,
      plannedSessions,
      priorReview: priorReview as WeeklyReviewRow | null,
    }),
    composeTrends({ supabase, userId, weekStart }),
    composeVolume({ supabase, userId, weekStart, nextPhase: blockPhaseNext }),
  ]);

  // compose-targets needs the next-week session plan from prescription;
  // prescription needs recap. Sequential.
  const targets = await composeTargets({
    supabase,
    userId,
    nextWeekStart,
    sessionPlan: plannedSessions,
  });

  // Read next week's deterministic prescription via the canonical engine seam.
  // Prefers training_weeks.session_prescriptions written by the Sunday cron at
  // 03:30 UTC; falls through to prescribeWeek inline if the row is missing.
  const { prescription: engineRx, source: rxSource } = await readNextWeekPrescription({
    supabase,
    userId,
    nextWeekStart,
    todayIso: nextWeekStart,
  });
  if (rxSource === "inline") {
    console.warn("[weekly-review] read fell through to inline prescribeWeek", {
      userId,
      nextWeekStart,
    });
  }
  const perLift = buildPerLiftFromEngine({
    prescription: engineRx,
    perLiftRecap: recap.per_lift,
    blockPhase: blockPhaseNext,
  });

  const prescription: WeeklyReviewPayload["prescription"] = {
    next_week_start: nextWeekStart,
    phase: blockPhaseNext,
    rir_target: upcomingWeek?.rir_target ?? trainingWeek?.rir_target ?? null,
    session_plan:
      (upcomingWeek?.session_plan as Record<string, string> | null) ??
      (trainingWeek?.session_plan as Record<string, string> | null) ??
      {},
    weekly_focus: upcomingWeek?.weekly_focus ?? trainingWeek?.weekly_focus ?? null,
    per_lift: perLift,
  };

  const reconfirm = composeReconfirm({
    recap,
    proteinTargetG: targets.nutrition.protein_g,
  });

  const onPace = await computeOnPace({
    supabase,
    userId,
    block: block as TrainingBlock,
    todayIso: weekStart,
    rirTarget: trainingWeek?.rir_target ?? null,
  });

  const payload: WeeklyReviewPayload = {
    schema_version: 2,
    header: {
      week_n: weekN,
      total_weeks: totalWeeks,
      block_goal_text: block.goal_text,
      block_phase_now: blockPhaseNow,
      block_phase_next: blockPhaseNext,
      on_pace: onPace,
      weeks_remaining: Math.max(0, totalWeeks - weekN),
      late,
    },
    recap,
    reconfirm,
    trends,
    prescription,
    volume,
    targets,
  };

  const narrative_md = await renderNarrative({ payload });
  return { payload, narrative_md, blockId: block.id };
}

function shiftDays(d: string, days: number): string {
  const dt = new Date(d + "T12:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function computeWeekN(blockStart: string, weekStart: string): number {
  const ms =
    new Date(weekStart + "T12:00:00Z").getTime() -
    new Date(blockStart + "T12:00:00Z").getTime();
  return Math.floor(ms / (7 * 24 * 3600 * 1000)) + 1;
}

/** Length of the training block in whole weeks. The migration enforces
 *  `end_date > start_date` and the canonical 5-week block has
 *  end_date = start + 34 days (a Sunday). Round to the nearest integer so a
 *  Mon..Sun span counts as a full week. */
function computeTotalWeeks(blockStart: string, blockEnd: string): number {
  const ms =
    new Date(blockEnd + "T12:00:00Z").getTime() -
    new Date(blockStart + "T12:00:00Z").getTime();
  const weeks = Math.round(ms / (7 * 24 * 3600 * 1000));
  return Math.max(1, weeks);
}

// ── BlockPhase derivation ────────────────────────────────────────────────────
//
// Mirrors the query shape + row-mapper in compute-on-pace.ts (workouts →
// exercises → exercise_sets) so the header's block_phase_{now,next} are
// derived from the same WorkoutSetSample[] feed the on_pace computation uses.
// Keeping these parallel for now; future refactor can extract a shared helper
// at module-stabilization time, not in this PR.

type RawSet = { kg: number | null; reps: number | null; warmup: boolean | null; failure: boolean | null };
type RawExercise = { name: string; exercise_sets: RawSet[] | null };
type RawWorkout = { date: string; exercises: RawExercise[] | null };

async function deriveBlockPhase(opts: {
  supabase: SupabaseClient;
  userId: string;
  block: TrainingBlock | null;
  todayIso: string;
  rirTarget: number | null;
}): Promise<BlockPhase> {
  const { supabase, userId, block, todayIso } = opts;
  if (!block || block.primary_lift == null) return "pre_target";

  const rirTarget = opts.rirTarget ?? 2;

  const sinceIso = (() => {
    const d = new Date(todayIso + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() - 28);
    return d.toISOString().slice(0, 10);
  })();

  const { data } = await supabase
    .from("workouts")
    .select("date, exercises(name, exercise_sets(kg, reps, warmup, failure))")
    .eq("user_id", userId)
    .gte("date", sinceIso)
    .order("date", { ascending: false });

  const rows = (data ?? []) as unknown as RawWorkout[];

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

  // recentProgressionRatePerWeek intentionally null: defers the off_pace
  // verdict to consolidation/deload_week/pre_target. compute-on-pace owns the
  // OLS-slope estimation for the on_pace flag; the header's block_phase
  // derivation is a calendar+target check, not a slope check.
  return evaluateBlockPhase({
    block,
    currentWorkingKg,
    recentProgressionRatePerWeek: null,
    todayIso,
  });
}

