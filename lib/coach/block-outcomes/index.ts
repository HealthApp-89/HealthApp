// lib/coach/block-outcomes/index.ts
//
// Orchestrator: loads data, runs the rule modules, returns the row payload
// the cron inserts. Handles secondary-lift summary (non-focus primaries'
// end kg + clamp adherence) since that data is shared across rule outputs.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { TrainingBlock, BlockOutcome, PrimaryLift } from "@/lib/data/types";
import type { BlockSetSample, SecondaryLiftOutcome } from "@/lib/coach/block-outcomes/types";
import { evaluateBlockOutcome } from "@/lib/coach/block-outcomes/evaluator";
import { recommendNextFocus } from "@/lib/coach/block-outcomes/rotation";
import { recommendNextTargetKg } from "@/lib/coach/block-outcomes/recalibrate-target";
import { composeLessons } from "@/lib/coach/block-outcomes/lessons";

const PRIMARY_LIFT_NAME_PATTERNS: Record<PrimaryLift, string[]> = {
  squat:    ["Squat (Barbell)"],
  bench:    ["Decline Bench Press (Barbell)", "Incline Bench Press (Dumbbell)", "Bench Press (Barbell)"],
  deadlift: ["Deadlift (Barbell)"],
  ohp:      ["Overhead Press (Barbell)"],
};

export type GenerateBlockOutcomeResult = {
  payload: Omit<BlockOutcome, "id" | "athlete_acknowledged_at" | "created_at" | "updated_at">;
};

export async function generateBlockOutcome(opts: {
  supabase: SupabaseClient;
  userId: string;
  blockId: string;
}): Promise<GenerateBlockOutcomeResult> {
  const { supabase, userId, blockId } = opts;

  const { data: blockRow } = await supabase
    .from("training_blocks")
    .select("*")
    .eq("id", blockId)
    .eq("user_id", userId)
    .maybeSingle();
  const block = blockRow as TrainingBlock | null;
  if (!block) throw new Error(`block ${blockId} not found for user`);

  const { data: wRows } = await supabase
    .from("workouts")
    .select("date, exercises(name, exercise_sets(kg, reps, warmup, failure))")
    .eq("user_id", userId)
    .gte("date", block.start_date)
    .lte("date", block.end_date);

  type RawSet = { kg: number | null; reps: number | null; warmup: boolean | null; failure: boolean | null };
  type RawEx = { name: string; exercise_sets: RawSet[] | null };
  type RawW = { date: string; exercises: RawEx[] | null };
  const rows = (wRows ?? []) as unknown as RawW[];

  const blockStartMs = new Date(block.start_date + "T00:00:00Z").getTime();
  const cleanSetsByName: Map<string, BlockSetSample[]> = new Map();
  for (const w of rows) {
    for (const ex of w.exercises ?? []) {
      for (const s of ex.exercise_sets ?? []) {
        if (s.kg == null || s.reps == null) continue;
        if (s.warmup || s.failure) continue;
        if (s.reps < 5) continue;
        const performedMs = new Date(w.date + "T00:00:00Z").getTime();
        const weekN = Math.max(1, Math.floor((performedMs - blockStartMs) / (7 * 24 * 60 * 60 * 1000)) + 1);
        const sample: BlockSetSample = {
          exercise_name: ex.name,
          kg: s.kg,
          reps: s.reps,
          performed_on: w.date,
          weekN,
        };
        const list = cleanSetsByName.get(ex.name) ?? [];
        list.push(sample);
        cleanSetsByName.set(ex.name, list);
      }
    }
  }

  const primaryLift = block.primary_lift;
  if (primaryLift == null) {
    throw new Error(`block ${blockId} has no primary_lift; cannot evaluate`);
  }

  const primaryNames = PRIMARY_LIFT_NAME_PATTERNS[primaryLift];
  const primarySets: BlockSetSample[] = [];
  for (const name of primaryNames) {
    primarySets.push(...(cleanSetsByName.get(name) ?? []));
  }

  const blockEndMs = new Date(block.end_date + "T00:00:00Z").getTime();
  const totalBlockWeeks = Math.max(1, Math.round((blockEndMs - blockStartMs) / (7 * 24 * 60 * 60 * 1000)));

  const facts = evaluateBlockOutcome({ block, primarySets, totalBlockWeeks });

  const secondaryLifts: SecondaryLiftOutcome[] = (["squat", "bench", "deadlift", "ohp"] as PrimaryLift[])
    .filter((l) => l !== primaryLift)
    .map((l) => {
      const names = PRIMARY_LIFT_NAME_PATTERNS[l];
      const sets: BlockSetSample[] = [];
      for (const name of names) sets.push(...(cleanSetsByName.get(name) ?? []));
      const endKg = sets.length > 0 ? Math.max(...sets.map((s) => s.kg)) : null;
      const startKg = sets.length > 0 ? Math.min(...sets.map((s) => s.kg)) : null;
      const clamp_held = endKg == null || startKg == null ? true : endKg <= startKg * 1.05;
      return { lift: l, end_kg: endKg, clamp_held };
    });

  const { data: allBlocks } = await supabase
    .from("training_blocks")
    .select("*")
    .eq("user_id", userId)
    .order("end_date", { ascending: false });
  const userBlocks = (allBlocks ?? []) as TrainingBlock[];

  const { data: profile } = await supabase
    .from("profiles")
    .select("rotation_priority_lift")
    .eq("user_id", userId)
    .maybeSingle();
  const priorityLift = (profile?.rotation_priority_lift as PrimaryLift | null) ?? null;

  const rotationDecision = recommendNextFocus({
    userBlocks,
    priorityLift,
    lastOutcome: { primary_lift: primaryLift, block_phase_at_end: facts.block_phase_at_end },
  });

  const { data: prevOutcomesRows } = await supabase
    .from("block_outcomes")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  const prevOutcomes = (prevOutcomesRows ?? []) as BlockOutcome[];
  const fallbackWorkingKg = computeFallbackForRecommendedLift(cleanSetsByName, rotationDecision.recommended_lift);
  const recommendedTargetKg = recommendNextTargetKg({
    lift: rotationDecision.recommended_lift,
    outcomeHistory: prevOutcomes,
    fallbackWorkingKg,
  });

  const lessons = composeLessons({
    facts,
    primaryLift,
    targetValueKg: block.target_value,
    secondaryLifts,
    rotationDecision,
  });

  return {
    payload: {
      block_id: blockId,
      user_id: userId,
      primary_lift: primaryLift,
      target_value_kg: block.target_value,
      target_metric: block.target_metric,
      end_working_kg: facts.end_working_kg,
      target_hit: facts.target_hit,
      target_hit_at_week: block.target_hit_at_week,
      block_phase_at_end: facts.block_phase_at_end,
      lessons,
      recommended_next_focus: rotationDecision.recommended_lift,
      recommended_target_value_kg: recommendedTargetKg,
    },
  };
}

function computeFallbackForRecommendedLift(
  cleanSetsByName: Map<string, BlockSetSample[]>,
  lift: PrimaryLift,
): number | null {
  const names = PRIMARY_LIFT_NAME_PATTERNS[lift];
  const sets: BlockSetSample[] = [];
  for (const name of names) sets.push(...(cleanSetsByName.get(name) ?? []));
  if (sets.length === 0) return null;
  return Math.max(...sets.map((s) => s.kg));
}
