// app/api/coach/approval-token/route.ts
//
// GET /api/coach/approval-token?review_id=<uuid>
//
// Issues a short-lived HMAC token that gates the matching commit_weekly_plan
// endpoint. The token is payload-bound: the same review row's prescription
// is re-hashed at verify time, so any drift between issue and commit fails.
//
// Auth: cookie-bound server client. The review row is loaded with service
// role and explicitly scoped via .eq("user_id"). Only "draft" reviews are
// signable — committed/superseded rows cannot mint new tokens.

import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { signApprovalToken } from "@/lib/coach/approval-token";
import { buildWeeklyReviewCommitPayload } from "@/lib/coach/weekly-review/commit-payload";
import type { WeeklyReviewPayload } from "@/lib/data/types";

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const reviewId = url.searchParams.get("review_id");
  if (!reviewId) {
    return NextResponse.json(
      { error: "review_id required" },
      { status: 400 },
    );
  }

  const sb = createSupabaseServiceRoleClient();
  const { data: row, error: rErr } = await sb
    .from("weekly_reviews")
    .select("id, user_id, status, next_week_start, payload")
    .eq("id", reviewId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (rErr || !row) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (row.status !== "draft") {
    return NextResponse.json(
      { error: "review is not draft" },
      { status: 409 },
    );
  }

  const payload = buildWeeklyReviewCommitPayload({
    reviewId: row.id as string,
    nextWeekStart: row.next_week_start as string,
    reviewPayload: row.payload as WeeklyReviewPayload,
  });
  const token = signApprovalToken({
    userId: user.id,
    action: "weekly_review",
    payload,
  });

  return NextResponse.json({ token });
}
