// lib/coach/prescription/reevaluate-target-hit.ts
//
// evaluateAndStampTargetHit early-returns whenever the block is already
// stamped, so target_hit_at_week can never fall on its own. After a session
// is unwound the stamp may be phantom — left by a PR from a workout that no
// longer exists — and a phantom stamp locks the block into consolidation,
// where the engine refuses further load increases on the primary lift.
//
// Split in two, deliberately, so the caller can put the clear BEFORE the
// workout delete and the re-evaluation AFTER it:
//
//   - clearTargetHitStamp is safe and idempotent run standalone. If the
//     delete that follows it then fails, the block is left momentarily
//     un-consolidated rather than falsely locked — the safe direction — and
//     the next ordinary commit's evaluateAndStampTargetHit rescans the
//     block window and re-stamps the identical value from surviving data
//     (pickQualifyingDate picks the earliest qualifying date, blockWeekOf
//     derives from start_date — both deterministic).
//   - reevaluateTargetHit re-derives the stamp from what's left after the
//     delete. A genuine crossing from a surviving session re-stamps (at its
//     own block week); a phantom one does not come back, because the clear
//     already ran before the row that would have produced it was removed.
//
// Calling clear first and treating IT as the fatal step (not the delete) is
// what removes the unrecoverable interleaving: the delete must never run
// while a to-be-deleted session might still be the reason the block is
// stamped. Re-evaluation failing afterward is safe — it leaves
// target_hit_at_week null, which the evaluator's own "already stamped"
// guard does not block, so the next ordinary commit repairs it.
//
// Unconditional by design: no "was the deleted session inside the block
// window?" check. The evaluator rescans the whole block window either way,
// so an out-of-window deletion simply re-stamps the same value.

import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateAndStampTargetHit } from "@/lib/coach/prescription/target-hit-evaluator";

/** Clears training_blocks.target_hit_at_week for the caller's active block,
 *  if set. Call BEFORE the workout delete — see module doc for why this
 *  half must gate the delete rather than run best-effort after it. */
export async function clearTargetHitStamp(opts: {
  supabase: SupabaseClient;
  userId: string;
}): Promise<{ cleared: boolean }> {
  const { supabase, userId } = opts;

  const { data: blocks, error } = await supabase
    .from("training_blocks")
    .select("id, target_hit_at_week")
    .eq("user_id", userId)
    .eq("status", "active")
    .limit(1);
  if (error) throw error;

  const block = blocks?.[0] as { id: string; target_hit_at_week: number | null } | undefined;
  if (!block || block.target_hit_at_week == null) return { cleared: false };

  const { error: clearErr } = await supabase
    .from("training_blocks")
    .update({ target_hit_at_week: null, updated_at: new Date().toISOString() })
    .eq("id", block.id);
  if (clearErr) throw clearErr;

  return { cleared: true };
}

/** Re-derives target_hit_at_week from surviving data. Call AFTER the
 *  workout delete and BEFORE repatchRemainingWeek, so the week recomputes
 *  against settled target-hit state. Thin, named wrapper over
 *  evaluateAndStampTargetHit — kept alongside clearTargetHitStamp so the
 *  unwind's two target-hit calls read as a pair at the call site. */
export async function reevaluateTargetHit(opts: {
  supabase: SupabaseClient;
  userId: string;
}): Promise<{ stamped: boolean; week_n: number | null }> {
  return evaluateAndStampTargetHit(opts);
}
