// app/api/strava/sync/route.ts — daily catch-up for missed webhook deliveries.
// Gated by CRON_SECRET; runs at 09:00 UTC via vercel.json.

import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { listActivities } from "@/lib/strava/client";
import { ingestActivity } from "@/lib/strava/ingest";

export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = createSupabaseServiceRoleClient();
  const { data: tokens, error } = await sb.from("strava_tokens").select("user_id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  const results: Array<{ user_id: string; ingested: number; errors: number }> = [];

  for (const t of tokens ?? []) {
    let ingested = 0;
    let errors = 0;
    try {
      const aclist = await listActivities(t.user_id, { after: sevenDaysAgo, perPage: 50 });
      for (const a of aclist) {
        try {
          await ingestActivity({ userId: t.user_id, stravaActivityId: a.id });
          ingested += 1;
        } catch {
          errors += 1;
        }
      }
    } catch {
      errors += 1;
    }
    results.push({ user_id: t.user_id, ingested, errors });
  }

  return NextResponse.json({ ok: true, results });
}
