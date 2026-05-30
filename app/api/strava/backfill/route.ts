// app/api/strava/backfill/route.ts — session-authed historical backfill.
// POST /api/strava/backfill?since=YYYY-MM-DD
// Paginated; respects Strava's 200req/15min limit by pausing between pages.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { listActivities } from "@/lib/strava/client";
import { ingestActivity } from "@/lib/strava/ingest";

export const maxDuration = 300;

const DEFAULT_SINCE_DAYS = 90;

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

export async function POST(req: Request) {
  const sb = await createSupabaseServerClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const since = url.searchParams.get("since");
  const sinceTs = since
    ? Math.floor(new Date(`${since}T00:00:00Z`).getTime() / 1000)
    : Math.floor(Date.now() / 1000) - DEFAULT_SINCE_DAYS * 24 * 3600;

  let page = 1;
  let totalIngested = 0;
  let totalErrors = 0;
  while (true) {
    const aclist = await listActivities(user.id, { after: sinceTs, page, perPage: 30 });
    if (aclist.length === 0) break;
    for (const a of aclist) {
      try {
        await ingestActivity({ userId: user.id, stravaActivityId: a.id });
        totalIngested += 1;
      } catch {
        totalErrors += 1;
      }
    }
    if (aclist.length < 30) break;
    page += 1;
    await sleep(500); // gentle pace
  }
  return NextResponse.json({ ok: true, ingested: totalIngested, errors: totalErrors });
}
