import type { ActivityType, ActivityIntensity, MuscleRegion } from "./types";

const REGIONS: Record<ActivityType, MuscleRegion[]> = {
  padel: ["legs", "lower_back", "shoulders"],
  running: ["legs"],
  cycling: ["legs"],
  swimming: ["back", "shoulders"],
  other: [],
};

// Eccentric/impact factor scales the recovery window. Cycling is low-damage even
// when hard; running/padel carry eccentric+impact so they cost more per intensity.
const DAMAGE_FACTOR: Record<ActivityType, number> = {
  padel: 1.0, running: 1.0, cycling: 0.5, swimming: 0.6, other: 0.6,
};
const INTENSITY_BASE_HOURS: Record<ActivityIntensity, number> = { light: 14, moderate: 28, hard: 44 };

export function activityRegions(type: ActivityType): MuscleRegion[] {
  return REGIONS[type] ?? [];
}

export function recoveryWindowHours(type: ActivityType, intensity: ActivityIntensity): number {
  const base = INTENSITY_BASE_HOURS[intensity];
  return Math.round(base * (DAMAGE_FACTOR[type] ?? 0.6));
}

export function regionOverlap(a: MuscleRegion[], b: MuscleRegion[]): MuscleRegion[] {
  const set = new Set(b);
  return a.filter((r) => set.has(r));
}
