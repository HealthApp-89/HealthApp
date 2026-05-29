// lib/coach/block-outcomes/types.ts
//
// Shared types internal to the block-outcomes engine. The public-facing
// BlockOutcome / BlockOutcomeLessons / BlockTrajectoryPayload types live
// in lib/data/types.ts.

import type { PrimaryLift } from "@/lib/data/types";

/** A clean working set in the block window, used for end-kg + observed-rate computation. */
export type BlockSetSample = {
  exercise_name: string;
  kg: number;
  reps: number;
  performed_on: string; // ISO date
  weekN: number;        // 1-indexed week within the block (computed from block.start_date)
};

/** A non-focus primary lift's outcome (used in lessons.secondary_lifts). */
export type SecondaryLiftOutcome = {
  lift: PrimaryLift;
  end_kg: number | null;
  clamp_held: boolean; // did baseKg stay ≤ 0.92 × maintenance for the block duration?
};
