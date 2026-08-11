// lib/coach/__tests__/classify-schedule-day.test.ts
//
// Pins the branch ORDER, which is where this was wrong. The original code
// tested `isToday` before `isPast && isLogged`, and since `isPast` is
// `date < todayIso`, the logged branch was unreachable for today: a session
// logged today showed the amber "Today" pill and a "Start session" button on
// a day already trained.
//
// The first test is the regression. The rest hold the surrounding cases still
// so a future reordering cannot fix one and break another.

import { describe, it, expect } from "vitest";
import { classifyScheduleDay } from "@/lib/coach/schedule/classify-day";

const TODAY = "2026-08-11";

function classify(date: string, isLogged: boolean, sessionType = "Chest") {
  return classifyScheduleDay({ date, todayIso: TODAY, sessionType, isLogged });
}

describe("classifyScheduleDay", () => {
  it("marks today as logged once a workout exists — the regression", () => {
    expect(classify(TODAY, true)).toBe("today_logged");
  });

  it("marks today as today while no workout exists", () => {
    expect(classify(TODAY, false)).toBe("today");
  });

  it("keeps the past logged/unlogged split intact", () => {
    expect(classify("2026-08-10", true)).toBe("past_logged");
    expect(classify("2026-08-10", false)).toBe("past_unlogged");
  });

  it("treats a future date as upcoming regardless of logged state", () => {
    expect(classify("2026-08-12", false)).toBe("future");
    // A future date cannot really be logged, but the classifier must not
    // invent a class for it if one ever is.
    expect(classify("2026-08-12", true)).toBe("future");
  });

  it("lets REST win over every date class, including a logged today", () => {
    expect(classify(TODAY, true, "REST")).toBe("rest");
    expect(classify(TODAY, false, "REST")).toBe("rest");
    expect(classify("2026-08-10", true, "REST")).toBe("rest");
  });
});
