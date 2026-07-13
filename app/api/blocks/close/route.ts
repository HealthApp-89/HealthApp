// app/api/blocks/close/route.ts
//
// POST → preview or confirm closing the active training block from the
// session-authed Blocks-tab form. Body: { reason, preview?: boolean,
// confirm?: boolean }.
//
//   preview: true → reuses executeProposeCloseBlock (active-block lookup +
//     prospective outcome generation) and DISCARDS the approval token — the
//     form is the approval, so the HMAC round-trip is unnecessary. Calling
//     the executor directly and dropping the token was chosen over extracting
//     a separate preview core: the executor is already the exact preview
//     assembly, and signApprovalToken is cheap and side-effect-free.
//   confirm: true → runs the shared close core (lib/coach/blocks/
//     close-block.ts) directly with blockId: null (resolve the active block).
//     Identical writes to the chat commit_close_block path.
//
// Session auth via createSupabaseServerClient; writes via service-role AFTER
// the auth check; user id comes from the session only.

import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { executeProposeCloseBlock } from "@/lib/coach/tools";
import { closeBlockCore, type CloseBlockErrorCode } from "@/lib/coach/blocks/close-block";
import type { SupabaseClient } from "@supabase/supabase-js";

function statusForCloseError(code: CloseBlockErrorCode | string | undefined): number {
  switch (code) {
    case "no_active_block":
    case "block_not_found":
      return 404;
    case "already_closed":
      return 409;
    case "outcome_generate_failed":
      return 422;
    default:
      return 500;
  }
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  // Same reason rule as propose_close_block (4-200 chars).
  const reason = body.reason;
  if (typeof reason !== "string" || reason.length < 4 || reason.length > 200) {
    return NextResponse.json(
      { ok: false, error: "reason required (4-200 chars)", code: "invalid_input" },
      { status: 422 },
    );
  }

  const sr = createSupabaseServiceRoleClient() as unknown as SupabaseClient;

  if (body.preview === true) {
    const result = await executeProposeCloseBlock({ supabase: sr, userId: user.id, input: { reason } });
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error.error, code: result.error.code ?? "preview_failed" },
        { status: statusForCloseError(result.error.code) },
      );
    }
    // Discard result.data.approval_token — the session-authed form is the
    // approval; the token only exists for the chat commit path.
    return NextResponse.json({ ok: true, preview: result.data.preview });
  }

  if (body.confirm === true) {
    // Audit trail for the no-token path (the chat path carries the reason in
    // the signed token payload; here it lives in the server log).
    console.info("[/api/blocks/close] confirm", { userId: user.id, reason });
    const result = await closeBlockCore({ supabase: sr, userId: user.id, blockId: null });
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error, code: result.code },
        { status: statusForCloseError(result.code) },
      );
    }
    return NextResponse.json({
      ok: true,
      block_id: result.block_id,
      status: result.status,
      outcome_id: result.outcome_id,
    });
  }

  return NextResponse.json(
    { ok: false, error: "Set preview: true or confirm: true", code: "invalid_input" },
    { status: 400 },
  );
}
