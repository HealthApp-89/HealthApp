// lib/coach/plan-builder/compose-snapshot.ts
//
// Composes athlete_snapshot section of plan_payload from intake_payload.
// Pure function, no I/O.

import type { IntakePayload, PlanPayload, Profile } from "@/lib/data/types";

export function composeSnapshot(
  intake: IntakePayload,
  profile: Pick<Profile, "name" | "age" | "height_cm"> | null,
): PlanPayload["athlete_snapshot"] {
  return {
    name: profile?.name ?? null,
    age: profile?.age ?? null,
    height_cm: profile?.height_cm ?? null,
    training_age: intake.training.training_age,
    derived_at: new Date().toISOString(),
  };
}
