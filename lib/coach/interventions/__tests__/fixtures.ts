// lib/coach/interventions/__tests__/fixtures.ts
//
// Test fixtures for classify-strength tests.
// Provides a minimal TrainingBlock builder and week-volume helpers.

import type { TrainingBlock } from "@/lib/data/types";

/** Build a minimal TrainingBlock with sensible defaults.
 *  start_date and end_date span 5 weeks (35 days).
 *  Overrides are shallow-merged over the defaults. */
export function makeBlock(overrides: Partial<TrainingBlock> = {}): TrainingBlock {
  const start = overrides.start_date ?? "2026-05-25"; // Monday
  const startMs = new Date(start + "T00:00:00Z").getTime();
  const endDate =
    overrides.end_date ??
    new Date(startMs + 34 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); // +34 days = 5-week block

  const base: TrainingBlock = {
    id: "block-fixture-1",
    user_id: "user-fixture-1",
    status: "active",
    start_date: start,
    end_date: endDate,
    goal_text: "Increase deadlift working weight",
    primary_lift: "deadlift",
    target_metric: "working_weight",
    target_value: 200,
    target_hit_at_week: null,
    target_unit: "kg",
    diet_goal: null,
    endurance_focus: null,
    session_structure_overrides: null,
    created_at: "2026-05-25T00:00:00Z",
    completed_at: null,
    updated_at: "2026-05-25T00:00:00Z",
  };
  // Spread overrides last so caller values win; end_date was already derived
  // from start_date above and is overwritten correctly via ...overrides.
  return { ...base, ...overrides };
}

/** Week-volume helper: produces a series of per-week primary-lift load values.
 *  Returns an array of { week: number; loadKg: number } entries.
 *  Useful for constructing scenarios where a load drop is visible. */
export function makeWeekVolume(
  baseKg: number,
  weeklySteps: number[],
): Array<{ week: number; loadKg: number }> {
  let current = baseKg;
  return weeklySteps.map((step, i) => {
    current += step;
    return { week: i + 1, loadKg: current };
  });
}

// ── Pre-built scenario objects ─────────────────────────────────────────────

/** A 5-week block where "today" is in the final (deload) week (week 5). */
export const blockInDeloadWeek = makeBlock({
  start_date: "2026-05-25", // Monday week 1
  // end_date = 2026-06-28, today 2026-06-26 is in week 5
});

/** A 5-week block where "today" is in week 3 (mid-block). */
export const blockMidBlock = makeBlock({
  start_date: "2026-06-02", // Monday, so week 1 = Jun 2, week 2 = Jun 9, week 3 = Jun 16
  // today 2026-06-12 lands in week 2; use start 2026-05-25 instead
});

// Override: use start that puts 2026-06-12 in week 3
export const blockForWeek3 = makeBlock({
  start_date: "2026-05-25", // week 1=May25, week 2=Jun1, week 3=Jun8, week 4=Jun15, week 5=Jun22
  // today 2026-06-12 = 18 days in => week 3
});
