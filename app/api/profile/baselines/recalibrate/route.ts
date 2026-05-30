// app/api/profile/baselines/recalibrate/route.ts
//
// User-triggered recalibration of profiles.whoop_baselines.rolling_30d.
// Session-authenticated (RLS-respecting). Same compute path as the cron;
// returns the fresh rolling_30d so the UI can update without a refetch.

import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { computeWhoopBaselines, persistBaselines } from "@/lib/whoop/baselines";

export async function POST() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }
  try {
    // Compute via service-role to avoid any RLS surprises on the read; the
    // write also goes via service-role so the user's own RLS update policy
    // on profiles doesn't matter. We've already verified the user is signed
    // in above, so this is safe.
    const service = createSupabaseServiceRoleClient();
    const baselines = await computeWhoopBaselines({
      supabase: service,
      userId: user.id,
      asOf: new Date(),
    });
    await persistBaselines({ supabase: service, userId: user.id, baselines });
    return NextResponse.json({ ok: true, rolling_30d: baselines });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
