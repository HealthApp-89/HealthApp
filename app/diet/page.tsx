import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { queryKeys } from "@/lib/query/keys";
import { fetchFoodEntriesServer } from "@/lib/query/fetchers/foodEntries";
import { fetchTodayTargetsServer } from "@/lib/query/fetchers/todayTargets.server";
import { fetchDailyLogsServer } from "@/lib/query/fetchers/dailyLogs";
import { fetchCoachTrendsServer } from "@/lib/query/fetchers/coachTrends";
import { fetchBlockHistoryServer } from "@/lib/query/fetchers/blockHistory";
import { fetchBodyMeasurementsServer } from "@/lib/query/fetchers/bodyMeasurements";
import { fetchHealthTrendServer } from "@/lib/query/fetchers/healthTrend";
import { fetchUserFoodItemsRecentServer } from "@/lib/query/fetchers/userFoodItems";
import { todayInUserTz } from "@/lib/time";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { DietJournalClient } from "@/components/diet/DietJournalClient";

export const dynamic = "force-dynamic";

export default async function DietPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; view?: string }>;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const params = await searchParams;
  const view: "journal" | "nutrition" | "body" | "coach" =
    params.view === "nutrition" ? "nutrition" :
    params.view === "body"      ? "body"      :
    params.view === "coach"     ? "coach"     :
                                  "journal";
  const tz = await getUserTimezone(user.id);
  const today = todayInUserTz(new Date(), tz);
  const date =
    typeof params.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params.date)
      ? params.date
      : today;

  // 12 months back — body-comp Trend window. Mirrors what the now-defunct
  // /health page passed to HealthClient.
  const trendFrom = new Date(`${today}T00:00:00Z`);
  trendFrom.setUTCMonth(trendFrom.getUTCMonth() - 12);
  const trendFromIso = trendFrom.toISOString().slice(0, 10);

  const serviceSupabase = createSupabaseServiceRoleClient();
  const qc = makeServerQueryClient();

  await Promise.all([
    // Food entries for the selected date (slot cards + macro totals)
    qc.prefetchQuery({
      queryKey: queryKeys.foodEntries.range(user.id, date, date),
      queryFn: () => fetchFoodEntriesServer(supabase, user.id, date, date),
    }),
    // Nutrition targets for the selected date (kcal ring + per-slot targets)
    qc.prefetchQuery({
      queryKey: queryKeys.todayTargets.byDate(user.id, date),
      queryFn: () => fetchTodayTargetsServer(supabase, user.id),
    }),
    // Daily log row for the selected date (active_calories for net-kcal display)
    qc.prefetchQuery({
      queryKey: queryKeys.dailyLogs.range(user.id, date, date),
      queryFn: () => fetchDailyLogsServer(supabase, user.id, date, date),
    }),
    // Recent saved library items for the Saved strip on the journal view
    qc.prefetchQuery({
      queryKey: queryKeys.userFoodItems.recent(user.id),
      queryFn: () => fetchUserFoodItemsRecentServer(supabase, user.id),
    }),
    // Coach trends for the Nutrition tab
    qc.prefetchQuery({
      queryKey: queryKeys.coachTrends.one(user.id),
      queryFn: () => fetchCoachTrendsServer(serviceSupabase, user.id, today),
    }),
    // Block history (macrocycle view) for the trends Performance section
    qc.prefetchQuery({
      queryKey: queryKeys.blockHistory.one(user.id),
      queryFn: () => fetchBlockHistoryServer(serviceSupabase, user.id, today),
    }),
    // Body tab — circumference history + 12mo body-comp trend
    qc.prefetchQuery({
      queryKey: queryKeys.bodyMeasurements.all(user.id),
      queryFn: () => fetchBodyMeasurementsServer(supabase, user.id),
    }),
    qc.prefetchQuery({
      queryKey: queryKeys.healthTrend.range(user.id, trendFromIso, today),
      queryFn: () => fetchHealthTrendServer(supabase, user.id, trendFromIso, today),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <DietJournalClient
        userId={user.id}
        initialDate={date}
        initialView={view}
        todayIso={today}
        trendFromIso={trendFromIso}
      />
    </HydrationBoundary>
  );
}
