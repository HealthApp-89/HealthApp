// lib/coach/intelligence/constraints-summary.ts
//
// Extracts active injuries, exercise exclusions, equipment access, and
// schedule constraints from athlete profile documents.
//
// Pure function, no side effects. Returns ConstraintPayload validated via Zod.

import { ConstraintPayloadSchema, type ConstraintPayload } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Type definitions for profile shape (loosely typed from Supabase query)
// ─────────────────────────────────────────────────────────────────────────────

type InjuryItem = {
  area: string;
  severity: string;
  weeks_since_onset: number;
  exercises_to_avoid?: string[];
};

type AthleteProfileDocument = {
  id?: string;
  status?: string;
  current_injuries?: InjuryItem[];
  gym_type?: string;
  lifestyle_constraints?: string[];
  [key: string]: unknown;
};

type ProfileWithDocuments = {
  user_id?: string;
  name?: string | null;
  athlete_profile_documents?: AthleteProfileDocument[] | null;
  [key: string]: unknown;
} | null;

// ─────────────────────────────────────────────────────────────────────────────
// Main composer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * composeConstraints — Extracts active injuries, exercise exclusions,
 * equipment access, and schedule constraints from athlete profile documents.
 *
 * Behavior:
 * 1. Extract active injuries and map status (weeks < 4 → acute, else chronic)
 * 2. Flatten exercise exclusions from all injuries into a Set (deduplicates)
 * 3. Map gym_type to equipment_access enum
 * 4. Parse schedule constraints from lifestyle_constraints keywords
 * 5. Handle null profile gracefully (return empty payload)
 *
 * @param profile — Athlete profile with athlete_profile_documents, loosely typed
 * @returns ConstraintPayload validated against schema
 */
export function composeConstraints(profile: ProfileWithDocuments): ConstraintPayload {
  const activeDoc = profile?.athlete_profile_documents?.[0];

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Extract active injuries and map status
  // ─────────────────────────────────────────────────────────────────────────

  const injuries: InjuryItem[] = activeDoc?.current_injuries ?? [];
  const activeInjuries = injuries.map((inj) => ({
    area: inj.area,
    status: inj.weeks_since_onset < 4 ? ("acute" as const) : ("chronic" as const),
    weeks_ago_onset: inj.weeks_since_onset,
  }));

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Flatten exercise exclusions (deduplicate via Set)
  // ─────────────────────────────────────────────────────────────────────────

  const exerciseExclusions = new Set<string>();
  for (const injury of injuries) {
    if (injury.exercises_to_avoid) {
      injury.exercises_to_avoid.forEach((ex) => exerciseExclusions.add(ex));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Map gym_type to equipment_access enum
  // ─────────────────────────────────────────────────────────────────────────

  const gymType = activeDoc?.gym_type ?? "commercial";
  let equipmentAccess: "home_gym" | "commercial_gym" | "mixed";

  if (gymType === "home") {
    equipmentAccess = "home_gym";
  } else if (gymType === "commercial") {
    equipmentAccess = "commercial_gym";
  } else {
    // Unknown or mixed
    equipmentAccess = "mixed";
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Parse schedule constraints from lifestyle_constraints keywords
  // ─────────────────────────────────────────────────────────────────────────

  const scheduleConstraints: string[] = [];
  if (activeDoc?.lifestyle_constraints) {
    for (const constraint of activeDoc.lifestyle_constraints) {
      // Check for max sessions/week
      if (constraint.toLowerCase().includes("3 sessions")) {
        scheduleConstraints.push("Max 3 sessions/week");
      }
      // Check for training time windows
      if (constraint.toLowerCase().includes("evening")) {
        scheduleConstraints.push("Training evenings only");
      }
      // Check for travel frequency
      if (constraint.toLowerCase().includes("travel")) {
        scheduleConstraints.push("Travel disrupts schedule");
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Build payload and validate
  // ─────────────────────────────────────────────────────────────────────────

  const payload: ConstraintPayload = {
    active_injuries: activeInjuries,
    exercise_exclusions: Array.from(exerciseExclusions),
    equipment_access: equipmentAccess,
    schedule_constraints: scheduleConstraints,
  };

  // Validate against schema
  const validated = ConstraintPayloadSchema.parse(payload);
  return validated;
}
