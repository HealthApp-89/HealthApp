// lib/coach/intelligence/types.ts
//
// Zod schemas and TypeScript types for the coach intelligence layer.
// Covers Layer 1 (identity, constraints) and Layer 2 (history, recovery,
// nutrition-performance, interference, body-comp) payloads plus the unified
// AthleteIntelligencePayload.
//
// Naming conventions:
//   - <Feature>Payload  for data blocks persisted / passed between layers
//   - <Feature>Result   for return types of analysis functions
//   - Enum constants (const) for discriminated union values

import { z } from "zod";

// Layer 2 schemas — imported from their composer files and re-composed here.
import { RecoveryReadinessResultSchema } from "./recovery-readiness";
import { NutritionPerformanceResultSchema } from "./nutrition-performance-linker";
import { InterferenceResultSchema } from "./interference-checker";
import { BodyCompDirectionResultSchema } from "./body-comp-direction";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** YYYY-MM-DD date string */
const ISODate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

/** ISO 8601 datetime string (used for generated_on) */
const ISODatetime = z.string().datetime({ message: "Expected ISO 8601 datetime" });

// ---------------------------------------------------------------------------
// Layer 1 — Identity
// ---------------------------------------------------------------------------

/** Exercise categories tracked in the identity layer */
export const ExerciseCategoryValues = [
  "lower",
  "upper",
  "pulls",
  "isolation",
  "cardio",
  "mobility",
] as const;

export const ExerciseCategorySchema = z.enum(ExerciseCategoryValues);
export type ExerciseCategory = z.infer<typeof ExerciseCategorySchema>;

/** Top exercises per category (max 5 per slot) */
export const TopExercisesPayloadSchema = z.object({
  lower: z.array(z.string()).max(5),
  upper: z.array(z.string()).max(5),
  pulls: z.array(z.string()).max(5),
  isolation: z.array(z.string()).max(5),
});
export type TopExercisesPayload = z.infer<typeof TopExercisesPayloadSchema>;

/** Eating identity: habitual protein/carb/fat sources, cuisines, monotone flags */
export const EatingIdentityPayloadSchema = z.object({
  top_proteins: z.array(z.string()).max(5),
  top_carbs: z.array(z.string()).max(5),
  top_fats: z.array(z.string()).max(5),
  cuisines: z.array(z.string()).max(4),
  monotone_flags: z.array(z.string()),
});
export type EatingIdentityPayload = z.infer<typeof EatingIdentityPayloadSchema>;

/** Volume preference descriptor */
export const VolumePreferenceValues = [
  "low",
  "moderate",
  "high",
  "very_high",
] as const;
export const VolumePreferenceSchema = z.enum(VolumePreferenceValues);
export type VolumePreference = z.infer<typeof VolumePreferenceSchema>;

/**
 * Intensity distribution as percentages across RPE brackets.
 * The three values must sum to exactly 100.
 */
export const IntensityDistributionSchema = z
  .object({
    rpe_6_7: z.number().int().min(0).max(100),
    rpe_8_9: z.number().int().min(0).max(100),
    rpe_10: z.number().int().min(0).max(100),
  })
  .refine(
    (d) => d.rpe_6_7 + d.rpe_8_9 + d.rpe_10 === 100,
    { message: "intensity_distribution_percent values must sum to 100" },
  );
export type IntensityDistribution = z.infer<typeof IntensityDistributionSchema>;

/** Athlete's training style signature derived from historical data */
export const TrainingStyleSignatureSchema = z.object({
  volume_preference: VolumePreferenceSchema,
  intensity_distribution_percent: IntensityDistributionSchema,
  /** Days needed to feel recovered after a hard session (2–14) */
  recovery_speed_days: z.number().int().min(2).max(14),
  /** Preferred session length in minutes (20–180) */
  session_duration_preference_min: z.number().int().min(20).max(180),
});
export type TrainingStyleSignature = z.infer<typeof TrainingStyleSignatureSchema>;

/** Unified identity payload */
export const IdentityPayloadSchema = z.object({
  top_exercises: TopExercisesPayloadSchema,
  eating_identity: EatingIdentityPayloadSchema,
  training_style_signature: TrainingStyleSignatureSchema,
});
export type IdentityPayload = z.infer<typeof IdentityPayloadSchema>;

// ---------------------------------------------------------------------------
// Layer 1 — Constraints
// ---------------------------------------------------------------------------

/** Injury status discriminator */
export const InjuryStatusValues = [
  "acute",
  "chronic",
  "recovering",
  "recovered",
] as const;
export const InjuryStatusSchema = z.enum(InjuryStatusValues);
export type InjuryStatus = z.infer<typeof InjuryStatusSchema>;

/** A single injury record */
export const InjuryRecordSchema = z.object({
  area: z.string().min(1),
  status: InjuryStatusSchema,
  weeks_ago_onset: z.number().int().min(0),
});
export type InjuryRecord = z.infer<typeof InjuryRecordSchema>;

/** Equipment access level */
export const EquipmentAccessValues = [
  "home_gym",
  "commercial_gym",
  "mixed",
] as const;
export const EquipmentAccessSchema = z.enum(EquipmentAccessValues);
export type EquipmentAccess = z.infer<typeof EquipmentAccessSchema>;

/** Constraint payload — what the athlete cannot or should not do */
export const ConstraintPayloadSchema = z.object({
  active_injuries: z.array(InjuryRecordSchema),
  exercise_exclusions: z.array(z.string()),
  equipment_access: EquipmentAccessSchema,
  schedule_constraints: z.array(z.string()),
});
export type ConstraintPayload = z.infer<typeof ConstraintPayloadSchema>;

// ---------------------------------------------------------------------------
// Layer 2 — History
// ---------------------------------------------------------------------------

/** Deload type discriminator */
export const DeloadTypeValues = [
  "planned",
  "reactive",
  "forced",
] as const;
export const DeloadTypeSchema = z.enum(DeloadTypeValues);
export type DeloadType = z.infer<typeof DeloadTypeSchema>;

/** Record of a single deload period */
export const DeloadRecordSchema = z.object({
  date: ISODate,
  type: DeloadTypeSchema,
  hrv_recovery_days: z.number().int().min(0),
  success: z.boolean(),
  reason_if_failed: z.string().optional(),
});
export type DeloadRecord = z.infer<typeof DeloadRecordSchema>;

/** Result of an exercise swap */
export const SwapResultValues = [
  "kept",
  "reverted",
  "further_modified",
] as const;
export const SwapResultSchema = z.enum(SwapResultValues);
export type SwapResult = z.infer<typeof SwapResultSchema>;

/** Record of an exercise swap event */
export const ExerciseSwapRecordSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  reason: z.string().min(1),
  result: SwapResultSchema,
  reason_if_failed: z.string().optional(),
  date: ISODate,
});
export type ExerciseSwapRecord = z.infer<typeof ExerciseSwapRecordSchema>;

/** Nutrition intervention record */
export const NutritionInterventionSchema = z.object({
  intervention: z.string().min(1),
  duration_weeks: z.number().int().min(1),
  effect_measured: z.string().min(1),
  effect_value: z.number(),
  adopted: z.boolean(),
});
export type NutritionIntervention = z.infer<typeof NutritionInterventionSchema>;

/** History payload — recent adaptations and experiments */
export const HistoryPayloadSchema = z.object({
  recent_deloads: z.array(DeloadRecordSchema).max(5),
  exercise_swaps_8w: z.array(ExerciseSwapRecordSchema).max(10),
  nutrition_interventions: z.array(NutritionInterventionSchema).max(6),
});
export type HistoryPayload = z.infer<typeof HistoryPayloadSchema>;

// ---------------------------------------------------------------------------
// Top-level unified payload
// ---------------------------------------------------------------------------

/**
 * AthleteIntelligencePayload — the full synthesized intelligence document
 * combining Layer 1 (identity, constraints, history) and Layer 2 (recovery
 * readiness, nutrition-performance, interference, body-comp direction).
 */
export const AthleteIntelligencePayloadSchema = z.object({
  // ── Layer 1 ───────────────────────────────────────────────────────────────
  identity: IdentityPayloadSchema,
  constraints: ConstraintPayloadSchema,
  history: HistoryPayloadSchema,
  // ── Layer 2 ───────────────────────────────────────────────────────────────
  recovery_readiness: RecoveryReadinessResultSchema,
  nutrition_performance: NutritionPerformanceResultSchema,
  interference: InterferenceResultSchema,
  body_comp_direction: BodyCompDirectionResultSchema,
  /** ISO 8601 datetime when this payload was generated */
  generated_on: ISODatetime,
});
export type AthleteIntelligencePayload = z.infer<typeof AthleteIntelligencePayloadSchema>;
