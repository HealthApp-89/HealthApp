// lib/coach/plan-builder/compose-strength.ts
//
// Composes strength TEMPLATE section of plan_payload. Per-block weights
// remain in training_blocks; per-week schedule in training_weeks. This
// section is the durable contract for what the user's strength practice
// looks like at the plan level.

import type { IntakePayload, PlanPayload, TrainingBlock } from "@/lib/data/types";

export type RecentE1RMsForStrength = {
  squat: number | null;
  bench: number | null;
  deadlift: number | null;
  ohp: number | null;
};

export function composeStrengthTemplate(
  intake: IntakePayload,
  activeBlock: Pick<TrainingBlock, "primary_lift"> | null,
  recentE1RMs: RecentE1RMsForStrength,
): PlanPayload["strength"] {
  const sessionsPerWeek = intake.training.sessions_per_week;
  const dayPattern = composeDayPattern(intake, sessionsPerWeek);
  const sessionTypes = Array.from(new Set(Object.values(dayPattern))) as Array<
    "Chest" | "Legs" | "Back" | "Mobility" | "REST"
  >;

  return {
    sessions_per_week: sessionsPerWeek,
    day_pattern: dayPattern,
    template_session_types: sessionTypes,
    weekly_volume_targets: composeVolumeTargets(
      intake,
      activeBlock?.primary_lift ?? null,
    ),
    progression_rule: composeProgressionRule(intake.training.training_age),
    notes: null, // populated by AI narrative pass
  };
}

/** Builds a Mon-Sun map of session types from intake.lifestyle.days_available.
 *  Defaults to a Chest/Legs/Back/Mobility rotation when the user has 4 available
 *  days, scaled up/down by sessions_per_week. */
function composeDayPattern(
  intake: IntakePayload,
  sessions: number,
): { [weekday: string]: string } {
  const days = intake.lifestyle.days_available;
  const orderedDays: Array<[keyof typeof days, string]> = [
    ["mon", "Monday"],
    ["tue", "Tuesday"],
    ["wed", "Wednesday"],
    ["thu", "Thursday"],
    ["fri", "Friday"],
    ["sat", "Saturday"],
    ["sun", "Sunday"],
  ];

  // Session-type rotation: prioritize Legs (primary lift goal often hinges on this),
  // then Back, then Chest, then Mobility for the 4-day case.
  const rotation = ["Legs", "Chest", "Back", "Mobility"];
  const pattern: { [weekday: string]: string } = {};

  let sessionIdx = 0;
  for (const [key, weekday] of orderedDays) {
    if (days[key] && sessionIdx < sessions) {
      pattern[weekday] = rotation[sessionIdx % rotation.length];
      sessionIdx++;
    } else {
      pattern[weekday] = "REST";
    }
  }
  return pattern;
}

/** Volume targets per primary lift, scaled by training_age. */
function composeVolumeTargets(
  intake: IntakePayload,
  primaryLift: "squat" | "bench" | "deadlift" | "ohp" | null,
): { [lift: string]: { reps_per_week: number; sets_per_week: number } } {
  const targets: { [lift: string]: { reps_per_week: number; sets_per_week: number } } = {};
  const lifts = primaryLift
    ? [primaryLift]
    : (["squat", "bench", "deadlift", "ohp"] as const);
  const profile = volumeProfileForAge(intake.training.training_age);
  for (const lift of lifts) {
    targets[lift] = { ...profile };
  }
  return targets;
}

function volumeProfileForAge(
  age: "beginner" | "intermediate" | "advanced",
): { reps_per_week: number; sets_per_week: number } {
  switch (age) {
    case "beginner":
      return { reps_per_week: 50, sets_per_week: 10 };
    case "intermediate":
      return { reps_per_week: 70, sets_per_week: 14 };
    case "advanced":
      return { reps_per_week: 90, sets_per_week: 18 };
  }
}

function composeProgressionRule(
  age: "beginner" | "intermediate" | "advanced",
): string {
  switch (age) {
    case "beginner":
      return "Add 2.5kg to primary lifts every session when all working reps are clean.";
    case "intermediate":
      return "Add 2.5kg to primary lifts when last set ≥ target RIR + 2 reps for 2 consecutive sessions.";
    case "advanced":
      return "Wave loading per block; reassess at block end against e1RM trajectory.";
  }
}
