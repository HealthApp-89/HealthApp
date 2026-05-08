import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { queryKeys } from "@/lib/query/keys";
import { fetchInsightsDailyServer } from "@/lib/query/fetchers/insightsDaily";
import { fetchWeeklyReviewServer } from "@/lib/query/fetchers/weeklyReview";
import { fetchRecommendationsServer } from "@/lib/query/fetchers/recommendations";
import { computeBlockProgress } from "@/lib/query/fetchers/blockProgress";
import { fetchTrainingWeekServer } from "@/lib/query/fetchers/trainingWeek";
import { CoachClient } from "@/components/coach/CoachClient";
import { type CoachView } from "@/components/coach/CoachNav";
import { reviewWindow, recommendationWeekStart, planningTargetMonday } from "@/lib/coach/week";
import { todayInUserTz } from "@/lib/time";

function userTzNoon(): Date {
  return new Date(`${todayInUserTz()}T12:00:00Z`);
}

export const revalidate = 60;

export default async function CoachPage(props: {
  searchParams: Promise<{ view?: string }>;
}) {
  const sp = await props.searchParams;
  const initialView: CoachView = (
    ["today", "this-week", "next-week"] as const
  ).includes(sp.view as CoachView)
    ? (sp.view as CoachView)
    : "today";

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const todayDate = todayInUserTz();
  const noon = userTzNoon();
  const { start: weekStart, end: weekEnd, mode: weekMode, daysRemaining } = reviewWindow(noon);
  const recsTargetWeek = recommendationWeekStart(noon);
  const targetMonday = planningTargetMonday(noon);

  // Prefetch all three views' data so any tab tap is a cache hit. Server has
  // no client cache to consult, so this is one Supabase round-trip per view —
  // worth it because the user is already paying for the page render.
  const queryClient = makeServerQueryClient();
  await Promise.all([
    queryClient.prefetchQuery({
      queryKey: queryKeys.insights.daily(user.id, todayDate),
      queryFn: () => fetchInsightsDailyServer(supabase, user.id),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.insights.weeklyReview(user.id, weekEnd),
      queryFn: () => fetchWeeklyReviewServer(supabase, user.id, weekEnd),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.recommendations.week(user.id, recsTargetWeek),
      queryFn: () => fetchRecommendationsServer(supabase, user.id, recsTargetWeek),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.blockProgress.active(user.id),
      queryFn: () => computeBlockProgress(supabase, user.id),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.trainingWeeks.one(user.id, targetMonday),
      queryFn: () => fetchTrainingWeekServer(supabase, user.id, targetMonday),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <CoachClient
        userId={user.id}
        todayDate={todayDate}
        weekStart={weekStart}
        weekEnd={weekEnd}
        weekMode={weekMode}
        daysRemaining={daysRemaining}
        recsTargetWeek={recsTargetWeek}
        initialView={initialView}
      />
    </HydrationBoundary>
  );
}
