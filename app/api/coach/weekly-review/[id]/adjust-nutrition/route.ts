// app/api/coach/weekly-review/[id]/adjust-nutrition/route.ts
//
// POST: apply a ±kcal delta to a draft weekly review's nutrition target.
// Protein floor + fat target are preserved; carbs absorb the delta. Then
// re-renders the §6 narrative (one Sonnet call) so the prose stays consistent
// with the new numbers.
//
// kcal_delta is bounded to [-500, 500] to prevent runaway adjustments —
// larger swings should go through full Regenerate.

import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { regenerateNarrative } from "@/lib/coach/weekly-review/regenerate-narrative";
import type {
  ReconfirmResponses,
  WeeklyReviewPayload,
} from "@/lib/data/types";

const MIN_KCAL = 800;
const MAX_DELTA = 500;

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
  const { kcal_delta } = (body ?? {}) as { kcal_delta?: unknown };
  if (typeof kcal_delta !== "number" || !Number.isFinite(kcal_delta)) {
    return NextResponse.json(
      { error: "kcal_delta must be a number" },
      { status: 400 },
    );
  }
  if (Math.abs(kcal_delta) > MAX_DELTA) {
    return NextResponse.json(
      { error: `kcal_delta out of bounds (|delta| <= ${MAX_DELTA})` },
      { status: 400 },
    );
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
      { error: "review is not draft" },
      { status: 409 },
    );
  }

  const payload = structuredClone(row.payload as WeeklyReviewPayload);
  const proteinFloor = payload.targets.nutrition.protein_g;
  const fatFloor = payload.targets.nutrition.fat_g;
  const newKcal = Math.max(MIN_KCAL, payload.targets.nutrition.kcal + kcal_delta);
  const carbsNew = Math.max(
    0,
    Math.round((newKcal - proteinFloor * 4 - fatFloor * 9) / 4),
  );
  payload.targets.nutrition.kcal = newKcal;
  payload.targets.nutrition.carbs_g = carbsNew;

  let narrative: string | null = null;
  try {
    narrative = await regenerateNarrative({
      payload,
      reconfirmResponses:
        (row.reconfirm_responses as ReconfirmResponses | null) ?? {},
    });
  } catch (e) {
    console.error("[weekly-review/adjust-nutrition] regenerateNarrative failed:", e);
    // Nutrition adjustment still persists — narrative just stays stale.
    narrative = null;
  }

  const updates: Record<string, unknown> = {
    payload,
    updated_at: new Date().toISOString(),
  };
  if (narrative) updates.narrative_md = narrative;

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
    payload,
    narrative_md: narrative,
  });
}
