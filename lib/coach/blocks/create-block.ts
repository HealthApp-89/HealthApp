// lib/coach/blocks/create-block.ts
//
// Shared create-block logic, extracted from lib/coach/tools.ts so two entry
// points run identical validation + writes:
//   1. The HMAC chat path (executeProposeBlock / executeCommitBlock) — the
//      approval-token round-trip is the confirmation.
//   2. The session-authed form route (POST /api/blocks) — the form IS the
//      approval, so it calls these directly with no token.
//
// validateBlockInput is pure (no I/O). The caller computes the target
// recommendation (computeTargetRecommendation) and passes it in; a null
// recommendation (no logged history / transient fetch failure) means no
// bounds enforcement — the bootstrap path for a first-ever block.
//
// insertBlock performs the two writes previously inline in executeCommitBlock:
// the training_blocks insert and the outstanding block_outcomes acknowledge.
// On failure it returns the RAW Postgres error code (e.g. "23505" for the
// one-active-block unique violation) — each entry point maps codes to prose.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PrimaryLift, TrainingBlock } from "@/lib/data/types";

// Local copy of tools.ts's isYmd — tools.ts imports this module, so importing
// back from it would create a cycle over a 2-line helper.
function isYmd(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** Structural subset of TargetRecommendation — everything the bounds check
 *  and its error prose need. TargetRecommendation is assignable to this. */
export type BlockRecommendationLike = {
  recommended_target: number | null;
  sanity_bounds: [number, number] | null;
  current_e1rm?: number | null;
  used?: string;
};

export type ValidateBlockResult =
  | {
      ok: true;
      /** True when the target is out of bounds but an override_reason
       *  (trimmed length ≥ 4) was supplied — callers should log the override. */
      overridden?: boolean;
    }
  | {
      ok: false;
      error: string;
      code: "target_out_of_bounds" | "invalid_input";
      hint?: string;
    };

/** Validate a create-block input against the propose_block rules. Same bounds
 *  rule as propose_block: an out-of-bounds target_value needs an explicit
 *  override_reason with trimmed length ≥ 4. Pass `recommendation: null` to
 *  skip bounds enforcement (also used by executeProposeBlock's first pass,
 *  which validates basics BEFORE the recommendation DB fetch so an invalid
 *  primary_lift never reaches computeTargetRecommendation). */
export function validateBlockInput(
  input: Record<string, unknown>,
  recommendation: BlockRecommendationLike | null,
): ValidateBlockResult {
  const i = (input ?? {}) as Record<string, unknown>;

  if (typeof i.goal_text !== "string" || i.goal_text.length < 4 || i.goal_text.length > 200) {
    return { ok: false, error: "goal_text required (4-200 chars)", code: "invalid_input" };
  }
  if (!isYmd(i.start_date) || !isYmd(i.end_date)) {
    return { ok: false, error: "start_date/end_date must be YYYY-MM-DD", code: "invalid_input" };
  }
  const start = new Date((i.start_date as string) + "T00:00:00Z");
  const end = new Date((i.end_date as string) + "T00:00:00Z");
  if (start.getUTCDay() !== 1) {
    return { ok: false, error: "start_date must be a Monday", code: "invalid_input" };
  }
  const expectedEnd = new Date(start);
  expectedEnd.setUTCDate(start.getUTCDate() + 34);
  if (end.toISOString().slice(0, 10) !== expectedEnd.toISOString().slice(0, 10)) {
    return { ok: false, error: "end_date must be exactly start_date + 34 days (5 weeks)", code: "invalid_input" };
  }
  // target_metric and target_value must come together
  const hasMetric = i.target_metric != null;
  const hasValue = i.target_value != null;
  if (hasMetric !== hasValue) {
    return { ok: false, error: "target_metric and target_value must both be set or both null", code: "invalid_input" };
  }
  // primary_lift enum guard — schema-level enforcement only runs in the
  // Anthropic API; server must re-validate so an unexpected string can't
  // slip through and silently bypass the sanity-bounds check below
  // (PRIMARY_LIFT_NAME_PATTERNS[unknown] = undefined → empty recommendation
  // → zero enforcement).
  if (i.primary_lift != null && !["squat", "bench", "deadlift", "ohp"].includes(i.primary_lift as string)) {
    return { ok: false, error: "primary_lift must be one of: squat, bench, deadlift, ohp", code: "invalid_input" };
  }

  // ── Target calibration bounds (same rule as propose_block) ──────────────
  if (recommendation?.sanity_bounds != null && i.target_value != null) {
    const [lo, hi] = recommendation.sanity_bounds;
    const tv = i.target_value as number;
    const outOfBounds = tv < lo || tv > hi;
    const overrideReason = typeof i.override_reason === "string" && i.override_reason.trim().length >= 4 ? i.override_reason : null;
    if (outOfBounds && overrideReason == null) {
      const direction = tv < lo ? "too low" : "too high";
      const hint = tv < lo
        ? `Target ${tv} kg would be hit too quickly given current ${recommendation.current_e1rm} e1RM. Sanity floor for this lift is ${lo} kg.`
        : `Target ${tv} kg exceeds realistic 4-week progression. Sanity ceiling for this lift is ${hi} kg (current ${recommendation.current_e1rm} e1RM + 1.5× the trend-realistic 4-week gain).`;
      return {
        ok: false,
        error: `Proposed target ${tv} kg is ${direction} for a 5-week ${i.primary_lift} block. ${hint} Recommended target: ${recommendation.recommended_target} kg (${recommendation.used}-based). To proceed with ${tv} kg anyway, retry propose_block with an explicit override_reason explaining why.`,
        code: "target_out_of_bounds",
        hint,
      };
    }
    if (outOfBounds && overrideReason != null) {
      return { ok: true, overridden: true };
    }
  }

  return { ok: true };
}

export type InsertBlockResult =
  | { ok: true; block: TrainingBlock }
  | { ok: false; error: string; code: string };

/** Insert the training_blocks row + acknowledge any outstanding
 *  block_outcomes row (the two writes previously inline in
 *  executeCommitBlock). Input must already be validated via
 *  validateBlockInput. Returns the raw Postgres error code on failure
 *  ("23505" = an active block already exists) — callers map codes to prose. */
export async function insertBlock(opts: {
  supabase: SupabaseClient;
  userId: string;
  input: Record<string, unknown>;
}): Promise<InsertBlockResult> {
  const p = opts.input as {
    goal_text: string;
    primary_lift?: PrimaryLift | null;
    target_metric?: "e1rm" | "working_weight" | null;
    target_value?: number | null;
    target_unit?: string | null;
    start_date: string;
    end_date: string;
  };
  const { data, error } = await opts.supabase
    .from("training_blocks")
    .insert({
      user_id: opts.userId,
      status: "active",
      start_date: p.start_date,
      end_date: p.end_date,
      goal_text: p.goal_text,
      primary_lift: p.primary_lift ?? null,
      target_metric: p.target_metric ?? null,
      target_value: p.target_value ?? null,
      target_unit: p.target_unit ?? "kg",
    })
    .select()
    .single();
  if (error) {
    return { ok: false, error: error.message, code: error.code ?? "insert_failed" };
  }

  // Stamp any outstanding unacknowledged block_outcomes row so the
  // BlockOutcomeCard stops surfacing and framework_state exits between-blocks
  // mode. Safe no-op when there's no such row (first-ever block, or already
  // acknowledged). Errors here are non-fatal — the block was saved.
  await opts.supabase
    .from("block_outcomes")
    .update({ athlete_acknowledged_at: new Date().toISOString() })
    .eq("user_id", opts.userId)
    .is("athlete_acknowledged_at", null);

  return { ok: true, block: data as TrainingBlock };
}
