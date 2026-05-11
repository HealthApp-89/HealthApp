// lib/coach/plan-builder/compose-periodization.ts
//
// Composes periodization section of plan_payload.
// Fixed defaults for v1: 5-week blocks ending in deload, RIR step-down
// 4→3→2→1→deload, rotation rule = fixed_split.

import type { IntakePayload, PlanPayload } from "@/lib/data/types";

export function composePeriodization(
  intake: IntakePayload,
): PlanPayload["periodization"] {
  const today = new Date();
  const targetDate = new Date(intake.goals.target_date);
  const daysToTarget = Math.max(
    0,
    (targetDate.getTime() - today.getTime()) / 86_400_000,
  );
  const blocksToGoalDate = Math.ceil(daysToTarget / 7 / 5);

  return {
    block_length_weeks: 5,
    blocks_to_goal_date: blocksToGoalDate,
    deload_cadence_weeks: 5,
    rir_arc: [
      { week: 1, rir: 4 },
      { week: 2, rir: 3 },
      { week: 3, rir: 2 },
      { week: 4, rir: 1 },
      { week: 5, rir: null }, // deload
    ],
    rotation_rule: "fixed_split",
  };
}
