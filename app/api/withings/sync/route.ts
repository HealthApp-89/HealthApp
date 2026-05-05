import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { getValidAccessToken, getMeasures, getActivity } from "@/lib/withings";
import { mergeWithingsToRows } from "@/lib/withings-merge";
import { todayInUserTz, ymdInUserTz } from "@/lib/time";

const MS_PER_DAY = 86_400_000;

async function syncForUser(userId: string) {
  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) return { ok: false, reason: "no_tokens" };

  const now = Date.now();
  const startMs = now - 14 * MS_PER_DAY;
  const startEpoch = Math.floor(startMs / 1000);
  const endEpoch = Math.floor(now / 1000);
  const startYmd = ymdInUserTz(new Date(startMs));
  const endYmd = todayInUserTz();

  const [measureGroups, activities] = await Promise.all([
    getMeasures(accessToken, startEpoch, endEpoch),
    getActivity(accessToken, startYmd, endYmd),
  ]);

  const byDate = mergeWithingsToRows(userId, measureGroups, activities);
  if (byDate.size === 0) return { ok: true, upserted: 0 };

  const supabase = createSupabaseServiceRoleClient();
  const { error } = await supabase
    .from("daily_logs")
    .upsert(Array.from(byDate.values()), { onConflict: "user_id,date" });
  if (error) throw error;
  // Invalidate ISR caches so the dashboard / trends pick up new body comp
  // and exercise minutes immediately.
  revalidatePath("/");
  revalidatePath("/trends");
  return {
    ok: true,
    upserted: byDate.size,
    counts: { measures: measureGroups.length, activities: activities.length },
  };
}

export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const isCron = cronSecret && auth === `Bearer ${cronSecret}`;

  if (isCron) {
    const supabase = createSupabaseServiceRoleClient();
    const { data: tokenRows } = await supabase.from("withings_tokens").select("user_id");
    const results: Record<string, unknown> = {};
    for (const { user_id } of tokenRows ?? []) {
      try { results[user_id] = await syncForUser(user_id); }
      catch (e) { results[user_id] = { ok: false, error: String(e) }; }
    }
    return NextResponse.json({ cron: true, results });
  }

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
