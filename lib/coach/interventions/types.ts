// lib/coach/interventions/types.ts
import { z } from "zod";
import type { BlockPhase } from "@/lib/coach/prescription/types";

export const InterventionKindSchema = z.enum(["reactive_deload", "exercise_swap", "nutrition_change"]);
export type InterventionKind = z.infer<typeof InterventionKindSchema>;

export const InterventionSourceSchema = z.enum(["explicit", "inferred"]);
export type InterventionSource = z.infer<typeof InterventionSourceSchema>;

/** Block context captured at intervention time (block_* null when no active block). */
export const BlockContextSchema = z.object({
  block_id: z.string().nullable(),
  block_phase: z.custom<BlockPhase>().nullable(),
  block_week: z.number().int().nullable(),
});
export type BlockContext = z.infer<typeof BlockContextSchema>;

export const DeloadContextSchema = BlockContextSchema.extend({
  deload_depth_pct: z.number().nullable(),
  trigger: z.enum(["low_hrv", "athlete_request", "inferred"]),
});
export type DeloadContext = z.infer<typeof DeloadContextSchema>;

export const SwapContextSchema = BlockContextSchema.extend({
  from_exercise: z.string(),
  to_exercise: z.string(),
  reason: z.enum(["pain", "stall", "equipment", "boredom"]),
});
export type SwapContext = z.infer<typeof SwapContextSchema>;

export const NutritionContextSchema = BlockContextSchema.extend({
  field: z.string(),
  from: z.union([z.number(), z.string(), z.null()]),
  to: z.union([z.number(), z.string(), z.null()]),
});
export type NutritionContext = z.infer<typeof NutritionContextSchema>;

export const DeloadOutcomeSchema = z.object({
  success: z.boolean().nullable(),
  hrv_recovery_days: z.number().nullable(),
  performance_resumed: z.boolean(),
});
export type DeloadOutcome = z.infer<typeof DeloadOutcomeSchema>;

export const SwapOutcomeSchema = z.object({
  success: z.boolean().nullable(),
  pain_resolved: z.boolean(),
  // swap_stuck = replacement did NOT progress (failure signal); a kept/successful swap has swap_stuck: false.
  swap_stuck: z.boolean(),
});
export type SwapOutcome = z.infer<typeof SwapOutcomeSchema>;

export const NutritionOutcomeSchema = z.object({
  success: z.boolean().nullable(),
  signal: z.string(),
  improved: z.boolean(),
});
export type NutritionOutcome = z.infer<typeof NutritionOutcomeSchema>;
