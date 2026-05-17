// app/metrics/_sub/TrendsSubPill.tsx
//
// Mirrors the old app/trends/page.tsx data fetch + render. Prefetches a
// wide window (min(ly.from, ytd.from) → today) so every pill range
// resolves from cache without a refetch — same pattern as before.
import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { queryKeys } from "@/lib/query/keys";
import { fetchDailyLogsTrendServer } from "@/lib/query/fetchers/dailyLogs";
import { TrendsClient } from "@/components/trends/TrendsClient";
import { resolvePeriod, type PeriodPreset } from "@/lib/ui/period";

type Params = {
  period?: string;
  start?: string;
  end?: string;
};

export async function TrendsSubPill({ params }: { params: Params }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const rawPeriod = params.period ?? "30d";
  const initialPeriod: PeriodPreset = (
    ["7d", "30d", "ytd", "ly"].includes(rawPeriod) ? rawPeriod : "30d"
  ) as PeriodPreset;

  // Prefetch a window wide enough to cover every pill range (see the
  // original trends/page.tsx comment for the full rationale).
  const lyRange = resolvePeriod("ly", undefined, undefined);
  const ytdRange = resolvePeriod("ytd", undefined, undefined);
  const yearFrom = lyRange.from < ytdRange.from ? lyRange.from : ytdRange.from;
  const yearTo = ytdRange.to;

  const queryClient = makeServerQueryClient();
  await queryClient.prefetchQuery({
    queryKey: queryKeys.dailyLogs.trend(user.id, yearFrom, yearTo),
    queryFn: () => fetchDailyLogsTrendServer(supabase, user.id, yearFrom, yearTo),
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
