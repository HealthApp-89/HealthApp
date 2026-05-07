import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { queryKeys } from "@/lib/query/keys";
import { fetchProfileServer } from "@/lib/query/fetchers/profile";
import { fetchWhoopTokensServer } from "@/lib/query/fetchers/whoopTokens";
import { fetchWithingsTokensServer } from "@/lib/query/fetchers/withingsTokens";
import { fetchIngestTokenServer } from "@/lib/query/fetchers/ingestToken";
import { fetchDailyLogsServer } from "@/lib/query/fetchers/dailyLogs";
import { ProfileClient } from "@/components/profile/ProfileClient";

export const revalidate = 60;

// BaselinesPanel runs over the user's daily-logs history. We ship a wide
// window (Jan 1, 2020 → today) — small per-row payload, enough for any
// realistic history depth without making the prefetch dependent on
// server-side aggregations.
const BASELINE_FROM = "2020-01-01";

export default async function ProfilePage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const today = new Date().toISOString().slice(0, 10);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  const queryClient = makeServerQueryClient();
  await Promise.all([
    queryClient.prefetchQuery({
      queryKey: queryKeys.profile.one(user.id),
      queryFn: () => fetchProfileServer(supabase, user.id),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.tokens.whoop(user.id),
      queryFn: () => fetchWhoopTokensServer(supabase, user.id),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.tokens.withings(user.id),
      queryFn: () => fetchWithingsTokensServer(supabase, user.id),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.tokens.ingest(user.id),
      queryFn: () => fetchIngestTokenServer(supabase, user.id),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.dailyLogs.range(user.id, BASELINE_FROM, today),
      queryFn: () => fetchDailyLogsServer(supabase, user.id, BASELINE_FROM, today),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ProfileClient
        userId={user.id}
        userEmail={user.email ?? null}
        baselineFrom={BASELINE_FROM}
        baselineTo={today}
        appUrl={appUrl}
      />
    </HydrationBoundary>
  );
}
