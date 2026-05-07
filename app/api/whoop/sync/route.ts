import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import {
  getValidAccessToken,
  whoopGet,
  type WhoopRecovery,
  type WhoopCycle,
  type WhoopSleep,
} from "@/lib/whoop";
import { buildWhoopDayRows } from "@/lib/whoop-day-rows";

const MS_PER_DAY = 86_400_000;

type SyncCounts = {
  recovery_seen: number;
  recovery_scored: number;
  recovery_pending: number;
  recovery_unscorable: number;
  cycles_seen: number;
  cycles_scored: number;
  sleep_seen: number;
  sleep_scored: number;
  upserted: number;
};

async function syncForUser(userId: string) {
  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) return { ok: false, reason: "no_tokens" };

  const since = new Date(Date.now() - 14 * MS_PER_DAY).toISOString();
  const qs = `?start=${encodeURIComponent(since)}&limit=25`;

  const [recovery, cycles, sleep] = await Promise.all([
    whoopGet<{ records: WhoopRecovery[] }>(accessToken, `/v2/recovery${qs}`),
    whoopGet<{ records: WhoopCycle[] }>(accessToken, `/v2/cycle${qs}`),
    whoopGet<{ records: WhoopSleep[] }>(accessToken, `/v2/activity/sleep${qs}`),
  ]);

  const counts: SyncCounts = {
    recovery_seen: recovery.records.length,
    recovery_scored: 0,
    recovery_pending: 0,
    recovery_unscorable: 0,
    cycles_seen: cycles.records.length,
    cycles_scored: 0,
    sleep_seen: sleep.records.length,
    sleep_scored: 0,
    upserted: 0,
  };

  // Counts are computed before delegating to the shared builder, since the
  // response shape includes them and the builder is a pure row-constructor.
  for (const r of recovery.records) {
    if (r.score_state === "PENDING_SCORE") counts.recovery_pending += 1;
    else if (r.score_state === "UNSCORABLE") counts.recovery_unscorable += 1;
    if (r.score) counts.recovery_scored += 1;
  }
  for (const c of cycles.records) {
    if (c.score) counts.cycles_scored += 1;
  }
  for (const s of sleep.records) {
    if (s.score) counts.sleep_scored += 1;
  }

  const { rows, skipped } = buildWhoopDayRows(userId, recovery.records, cycles.records, sleep.records);

  if (rows.length === 0) return { ok: true, ...counts, skipped };

  const supabase = createSupabaseServiceRoleClient();
  const { error } = await supabase
    .from("daily_logs")
    .upsert(rows, { onConflict: "user_id,date" });
  if (error) throw error;
  counts.upserted = rows.length;
  // Invalidate ISR caches so the dashboard / trends / coach pick up new
  // WHOOP data immediately instead of waiting up to 60s for revalidation.
  revalidatePath("/");
  revalidatePath("/trends");
  revalidatePath("/coach");
  return { ok: true, ...counts, skipped };
}

export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const isCron = cronSecret && auth === `Bearer ${cronSecret}`;

  if (isCron) {
    // Cron path: sync every user that has WHOOP tokens
    const supabase = createSupabaseServiceRoleClient();
    const { data: tokenRows } = await supabase.from("whoop_tokens").select("user_id");
    const results: Record<string, unknown> = {};
    for (const { user_id } of tokenRows ?? []) {
      try { results[user_id] = await syncForUser(user_id); }
      catch (e) { results[user_id] = { ok: false, error: String(e) }; }
    }
    return NextResponse.json({ cron: true, results });
  }

  // User-initiated path: sync just the signed-in user
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  try {
    const result = await syncForUser(user.id);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
