// lib/coach/prescription/__tests__/block-week.test.ts
//
// blockWeekOf is the single source of truth for turning a block start date
// plus an as-of date into a 1-indexed block-week number. Extracted so
// currentBlockWeek (block-phase-rule.ts) and target-hit-evaluator.ts's stamp
// computation share one implementation instead of drifting into two copies
// of the same date arithmetic. This is the property the whole target-hit-
// week task exists to establish: the stamped week equals the block week of
// the session that actually qualified, not of "now".

import { describe, it, expect } from "vitest";
import { blockWeekOf } from "@/lib/coach/prescription/block-week";

describe("blockWeekOf", () => {
  it("a session on start_date is week 1", () => {
    expect(blockWeekOf("2026-07-06", "2026-07-06")).toBe(1);
  });

  it("start_date + 6 days is still week 1", () => {
    expect(blockWeekOf("2026-07-06", "2026-07-12")).toBe(1);
  });

  it("start_date + 7 days rolls over to week 2", () => {
    expect(blockWeekOf("2026-07-06", "2026-07-13")).toBe(2);
  });

  it("a date before start_date clamps to week 1", () => {
    expect(blockWeekOf("2026-07-06", "2026-06-29")).toBe(1);
  });
});
