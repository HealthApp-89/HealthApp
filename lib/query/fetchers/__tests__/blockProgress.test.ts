import { describe, expect, it } from "vitest";
import { deriveBlockCalendar } from "@/lib/query/fetchers/blockProgress";
import type { TrainingBlock } from "@/lib/data/types";

/** The athlete's real block: 2026-07-13 → 2026-09-06 is 8 weeks. */
function block(overrides: Partial<TrainingBlock> = {}): TrainingBlock {
  return {
    id: "b1",
    user_id: "u1",
    status: "active",
    start_date: "2026-07-13",
    end_date: "2026-09-06",
    goal_text: "",
    primary_lift: "squat",
    target_metric: "e1rm",
    target_value: 112,
    target_unit: "kg",
    diet_goal: null,
    created_at: "",
    completed_at: null,
    updated_at: "",
    target_hit_at_week: null,
    endurance_focus: null,
    session_structure_overrides: null,
    ...overrides,
  } as TrainingBlock;
}

describe("deriveBlockCalendar — block length", () => {
  it("derives total_weeks from the block dates, not a hardcoded 5", () => {
    expect(deriveBlockCalendar(block(), null, "2026-08-03").total_weeks).toBe(8);
  });

  it("does not clamp current_week to 5", () => {
    expect(deriveBlockCalendar(block(), null, "2026-08-24").current_week).toBe(7);
  });

  it("reports week 1 on the block start date", () => {
    expect(deriveBlockCalendar(block(), null, "2026-07-13").current_week).toBe(1);
  });

  it("reports week 4 for the session that exposed the bug", () => {
    expect(deriveBlockCalendar(block(), null, "2026-08-03").current_week).toBe(4);
  });
});

describe("deriveBlockCalendar — phase", () => {
  it("is accumulate before the final week", () => {
    expect(deriveBlockCalendar(block(), null, "2026-08-03").research_phase).toBe("accumulate");
  });

  it("is deload on the final week", () => {
    expect(deriveBlockCalendar(block(), null, "2026-08-31").research_phase).toBe("deload");
  });

  it("stays accumulate when the target was already hit (consolidation)", () => {
    const b = block({ target_hit_at_week: 2 });
    expect(deriveBlockCalendar(b, null, "2026-08-03").research_phase).toBe("accumulate");
  });
});

describe("deriveBlockCalendar — RIR target", () => {
  it("falls back to 2 when the week row has no rir_target (matches prescribeWeek)", () => {
    expect(deriveBlockCalendar(block(), null, "2026-08-03").rir_target).toBe(2);
  });

  it("uses the week row's rir_target when set", () => {
    expect(deriveBlockCalendar(block(), 3, "2026-08-03").rir_target).toBe(3);
  });

  it("does not vary RIR by week number", () => {
    const w1 = deriveBlockCalendar(block(), null, "2026-07-13").rir_target;
    const w4 = deriveBlockCalendar(block(), null, "2026-08-03").rir_target;
    expect(w1).toBe(w4);
  });
});
