// app/page.tsx
import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { queryKeys } from "@/lib/query/keys";
import { fetchProfileServer } from "@/lib/query/fetchers/profile";
import { fetchDailyLogsServer } from "@/lib/query/fetchers/dailyLogs";
import { fetchCheckinServer } from "@/lib/query/fetchers/checkin";
import { fetchLatestWeightServer } from "@/lib/query/fetchers/latestWeight";
import { fetchLast7Server } from "@/lib/query/fetchers/last7";
import { fetchWorkoutsRangeServer } from "@/lib/query/fetchers/workouts";
import { fetchIntakeStateServer } from "@/lib/query/fetchers/intakeState";
import { fetchTodayBriefServer } from "@/lib/query/fetchers/todayBrief";
import { TodayClient } from "@/components/dashboard/TodayClient";
import { WeeklyRollups } from "@/components/dashboard/WeeklyRollups";
import { BodyTile } from "@/components/dashboard/BodyTile";
import { todayInUserTz } from "@/lib/time";
import type { Profile } from "@/lib/query/fetchers/profile";
import type { DailyLog } from "@/lib/data/types";

export const revalidate = 60;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function shiftIso(iso: string, deltaDays: number): string {
  const t = new Date(iso + "T00:00:00Z").getTime();
  return new Date(t + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

export default async function Home(props: { searchParams: Promise<{ date?: string }> }) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const today = todayInUserTz();
  const sp = await props.searchParams;
  const selectedDate =
    sp.date && ISO_DATE.test(sp.date) && sp.date <= today ? sp.date : today;
  const selectedYesterday = shiftIso(selectedDate, -1);
  const isToday = selectedDate === today;
  const sevenDaysBefore = shiftIso(selectedDate, -7);
  const fourteenBefore = shiftIso(selectedDate, -14);

  const queryClient = makeServerQueryClient();
  await Promise.all([
    queryClient.prefetchQuery({
      queryKey: queryKeys.profile.one(user.id),
      queryFn: () => fetchProfileServer(supabase, user.id),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.dailyLogs.range(user.id, selectedDate, selectedDate),
      queryFn: () => fetchDailyLogsServer(supabase, user.id, selectedDate, selectedDate),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.dailyLogs.range(user.id, selectedYesterday, selectedYesterday),
      queryFn: () => fetchDailyLogsServer(supabase, user.id, selectedYesterday, selectedYesterday),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.checkin.one(user.id, selectedDate),
      queryFn: () => fetchCheckinServer(supabase, user.id, selectedDate),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.dailyLogs.latestWeight(user.id, selectedDate),
      queryFn: () => fetchLatestWeightServer(supabase, user.id, selectedDate),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.dailyLogs.last7(user.id, selectedDate),
      queryFn: () => fetchLast7Server(supabase, user.id, selectedDate, sevenDaysBefore),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.workouts.range(user.id, fourteenBefore, selectedDate),
      queryFn: () => fetchWorkoutsRangeServer(supabase, user.id, fourteenBefore, selectedDate, 5),
    }),
    ...(isToday
      ? [
          queryClient.prefetchQuery({
            queryKey: queryKeys.intakeState.one(user.id, selectedDate),
            queryFn: () => fetchIntakeStateServer(supabase, user.id, selectedDate),
          }),
          queryClient.prefetchQuery({
            queryKey: queryKeys.morningBrief.today(user.id, selectedDate),
            queryFn: () => fetchTodayBriefServer(supabase, user.id, selectedDate),
          }),
        ]
      : []),
  ]);

  // Pull prefetched profile + selected day's log out of the QueryClient so we
  // can pre-render WeeklyRollups (which is async + uses next/headers and so
  // must stay in the Server Component tree — TodayClient receives it as a
  // ReactNode prop).
  const profile = queryClient.getQueryData<Profile | null>(
    queryKeys.profile.one(user.id),
  );
  const selectedRange = queryClient.getQueryData<DailyLog[]>(
    queryKeys.dailyLogs.range(user.id, selectedDate, selectedDate),
  );
  const selectedLog = (selectedRange?.[0] ?? null) as DailyLog | null;
  const baselines = (profile?.whoop_baselines as Record<string, unknown> | null) ?? null;
  const hrvBaseline =
    typeof baselines?.hrv_6mo_avg === "number" ? (baselines.hrv_6mo_avg as number) : 33;

  const weeklyRollups = (
    <WeeklyRollups
      userId={user.id}
      today={selectedDate}
      todayHrv={selectedLog?.hrv ?? null}
      todayRhr={selectedLog?.resting_hr ?? null}
      hrvBaseline={hrvBaseline}
    />
  );

  const bodyTile = <BodyTile userId={user.id} />;

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <TodayClient
        userId={user.id}
        userEmail={user.email ?? null}
        selectedDate={selectedDate}
        today={today}
        isToday={isToday}
        weeklyRollups={weeklyRollups}
        bodyTile={bodyTile}
      />
    </HydrationBoundary>
  );
}
