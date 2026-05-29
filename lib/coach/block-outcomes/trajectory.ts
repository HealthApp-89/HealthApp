// lib/coach/block-outcomes/trajectory.ts
//
// Cross-block macrocycle analysis. Reads block_outcomes joined with
// training_blocks for window fields. Returns the BlockTrajectoryPayload
// consumed by /coach/trends + BlockOutcomeCard's macrocycle line.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PrimaryLift, BlockTrajectoryPayload, TrainingBlock } from "@/lib/data/types";
import { ROTATION_ORDER, idealSequence } from "@/lib/coach/block-outcomes/rotation";

type OutcomeWithWindow = {
  block_id: string;
  primary_lift: PrimaryLift;
  target_value_kg: number | null;
  end_working_kg: number | null;
  block_phase_at_end: "hit_early" | "hit_on_pace" | "off_pace" | "underperformed";
  lessons: {
    observed_step_kg_per_wk?: number | null;
    rotation_context?: { athlete_overrode_rotation?: boolean };
  } | null;
  created_at: string;
  training_blocks: { start_date: string; end_date: string } | null;
};

export async function generateBlockTrajectory(opts: {
  supabase: SupabaseClient;
  userId: string;
  todayIso: string;
}): Promise<BlockTrajectoryPayload> {
  const { supabase, userId, todayIso } = opts;

  const { data: outcomes } = await supabase
    .from("block_outcomes")
    .select("block_id, primary_lift, target_value_kg, end_working_kg, block_phase_at_end, lessons, created_at, training_blocks!inner(start_date, end_date)")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  const closed = ((outcomes ?? []) as unknown as OutcomeWithWindow[]);

  const { data: activeBlocks } = await supabase
    .from("training_blocks")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .limit(1);
  const active = (activeBlocks?.[0] as TrainingBlock | undefined) ?? null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("rotation_priority_lift")
    .eq("user_id", userId)
    .maybeSingle();
  const priorityLift = (profile?.rotation_priority_lift as PrimaryLift | null) ?? null;

  const per_lift = ROTATION_ORDER.map((lift) => {
    const liftBlocks = closed
      .filter((o) => o.primary_lift === lift)
      .map((o) => ({
        block_id: o.block_id,
        window: {
          start_date: o.training_blocks?.start_date ?? "",
          end_date: o.training_blocks?.end_date ?? "",
        },
        target_kg: o.target_value_kg,
        end_working_kg: o.end_working_kg,
        block_phase_at_end: o.block_phase_at_end,
        calibration_error_pct:
          o.target_value_kg != null && o.end_working_kg != null && o.target_value_kg !== 0
            ? ((o.target_value_kg - o.end_working_kg) / o.target_value_kg) * 100
            : null,
      }));

    return {
      lift,
      blocks: liftBlocks,
      long_term_progression_kg_per_year: ltProgressionKgPerYear(liftBlocks),
      target_calibration_trend: calibrationTrend(liftBlocks),
      weeks_since_last_focus: weeksSinceLastFocus(liftBlocks, todayIso),
    };
  });

  const actual_sequence = closed.map((o) => o.primary_lift);
  if (active?.primary_lift != null) actual_sequence.push(active.primary_lift);
  const ideal_sequence = idealSequence({
    n: Math.max(1, actual_sequence.length),
    priorityLift,
  });
  const deviations: BlockTrajectoryPayload["rotation_adherence"]["deviations"] = [];
  for (let i = 0; i < actual_sequence.length; i++) {
    if (actual_sequence[i] !== ideal_sequence[i]) {
      const o = closed[i];
      deviations.push({
        block_id: o?.block_id ?? "active",
        expected: ideal_sequence[i],
        actual: actual_sequence[i],
        reason: o?.lessons?.rotation_context?.athlete_overrode_rotation
          ? "athlete_choice"
          : (priorityLift != null ? "priority_lift_injection" : "first_block"),
      });
    }
  }
  const adherence_pct =
    actual_sequence.length > 0
      ? ((actual_sequence.length - deviations.length) / actual_sequence.length) * 100
      : 100;

  const next_focus_due =
    actual_sequence.length > 0
      ? idealSequence({ n: actual_sequence.length + 1, priorityLift })[actual_sequence.length]
      : (priorityLift ?? "deadlift");

  return {
    per_lift,
    rotation_adherence: { ideal_sequence, actual_sequence, adherence_pct, deviations },
    next_focus_due,
  };
}

function ltProgressionKgPerYear(blocks: Array<{ end_working_kg: number | null; window: { end_date: string } }>): number | null {
  const pts = blocks.filter((b) => b.end_working_kg != null && b.window.end_date !== "");
  if (pts.length < 2) return null;
  const first = new Date(pts[0].window.end_date + "T00:00:00Z").getTime();
  const points = pts.map((b) => [
    (new Date(b.window.end_date + "T00:00:00Z").getTime() - first) / (24 * 60 * 60 * 1000),
    b.end_working_kg as number,
  ] as [number, number]);
  const n = points.length;
  const sumX = points.reduce((a, p) => a + p[0], 0);
  const sumY = points.reduce((a, p) => a + p[1], 0);
  const sumXY = points.reduce((a, p) => a + p[0] * p[1], 0);
  const sumX2 = points.reduce((a, p) => a + p[0] * p[0], 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  return slope * 365;
}

function calibrationTrend(
  blocks: Array<{ calibration_error_pct: number | null }>,
): "improving" | "stable" | "drifting" | "insufficient_data" {
  const errs = blocks.map((b) => b.calibration_error_pct).filter((e): e is number => e != null);
  if (errs.length < 3) return "insufficient_data";
  const recent = errs.slice(-3);
  const older = errs.slice(0, -3);
  if (older.length === 0) return "stable";
  const recentAbs = recent.reduce((a, x) => a + Math.abs(x), 0) / recent.length;
  const olderAbs = older.reduce((a, x) => a + Math.abs(x), 0) / older.length;
  if (recentAbs < olderAbs * 0.7) return "improving";
  if (recentAbs > olderAbs * 1.3) return "drifting";
  return "stable";
}

function weeksSinceLastFocus(
  blocks: Array<{ window: { end_date: string } }>,
  todayIso: string,
): number | null {
  const last = blocks[blocks.length - 1];
  if (!last || last.window.end_date === "") return null;
  const todayMs = new Date(todayIso + "T00:00:00Z").getTime();
  const endMs = new Date(last.window.end_date + "T00:00:00Z").getTime();
  return Math.max(0, Math.round((todayMs - endMs) / (7 * 24 * 60 * 60 * 1000)));
}
