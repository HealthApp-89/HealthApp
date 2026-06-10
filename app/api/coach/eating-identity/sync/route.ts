// app/api/coach/eating-identity/sync/route.ts
//
// Daily cron — walks profiles, recomputes EatingIdentity, writes back.
// Single-user app: profiles row count is 1. Idempotent.

import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { composeEatingIdentity } from "@/lib/coach/nora-suggestions/compose-eating-identity";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { todayInUserTz } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!auth || !secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createSupabaseServiceRoleClient();
  const { data: profiles, error } = await supabase.from("profiles").select("user_id");
  if (error) return NextResponse.json({ error: "read_failed", detail: error.message }, { status: 500 });

  const results: Array<{ user_id: string; ok: boolean; today?: string; error?: string }> = [];
  for (const p of profiles ?? []) {
    try {
      const tz = await getUserTimezone(p.user_id);
      const today = todayInUserTz(new Date(), tz);
      const payload = await composeEatingIdentity({ supabase, userId: p.user_id, today });
      const { error: upErr } = await supabase
        .from("profiles")
        .update({ eating_identity_cache: payload })
        .eq("user_id", p.user_id);
      if (upErr) throw upErr;
      results.push({ user_id: p.user_id, ok: true, today });
    } catch (e) {
      results.push({ user_id: p.user_id, ok: false, error: String(e) });
    }
  }
  return NextResponse.json({ results });
}
