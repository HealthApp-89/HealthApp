// lib/validation/intakePayload.ts
//
// Zod runtime validator for the IntakePayload jsonb stored in
// athlete_profile_documents.intake_payload. Used by:
//   - Server actions (createDraftProfile, updateDraftProfile) on submit
//   - Probe scripts during development
//
// The shape MUST stay in sync with IntakePayload in lib/data/types.ts.
// If you change one, change the other.

import { z } from "zod";

const HHmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:mm");
const YYYYMMDD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const NonNegInt = z.number().int().min(0);
const PosNum = z.number().positive();
const NonNegNum = z.number().min(0);

const HealthSchema = z.object({
  conditions: z.object({
    cardiac: z.boolean(),
    hypertension: z.boolean(),
    diabetes: z.enum(["none", "type1", "type2", "prediabetic"]),
    autoimmune: z.boolean(),
    joint_surgeries: z.array(
      z.object({
        joint: z.string().min(1),
        year: z.number().int().min(1900).max(2100),
        notes: z.string().optional(),
      }),
    ),
    other: z.string(),
  }),
  medications: z.string(),
  recent_illness_injury: z.string(),
  active_injuries: z.array(
    z.object({
      joint: z.string().min(1),
      restriction: z.string().min(1),
    }),
  ),
  allergies: z.string(),
});

const EquipmentSchema = z.object({
  barbell: z.boolean(),
  rack: z.boolean(),
  bench: z.boolean(),
  dumbbells: z.boolean(),
  cables: z.boolean(),
  machines: z.boolean(),
  platform: z.boolean(),
  ghd: z.boolean(),
  sled: z.boolean(),
  treadmill: z.boolean(),
  rower: z.boolean(),
  bike: z.boolean(),
  kettlebells: z.boolean(),
  bands: z.boolean(),
  other: z.string(),
});

const LiftMapNullable = z.object({
  squat: z.number().nullable(),
  bench: z.number().nullable(),
  deadlift: z.number().nullable(),
  ohp: z.number().nullable(),
});

const TrainingSchema = z.object({
  years_lifting: NonNegNum,
  training_age: z.enum(["beginner", "intermediate", "advanced"]),
  sessions_per_week: NonNegInt.max(14),
  typical_session_minutes: NonNegInt.max(600),
  equipment: EquipmentSchema,
  current_e1rm: LiftMapNullable,
  best_ever_pr: LiftMapNullable,
  previous_programs: z.string(),
  recent_plateaus: z.string(),
});

const LifestyleSchema = z.object({
  job_demands: z.enum(["sedentary", "mixed", "active", "labor"]),
  commute_minutes: NonNegInt.max(600),
  has_dependents: z.boolean(),
  dependent_notes: z.string(),
  stress_self_rating: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
  ]),
  days_available: z.object({
    mon: z.boolean(),
    tue: z.boolean(),
    wed: z.boolean(),
    thu: z.boolean(),
    fri: z.boolean(),
    sat: z.boolean(),
    sun: z.boolean(),
  }),
  earliest_session_time: HHmm,
  latest_session_time: HHmm,
  travel_frequency: z.enum(["none", "rare", "monthly", "weekly"]),
});

const NutritionSchema = z.object({
  current_phase: z.enum(["cut", "maintain", "lean_bulk", "recomp", "unsure"]),
  current_kcal: NonNegInt.max(15000),
  current_macros: z.object({
    protein_g: NonNegNum,
    carb_g: NonNegNum,
    fat_g: NonNegNum,
  }),
  tracking_experience: z.enum(["none", "on_off", "consistent"]),
  restrictions: z.string(),
  alcohol_drinks_per_week: NonNegNum.max(200),
  caffeine_mg_per_day: NonNegNum.max(5000),
  supplements: z.string(),
});

const SleepRecoverySchema = z.object({
  avg_sleep_hours: NonNegNum.max(24),
  typical_bedtime: HHmm,
  typical_wake_time: HHmm,
  sleep_latency_minutes: NonNegNum.max(600),
  awakenings: z.enum(["none", "1_2", "3_plus"]),
  mobility_work: z.string(),
  soreness_frequency: z.enum(["rare", "common", "always"]),
});

const GoalsSchema = z.object({
  primary_type: z.enum(["strength", "body_comp", "performance", "health"]),
  primary_metric: z.string().min(1),
  target_value: PosNum,
  target_unit: z.string().min(1),
  target_date: YYYYMMDD,
  why_narrative: z.string().min(10, "Please share a sentence or two on why this goal matters"),
});

export const IntakePayloadSchema = z.object({
  schema_version: z.literal(1),
  health: HealthSchema,
  training: TrainingSchema,
  lifestyle: LifestyleSchema,
  nutrition: NutritionSchema,
  sleep_recovery: SleepRecoverySchema,
  goals: GoalsSchema,
});

/** Parse + assert. Throws ZodError on invalid input — server action callers
 *  catch and surface as form errors. */
export function parseIntakePayload(input: unknown) {
  return IntakePayloadSchema.parse(input);
}

/** Soft variant — returns SafeParseResult. Use when you want to display
 *  field-level errors in the wizard without throwing. */
export function safeParseIntakePayload(input: unknown) {
  return IntakePayloadSchema.safeParse(input);
}
