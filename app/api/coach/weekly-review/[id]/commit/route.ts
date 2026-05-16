// app/api/coach/weekly-review/[id]/commit/route.ts
//
// POST: commit a draft weekly_reviews row's prescription into training_weeks
// for the next Monday, then mark the review status='committed' with the
// resulting training_weeks row id.
//
// HMAC-gated: the client mints a token via GET /api/coach/approval-token and
// passes it in the body. The verifier recomputes the same payload hash on the
// server, so any drift between issue and commit fails. weekly_reviews has no
// UPDATE/INSERT RLS policy — writes go through service role with .eq("user_id")
// scoping.

import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { verifyApprovalToken, payloadHash, ApprovalTokenError, approvalTokenUserMessage } from "@/lib/coach/approval-token";
import { buildWeeklyReviewCommitPayload } from "@/lib/coach/weekly-review/commit-payload";
import type { WeeklyReviewPayload } from "@/lib/data/types";
import { revalidatePath } from "next/cache";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const { approval_token } = (body ?? {}) as { approval_token?: unknown };
  if (typeof approval_token !== "string") {
    return NextResponse.json(
      { error: "approval_token required" },
      { status: 400 },
    );
  }

  const sb = createSupabaseServiceRoleClient();
  const { data: row, error: rErr } = await sb
    .from("weekly_reviews")
    .select("id, user_id, payload, next_week_start, status, block_id")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (rErr || !row) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (row.status !== "draft") {
    return NextResponse.json(
      { error: "already committed or superseded" },
      { status: 409 },
    );
  }

  const reviewPayload = row.payload as WeeklyReviewPayload;
  const commitPayload = buildWeeklyReviewCommitPayload({
    reviewId: row.id as string,
    nextWeekStart: row.next_week_start as string,
    reviewPayload,
  });

  let envelope;
  try {
    envelope = verifyApprovalToken({
      token: approval_token,
      userId: user.id,
      action: "weekly_review",
    });
  } catch (e) {
    if (e instanceof ApprovalTokenError) {
      return NextResponse.json(
        { error: approvalTokenUserMessage(e.code), code: e.code },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { error: (e as Error).message, code: "verify_failed" },
      { status: 403 },
    );
  }
  // Drift check: the issuer baked commitPayload into the token; reject if the
  // review row has been re-generated since the token was minted.
  if (payloadHash(envelope.payload) !== payloadHash(commitPayload)) {
    return NextResponse.json(
      {
        error: "This review was regenerated after you approved it. Refresh the page and approve the updated version.",
        code: "payload_drift",
      },
      { status: 409 },
    );
  }

  const { data: upserted, error: upsertErr } = await sb
    .from("training_weeks")
    .upsert(
      {
        user_id: user.id,
        block_id: row.block_id ?? null,
        week_start: commitPayload.next_week_start,
        session_plan: commitPayload.session_plan,
        rir_target: commitPayload.rir_target,
        weekly_focus: commitPayload.weekly_focus,
        research_phase: commitPayload.research_phase,
        proposed_by: "coach",
        committed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,week_start" },
    )
    .select("id")
    .single();
  if (upsertErr || !upserted) {
    return NextResponse.json(
      { error: upsertErr?.message ?? "upsert failed" },
      { status: 500 },
    );
  }

  const { error: updErr } = await sb
    .from("weekly_reviews")
    .update({
      status: "committed",
      committed_at: new Date().toISOString(),
      committed_training_week_id: upserted.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("user_id", user.id);
  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  revalidatePath(`/coach/weeks/${row.next_week_start}`);
  revalidatePath("/coach");
  revalidatePath("/strength");

  return NextResponse.json({
    ok: true,
    training_week_id: upserted.id,
  });
}
