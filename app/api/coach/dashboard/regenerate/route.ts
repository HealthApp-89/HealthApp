// app/api/coach/dashboard/regenerate/route.ts
//
// Manual regen. Inserts a new row at (user_id, today, max(version) + 1).
// Rate-limited 6/day per user via row count.

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { generatePeterDashboard } from "@/lib/coach/peter-dashboard";
import { renderInjectionBlock } from "@/lib/coach/peter-dashboard/render-injection";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DAILY_REGEN_CAP = 6;

export async function POST() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = createSupabaseServiceRoleClient();
  const today = new Date().toISOString().slice(0, 10);

  // Rate limit: count existing rows for today.
  const { data: rows, error: countErr } = await sb
    .from("coach_dashboards")
    .select("version")
    .eq("user_id", user.id)
    .eq("generated_on", today)
    .order("version", { ascending: false });
  if (countErr) {
    return NextResponse.json(
      { error: "count_failed", detail: countErr.message },
      { status: 500 },
    );
  }

  if ((rows?.length ?? 0) >= DAILY_REGEN_CAP) {
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    return NextResponse.json(
      { error: "rate_limited", retry_after: tomorrow.toISOString() },
      { status: 429 },
    );
  }

  const nextVersion = ((rows?.[0]?.version as number | undefined) ?? 0) + 1;

  try {
    const payload = await generatePeterDashboard({
      supabase: sb,
      userId: user.id,
      today,
    });
    const narrative_md = renderInjectionBlock(payload, today);

    const { data: inserted, error: insErr } = await sb
      .from("coach_dashboards")
      .insert({
        user_id: user.id,
        generated_on: today,
        version: nextVersion,
        status: payload.narrative_failed ? "failed" : "ready",
        payload,
        narrative_md,
      })
      .select("id, version")
      .single();
    if (insErr) throw insErr;

    revalidatePath("/coach");

    return NextResponse.json({
      ok: true,
      id: inserted.id,
      version: inserted.version,
      status: payload.narrative_failed ? "failed" : "ready",
    });
  } catch (e) {
    console.error("[peter-dashboard.regenerate] failed", e);
    return NextResponse.json(
      { error: "generation_failed", detail: String(e) },
      { status: 500 },
    );
  }
}
