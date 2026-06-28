import { z } from "zod";

export const MUSCLE_REGIONS = ["legs", "lower_back", "shoulders", "chest", "back", "arms", "core"] as const;
export const MuscleRegionSchema = z.enum(MUSCLE_REGIONS);
export type MuscleRegion = z.infer<typeof MuscleRegionSchema>;

export const ACTIVITY_TYPES = ["padel", "running", "cycling", "swimming", "other"] as const;
export const ActivityTypeSchema = z.enum(ACTIVITY_TYPES);
export type ActivityType = z.infer<typeof ActivityTypeSchema>;

export const ActivityIntensitySchema = z.enum(["light", "moderate", "hard"]);
export type ActivityIntensity = z.infer<typeof ActivityIntensitySchema>;

export const ActivitySourceSchema = z.enum(["recurring", "manual", "detected"]);

export const PlannedActivitySchema = z.object({
  date: z.string(),                       // YYYY-MM-DD
  type: ActivityTypeSchema,
  intensity_estimate: ActivityIntensitySchema,
  source: ActivitySourceSchema,
});
export type PlannedActivity = z.infer<typeof PlannedActivitySchema>;

export const RecurringActivitySchema = z.object({
  type: ActivityTypeSchema,
  weekdays: z.array(z.number().int().min(0).max(6)),  // 0=Sun..6=Sat
  typical_intensity: ActivityIntensitySchema,
});
export type RecurringActivity = z.infer<typeof RecurringActivitySchema>;
