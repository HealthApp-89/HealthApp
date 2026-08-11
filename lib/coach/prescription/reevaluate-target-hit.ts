// lib/coach/prescription/reevaluate-target-hit.ts
//
// evaluateAndStampTargetHit early-returns whenever the block is already
// stamped, so target_hit_at_week can never fall on its own. After a session
// is unwound the stamp may be phantom — left by a PR from a workout that no
// longer exists — and a phantom stamp locks the block into consolidation,
// where the engine refuses further load increases on the primary lift.
//
// Clearing before re-running is the only way the value can be re-derived. A
// genuine crossing from a surviving session re-stamps (at its own block
// week, per pickQualifyingDate); a phantom one does not come back.
//
// Unconditional by design: no "was the deleted session inside the block
// window?" check. The evaluator rescans the whole block window either way,
// so an out-of-window deletion simply re-stamps the same value.

import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateAndStampTargetHit } from "@/lib/coach/prescription/target-hit-evaluator";

export async function reevaluateTargetHit(opts: {
  supabase: SupabaseClient;
  userId: string;
}): Promise<{ cleared: boolean; stamped: boolean; week_n: number | null }> {
  const { supabase, userId } = opts;

  const { data: blocks, error } = await supabase
    .from("training_blocks")
    .select("id, target_hit_at_week")
    .eq("user_id", userId)
    .eq("status", "active")
    .limit(1);
  if (error) throw error;

  const block = blocks?.[0] as { id: string; target_hit_at_week: number | null } | undefined;
  let cleared = false;

  if (block && block.target_hit_at_week != null) {
    const { error: clearErr } = await supabase
      .from("training_blocks")
      .update({ target_hit_at_week: null, updated_at: new Date().toISOString() })
      .eq("id", block.id);
    if (clearErr) throw clearErr;
    cleared = true;
  }

  const res = await evaluateAndStampTargetHit({ supabase, userId });
  return { cleared, stamped: res.stamped, week_n: res.week_n };
}
