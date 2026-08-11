// The athlete's week is FIRM: Mon Legs, Tue Chest, Wed Mobility, Thu Back,
// Fri Arms. Mid-week he moves sessions around constantly — padel, work, a bad
// night's sleep — and those moves must not redefine the schedule.
//
// They did. The Sunday cron seeded each new week's session_plan from the most
// recent week's STORED plan, swaps and all, so every one-off move became
// permanent and compounded:
//
//   2026-07-06  Legs Chest Arms  Mobility Back      (already drifted)
//   2026-07-13  Legs Chest Arms  Back Mobility      <- seeded from 07-06
//   2026-07-20  Mobility Legs Chest Back Arms       <- seeded from 07-13
//   2026-08-10  Legs Mobility Chest REST Arms + Sat=Back
//
// Proof it was the seed and not something else: each week's
// original_session_plan (the pre-edit snapshot, written on first edit) was
// byte-equal to the PREVIOUS week's final session_plan.

import { describe, it, expect } from "vitest";
import { seedSessionPlanForNewWeek } from "@/lib/coach/prescription/upsert-week-prescription";
import { WEEKLY_SESSIONS } from "@/lib/coach/sessionPlans";
import type { SessionPlan } from "@/lib/data/types";

describe("seedSessionPlanForNewWeek", () => {
  it("returns the firm weekly schedule", () => {
    expect(seedSessionPlanForNewWeek(null)).toEqual(WEEKLY_SESSIONS);
  });

  it("ignores a prior week that was swapped mid-week", () => {
    // Exactly the 2026-08-03 row: Chest and Mobility traded places, Back moved
    // off Thursday onto Saturday.
    const swapped: SessionPlan = {
      Monday: "Legs",
      Tuesday: "Mobility",
      Wednesday: "Chest",
      Thursday: "REST",
      Friday: "Arms",
      Saturday: "Back",
      Sunday: "REST",
    };
    const seeded = seedSessionPlanForNewWeek(swapped);
    expect(seeded).toEqual(WEEKLY_SESSIONS);
    // The specific regressions the athlete reported.
    expect(seeded.Tuesday).toBe("Chest");
    expect(seeded.Wednesday).toBe("Mobility");
    expect(seeded.Thursday).toBe("Back");
    expect(seeded.Saturday).toBe("REST");
  });

  it("does not let a caller mutate the shared constant through the result", () => {
    const seeded = seedSessionPlanForNewWeek(null);
    seeded.Monday = "Arms";
    expect(WEEKLY_SESSIONS.Monday).toBe("Legs");
  });

  it("still produces a full seven-day plan", () => {
    const seeded = seedSessionPlanForNewWeek({ Monday: "Legs" });
    expect(Object.keys(seeded).sort()).toEqual(
      ["Friday", "Monday", "Saturday", "Sunday", "Thursday", "Tuesday", "Wednesday"],
    );
  });
});
