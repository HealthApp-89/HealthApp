// lib/coach/blocks/close-block.ts
//
// Shared close-block core, extracted from executeCommitCloseBlock in
// lib/coach/tools.ts so two entry points run identical writes:
//   1. The HMAC chat path (commit_close_block) — tools.ts keeps only token
//      verification + error-shape mapping, then calls this core with the
//      blockId named in the token payload.
//   2. The session-authed form route (POST /api/blocks/close, confirm: true)
//      — the form IS the approval; it calls this core with blockId: null,
//      which resolves the single active block.
//
// Idempotent: UPSERT on block_outcomes(block_id) preserves
// athlete_acknowledged_at; the conditional training_blocks UPDATE
// (WHERE status='active') no-ops on re-run.

import type { SupabaseClient } from "@supabase/supabase-js";
import { generateBlockOutcome, type GenerateBlockOutcomeResult } from "@/lib/coach/block-outcomes";

export type CloseBlockErrorCode =
  | "fetch_failed"
  | "no_active_block"
  | "block_not_found"
  | "already_closed"
  | "outcome_generate_failed"
  | "outcome_upsert_failed"
  | "block_update_failed";

export type CloseBlockResult =
  | { ok: true; block_id: string; status: "completed"; outcome_id: string }
  | { ok: false; error: string; code: CloseBlockErrorCode };

export async function closeBlockCore(opts: {
  supabase: SupabaseClient;
  userId: string;
  /** When set (HMAC chat path — the token names a specific block), close
   *  exactly this block; a missing row is "block_not_found" (deleted or
   *  tampered id, distinct from "no active block" — UI/audit needs the
   *  distinction). When null (session-authed API path), resolve the single
   *  active block; none is "no_active_block". */
  blockId?: string | null;
}): Promise<CloseBlockResult> {
  let blockRow: { id: string; status: string; start_date: string; end_date: string };

  if (opts.blockId != null) {
    // Re-verify the block is still active + owned by this user.
    const { data, error } = await opts.supabase
      .from("training_blocks")
      .select("id, status, start_date, end_date")
      .eq("id", opts.blockId)
      .eq("user_id", opts.userId)
      .maybeSingle();
    if (error) {
      return { ok: false, error: `active_block_fetch_failed: ${error.message}`, code: "fetch_failed" };
    }
    if (!data) {
      return { ok: false, error: "Block not found.", code: "block_not_found" };
    }
    if (data.status !== "active") {
      return { ok: false, error: `Block is already ${data.status}. Nothing to close.`, code: "already_closed" };
    }
    blockRow = data as typeof blockRow;
  } else {
    // Find active block. maybeSingle() so two active blocks (a data-integrity
    // bug) surface as an error rather than silently picking the first.
    const { data, error } = await opts.supabase
      .from("training_blocks")
      .select("id, status, start_date, end_date")
      .eq("user_id", opts.userId)
      .eq("status", "active")
      .maybeSingle();
    if (error) {
      return { ok: false, error: `active_block_fetch_failed: ${error.message}`, code: "fetch_failed" };
    }
    if (!data) {
      return {
        ok: false,
        error: "You're not in an active block; nothing to close. Use propose_block / commit_block to start a new one.",
        code: "no_active_block",
      };
    }
    blockRow = data as typeof blockRow;
  }

  const blockId = blockRow.id;

  // Re-run outcome generation against fresh data (athlete may have logged a
  // workout between propose and commit; we write what's current, not what's
  // in the token).
  let outcomePayload: GenerateBlockOutcomeResult["payload"];
  try {
    const result = await generateBlockOutcome({
      supabase: opts.supabase,
      userId: opts.userId,
      blockId,
    });
    outcomePayload = result.payload;
  } catch (e) {
    return {
      ok: false,
      error: `Couldn't compute the block outcome at commit time. ${String(e)}`,
      code: "outcome_generate_failed",
    };
  }

  // Generate Carter-voiced narrative BEFORE the upsert so it is always
  // included. Re-closing a block regenerates a fresh narrative — acceptable
  // since generateOutcomeNarrative never returns empty (fallback guarantees
  // text). Block dates were fetched above; use them directly.
  let narrative: string | null = null;
  try {
    const { generateOutcomeNarrative } = await import("@/lib/coach/block-outcomes/narrative");
    const result = await generateOutcomeNarrative({
      payload: outcomePayload,
      blockWindow: {
        start_date: blockRow.start_date,
        end_date: blockRow.end_date,
      },
    });
    narrative = result.narrative;
  } catch (e) {
    // Degrade gracefully: import or generation failure leaves narrative null;
    // upsert proceeds without narrative_md rather than failing the close.
  }

  // Upsert the block_outcomes row. UNIQUE constraint is on (block_id);
  // ON CONFLICT updates the payload but preserves athlete_acknowledged_at
  // (which the next commit_block will stamp when the next block starts).
  const { data: outcomeRow, error: outcomeErr } = await opts.supabase
    .from("block_outcomes")
    .upsert(
      {
        ...outcomePayload,
        ...(narrative ? { narrative_md: narrative } : {}),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "block_id", ignoreDuplicates: false },
    )
    .select("id")
    .single();
  if (outcomeErr || !outcomeRow) {
    return {
      ok: false,
      error: `block_outcomes upsert failed: ${outcomeErr?.message ?? "unknown"}`,
      code: "outcome_upsert_failed",
    };
  }

  // Flip the block to completed. Idempotent — the WHERE status='active' guard
  // makes re-runs no-op even if a concurrent close just landed.
  //
  // NOTE: deliberately does NOT write a `chat_messages` row with kind=
  // 'block_outcome' (which the cron at app/api/coach/block-outcomes/sweep
  // does). The chat-initiated close-block flow surfaces the outcome via the
  // commit_close_block confirmation chip (PERSIST_RESULT_TOOLS) and via
  // BLOCK_OUTCOME_CONTEXT in setup_block mode — the durable card is
  // unnecessary on the in-chat path and would duplicate the chip.
  const { error: updateErr } = await opts.supabase
    .from("training_blocks")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", blockId)
    .eq("user_id", opts.userId)
    .eq("status", "active");
  if (updateErr) {
    return {
      ok: false,
      error: `training_blocks update failed: ${updateErr.message}`,
      code: "block_update_failed",
    };
  }

  return { ok: true, block_id: blockId, status: "completed", outcome_id: outcomeRow.id as string };
}
