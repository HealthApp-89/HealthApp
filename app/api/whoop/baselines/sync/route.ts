// app/api/whoop/baselines/sync/route.ts
//
// Daily cron at 10:30 UTC (30 min after the 10:00 UTC WHOOP sync). Iterates
// every user with a WHOOP token row and refreshes their rolling_30d block on
// profiles.whoop_baselines. CRON_SECRET-gated; mirrors the auth shape of
// /api/whoop/sync. GET (not POST) because Vercel cron sends GET.

import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { computeWhoopBaselines, persistBaselines } from "@/lib/whoop/baselines";

async function syncForUser(userId: string) {
  const supabase = createSupabaseServiceRoleClient();
  const baselines = await computeWhoopBaselines({
    supabase,
    userId,
    asOf: new Date(),
  });
  await persistBaselines({ supabase, userId, baselines });
  return { ok: true as const, baselines };
}

export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const isCron = cronSecret && auth === `Bearer ${cronSecret}`;

  if (isCron) {
    const supabase = createSupabaseServiceRoleClient();
    // Post-cutover: recovery baselines recompute from daily_logs (Garmin-owned),
    // so iterate athletes whose metrics_source is Garmin — NOT whoop_tokens,
    // which empties when the WHOOP subscription lapses.
    const { data: profileRows } = await supabase
      .from("profiles")
      .select("user_id")
      .eq("metrics_source", "garmin");
    const results: Record<string, unknown> = {};
    for (const { user_id } of profileRows ?? []) {
      try {
        results[user_id] = await syncForUser(user_id);
      } catch (e) {
        results[user_id] = { ok: false, error: String(e) };
      }
    }
    return NextResponse.json({ cron: true, results });
  }

  // User-initiated path (manual debug/recovery): require session.
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await syncForUser(user.id));
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
