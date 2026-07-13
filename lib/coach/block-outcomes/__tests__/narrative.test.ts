import { describe, expect, test } from "vitest";
import { narrativeNumbersValid, deterministicNarrative } from "@/lib/coach/block-outcomes/narrative";
import type { BlockOutcome } from "@/lib/data/types";

const payload: Omit<BlockOutcome, "id" | "athlete_acknowledged_at" | "created_at" | "updated_at"> = {
  block_id: "b1", user_id: "u1", primary_lift: "bench",
  target_value_kg: 85, target_metric: "e1rm", end_working_kg: 90,
  target_hit: true, target_hit_at_week: 2, block_phase_at_end: "hit_early",
  lessons: {
    observed_step_kg_per_wk: 1.9, projected_kg_at_end: null, gap_kg: 5, gap_pct: 5.9,
    calibration_note: "Target set conservatively.",
    secondary_lifts: [{ lift: "squat", end_kg: 72.5, clamp_held: true }],
    rotation_context: { ideal_next: null, athlete_overrode_rotation: false, override_reason: null },
  },
  recommended_next_focus: "squat", recommended_target_value_kg: 82.5,
  narrative_md: null,
};
const win = { start_date: "2026-06-08", end_date: "2026-07-12" };

describe("narrativeNumbersValid", () => {
  test("accepts a narrative whose numbers all exist in the payload", () => {
    expect(narrativeNumbersValid("Hit 85 by week 2, ended at 90 (+1.9 kg/wk).", payload)).toBe(true);
  });
  test("rejects a fabricated number", () => {
    expect(narrativeNumbersValid("You ended at 97.5 kg.", payload)).toBe(false);
  });
  test("date fragments and small integers (weeks 1-5) are exempt", () => {
    expect(narrativeNumbersValid("A 5-week block ending Jul 12.", payload)).toBe(true);
  });
});

describe("deterministicNarrative", () => {
  test("mentions target, reached value and pick-up point", () => {
    const text = deterministicNarrative(payload, win);
    expect(text).toContain("85");
    expect(text).toContain("90");
    expect(text.toLowerCase()).toContain("pick up");
  });
  test("covers recommended_next_focus === primary_lift path", () => {
    const payloadSameLift = {
      ...payload,
      primary_lift: "bench" as const,
      recommended_next_focus: "bench" as const,
      recommended_target_value_kg: 92.5,
    };
    const text = deterministicNarrative(payloadSameLift, win);
    expect(text).toContain("92.5");
    expect(text.toLowerCase()).toContain("pick up");
  });
});
