import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { queryKeys } from "@/lib/query/keys";
import { fetchProfileServer } from "@/lib/query/fetchers/profile";
import { fetchDailyLogsServer } from "@/lib/query/fetchers/dailyLogs";
import { fetchCheckinServer } from "@/lib/query/fetchers/checkin";
import { fetchAllWorkoutsServer } from "@/lib/query/fetchers/loadWorkouts";
import { fetchStrengthInsightsServer } from "@/lib/query/fetchers/strengthInsights";
import { StrengthClient } from "@/components/strength/StrengthClient";
import { todayInUserTz } from "@/lib/time";

export const revalidate = 60;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function StrengthPage(props: {
  searchParams: Promise<{ ex?: string; view?: string; date?: string }>;
}) {
  const sp = await props.searchParams;
  const { ex: selectedExercise, view, date: rawDate } = sp;

  const initialView: "today" | "recent" | "date" =
    view === "today" ? "today" : view === "date" ? "date" : "recent";
  const todayIso = todayInUserTz();
  const initialDate =
    rawDate && ISO_DATE.test(rawDate) && rawDate <= todayIso ? rawDate : null;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const queryClient = makeServerQueryClient();
  await Promise.all([
    queryClient.prefetchQuery({
      queryKey: queryKeys.profile.one(user.id),
      queryFn: () => fetchProfileServer(supabase, user.id),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.workouts.all(user.id),
      queryFn: () => fetchAllWorkoutsServer(supabase, user.id),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.insights.strength(user.id),
      queryFn: () => fetchStrengthInsightsServer(supabase, user.id),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.dailyLogs.range(user.id, todayIso, todayIso),
      queryFn: () => fetchDailyLogsServer(supabase, user.id, todayIso, todayIso),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.checkin.one(user.id, todayIso),
      queryFn: () => fetchCheckinServer(supabase, user.id, todayIso),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <StrengthClient
        userId={user.id}
        todayIso={todayIso}
        initialView={initialView}
        initialDate={initialDate}
        selectedExercise={selectedExercise}
      />
    </HydrationBoundary>
  );
}
