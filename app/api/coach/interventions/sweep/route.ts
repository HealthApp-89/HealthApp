// app/api/coach/interventions/sweep/route.ts
//
// Daily cron at 02:00 UTC. Per-user sweep:
//   1. Run detectInferredInterventions against the current active training block.
//   2. Dedup: skip insert when an existing row (explicit OR inferred) already covers
//      the same (user_id, kind) within ±7 days of the candidate's started_on.
//      Explicit wins — skip; existing inferred — idempotent skip.
//   3. Insert new inferred candidates.
//   4. For each pending row (outcome_evaluated_at IS NULL) whose windowClosed today,
//      build the typed eval ctx, call the matching evaluator, and stamp outcome +
//      outcome_evaluated_at.
//
// Mirrors app/api/coach/block-outcomes/sweep/route.ts (auth, client, JSON summary).

import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { todayInUserTz, USER_TIMEZONE } from "@/lib/time";
import { detectInferredInterventions } from "@/lib/coach/interventions/detect-inferred";
import {
  OUTCOME_WINDOWS,
  windowClosed,
  evaluateDeloadOutcome,
  evaluateSwapOutcome,
  evaluateNutritionOutcome,
} from "@/lib/coach/interventions/evaluate-outcome";
import type {
  DeloadEvalCtx,
  SwapEvalCtx,
  NutritionEvalCtx,
} from "@/lib/coach/interventions/evaluate-outcome";
import type { CoachInterventionRow } from "@/lib/data/types";
import { readRolling30d } from "@/lib/whoop/baselines";
import { processRawWorkouts, WORKOUT_QUERY_COLS } from "@/lib/data/workouts";
import type { TrainingBlock } from "@/lib/data/types";

export const dynamic = "force-dynamic";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Dedup window: a candidate is considered duplicate when an existing row for the
 *  same (user_id, kind) has a started_on within ±DEDUP_DAYS of the candidate. */
const DEDUP_DAYS = 7;

// ── GET handler ───────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createSupabaseServiceRoleClient();

  const summary = {
    users_scanned: 0,
    detected: 0,
    inserted: 0,
    deduped: 0,
    evaluated: 0,
    errors: [] as Array<{ user_id: string; message: string }>,
  };

  // ── Fetch all users with an active training block ────────────────────────────

  const { data: activeBlocks, error: blocksErr } = await supabase
    .from("training_blocks")
    .select("id, user_id, start_date, end_date, primary_lift, target_metric, target_value, status, target_hit_at_week, goal_text, target_unit, diet_goal, endurance_focus, created_at, completed_at, updated_at")
    .eq("status", "active");

  if (blocksErr) {
    return NextResponse.json({ error: blocksErr.message }, { status: 500 });
  }

  // Deduplicate to one block per user (in case there are multiple; pick first)
  const blockByUser = new Map<string, typeof activeBlocks[number]>();
  for (const b of activeBlocks ?? []) {
    if (!blockByUser.has(b.user_id)) blockByUser.set(b.user_id, b);
  }

  // ── Also gather users who have pending rows to evaluate (no active block needed) ─

  const { data: pendingRows, error: pendingErr } = await supabase
    .from("coach_interventions")
    .select("*")
    .is("outcome_evaluated_at", null);

  if (pendingErr) {
    return NextResponse.json({ error: pendingErr.message }, { status: 500 });
  }

  // Collect all user IDs: those with active blocks + those with pending rows
  const userIds = new Set<string>();
  for (const b of blockByUser.keys()) userIds.add(b);
  for (const r of pendingRows ?? []) userIds.add(r.user_id);

  // ── Per-user sweep ────────────────────────────────────────────────────────────

  for (const userId of userIds) {
    summary.users_scanned += 1;

    try {
      // Resolve today in user's timezone
      const tz = await getUserTimezone(userId);
      const todayIso = todayInUserTz(new Date(), tz);

      // ── Step 1: Detect inferred candidates (only if user has active block) ────

      const block = blockByUser.get(userId);

      if (block) {
        const blockTyped = block as unknown as TrainingBlock;

        // Fetch workouts within the block window
        const { data: rawWorkouts } = await supabase
          .from("workouts")
          .select(WORKOUT_QUERY_COLS)
          .eq("user_id", userId)
          .gte("date", block.start_date)
          .lte("date", block.end_date)
          .order("date", { ascending: true });

        const workouts = processRawWorkouts(rawWorkouts ?? []);

        const primaryLift = block.primary_lift ?? "";
        const candidates = primaryLift
          ? detectInferredInterventions({ workouts, block: blockTyped, primaryLift })
          : [];

        summary.detected += candidates.length;

        // ── Step 2: Dedup and insert ───────────────────────────────────────────

        for (const candidate of candidates) {
          // Check for existing row within ±DEDUP_DAYS for same (user_id, kind)
          const windowStart = shiftDate(candidate.started_on, -DEDUP_DAYS);
          const windowEnd = shiftDate(candidate.started_on, DEDUP_DAYS);

          const { data: existing } = await supabase
            .from("coach_interventions")
            .select("id, source")
            .eq("user_id", userId)
            .eq("kind", candidate.kind)
            .gte("started_on", windowStart)
            .lte("started_on", windowEnd)
            .limit(1)
            .maybeSingle();

          if (existing) {
            // explicit wins: skip; inferred: idempotent skip
            summary.deduped += 1;
            continue;
          }

          const { error: insErr } = await supabase.from("coach_interventions").insert({
            user_id: userId,
            kind: candidate.kind,
            source: "inferred",
            started_on: candidate.started_on,
            context: candidate.context,
          });

          if (insErr) {
            summary.errors.push({ user_id: userId, message: `insert ${candidate.kind}: ${insErr.message}` });
          } else {
            summary.inserted += 1;
          }
        }
      }

      // ── Step 3: Evaluate closed-window pending rows ────────────────────────

      const userPendingRows = (pendingRows ?? []).filter(
        (r) => r.user_id === userId,
      ) as CoachInterventionRow[];

      for (const row of userPendingRows) {
        if (!windowClosed(row, todayIso)) continue;

        try {
          const outcome = await buildOutcome(supabase, userId, row, todayIso);

          const { error: stampErr } = await supabase
            .from("coach_interventions")
            .update({
              outcome,
              outcome_evaluated_at: new Date().toISOString(),
            })
            .eq("id", row.id);

          if (stampErr) {
            summary.errors.push({ user_id: userId, message: `stamp ${row.kind} ${row.id}: ${stampErr.message}` });
          } else {
            summary.evaluated += 1;
          }
        } catch (evalErr) {
          summary.errors.push({ user_id: userId, message: `eval ${row.kind} ${row.id}: ${(evalErr as Error).message}` });
        }
      }
    } catch (userErr) {
      summary.errors.push({ user_id: userId, message: (userErr as Error).message });
    }
  }

  return NextResponse.json({ ok: true, summary });
}

// ── buildOutcome: assemble ctx + call evaluator ────────────────────────────────

async function buildOutcome(
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string,
  row: CoachInterventionRow,
  todayIso: string,
): Promise<Record<string, unknown>> {
  if (row.kind === "reactive_deload") {
    return buildDeloadOutcome(supabase, userId, row, todayIso);
  }
  if (row.kind === "exercise_swap") {
    return buildSwapOutcome(supabase, userId, row, todayIso);
  }
  if (row.kind === "nutrition_change") {
    return buildNutritionOutcome(supabase, userId, row, todayIso);
  }
  return { success: null, signal: "unknown kind" };
}

// ── reactive_deload ctx assembly ──────────────────────────────────────────────

async function buildDeloadOutcome(
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string,
  row: CoachInterventionRow,
  _todayIso: string,
): Promise<Record<string, unknown>> {
  const windowDays = OUTCOME_WINDOWS.reactive_deload;
  const windowEnd = shiftDate(row.started_on, windowDays);
  // 7d before trigger for "before" sets
  const beforeStart = shiftDate(row.started_on, -7);

  // Fetch daily_logs in the window
  const { data: dlWindow } = await supabase
    .from("daily_logs")
    .select("date, hrv, recovery")
    .eq("user_id", userId)
    .gte("date", row.started_on)
    .lte("date", windowEnd);

  // Fetch primary lift from block context
  const primaryLift = typeof row.context.block_id === "string"
    ? await getPrimaryLiftForBlock(supabase, row.context.block_id)
    : null;

  // Fetch workouts before (7d) and after (window) for the primary lift
  const { data: rawBefore } = await supabase
    .from("workouts")
    .select(WORKOUT_QUERY_COLS)
    .eq("user_id", userId)
    .gte("date", beforeStart)
    .lt("date", row.started_on)
    .order("date", { ascending: true });

  const { data: rawAfter } = await supabase
    .from("workouts")
    .select(WORKOUT_QUERY_COLS)
    .eq("user_id", userId)
    .gte("date", row.started_on)
    .lte("date", windowEnd)
    .order("date", { ascending: true });

  const sessionsBefore = processRawWorkouts(rawBefore ?? []);
  const sessionsAfter = processRawWorkouts(rawAfter ?? []);

  // Extract sets for the primary lift
  const workouts_before = extractSets(sessionsBefore, primaryLift);
  const workouts_after = extractSets(sessionsAfter, primaryLift);

  // Fetch rolling baselines from profiles
  const { data: profile } = await supabase
    .from("profiles")
    .select("whoop_baselines")
    .eq("user_id", userId)
    .maybeSingle();

  const rolling = readRolling30d(profile?.whoop_baselines ?? null);

  const ctx: DeloadEvalCtx = {
    triggered_at: row.started_on,
    daily_logs: (dlWindow ?? []).map((l) => ({
      date: l.date,
      hrv: l.hrv as number | null,
      recovery: l.recovery as number | null,
    })),
    workouts_before,
    workouts_after,
    hrv_baseline: rolling?.hrv ?? null,
    recovery_baseline: rolling?.recovery ?? null,
  };

  return evaluateDeloadOutcome(row, ctx) as Record<string, unknown>;
}

// ── exercise_swap ctx assembly ────────────────────────────────────────────────

async function buildSwapOutcome(
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string,
  row: CoachInterventionRow,
  _todayIso: string,
): Promise<Record<string, unknown>> {
  const windowDays = OUTCOME_WINDOWS.exercise_swap;
  const windowEnd = shiftDate(row.started_on, windowDays);

  const toExercise = typeof row.context.to_exercise === "string"
    ? row.context.to_exercise
    : null;

  // Fetch soreness checkins in window
  const { data: checkins } = await supabase
    .from("checkins")
    .select("date, soreness_areas")
    .eq("user_id", userId)
    .gte("date", row.started_on)
    .lte("date", windowEnd);

  // Fetch workouts for the replacement exercise on trigger day (baseline_sets)
  // and during the window (post_swap_sets)
  const { data: rawBaseline } = await supabase
    .from("workouts")
    .select(WORKOUT_QUERY_COLS)
    .eq("user_id", userId)
    .eq("date", row.started_on);

  const { data: rawPost } = await supabase
    .from("workouts")
    .select(WORKOUT_QUERY_COLS)
    .eq("user_id", userId)
    .gt("date", row.started_on)
    .lte("date", windowEnd)
    .order("date", { ascending: true });

  const baselineSessions = processRawWorkouts(rawBaseline ?? []);
  const postSessions = processRawWorkouts(rawPost ?? []);

  const baseline_sets = extractSets(baselineSessions, toExercise);
  const post_swap_sets = extractSets(postSessions, toExercise);

  // Infer swapped_muscle_area from the from_exercise name (simple heuristic)
  const fromExercise = typeof row.context.from_exercise === "string"
    ? row.context.from_exercise
    : "";
  const swapped_muscle_area = inferMuscleArea(fromExercise);

  const ctx: SwapEvalCtx = {
    triggered_at: row.started_on,
    soreness_checkins: (checkins ?? []).map((c) => ({
      date: c.date,
      areas: (c.soreness_areas as string[] | null) ?? [],
    })),
    swapped_muscle_area,
    baseline_sets,
    post_swap_sets,
  };

  return evaluateSwapOutcome(row, ctx) as Record<string, unknown>;
}

// ── nutrition_change ctx assembly ─────────────────────────────────────────────

async function buildNutritionOutcome(
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string,
  row: CoachInterventionRow,
  _todayIso: string,
): Promise<Record<string, unknown>> {
  const windowDays = OUTCOME_WINDOWS.nutrition_change;
  const windowEnd = shiftDate(row.started_on, windowDays);
  const baselineStart = shiftDate(row.started_on, -7);

  const { data: baselineDl } = await supabase
    .from("daily_logs")
    .select("date, calories_eaten, protein_g, weight_kg")
    .eq("user_id", userId)
    .gte("date", baselineStart)
    .lt("date", row.started_on);

  const { data: windowDl } = await supabase
    .from("daily_logs")
    .select("date, calories_eaten, protein_g, weight_kg")
    .eq("user_id", userId)
    .gte("date", row.started_on)
    .lte("date", windowEnd);

  // Derive sub_kind from the real NutritionContext fields written by buildExplicitIntervention.
  // The writer stores { field, from, to } — NOT sub_kind / caloric_target.
  const field = typeof row.context.field === "string" ? row.context.field : null;
  const sub_kind: NutritionEvalCtx["sub_kind"] =
    field === "kcal"
      ? "caloric_adjustment"
      : field === "protein_g"
      ? "protein_increase"
      : field === "weight_kg" || field === "body_fat_pct" || field === "fat_mass_kg"
      ? "body_comp_improve"
      : "protein_increase"; // safe fallback for unknown fields
  const caloric_target =
    field === "kcal" && typeof row.context.to === "number"
      ? row.context.to
      : undefined;

  const ctx: NutritionEvalCtx = {
    triggered_at: row.started_on,
    sub_kind,
    baseline_logs: (baselineDl ?? []).map((l) => ({
      date: l.date,
      calories_eaten: l.calories_eaten as number | null,
      protein_g: l.protein_g as number | null,
      weight_kg: l.weight_kg as number | null,
    })),
    window_logs: (windowDl ?? []).map((l) => ({
      date: l.date,
      calories_eaten: l.calories_eaten as number | null,
      protein_g: l.protein_g as number | null,
      weight_kg: l.weight_kg as number | null,
    })),
    caloric_target,
  };

  return evaluateNutritionOutcome(row, ctx) as Record<string, unknown>;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Shift an ISO date string by N days (positive = forward, negative = backward). */
function shiftDate(dateIso: string, days: number): string {
  const ms = new Date(dateIso + "T00:00:00Z").getTime() + days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Extract sets for a specific exercise from workout sessions. Returns [] if no
 *  exercise name provided or no matching sets found. */
function extractSets(
  sessions: ReturnType<typeof processRawWorkouts>,
  exerciseName: string | null,
): Array<{ date: string; exercise: string; kg: number; reps: number; warmup: boolean }> {
  if (!exerciseName) return [];
  const target = exerciseName.toLowerCase();
  const result: Array<{ date: string; exercise: string; kg: number; reps: number; warmup: boolean }> = [];
  for (const s of sessions) {
    for (const e of s.exercises) {
      if (e.name.toLowerCase() !== target) continue;
      for (const set of e.sets) {
        if (set.kg == null || set.reps == null) continue;
        result.push({
          date: s.date,
          exercise: e.name,
          kg: set.kg,
          reps: set.reps,
          warmup: set.warmup,
        });
      }
    }
  }
  return result;
}

/** Fetch primary_lift for a block by id. Returns null if not found. */
async function getPrimaryLiftForBlock(
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  blockId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("training_blocks")
    .select("primary_lift")
    .eq("id", blockId)
    .maybeSingle();
  return data?.primary_lift ?? null;
}

/** Infer a muscle area label from an exercise name (best-effort, used for swap
 *  ctx's swapped_muscle_area field). The evaluator does a substring match, so
 *  rough anatomy labelling is sufficient. */
function inferMuscleArea(exerciseName: string): string {
  const name = exerciseName.toLowerCase();
  if (/hamstring|rdl|leg curl|hip thrust/.test(name)) return "hamstrings";
  if (/quad|squat|leg press|leg ext/.test(name)) return "quads";
  if (/glute/.test(name)) return "glutes";
  if (/calf|calves/.test(name)) return "calves";
  if (/chest|bench|fly/.test(name)) return "chest";
  if (/back|row|pull|lat|deadlift/.test(name)) return "back";
  if (/shoulder|press|delt|ohp|arnold/.test(name)) return "shoulders";
  if (/tricep/.test(name)) return "triceps";
  if (/bicep|curl/.test(name)) return "biceps";
  if (/core|plank|ab/.test(name)) return "core";
  // Fallback: use the first word of the exercise name
  return exerciseName.split(/\s+/)[0].toLowerCase();
}
