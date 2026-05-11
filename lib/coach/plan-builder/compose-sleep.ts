// lib/coach/plan-builder/compose-sleep.ts
//
// Composes sleep section of plan_payload. Wake-anchored (sleep medicine
// convention) — wake_target stays fixed, bedtime_target derived. Hygiene
// rules typed with time-relative-to-bedtime defaults. Chronotype-aware
// when set in Beat 4; otherwise neutral.

import type { IntakePayload, PlanPayload } from "@/lib/data/types";

export function composeSleep(intake: IntakePayload): PlanPayload["sleep"] {
  const chronotype = intake.sleep_recovery.chronotype ?? "neutral";

  // Default target: 7.5-8.5h. Chronotype can shift the wake/bed targets but
  // not the duration band in v1.
  const targetHoursMin = 7.5;
  const targetHoursMax = 8.5;

  // Use intake's typical_wake_time as the wake anchor (or chronotype default
  // if unspecified).
  const wakeTarget = intake.sleep_recovery.typical_wake_time || defaultWake(chronotype);

  // Bedtime derived from wake - target_hours_max
  const bedtimeTarget = subtractHoursFromHHmm(wakeTarget, targetHoursMax);

  return {
    chronotype,
    target_hours_min: targetHoursMin,
    target_hours_max: targetHoursMax,
    wake_target: wakeTarget,
    bedtime_target: bedtimeTarget,
    efficiency_target: 0.85,
    latency_target_min: 20,
    hygiene_rules: {
      caffeine_cutoff_hours_before_bed: 8,
      alcohol_cutoff_hours_before_bed: 3,
      last_meal_cutoff_hours_before_bed: 2,
      screen_cutoff_minutes_before_bed: 60,
      intense_exercise_cutoff_hours_before_bed: 3,
      morning_light_exposure_minutes: 10,
      weekend_consistency_within_minutes: 60,
    },
    concern_triggers: {
      avg_sleep_below_h: 6.5,
      efficiency_below: 0.80,
      latency_above_min: 30,
      consecutive_short_nights: 2,
    },
  };
}

function defaultWake(chronotype: "lark" | "neutral" | "owl"): string {
  switch (chronotype) {
    case "lark":
      return "05:30";
    case "owl":
      return "08:00";
    case "neutral":
      return "06:30";
  }
}

function subtractHoursFromHHmm(hhmm: string, hours: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return "22:30";
  let totalMinutes = h * 60 + m - Math.round(hours * 60);
  while (totalMinutes < 0) totalMinutes += 24 * 60;
  const newH = Math.floor(totalMinutes / 60);
  const newM = totalMinutes % 60;
  return `${String(newH).padStart(2, "0")}:${String(newM).padStart(2, "0")}`;
}
