// app/trends/page.tsx
import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { queryKeys } from "@/lib/query/keys";
import { fetchDailyLogsTrendServer } from "@/lib/query/fetchers/dailyLogs";
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

  // Prefetch a window wide enough to cover EVERY pill range. resolvePeriod's
  // "ly" returns calendar last year (e.g. 2025-01-01..2025-12-31) and "ytd"
  // returns the current year so far — they don't overlap. We compute the
  // union by taking min(ly.from, ytd.from) → today, so any pill click slices
  // a subset of the cached array (no extra fetch). 7d and 30d are trivially
  // inside the window.
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
