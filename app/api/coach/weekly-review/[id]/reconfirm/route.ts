// app/api/coach/weekly-review/[id]/reconfirm/route.ts
//
// PATCH: persist a reconfirm-chip answer on a weekly_reviews row, then
// regenerate the §6 narrative (cheap second AI call).
//
// Auth uses the cookie-bound server client; writes go through service-role
// since weekly_reviews has no UPDATE RLS policy (writes are server-only).
// The user_id ownership check is enforced in code via the row .eq("user_id").

import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { regenerateNarrative } from "@/lib/coach/weekly-review/regenerate-narrative";
import type { ReconfirmResponses, WeeklyReviewPayload } from "@/lib/data/types";

export async function PATCH(
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
  const { reconfirm_id, chip_value } = (body ?? {}) as {
    reconfirm_id?: unknown;
    chip_value?: unknown;
  };
  if (typeof reconfirm_id !== "string" || typeof chip_value !== "string") {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const sb = createSupabaseServiceRoleClient();
  const { data: row, error: rErr } = await sb
    .from("weekly_reviews")
    .select("id, user_id, status, payload, reconfirm_responses")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (rErr || !row) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (row.status !== "draft") {
    return NextResponse.json(
      {
        error: "review_not_draft",
        message:
          "Review is not a draft — reconfirm answers can only be persisted on draft reviews.",
      },
      { status: 409 },
    );
  }

  const responses = (row.reconfirm_responses as ReconfirmResponses | null) ?? {};
  const updatedResponses: ReconfirmResponses = {
    ...responses,
    [reconfirm_id]: { chip_value, answered_at: new Date().toISOString() },
  };

  let newNarrative: string | null = null;
  try {
    newNarrative = await regenerateNarrative({
      payload: row.payload as WeeklyReviewPayload,
      reconfirmResponses: updatedResponses,
    });
  } catch (e) {
    console.error("[weekly-review/reconfirm] regenerateNarrative failed:", e);
    // Chip answer still persists below — narrative just stays stale.
  }

  const updates: Record<string, unknown> = {
    reconfirm_responses: updatedResponses,
    updated_at: new Date().toISOString(),
  };
  if (newNarrative) updates.narrative_md = newNarrative;

  const { error: uErr } = await sb
    .from("weekly_reviews")
    .update(updates)
    .eq("id", id)
    .eq("user_id", user.id);
  if (uErr) {
    return NextResponse.json({ error: uErr.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    reconfirm_responses: updatedResponses,
    narrative_md: newNarrative,
  });
}
