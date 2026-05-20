import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { queryKeys } from "@/lib/query/keys";
import { fetchFoodEntriesServer } from "@/lib/query/fetchers/foodEntries";
import { fetchTodayTargetsServer } from "@/lib/query/fetchers/todayTargets";
import { fetchHealthTrendServer } from "@/lib/query/fetchers/healthTrend";
import { todayInUserTz, ymdInUserTz } from "@/lib/time";
import { SubPillNav } from "@/components/layout/SubPillNav";
import { DietCoachClient } from "@/components/diet/DietCoachClient";
import { DietLogClient } from "@/components/diet/DietLogClient";
import { COLOR } from "@/lib/ui/theme";

export const dynamic = "force-dynamic";

const SUB_TABS = [
  { key: "coach", label: "Coach" },
  { key: "log", label: "Log" },
];

export default async function DietPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; date?: string }>;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { tab: tabParam, date: dateParam } = await searchParams;
  const tab = tabParam === "log" ? "log" : "coach";
  const today = todayInUserTz();
  // Log tab respects a custom date; Coach tab always shows today
  const date = dateParam ?? today;

  // 36-day window for BodyCompCard in DietCoachClient (same window as the component itself uses)
  const trendFrom = ymdInUserTz(new Date(Date.now() - 36 * 24 * 60 * 60 * 1000));

  const qc = makeServerQueryClient();

  // Prefetch the union of what both tabs need. Negligible extra cost,
  // simpler code than per-tab branching.
  await Promise.all([
    // Food entries for the active date (Log tab) AND today (Coach macro strip + slot cards)
    // When date === today, this single query satisfies both tabs.
    qc.prefetchQuery({
      queryKey: queryKeys.foodEntries.range(user.id, date, date),
      queryFn: () => fetchFoodEntriesServer(supabase, user.id, date, date),
    }),
    // When on the Log tab with a custom date, also prefetch today's entries for Coach
    ...(date !== today
      ? [
          qc.prefetchQuery({
            queryKey: queryKeys.foodEntries.range(user.id, today, today),
            queryFn: () =>
              fetchFoodEntriesServer(supabase, user.id, today, today),
          }),
        ]
      : []),
    // Nutrition targets for the active date (Log tab uses it for slot targets)
    qc.prefetchQuery({
      queryKey: queryKeys.todayTargets.byDate(user.id, date),
      queryFn: () => fetchTodayTargetsServer(supabase, user.id),
    }),
    // Today's targets for Coach tab (same result as above when date === today)
    ...(date !== today
      ? [
          qc.prefetchQuery({
            queryKey: queryKeys.todayTargets.byDate(user.id, today),
            queryFn: () => fetchTodayTargetsServer(supabase, user.id),
          }),
        ]
      : []),
    // Body-comp trend for BodyCompCard in DietCoachClient
    qc.prefetchQuery({
      queryKey: queryKeys.healthTrend.range(user.id, trendFrom, today),
      queryFn: () =>
        fetchHealthTrendServer(supabase, user.id, trendFrom, today),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <div style={{ minHeight: "100dvh", paddingBottom: 100 }}>
        <header style={{ padding: "16px 16px 4px 16px" }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Diet</h1>
          <p
            style={{ fontSize: 12, color: COLOR.textMuted, margin: "2px 0 0 0" }}
          >
            Nora
          </p>
        </header>
        <SubPillNav pills={SUB_TABS} paramName="tab" defaultKey="coach" />
        {tab === "coach" ? (
          <DietCoachClient userId={user.id} />
        ) : (
          <DietLogClient userId={user.id} date={date} />
        )}
      </div>
    </HydrationBoundary>
  );
}
