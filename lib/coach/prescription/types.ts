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
  rpe: number | null;
  rir: number | null;
  performed_on: string; // ISO date
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
