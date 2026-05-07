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
 *  (notes, weight_kg, steps, calories, body_fat_pct) are NOT touched.
 *
 *  Every error path returns JSON with a useful `error` field — the client
 *  surfaces this directly. Throwing here would let Next return its HTML 500
 *  page, which crashes `await res.json()` on the client and masks the cause. */
export async function POST(request: Request) {
  try {
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

    let accessToken: string | null;
    try {
      accessToken = await getValidAccessToken(user.id);
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: `token refresh failed: ${(e as Error).message}` },
        { status: 502 },
      );
    }
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
      return NextResponse.json(
        { ok: false, error: `whoop fetch failed: ${(e as Error).message}` },
        { status: 502 },
      );
    }

    let rows: Awaited<ReturnType<typeof buildWhoopDayRows>>["rows"];
    let skipped: Awaited<ReturnType<typeof buildWhoopDayRows>>["skipped"];
    try {
      ({ rows, skipped } = buildWhoopDayRows(user.id, recovery, cycles, sleep));
    } catch (e) {
      // The builder is now defensive against bad date fields, but wrap anyway
      // so any future regression surfaces with a precise label instead of
      // bubbling to the outer catch as an opaque `unhandled:` error.
      return NextResponse.json(
        { ok: false, error: `build rows failed: ${(e as Error).message}` },
        { status: 500 },
      );
    }

    if (rows.length === 0) {
      return NextResponse.json({
        ok: true,
        since: sinceIso.slice(0, 10),
        upserted: 0,
        counts: { recovery: recovery.length, cycles: cycles.length, sleep: sleep.length },
        skipped,
      });
    }

    // Use service-role for the upsert to keep this fast and predictable
    const sr = createSupabaseServiceRoleClient();
    const CHUNK = 500;
    let upserted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const { error } = await sr.from("daily_logs").upsert(chunk, { onConflict: "user_id,date" });
      if (error) {
        return NextResponse.json(
          { ok: false, error: `upsert failed: ${error.message}` },
          { status: 500 },
        );
      }
      upserted += chunk.length;
    }

    return NextResponse.json({
      ok: true,
      since: sinceIso.slice(0, 10),
      upserted,
      counts: { recovery: recovery.length, cycles: cycles.length, sleep: sleep.length },
      skipped,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `unhandled: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}
