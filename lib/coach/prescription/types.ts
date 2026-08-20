// lib/coach/prescription/types.ts
//
// Shared types for the prescription engine. Imported by all rule modules.

import type { PrimaryLift, WeekdayLong } from "@/lib/data/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

export type { WeekdayLong };

export type BlockPhase = "pre_target" | "consolidation" | "off_pace" | "deload_week";

export type WorkoutSetSample = {
  exercise_name: string;
  exercise_key: string | null;
  kg: number;
  reps: number;
  warmup: boolean;
  failure: boolean;
  performed_on: string; // ISO date
  /** Reps in reserve recorded for this set. Optional: only the prescription
   *  engine's own fetch populates it; other sample constructors omit it and
   *  every consumer treats null/undefined as "not recorded" (legacy path). */
  rir?: number | null;
  /** True when this set was the exercise's heavy top set (migration 0059).
   *
   *  Load baselines MUST filter it out. `maintenanceLoadFor` takes the max kg
   *  across clean non-warmup sets, so a top set — which is heavier BY DESIGN —
   *  would otherwise become the next working load and ratchet the back-offs up
   *  to it. e1RM comparison, by contrast, should keep it: at ~85% of e1RM it is
   *  the best estimate available that week.
   *
   *  Optional for the same reason as `rir`: only the prescription engine's own
   *  fetch populates it, and absent means "not a top set". */
  is_top_set?: boolean | null;
};

export type PrescriptionRuleInput = {
  blockPhase: BlockPhase;
  primaryLift: PrimaryLift;
  currentWorkingKg: number;
  targetValueKg: number;
  rirTarget: number;
  recentSets: WorkoutSetSample[];
};

export type PrescribedExercise = PlannedExercise;
