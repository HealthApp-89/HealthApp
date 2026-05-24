import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { queryKeys } from "@/lib/query/keys";
import { fetchFoodEntriesServer } from "@/lib/query/fetchers/foodEntries";
import { fetchTodayTargetsServer } from "@/lib/query/fetchers/todayTargets";
import { fetchDailyLogsServer } from "@/lib/query/fetchers/dailyLogs";
import { fetchCoachTrendsServer } from "@/lib/query/fetchers/coachTrends";
import { todayInUserTz } from "@/lib/time";
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
  const view: "journal" | "nutrition" = params.view === "nutrition" ? "nutrition" : "journal";
  const today = todayInUserTz();
  const date =
    typeof params.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params.date)
      ? params.date
      : today;

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
    // Coach trends for the Nutrition tab
    qc.prefetchQuery({
      queryKey: queryKeys.coachTrends.one(user.id),
      queryFn: () => fetchCoachTrendsServer(serviceSupabase, user.id, today),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <DietJournalClient userId={user.id} initialDate={date} initialView={view} />
    </HydrationBoundary>
  );
}
