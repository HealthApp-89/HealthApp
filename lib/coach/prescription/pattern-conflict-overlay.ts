// lib/coach/prescription/pattern-conflict-overlay.ts
//
// Hard-rejects pattern conflicts in a Sunday prescription: axial-loaded
// hinge accessories on non-focus days during a deadlift focus block.
// Extensible to other patterns via the PRIMARY_LIFT_TO_SESSION matrix.

import type {
  TrainingBlock,
  TrainingWeek,
  SessionPrescriptions,
  WeekdayLong,
  PrimaryLift,
} from "@/lib/data/types";

const AXIAL_HINGE_KEYS = ["rdl", "good_morning", "stiff_leg_dl"];
const LOW_AXIAL_HINGE_KEYS = ["hip_thrust", "45_hyper_loaded", "cable_pull_through"];

/** For each primary lift, which session_type contains it. Used to find the
 *  focus day per-week from training_weeks.session_plan, since users may
 *  train Back on different weekdays. */
const PRIMARY_LIFT_TO_SESSION: Record<PrimaryLift, string> = {
  deadlift: "Back",
  squat:    "Legs",
  bench:    "Chest",
  ohp:      "Chest",
};

export type PatternConflictError = {
  code: "pattern_conflict";
  message: string;
  offending: Array<{ weekday: WeekdayLong; exercise: string }>;
  hint: string;
};

export function validatePatternConflicts(
  prescription: SessionPrescriptions,
  block: TrainingBlock,
  week: TrainingWeek,
): PatternConflictError | null {
  if (block.primary_lift !== "deadlift") return null; // only deadlift blocks have axial-hinge conflict for now

  const focusDay = focusDayForBlock(block, week);
  const offending: Array<{ weekday: WeekdayLong; exercise: string }> = [];

  for (const [weekday, exercises] of Object.entries(prescription) as Array<[WeekdayLong, SessionPrescriptions[WeekdayLong]]>) {
    if (!exercises) continue;
    if (weekday === focusDay) continue;
    for (const ex of exercises) {
      if (ex.key != null && AXIAL_HINGE_KEYS.includes(ex.key)) {
        offending.push({ weekday, exercise: ex.name });
      }
    }
  }

  if (offending.length === 0) return null;

  return {
    code: "pattern_conflict",
    message: "Axial-loaded hinge accessory on a non-focus day during a deadlift focus block.",
    offending,
    hint: `Move to ${focusDay ?? "the deadlift day"}, swap for a low-axial variant (${LOW_AXIAL_HINGE_KEYS.join(", ")}), or drop.`,
  };
}

export function focusDayForBlock(block: TrainingBlock, week: TrainingWeek): WeekdayLong | null {
  if (block.primary_lift == null) return null;
  const focusSessionType = PRIMARY_LIFT_TO_SESSION[block.primary_lift];
  const sessionPlan = week.session_plan as Record<WeekdayLong, string>;
  for (const [day, type] of Object.entries(sessionPlan) as Array<[WeekdayLong, string]>) {
    if (type === focusSessionType) return day;
  }
  return null;
}
