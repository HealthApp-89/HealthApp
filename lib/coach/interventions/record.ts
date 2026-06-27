// lib/coach/interventions/record.ts
//
// Pure builder + I/O insert helper for explicit coach interventions.
//
// Design contract:
//   - buildExplicitIntervention: PURE — assembles the row fields from typed args.
//   - recordIntervention: I/O — inserts via supabase. MUST be best-effort:
//     a failed insert is caught + logged, the commit that called it still returns
//     success. A capture failure must never surface to the athlete as an error.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoachInterventionKind } from "@/lib/data/types";
import type { SwapContext, NutritionContext, BlockContext } from "./types";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Args for a session-swap capture. */
export type BuildSwapArgs = BlockContext & {
  kind: "exercise_swap";
  started_on: string; // YYYY-MM-DD
  from_exercise: string;
  to_exercise: string;
  reason: SwapContext["reason"];
};

/** Args for a nutrition-change capture. */
export type BuildNutritionArgs = BlockContext & {
  kind: "nutrition_change";
  started_on: string; // YYYY-MM-DD
  field: string;
  from: number | string | null;
  to: number | string | null;
};

export type BuildExplicitArgs = BuildSwapArgs | BuildNutritionArgs;

/** The assembled row — ready for insert (minus id/user_id which supabase supplies). */
export type BuiltIntervention = {
  kind: CoachInterventionKind;
  source: "explicit";
  started_on: string;
  context: Record<string, unknown>;
};

// ── Pure builder ──────────────────────────────────────────────────────────────

/** Assembles a BuiltIntervention from strongly-typed args.
 *  No I/O — safe to call in tests without a database. */
export function buildExplicitIntervention(args: BuildExplicitArgs): BuiltIntervention {
  const blockBase: BlockContext = {
    block_id: args.block_id,
    block_phase: args.block_phase,
    block_week: args.block_week,
  };

  let context: Record<string, unknown>;

  if (args.kind === "exercise_swap") {
    const swapCtx: SwapContext = {
      ...blockBase,
      from_exercise: args.from_exercise,
      to_exercise: args.to_exercise,
      reason: args.reason,
    };
    context = swapCtx as unknown as Record<string, unknown>;
  } else {
    const nutritionCtx: NutritionContext = {
      ...blockBase,
      field: args.field,
      from: args.from,
      to: args.to,
    };
    context = nutritionCtx as unknown as Record<string, unknown>;
  }

  return {
    kind: args.kind,
    source: "explicit",
    started_on: args.started_on,
    context,
  };
}

// ── I/O insert (best-effort) ──────────────────────────────────────────────────

/** Inserts a coach_interventions row. MUST be called inside try/catch by the
 *  caller — but also wraps internally so double-safety is harmless.
 *  Returns { ok: true } on success, { ok: false } on any error (never throws). */
export async function recordIntervention(
  supabase: SupabaseClient,
  userId: string,
  built: BuiltIntervention,
): Promise<{ ok: boolean }> {
  try {
    const { error } = await supabase.from("coach_interventions").insert({
      user_id: userId,
      kind: built.kind,
      source: built.source,
      started_on: built.started_on,
      context: built.context,
    });
    if (error) {
      console.warn("[recordIntervention] insert failed — capture skipped:", error.message);
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    console.warn("[recordIntervention] unexpected error — capture skipped:", e);
    return { ok: false };
  }
}

// ── Swap-reason derivation (from rationale text) ──────────────────────────────

/** Infers a swap reason from the free-text rationale Carter/the coach writes.
 *  Falls back to "boredom" (least clinical) when no keyword matches, which
 *  is clearly labelled and doesn't fabricate a medical signal. */
export function deriveSwapReason(rationale: string): SwapContext["reason"] {
  const lower = rationale.toLowerCase();
  if (lower.includes("pain") || lower.includes("hurt") || lower.includes("injury") || lower.includes("injur")) {
    return "pain";
  }
  if (lower.includes("stall") || lower.includes("plateau") || lower.includes("stuck") || lower.includes("progress")) {
    return "stall";
  }
  if (lower.includes("equipment") || lower.includes("unavailable") || lower.includes("no bar") || lower.includes("no dumbbell") || lower.includes("no machine")) {
    return "equipment";
  }
  return "boredom";
}
