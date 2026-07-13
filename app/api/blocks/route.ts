// app/api/blocks/route.ts
//
// POST → create a training block from the session-authed Blocks-tab form.
// Shares validation + writes with the chat propose_block / commit_block
// executors via lib/coach/blocks/create-block.ts — but with NO HMAC
// approval-token round-trip: the form IS the approval.
//
// Session auth via createSupabaseServerClient; writes via service-role AFTER
// the auth check (matches the executors' expectations); user id comes from
// the session only.

import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { computeTargetRecommendation } from "@/lib/coach/prescription/calibrate-target";
import { validateBlockInput, insertBlock } from "@/lib/coach/blocks/create-block";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { todayInUserTz } from "@/lib/time";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const sr = createSupabaseServiceRoleClient() as unknown as SupabaseClient;
  const tz = await getUserTimezone(user.id);
  const todayIso = todayInUserTz(new Date(), tz);

  const LIFTS = ["squat", "bench", "deadlift", "ohp"] as const;
  if (!LIFTS.includes(body.primary_lift as (typeof LIFTS)[number])) {
    return NextResponse.json({ ok: false, error: "primary_lift must be one of squat|bench|deadlift|ohp", code: "invalid_input" }, { status: 422 });
  }
  const lift = body.primary_lift as (typeof LIFTS)[number];
  const recommendation = await computeTargetRecommendation({ supabase: sr, userId: user.id, lift, todayIso })
    .catch(() => null);

  const v = validateBlockInput(body, recommendation);
  // Spread carries ok:false (v is narrowed) — restating it trips TS2783.
  if (!v.ok) return NextResponse.json({ ...v }, { status: 422 });

  const result = await insertBlock({ supabase: sr, userId: user.id, input: body });
  if (!result.ok) {
    const status = result.code === "23505" ? 409 : 500;
    return NextResponse.json({ ...result }, { status });
  }
  return NextResponse.json({ ok: true, block: result.block });
}
