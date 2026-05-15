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
  ResearchPhase,
  WeeklyReviewPayload,
  WeeklyReviewRow,
} from "@/lib/data/types";
import { composeRecap } from "./compose-recap";
import { composeReconfirm } from "./compose-reconfirm";
import { composeTrends } from "./compose-trends";
import { composePrescription } from "./compose-prescription";
import { composeVolume } from "./compose-volume";
import { composeTargets } from "./compose-targets";
import { renderNarrative } from "./narrative-prompt";
import { weeklyPhaseFor, nextWeeklyPhaseFor } from "./phase-mapping";

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
    .select("id, goal_text, start_date, end_date")
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

  // research_phase lives on training_weeks (not training_blocks). When the
  // recap week has no committed row, default to 'accumulate' so phase-mapping
  // gives us a normal MEV/MAV/MRV/deload progression.
  const researchPhase: ResearchPhase = (trainingWeek?.research_phase as ResearchPhase | null) ?? "accumulate";
  const weeklyPhaseCurrent = weeklyPhaseFor(weekN, totalWeeks, researchPhase);
  const weeklyPhaseNext = nextWeeklyPhaseFor(weekN, totalWeeks, researchPhase);

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
    composeVolume({ supabase, userId, weekStart, nextPhase: weeklyPhaseNext }),
  ]);

  // compose-targets needs the next-week session plan from prescription;
  // prescription needs recap. Sequential.
  const targets = await composeTargets({
    supabase,
    userId,
    nextWeekStart: shiftDays(weekStart, 7),
    sessionPlan: plannedSessions,
  });

  const prescription = await composePrescription({
    supabase,
    userId,
    nextWeekStart: shiftDays(weekStart, 7),
    weeklyPhaseCurrent,
    weeklyPhaseNext,
    rirTargetCurrent: trainingWeek?.rir_target ?? null,
    rirTargetNext: rirForPhase(weeklyPhaseNext),
    perLiftRecap: recap.per_lift,
    bodyWeightLossPctPerWk: deriveLossPct(
      trends.weight_loss_kg_per_week,
      recap.weight,
    ),
    sleepAvg7d: recap.sleep.avg_h,
    hrvFlag: false, // v1: sleep-based recovery_hold only. HRV-based hold deferred to a follow-up — leaves an explicit gap when sleep is fine but HRV crashed.
    isFirstWeekOfBlock: weekN === 1,
    intakeStartingLoads: null, // v1: when null, prescription falls back to last-week weight. First-week-of-block users get block_start_baseline tag with last-week weight; if intake load injection is needed, add it before shipping.
    weeklyFocus: trainingWeek?.weekly_focus ?? null,
  });

  const reconfirm = composeReconfirm({
    recap,
    proteinTargetG: targets.nutrition.protein_g,
  });

  const onPace = computeOnPace(block, recap);

  const payload: WeeklyReviewPayload = {
    schema_version: 1,
    header: {
      week_n: weekN,
      total_weeks: totalWeeks,
      block_goal_text: block.goal_text,
      block_phase_now: weeklyPhaseCurrent,
      block_phase_next: weeklyPhaseNext,
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

function rirForPhase(phase: "mev" | "mav" | "mrv" | "deload"): number | null {
  if (phase === "mev") return 3;
  if (phase === "mav") return 2;
  if (phase === "mrv") return 1;
  if (phase === "deload") return 4;
  return null;
}

function deriveLossPct(
  weeklyDeltaKg: number | null,
  weight: { start_kg: number | null; end_kg: number | null },
): number | null {
  if (weeklyDeltaKg == null || weight.start_kg == null || weight.start_kg <= 0)
    return null;
  return weeklyDeltaKg / weight.start_kg;
}

function computeOnPace(
  block: { goal_text: string },
  _recap: WeeklyReviewPayload["recap"],
): boolean | null {
  // TODO(v2): parse a "<kg>x<reps>" target out of block.goal_text and compare
  // to current top e1rm in recap. Returning null for now means downstream UI
  // shows "pace unknown" instead of false/true.
  console.warn(
    `[weekly-review] computeOnPace not implemented — block goal "${block.goal_text}" will render as pace-unknown`,
  );
  return null;
}
