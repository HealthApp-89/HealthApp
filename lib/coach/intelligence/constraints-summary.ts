// lib/coach/intelligence/constraints-summary.ts
//
// Extracts active injuries, exercise exclusions, equipment access, and
// schedule constraints from athlete profile documents.
//
// Pure function, no side effects. Returns ConstraintPayload validated via Zod.

import { ConstraintPayloadSchema, type ConstraintPayload } from "./types";
import type { Injury, PrimaryLift } from "@/lib/data/types";
import { PRIMARY_LIFT_NAME_PATTERNS } from "@/lib/coach/prescription/current-comparison-value";

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
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Weeks between two ISO date strings (truncated). */
function weeksBetweenIso(fromIso: string, toIso: string): number {
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const diff = new Date(toIso + "T00:00:00Z").getTime() - new Date(fromIso + "T00:00:00Z").getTime();
  return Math.floor(Math.max(0, diff) / msPerWeek);
}

/** Build the canonical area label from a live injury row, folding side in. */
function liveInjuryAreaLabel(inj: Injury): string {
  if (inj.side === "left" || inj.side === "right") {
    return `${inj.area} (${inj.side})`;
  }
  return inj.area;
}

/** Expand a live injury's affected_lifts into canonical exercise names. */
function exercisesForLifts(lifts: PrimaryLift[]): string[] {
  const names: string[] = [];
  for (const lift of lifts) {
    const patterns = PRIMARY_LIFT_NAME_PATTERNS[lift] ?? [];
    names.push(...patterns);
  }
  return names;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main composer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * composeConstraints — Extracts active injuries, exercise exclusions,
 * equipment access, and schedule constraints from athlete profile documents,
 * then merges in live Injury rows from the injuries table.
 *
 * Merge rules:
 * 1. Live rows are injected with area label = "<area>" or "<area> (side)".
 * 2. Status derives from todayIso vs onset_date: weeks < 4 → acute, else chronic.
 * 3. exercise_exclusions += PRIMARY_LIFT_NAME_PATTERNS[lift] for each affected_lift.
 * 4. Dedup: live row with same lowercased area as a profile item → live wins.
 *
 * @param profile — Athlete profile with athlete_profile_documents, loosely typed
 * @param liveInjuries — Active injury rows from the injuries table (Task 1's fetchActiveInjuries)
 * @param todayIso — Caller's tz-resolved "today" (YYYY-MM-DD); used for weeks-since-onset math
 * @returns ConstraintPayload validated against schema
 */
export function composeConstraints(
  profile: ProfileWithDocuments,
  liveInjuries: Injury[] = [],
  todayIso: string = new Date().toISOString().slice(0, 10),
): ConstraintPayload {
  const activeDoc = profile?.athlete_profile_documents?.[0];

  // Build a set of live injury area keys (lowercased base area) for dedup.
  const liveAreaKeys = new Set(liveInjuries.map((inj) => inj.area.toLowerCase()));

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Extract profile injuries — skip any area superseded by a live row.
  // ─────────────────────────────────────────────────────────────────────────

  const profileInjuries: InjuryItem[] = activeDoc?.current_injuries ?? [];
  const profileInjuryItems = profileInjuries
    .filter((inj) => !liveAreaKeys.has(inj.area.toLowerCase()))
    .map((inj) => ({
      area: inj.area,
      status: inj.weeks_since_onset < 4 ? ("acute" as const) : ("chronic" as const),
      weeks_ago_onset: inj.weeks_since_onset,
    }));

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Map live injuries to payload items.
  // ─────────────────────────────────────────────────────────────────────────

  const liveInjuryItems = liveInjuries.map((inj) => {
    const weeksAgo = weeksBetweenIso(inj.onset_date, todayIso);
    return {
      area: liveInjuryAreaLabel(inj),
      status: weeksAgo < 4 ? ("acute" as const) : ("chronic" as const),
      weeks_ago_onset: weeksAgo,
    };
  });

  const activeInjuries = [...profileInjuryItems, ...liveInjuryItems];

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Flatten exercise exclusions (deduplicate via Set).
  //
  //    Sources:
  //    a) profile injuries NOT superseded — their exercises_to_avoid lists.
  //    b) live injuries — PRIMARY_LIFT_NAME_PATTERNS for each affected_lift.
  //       (Profile entries for superseded areas are dropped, so their
  //        exercises_to_avoid are also dropped in favor of the live mapping.)
  // ─────────────────────────────────────────────────────────────────────────

  const exerciseExclusions = new Set<string>();

  // From non-superseded profile injuries
  for (const injury of profileInjuries) {
    if (liveAreaKeys.has(injury.area.toLowerCase())) continue; // superseded — skip
    if (injury.exercises_to_avoid) {
      injury.exercises_to_avoid.forEach((ex) => exerciseExclusions.add(ex));
    }
  }

  // From live injuries via affected_lifts
  for (const inj of liveInjuries) {
    for (const name of exercisesForLifts(inj.affected_lifts)) {
      exerciseExclusions.add(name);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Map gym_type to equipment_access enum
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
  // 5. Parse schedule constraints from lifestyle_constraints keywords
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
