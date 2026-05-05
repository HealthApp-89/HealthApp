import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import {
  getValidAccessToken,
  whoopGetAll,
  type WhoopRecovery,
  type WhoopCycle,
  type WhoopSleep,
} from "@/lib/whoop";
import { buildWhoopDayRows } from "@/lib/whoop-day-rows";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** POST /api/whoop/backfill?since=YYYY-MM-DD
 *  Pulls every recovery / cycle / sleep record from WHOOP between `since` and now,
 *  upserts them into daily_logs. Default since = 2 years ago. Manual fields
 *  (notes, weight_kg, steps, calories, body_fat_pct) are NOT touched. */
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const sinceParam = url.searchParams.get("since");
  const since = sinceParam
    ? new Date(sinceParam + "T00:00:00Z")
    : new Date(Date.now() - 730 * 86_400_000);
  const sinceIso = since.toISOString();

  const accessToken = await getValidAccessToken(user.id);
  if (!accessToken) {
    return NextResponse.json({ ok: false, reason: "no_tokens" }, { status: 400 });
  }

  let recovery: WhoopRecovery[] = [];
  let cycles: WhoopCycle[] = [];
  let sleep: WhoopSleep[] = [];
  try {
    [recovery, cycles, sleep] = await Promise.all([
      whoopGetAll<WhoopRecovery>(accessToken, "/v2/recovery", { start: sinceIso }),
      whoopGetAll<WhoopCycle>(accessToken, "/v2/cycle", { start: sinceIso }),
      whoopGetAll<WhoopSleep>(accessToken, "/v2/activity/sleep", { start: sinceIso }),
    ]);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }

  const rows = buildWhoopDayRows(user.id, recovery, cycles, sleep);

  if (rows.length === 0) {
    return NextResponse.json({
      ok: true,
      upserted: 0,
      counts: { recovery: recovery.length, cycles: cycles.length, sleep: sleep.length },
    });
  }

  // Use service-role for the upsert to keep this fast and predictable
  const sr = createSupabaseServiceRoleClient();
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
    since: sinceIso.slice(0, 10),
    upserted,
    counts: { recovery: recovery.length, cycles: cycles.length, sleep: sleep.length },
  });
}
