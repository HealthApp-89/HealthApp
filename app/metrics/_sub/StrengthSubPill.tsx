// app/metrics/_sub/StrengthSubPill.tsx
//
// Mirrors the old app/strength/page.tsx data fetch + render. Renamed
// from a route page to a sub-pill so it composes inside the /metrics
// shell (see app/metrics/page.tsx). Underscore prefix excludes the
// directory from Next's route table.
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
import { fetchTrainingWeekServer } from "@/lib/query/fetchers/trainingWeek";
import { fetchMuscleVolumeServer } from "@/lib/query/fetchers/muscleVolume";
import { fetchActiveProfileServer } from "@/lib/query/fetchers/athleteProfile";
import { StrengthClient } from "@/components/strength/StrengthClient";
import { todayInUserTz } from "@/lib/time";
import { currentWeekMonday } from "@/lib/coach/week";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type Params = {
  ex?: string;
  view?: string;
  date?: string;
};

export async function StrengthSubPill({ params }: { params: Params }) {
  const { ex: selectedExercise, view, date: rawDate } = params;

  const initialView: "today" | "recent" | "date" | "by_muscle" =
    view === "today"
      ? "today"
      : view === "date"
      ? "date"
      : view === "by_muscle"
      ? "by_muscle"
      : "recent";
  const todayIso = todayInUserTz();
  const initialDate =
    rawDate && ISO_DATE.test(rawDate) && rawDate <= todayIso ? rawDate : null;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const queryClient = makeServerQueryClient();
  const currentWeekStart = currentWeekMonday();
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
    queryClient.prefetchQuery({
      queryKey: queryKeys.trainingWeeks.one(user.id, currentWeekStart),
      queryFn: () => fetchTrainingWeekServer(supabase, user.id, currentWeekStart),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.muscleVolume.snapshot(user.id, todayIso),
      queryFn: () => fetchMuscleVolumeServer(supabase, user.id, todayIso),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.athleteProfile.active(user.id),
      queryFn: () => fetchActiveProfileServer(supabase, user.id),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <StrengthClient
        userId={user.id}
        todayIso={todayIso}
        currentWeekStart={currentWeekStart}
        initialView={initialView}
        initialDate={initialDate}
        selectedExercise={selectedExercise}
      />
    </HydrationBoundary>
  );
}
