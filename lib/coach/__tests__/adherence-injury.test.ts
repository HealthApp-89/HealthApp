// lib/coach/__tests__/adherence-injury.test.ts
//
// TDD coverage for the injury-excused adherence classification (Task 5,
// Injury Lifecycle arc). Tests the pure `classifyDayWithInjuries` helper
// directly — no DB dependencies.
//
// Hip injury fixture: onset 2026-06-29, affected_session_types ["Legs","Back"],
// status "active". Resolved-at variant: resolved_at 2026-07-16T00:00:00Z
// (resolves Thursday 2026-07-16 — so Fri 2026-07-18 is NOT excused).

import { describe, it, expect } from "vitest";
import { classifyDayWithInjuries } from "@/lib/coach/adherence";
import type { Injury } from "@/lib/data/types";

const HIP_ACTIVE: Injury = {
  id: "inj-hip-1",
  user_id: "user-1",
  area: "hip",
  side: null,
  cause: null,
  severity: "moderate",
  onset_date: "2026-06-29",
  status: "active",
  resolved_at: null,
  affected_session_types: ["Legs", "Back"],
  affected_lifts: [],
  notes: null,
  created_at: "2026-06-29T08:00:00Z",
  updated_at: "2026-06-29T08:00:00Z",
};

/** Same injury but resolved Thursday 2026-07-16. */
const HIP_RESOLVED_THURSDAY: Injury = {
  ...HIP_ACTIVE,
  status: "resolved",
  resolved_at: "2026-07-16T00:00:00Z", // resolved_at date portion = 2026-07-16
};

describe("classifyDayWithInjuries", () => {
  // (a) Mon 2026-07-07 Legs missed while hip active → "injury" with injury_area "hip"
  it("(a) missed Legs on an active hip injury day → injury", () => {
    const result = classifyDayWithInjuries("missed", "Legs", "2026-07-07", [HIP_ACTIVE]);
    expect(result.status).toBe("injury");
    expect(result.injury_area).toBe("hip");
  });

  // (b) Tue Chest missed → "missed" (Chest ∉ affected_session_types)
  it("(b) missed Chest on a day with active hip injury → missed (Chest not affected)", () => {
    const result = classifyDayWithInjuries("missed", "Chest", "2026-07-08", [HIP_ACTIVE]);
    expect(result.status).toBe("missed");
    expect(result.injury_area).toBeUndefined();
  });

  // (c) Wed Back completed → "as_planned" (never reclassified even though affected)
  it("(c) completed Back session on injury day → as_planned (completed sessions never reclassified)", () => {
    const result = classifyDayWithInjuries("as_planned", "Back", "2026-07-09", [HIP_ACTIVE]);
    expect(result.status).toBe("as_planned");
    expect(result.injury_area).toBeUndefined();
  });

  // Also confirm swapped/rest are not reclassified
  it("swapped status is never reclassified as injury", () => {
    const result = classifyDayWithInjuries("swapped", "Legs", "2026-07-07", [HIP_ACTIVE]);
    expect(result.status).toBe("swapped");
  });

  it("rest status is never reclassified as injury", () => {
    const result = classifyDayWithInjuries("rest", "Legs", "2026-07-07", [HIP_ACTIVE]);
    expect(result.status).toBe("rest");
  });

  // (d) Fri 2026-07-18 Legs missed with injury resolved Thursday 2026-07-16 → "missed"
  //     resolved_at date = 2026-07-16, so injuryActiveOn(inj, "2026-07-18") = false
  it("(d) missed Legs on Friday after injury resolved Thursday → missed", () => {
    const FRI = "2026-07-18";
    const result = classifyDayWithInjuries("missed", "Legs", FRI, [HIP_RESOLVED_THURSDAY]);
    expect(result.status).toBe("missed");
    expect(result.injury_area).toBeUndefined();
  });

  // resolved_at day itself is still covered (onset-inclusive, resolved_at-inclusive)
  it("injury day equals resolved_at date → still excused (inclusive boundary)", () => {
    const THU = "2026-07-16";
    const result = classifyDayWithInjuries("missed", "Legs", THU, [HIP_RESOLVED_THURSDAY]);
    expect(result.status).toBe("injury");
    expect(result.injury_area).toBe("hip");
  });

  // Day before onset is not covered
  it("day before onset_date → missed (not yet started)", () => {
    const BEFORE_ONSET = "2026-06-28";
    const result = classifyDayWithInjuries("missed", "Legs", BEFORE_ONSET, [HIP_ACTIVE]);
    expect(result.status).toBe("missed");
  });

  // No injuries → unchanged
  it("empty injuries list → base status unchanged", () => {
    const result = classifyDayWithInjuries("missed", "Legs", "2026-07-07", []);
    expect(result.status).toBe("missed");
  });

  // null sessionType → unchanged
  it("null sessionType → base status unchanged", () => {
    const result = classifyDayWithInjuries("missed", null, "2026-07-07", [HIP_ACTIVE]);
    expect(result.status).toBe("missed");
  });
});

describe("classifyDayWithInjuries denominator logic (unit test of excused count)", () => {
  // (e) denominator excludes exactly the injury days
  // We can verify this by simulating a week: only Mon Legs missed (active injury)
  // should be excluded from sessions_planned; other non-rest days should count.
  it("(e) only injury-excused days are removed from the denominator", () => {
    // Simulate 4 sessions in a week plan: Mon Legs, Tue Chest, Wed Back, Fri Push
    // Mon Legs: missed while injury active → injury (excused)
    // Tue Chest: missed → missed (not excused)
    // Wed Back: completed → as_planned (not excused)
    // Fri Push: missed but Fri is after injury resolved Thursday → missed (not excused)
    const scenarios: Array<{ baseStatus: "as_planned" | "swapped" | "missed" | "rest"; sessionType: string; day: string; injuries: Injury[] }> = [
      { baseStatus: "missed", sessionType: "Legs", day: "2026-07-07", injuries: [HIP_ACTIVE] },
      { baseStatus: "missed", sessionType: "Chest", day: "2026-07-08", injuries: [HIP_ACTIVE] },
      { baseStatus: "as_planned", sessionType: "Back", day: "2026-07-09", injuries: [HIP_ACTIVE] },
      { baseStatus: "missed", sessionType: "Push", day: "2026-07-11", injuries: [HIP_RESOLVED_THURSDAY] },
    ];

    const results = scenarios.map((s) =>
      classifyDayWithInjuries(s.baseStatus, s.sessionType, s.day, s.injuries),
    );

    // Check individual statuses
    expect(results[0].status).toBe("injury");   // Mon Legs excused
    expect(results[1].status).toBe("missed");   // Tue Chest not excused
    expect(results[2].status).toBe("as_planned"); // Wed Back completed
    expect(results[3].status).toBe("missed");   // Fri Push after resolution

    // Simulate denominator computation (mirrors computeAdherence logic):
    // sessions_planned counts non-rest non-injury days
    let sessionsPlanned = 0;
    let injuryExcused = 0;
    for (const r of results) {
      if (r.status === "injury") injuryExcused += 1;
      else if (r.status !== "rest") sessionsPlanned += 1;
    }

    // 3 sessions count toward planned (Mon excluded as injury), 0 injury on Fri
    expect(sessionsPlanned).toBe(3);
    expect(injuryExcused).toBe(1);
  });
});
