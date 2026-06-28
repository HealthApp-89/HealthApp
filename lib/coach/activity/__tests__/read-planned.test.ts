import { describe, it, expect } from "vitest";
import { mergePlannedActivities } from "../read-planned";
import type { PlannedActivity, RecurringActivity } from "../types";

// The week under test starts on 2026-06-23 (Tuesday — used as the week_start
// input; the code does not validate that week_start is a calendar Monday).
// Weekday→date mapping (week_start-relative, 0=Sun..6=Sat):
//   weekday 0 (Sun)  → 2026-06-29
//   weekday 1 (Mon)  → 2026-06-23
//   weekday 2 (Tue)  → 2026-06-24
//   weekday 3 (Wed)  → 2026-06-25
//   weekday 4 (Thu)  → 2026-06-26
//   weekday 5 (Fri)  → 2026-06-27
//   weekday 6 (Sat)  → 2026-06-28
const WEEK_START = "2026-06-23"; // Tuesday (used as week_start; dates above are correct relative to it)

describe("mergePlannedActivities", () => {
  it("empty everything → empty output", () => {
    const result = mergePlannedActivities({
      weekStartIso: WEEK_START,
      declared: [],
      recurring: [],
      detected: [],
    });
    expect(result).toEqual([]);
  });

  it("recurring padel on weekdays [2,4] → padel on Tue + Thu with source recurring", () => {
    const recurring: RecurringActivity[] = [
      { type: "padel", weekdays: [2, 4], typical_intensity: "moderate" },
    ];
    const result = mergePlannedActivities({
      weekStartIso: WEEK_START,
      declared: [],
      recurring,
      detected: [],
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      date: "2026-06-24", // Tue
      type: "padel",
      intensity_estimate: "moderate",
      source: "recurring",
    });
    expect(result[1]).toMatchObject({
      date: "2026-06-26", // Thu
      type: "padel",
      intensity_estimate: "moderate",
      source: "recurring",
    });
  });

  it("declared (manual) Tue padel wins over recurring on same date+type, no duplicate", () => {
    const recurring: RecurringActivity[] = [
      { type: "padel", weekdays: [2, 4], typical_intensity: "moderate" },
    ];
    const declared: PlannedActivity[] = [
      {
        date: "2026-06-24", // Tue — same slot as recurring
        type: "padel",
        intensity_estimate: "hard",
        source: "manual",
      },
    ];
    const result = mergePlannedActivities({
      weekStartIso: WEEK_START,
      declared,
      recurring,
      detected: [],
    });
    // Tue padel: manual wins (hard, not moderate); Thu padel: recurring still there
    const tuePadel = result.filter((a) => a.date === "2026-06-24" && a.type === "padel");
    expect(tuePadel).toHaveLength(1);
    expect(tuePadel[0].source).toBe("manual");
    expect(tuePadel[0].intensity_estimate).toBe("hard");

    const thuPadel = result.filter((a) => a.date === "2026-06-26" && a.type === "padel");
    expect(thuPadel).toHaveLength(1);
    expect(thuPadel[0].source).toBe("recurring");

    // No duplicates anywhere
    expect(result.length).toBe(2);
  });

  it("detected cycling on Wed with no declared → included as source detected", () => {
    const detected: PlannedActivity[] = [
      {
        date: "2026-06-25", // Wed
        type: "cycling",
        intensity_estimate: "hard",
        source: "detected",
      },
    ];
    const result = mergePlannedActivities({
      weekStartIso: WEEK_START,
      declared: [],
      recurring: [],
      detected,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      date: "2026-06-25",
      type: "cycling",
      source: "detected",
    });
  });

  it("detected same date+type as declared → detected is dropped (declared wins)", () => {
    const declared: PlannedActivity[] = [
      {
        date: "2026-06-25", // Wed
        type: "cycling",
        intensity_estimate: "moderate",
        source: "manual",
      },
    ];
    const detected: PlannedActivity[] = [
      {
        date: "2026-06-25",
        type: "cycling",
        intensity_estimate: "hard",
        source: "detected",
      },
    ];
    const result = mergePlannedActivities({
      weekStartIso: WEEK_START,
      declared,
      recurring: [],
      detected,
    });
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("manual");
    expect(result[0].intensity_estimate).toBe("moderate");
  });

  it("detected same date+type as recurring → detected is dropped (recurring wins over detected)", () => {
    const recurring: RecurringActivity[] = [
      { type: "padel", weekdays: [2], typical_intensity: "light" },
    ];
    const detected: PlannedActivity[] = [
      {
        date: "2026-06-24", // Tue
        type: "padel",
        intensity_estimate: "hard",
        source: "detected",
      },
    ];
    const result = mergePlannedActivities({
      weekStartIso: WEEK_START,
      declared: [],
      recurring,
      detected,
    });
    // Recurring wins, no dupe
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("recurring");
    expect(result[0].intensity_estimate).toBe("light");
  });

  it("output is sorted deterministically by date", () => {
    const recurring: RecurringActivity[] = [
      { type: "padel", weekdays: [4, 2], typical_intensity: "moderate" }, // reversed order
    ];
    const result = mergePlannedActivities({
      weekStartIso: WEEK_START,
      declared: [],
      recurring,
      detected: [],
    });
    const dates = result.map((a) => a.date);
    expect(dates).toEqual([...dates].sort());
  });

  it("Sunday weekday 0 materializes to the Sunday at the END of the Mon-keyed week", () => {
    const recurring: RecurringActivity[] = [
      { type: "running", weekdays: [0], typical_intensity: "light" }, // Sunday
    ];
    const result = mergePlannedActivities({
      weekStartIso: WEEK_START,
      declared: [],
      recurring,
      detected: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe("2026-06-29"); // Sunday after the Mon-keyed week
  });

  it("multiple sources — all three contribute without duplicates", () => {
    const recurring: RecurringActivity[] = [
      { type: "padel", weekdays: [2, 4], typical_intensity: "moderate" },
    ];
    const declared: PlannedActivity[] = [
      { date: "2026-06-24", type: "padel", intensity_estimate: "hard", source: "manual" }, // override Tue
    ];
    const detected: PlannedActivity[] = [
      { date: "2026-06-25", type: "cycling", intensity_estimate: "hard", source: "detected" }, // new Wed
      { date: "2026-06-26", type: "padel", intensity_estimate: "light", source: "detected" }, // dupe Thu — recurring wins
    ];
    const result = mergePlannedActivities({
      weekStartIso: WEEK_START,
      declared,
      recurring,
      detected,
    });
    // Tue padel: manual (hard)
    // Thu padel: recurring (moderate) — detected duplicate dropped
    // Wed cycling: detected (hard) — new gap filled
    expect(result).toHaveLength(3);
    const tue = result.find((a) => a.date === "2026-06-24" && a.type === "padel")!;
    expect(tue.source).toBe("manual");
    expect(tue.intensity_estimate).toBe("hard");

    const thu = result.find((a) => a.date === "2026-06-26" && a.type === "padel")!;
    expect(thu.source).toBe("recurring");
    expect(thu.intensity_estimate).toBe("moderate");

    const wed = result.find((a) => a.date === "2026-06-25" && a.type === "cycling")!;
    expect(wed.source).toBe("detected");
    expect(wed.intensity_estimate).toBe("hard");
  });
});
