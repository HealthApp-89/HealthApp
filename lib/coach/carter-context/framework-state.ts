// lib/coach/carter-context/framework-state.ts
//
// Builds the "Framework state" context block appended to Carter's system
// prompt for default-mode chat. Mirrors what evaluateBlockPhase +
// prescribePrimaryFromPhase would say if Carter were on the Sunday or
// workout-debrief path, so any chat question about progression / loads /
// block direction lands the same framework call.
//
// Goal: structurally prevent the 2026-05-28 "go to 100 kg next week" advice
// in default chat — same off_pace situation the debrief composer was
// rewritten to catch (PR #120). Carter cannot give advice that contradicts
// the framework if the framework's verdict is in his prompt.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { TrainingBlock, PrimaryLift, TargetMetric } from "@/lib/data/types";
import type { WorkoutSetSample, BlockPhase } from "@/lib/coach/prescription/types";
import { evaluateBlockPhase } from "@/lib/coach/prescription/block-phase-rule";
import {
  PRIMARY_LIFT_NAME_PATTERNS,
  currentComparisonValueForLift,
} from "@/lib/coach/prescription/current-comparison-value";
import { bestComparisonValue, metricLabel } from "@/lib/coach/e1rm";
import { todayInUserTz } from "@/lib/time";

/** Pure assembly — no Anthropic call. Returns null when no active focus
 *  block exists (Carter falls back to general autoregulation talk; no
 *  framework block injected). */
export async function buildFrameworkStateBlock(args: {
  supabase: SupabaseClient;
  userId: string;
}): Promise<string | null> {
  const { supabase, userId } = args;
  const todayIso = todayInUserTz();

  const { data: blocks } = await supabase
    .from("training_blocks")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .limit(1);

  const block = (blocks?.[0] as TrainingBlock | undefined) ?? null;

  // Between-blocks fallback (no active block, but possibly an unacknowledged outcome).
  if (!block || block.primary_lift == null) {
    const { data: outcomes } = await supabase
      .from("block_outcomes")
      .select("*")
      .eq("user_id", userId)
      .is("athlete_acknowledged_at", null)
      .order("created_at", { ascending: false })
      .limit(1);
    const outcome = outcomes?.[0] ?? null;
    if (!outcome) return null;

    const { data: profile } = await supabase
      .from("profiles")
      .select("rotation_priority_lift")
      .eq("user_id", userId)
      .maybeSingle();
    const priorityLift = (profile?.rotation_priority_lift as string | null) ?? null;

    const lines: string[] = [
      "<framework_state>",
      `Status: BETWEEN BLOCKS.`,
      `Last block: ${outcome.primary_lift} focus, ended ${outcome.block_phase_at_end} (reached ${outcome.end_working_kg ?? "n/a"} kg vs target ${outcome.target_value_kg ?? "n/a"}).`,
      `Block outcome written; not yet acknowledged by athlete.`,
      `Rotation recommends: ${outcome.recommended_next_focus} focus next block. Suggested target: ${outcome.recommended_target_value_kg ?? "tbd"} kg.`,
    ];
    if (priorityLift != null) {
      lines.push(`Athlete priority lift: ${priorityLift}.`);
    }
    lines.push(``);
    lines.push(`Framework rule (NON-NEGOTIABLE):`);
    lines.push(`  Do NOT propose a new ${outcome.primary_lift} block immediately. The 4-lift rotation puts ${outcome.recommended_next_focus} next. If the athlete pushes for consecutive ${outcome.primary_lift} focus, explain the recovery + balance reasoning ONCE and respect their override if they hold firm. Do NOT volunteer a ${outcome.primary_lift} re-focus.`);
    lines.push(`</framework_state>`);

    return lines.join("\n");
  }

  // Fetch last 28 days of sets for the primary lift to find current working kg.
  const cutoff = subtractDaysIso(todayIso, 28);
  const { data: wRows } = await supabase
    .from("workouts")
    .select("date, exercises(name, exercise_sets(kg, reps, warmup, failure))")
    .eq("user_id", userId)
    .gte("date", cutoff)
    .order("date", { ascending: false });

  type RawSet = { kg: number | null; reps: number | null; warmup: boolean | null; failure: boolean | null };
  type RawEx = { name: string; exercise_sets: RawSet[] | null };
  type RawW = { date: string; exercises: RawEx[] | null };
  const rows = (wRows ?? []) as unknown as RawW[];

  const recentSets: WorkoutSetSample[] = [];
  for (const w of rows) {
    for (const ex of w.exercises ?? []) {
      for (const s of ex.exercise_sets ?? []) {
        if (s.kg == null || s.reps == null) continue;
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

  const namePatterns = PRIMARY_LIFT_NAME_PATTERNS[block.primary_lift];
  const metric: TargetMetric = (block.target_metric as TargetMetric | null) ?? "working_weight";
  const currentWorkingKg = currentComparisonValueForLift({
    lift: block.primary_lift,
    metric,
    recentSets,
    rirTarget: 2,
    todayIso,
  });

  // Observed weekly progression rate for the primary lift — needed for the
  // block-phase rule's off_pace detection. Computed in the SAME comparison
  // space as currentWorkingKg (kg for working_weight blocks, e1RM for e1rm
  // blocks) so the off_pace required-vs-observed math is internally
  // consistent. Returns null if fewer than 2 clean primary-lift sets exist;
  // phase then falls back to pre_target.
  const recentProgressionRatePerWeek = estimateProgressionRate(recentSets, namePatterns, metric);

  const weekN = currentBlockWeek(block, todayIso);
  const totalWeeks = totalBlockWeeks(block);

  const phase: BlockPhase = evaluateBlockPhase({
    block,
    currentWorkingKg,
    recentProgressionRatePerWeek,
    todayIso,
  });

  const weeksLeft = Math.max(0, totalWeeks - weekN);
  // Required step is the per-week kg jump needed to hit target from current.
  // weeksLeft can be 0 (final accumulation week or already in deload); in
  // that case there's no in-block progression runway at all.
  const requiredStep =
    block.target_value != null && currentWorkingKg != null && weeksLeft > 0
      ? (block.target_value - currentWorkingKg) / weeksLeft
      : null;

  const unit = metricLabel(metric);
  const lines: string[] = [];
  lines.push("<framework_state>");
  lines.push(`Active block: ${block.primary_lift} focus, target ${block.target_value ?? "n/a"} ${unit}, window ${block.start_date} → ${block.end_date}.`);
  lines.push(`Today: ${todayIso} — week ${weekN} of ${totalWeeks}.`);
  if (block.target_hit_at_week != null) {
    lines.push(`target_hit_at_week = ${block.target_hit_at_week} (block target ALREADY MET — consolidation engaged).`);
  }
  lines.push("");
  lines.push(`Primary lift (${block.primary_lift}):`);
  lines.push(`  current ${metric === "e1rm" ? "best e1RM" : "working kg"}: ${currentWorkingKg ?? "unknown (no clean working set in last 28d)"}`);
  lines.push(`  block phase: **${phase}**`);
  if (requiredStep != null) {
    lines.push(`  required progression to hit target: ${requiredStep.toFixed(2)} ${metric === "e1rm" ? "e1RM kg" : "kg"}/wk over ${weeksLeft} remaining week${weeksLeft === 1 ? "" : "s"}.`);
  }
  lines.push("");
  lines.push("Framework rule for this phase (NON-NEGOTIABLE):");
  switch (phase) {
    case "pre_target":
      lines.push("  pre_target → if last working set met prescribed RIR cleanly, advise +equipment step (typically +2.5 kg barbell). If missed, advise HOLD. Do NOT propose jumps larger than +step.");
      break;
    case "consolidation":
      lines.push("  consolidation → HOLD load. Progress reps by +1 (sets stay at baseline; do NOT add a set in the same week). The block target was hit early; raising target mid-block is forbidden — close the block and start a new one to raise targets.");
      break;
    case "off_pace":
      lines.push("  off_pace → HOLD load AND HOLD sets. The required progression rate exceeds normal step — the block target is out of reach in remaining weeks. Name it clearly to the athlete, explain the math, suggest accepting the current block result and resetting target next block. Do NOT push harder load to try to catch up.");
      break;
    case "deload_week":
      lines.push("  deload_week → drop load to ~0.80×, cut sets ~50%. Don't apologize for the deload; own it as structural recovery.");
      break;
  }
  lines.push("");
  lines.push("When giving any advice about progression, loads, or next-session prescriptions for the primary lift — your answer must be consistent with the rule above. Do NOT contradict the framework in prose. If the athlete pushes back, explain the math; do not capitulate to ego-pressure.");
  lines.push("</framework_state>");

  return lines.join("\n");
}

// ── helpers (kept local — same shape as block-phase-rule.ts internals) ────

function subtractDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function currentBlockWeek(block: TrainingBlock, todayIso: string): number {
  const start = new Date(block.start_date + "T00:00:00Z");
  const today = new Date(todayIso + "T00:00:00Z");
  const days = Math.floor((today.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  return Math.max(1, Math.floor(days / 7) + 1);
}

function totalBlockWeeks(block: TrainingBlock): number {
  const start = new Date(block.start_date + "T00:00:00Z");
  const end = new Date(block.end_date + "T00:00:00Z");
  const days = Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  return Math.round(days / 7);
}

/** Observed per-week progression rate (kg/wk for working_weight blocks,
 *  e1RM-kg/wk for e1rm blocks) across clean primary-lift sets in the 28-day
 *  window. Returns null when fewer than 2 valid samples exist. */
function estimateProgressionRate(
  sets: WorkoutSetSample[],
  namePatterns: string[],
  metric: TargetMetric,
): number | null {
  const nameSet = new Set(namePatterns.map((n) => n.toLowerCase()));
  const matching = sets
    .filter((s) => !s.warmup && !s.failure && nameSet.has(s.exercise_name.toLowerCase()))
    .sort((a, b) => (a.performed_on < b.performed_on ? -1 : 1)); // oldest first
  if (matching.length < 2) return null;
  const samples = matching
    .map((s) => {
      const v =
        metric === "e1rm"
          ? bestComparisonValue([{ kg: s.kg, reps: s.reps, warmup: false }], "e1rm")
          : s.kg;
      return v == null ? null : { v, performed_on: s.performed_on };
    })
    .filter((x): x is { v: number; performed_on: string } => x != null);
  if (samples.length < 2) return null;
  const oldest = samples[0];
  const newest = samples[samples.length - 1];
  const days = Math.max(
    1,
    Math.round(
      (new Date(newest.performed_on + "T00:00:00Z").getTime() -
        new Date(oldest.performed_on + "T00:00:00Z").getTime()) /
        (24 * 60 * 60 * 1000),
    ),
  );
  const weeks = Math.max(1, days / 7);
  return (newest.v - oldest.v) / weeks;
}
