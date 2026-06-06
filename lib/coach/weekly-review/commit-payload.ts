// lib/coach/weekly-review/commit-payload.ts
//
// Stable, payload-hashable shape used by both the approval-token issuer and
// the commit endpoint's verifier. The hash function in approval-token.ts
// stringifies with Object.keys(...).sort() so the JSON is order-stable across
// re-encodes — but the shape itself must be deterministic. Keep this helper
// pure: any field that ends up in the hash must be derived the same way at
// issue and commit time.

import type { WeeklyReviewPayload } from "@/lib/data/types";

export type WeeklyReviewCommitPayload = {
  review_id: string;
  next_week_start: string;
  session_plan: Record<string, string>;
  rir_target: number | null;
  weekly_focus: string | null;
  research_phase: string | null;
};

export function buildWeeklyReviewCommitPayload(args: {
  reviewId: string;
  nextWeekStart: string;
  reviewPayload: WeeklyReviewPayload;
}): WeeklyReviewCommitPayload {
  const presc = args.reviewPayload.prescription;
  // training_weeks.research_phase enum is 'accumulate' | 'deload' | null.
  // The review payload's prescription.phase is a WeeklyPhase ('mev'|'mav'|'mrv'|'deload'...).
  // Map deload → 'deload', everything else → 'accumulate'.
  // v2 payloads use the BlockPhase literal "deload_week"; cover both.
  const researchPhase: "accumulate" | "deload" =
    (presc.phase === "deload" || presc.phase === "deload_week")
      ? "deload"
      : "accumulate";
  return {
    review_id: args.reviewId,
    next_week_start: args.nextWeekStart,
    session_plan: presc.session_plan,
    rir_target: presc.rir_target,
    weekly_focus: presc.weekly_focus,
    research_phase: researchPhase,
  };
}
