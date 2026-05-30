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
import { fetchActiveProfileServer, fetchProfileHistoryServer, fetchDraftProfileServer } from "@/lib/query/fetchers/athleteProfile";
import { fetchLabAcknowledgmentsServer } from "@/lib/query/fetchers/labAcknowledgments";
import { fetchTodayTargetsServer } from "@/lib/query/fetchers/todayTargets";
import { ProfileClient } from "@/components/profile/ProfileClient";
import { todayInUserTz } from "@/lib/time";

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
  const todayUserTz = todayInUserTz();
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
    queryClient.prefetchQuery({
      queryKey: queryKeys.athleteProfile.active(user.id),
      queryFn: () => fetchActiveProfileServer(supabase, user.id),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.athleteProfile.history(user.id),
      queryFn: () => fetchProfileHistoryServer(supabase, user.id),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.athleteProfile.draft(user.id),
      queryFn: () => fetchDraftProfileServer(supabase, user.id),
    }),
    // LabPromptCard (GLP-1 plan users) reads profiles.lab_acknowledgments
    // via useLabAcknowledgments. Prefetched here so the card hydrates with
    // the actual acked state on first paint instead of flashing all-Pending
    // for ~200ms while the browser query resolves.
    queryClient.prefetchQuery({
      queryKey: queryKeys.labAcks.one(user.id),
      queryFn: () => fetchLabAcknowledgmentsServer(supabase, user.id),
    }),
    // NutritionTargetsSection's "Source: ..." labels need the resolved
    // targets on first paint; prefetch keyed by user-tz today so the
    // useTodayTargets hook hits the dehydrated cache.
    queryClient.prefetchQuery({
      queryKey: queryKeys.todayTargets.byDate(user.id, todayUserTz),
      queryFn: () => fetchTodayTargetsServer(supabase, user.id),
    }),
  ]);

  // Strava connection state — small one-shot read for the EnduranceSetupSection.
  // Not worth a TanStack fetcher: there's only ever one row per user, and the
  // connect/disconnect CTAs are server-rendered links/forms that trigger a
  // navigation, so a stale value is naturally refreshed on the next paint.
  // RLS scopes the read to the current user.
  const { data: stravaRow } = await supabase
    .from("strava_tokens")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ProfileClient
        userId={user.id}
        userEmail={user.email ?? null}
        baselineFrom={BASELINE_FROM}
        baselineTo={today}
        today={todayUserTz}
        appUrl={appUrl}
        stravaConnected={!!stravaRow}
      />
    </HydrationBoundary>
  );
}
