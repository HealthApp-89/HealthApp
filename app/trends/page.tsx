// app/trends/page.tsx
import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { queryKeys } from "@/lib/query/keys";
import { fetchDailyLogsServer } from "@/lib/query/fetchers/dailyLogs";
import { TrendsClient } from "@/components/trends/TrendsClient";
import { resolvePeriod, type PeriodPreset } from "@/lib/ui/period";

export const revalidate = 60;

export default async function TrendsPage(props: {
  searchParams: Promise<{ period?: string; start?: string; end?: string }>;
}) {
  const sp = await props.searchParams;
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Initial period from URL (deep links keep working) but it becomes pure
  // client state from here — no further navigation on pill change.
  const rawPeriod = sp.period ?? "30d";
  const initialPeriod: PeriodPreset = (
    ["7d", "30d", "ytd", "ly"].includes(rawPeriod) ? rawPeriod : "30d"
  ) as PeriodPreset;

  // Always prefetch a 1-year window — TrendsClient slices it client-side
  // for any pill choice including "1Y".
  const { from: yearFrom, to: yearTo } = resolvePeriod("ly", undefined, undefined);

  const queryClient = makeServerQueryClient();
  await queryClient.prefetchQuery({
    queryKey: queryKeys.dailyLogs.range(user.id, yearFrom, yearTo),
    queryFn: () => fetchDailyLogsServer(supabase, user.id, yearFrom, yearTo),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <TrendsClient
        userId={user.id}
        initialFrom={yearFrom}
        initialTo={yearTo}
        initialPeriod={initialPeriod}
      />
    </HydrationBoundary>
  );
}
