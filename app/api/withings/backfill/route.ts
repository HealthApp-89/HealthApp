import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { getValidAccessToken, getMeasures, getActivity } from "@/lib/withings";
import { mergeWithingsToRows } from "@/lib/withings-merge";
import { todayInUserTz } from "@/lib/time";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** POST /api/withings/backfill?since=YYYY-MM-DD
 *  Default since = 2 years ago. Pulls scale measurements + activity, upserts
 *  body composition / steps / calories columns. Manual fields (notes, sleep) untouched. */
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const sinceParam = url.searchParams.get("since");
  const since = sinceParam
    ? new Date(sinceParam + "T00:00:00Z")
    : new Date(Date.now() - 730 * 86_400_000);

  const accessToken = await getValidAccessToken(user.id);
  if (!accessToken) {
    return NextResponse.json({ ok: false, reason: "no_tokens" }, { status: 400 });
  }

  const startEpoch = Math.floor(since.getTime() / 1000);
  const endEpoch = Math.floor(Date.now() / 1000);
  const startYmd = since.toISOString().slice(0, 10);
  const endYmd = todayInUserTz();

  let measureGroups, activities;
  try {
    [measureGroups, activities] = await Promise.all([
      getMeasures(accessToken, startEpoch, endEpoch),
      getActivity(accessToken, startYmd, endYmd),
    ]);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }

  const byDate = mergeWithingsToRows(user.id, measureGroups, activities);
  if (byDate.size === 0) {
    return NextResponse.json({
      ok: true,
      upserted: 0,
      counts: { measures: measureGroups.length, activities: activities.length },
    });
  }

  const sr = createSupabaseServiceRoleClient();
  const rows = [...byDate.values()];
  const CHUNK = 500;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await sr.from("daily_logs").upsert(chunk, { onConflict: "user_id,date" });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    upserted += chunk.length;
  }

  return NextResponse.json({
    ok: true,
    since: startYmd,
    upserted,
    counts: { measures: measureGroups.length, activities: activities.length },
  });
}
