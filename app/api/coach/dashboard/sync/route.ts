// app/api/coach/dashboard/sync/route.ts
//
// Cron entrypoint. Daily 04:00 UTC. Idempotent on (user_id, today, version=1):
// if a v1 row exists, returns it without re-running composers.

import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { generatePeterDashboard } from "@/lib/coach/peter-dashboard";
import { renderInjectionBlock } from "@/lib/coach/peter-dashboard/render-injection";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || !auth.startsWith("Bearer ") || auth.slice(7) !== cronSecret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = createSupabaseServiceRoleClient();

  // Single-user app: pick the first profile. Note: profiles PK is user_id
  // (one row per auth user; see supabase/schema.sql).
  const { data: profile, error: pErr } = await sb
    .from("profiles")
    .select("user_id")
    .order("created_at", { ascending: true })
    .limit(1)
    .single();
  if (pErr || !profile) {
    return NextResponse.json({ error: "no user", detail: pErr?.message }, { status: 404 });
  }
  const userId = profile.user_id as string;

  const today = new Date().toISOString().slice(0, 10);

  // Idempotent on v1.
  const { data: existing } = await sb
    .from("coach_dashboards")
    .select("id, status, version")
    .eq("user_id", userId)
    .eq("generated_on", today)
    .eq("version", 1)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ ok: true, skipped: "exists", existing_id: existing.id });
  }

  const t0 = Date.now();
  try {
    const payload = await generatePeterDashboard({ supabase: sb, userId, today });
    const narrative_md = renderInjectionBlock(payload, today);

    const { data: inserted, error: insErr } = await sb
      .from("coach_dashboards")
      .insert({
        user_id: userId,
        generated_on: today,
        version: 1,
        status: payload.narrative_failed ? "failed" : "ready",
        payload,
        narrative_md,
      })
      .select("id")
      .single();
    if (insErr) throw insErr;

    const tookMs = Date.now() - t0;
    console.info("[peter-dashboard.sync]", {
      userId,
      generated_on: today,
      version: 1,
      status: payload.narrative_failed ? "failed" : "ready",
      narrative_failed: payload.narrative_failed,
      narrative_failure_reason: payload.narrative_failure_reason,
      took_ms: tookMs,
    });

    return NextResponse.json({
      ok: true,
      id: inserted.id,
      status: payload.narrative_failed ? "failed" : "ready",
    });
  } catch (e) {
    console.error("[peter-dashboard.sync] failed", e);
    return NextResponse.json({ error: "generation_failed", detail: String(e) }, { status: 500 });
  }
}
