// lib/coach/prescription/__tests__/target-hit-week.test.ts
//
// The target-hit week used to be computed from `new Date()`, which made it
// unrecoverable: unwinding a mistakenly-saved session and re-evaluating
// would re-stamp an old crossing with today's week index. Deriving it from
// the date of the session that actually holds the qualifying value makes it
// a function of the data, so the unwind can restore it.

import { describe, it, expect } from "vitest";
import { pickQualifyingDate } from "@/lib/coach/prescription/target-hit-evaluator";

describe("pickQualifyingDate", () => {
  it("returns the earliest date that meets the target", () => {
    const out = pickQualifyingDate(
      [
        { date: "2026-07-20", best: 98 },
        { date: "2026-08-03", best: 102 },
        { date: "2026-08-10", best: 106 },
      ],
      100,
    );
    expect(out).toBe("2026-08-03");
  });

  it("is order-independent", () => {
    const out = pickQualifyingDate(
      [
        { date: "2026-08-10", best: 106 },
        { date: "2026-08-03", best: 102 },
      ],
      100,
    );
    expect(out).toBe("2026-08-03");
  });

  it("treats an exact match as qualifying", () => {
    expect(pickQualifyingDate([{ date: "2026-08-03", best: 100 }], 100)).toBe("2026-08-03");
  });

  it("returns null when nothing meets the target", () => {
    expect(pickQualifyingDate([{ date: "2026-08-03", best: 99 }], 100)).toBeNull();
  });

  it("skips dates with no comparable sets", () => {
    const out = pickQualifyingDate(
      [
        { date: "2026-08-03", best: null },
        { date: "2026-08-10", best: 106 },
      ],
      100,
    );
    expect(out).toBe("2026-08-10");
  });

  it("returns null for an empty set", () => {
    expect(pickQualifyingDate([], 100)).toBeNull();
  });
});
