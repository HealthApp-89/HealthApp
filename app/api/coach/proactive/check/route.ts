// app/api/coach/proactive/check/route.ts
//
// Vercel cron entrypoint. Daily at 11:00 UTC.
// Computes coach trends once, evaluates 3 triggers, writes chat cards
// with 7-day dedup. Idempotent: re-running same day writes 0 new cards.

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { generateCoachTrends } from "@/lib/coach/trends";
import { runProactiveChecks } from "@/lib/coach/proactive";
import { todayInUserTz } from "@/lib/time";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || !auth.startsWith("Bearer ") || auth.slice(7) !== cronSecret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = createSupabaseServiceRoleClient();

  const { data: profile, error: pErr } = await sb
    .from("profiles")
    .select("user_id")
    .order("created_at", { ascending: true })
    .limit(1)
    .single();
  if (pErr || !profile) {
    return NextResponse.json(
      { error: "no user", detail: pErr?.message },
      { status: 404 },
    );
  }
  const userId = profile.user_id as string;
  // Use user-TZ today so date math stays consistent with Sub-project #2's
  // morning brief and Sub-project #5's trends compute (which both anchor on
  // todayInUserTz). Near-midnight UTC firings could otherwise resolve to a
  // different calendar day than the surfaces that consume the same signals.
  const today = todayInUserTz();

  let trends;
  try {
    trends = await generateCoachTrends({ supabase: sb, userId, today });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "trends compute failed", detail: msg },
      { status: 500 },
    );
  }

  let result;
  try {
    result = await runProactiveChecks({ supabase: sb, userId, trends });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "proactive run failed", detail: msg },
      { status: 500 },
    );
  }

  if (result.fired.length > 0) {
    revalidatePath("/coach");
  }

  return NextResponse.json({
    ok: true,
    fired: result.fired.length,
    suppressed: result.suppressed.length,
    fired_keys: result.fired.map((f) => f.event.trigger_key),
    suppressed_keys: result.suppressed.map((s) => s.event.trigger_key),
  });
}
