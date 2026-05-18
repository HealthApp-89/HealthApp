import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { queryKeys } from "@/lib/query/keys";
import { fetchDailyLogsServer } from "@/lib/query/fetchers/dailyLogs";
import { fetchCheckinServer } from "@/lib/query/fetchers/checkin";
import { fetchFoodEntriesServer } from "@/lib/query/fetchers/foodEntries";
import { LogClient } from "@/components/log/LogClient";
import { todayInUserTz } from "@/lib/time";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function resolveDate(raw: string | undefined): string {
  const today = todayInUserTz();
  if (typeof raw !== "string" || !ISO_DATE.test(raw)) return today;
  return raw > today ? today : raw;
}

export async function LogSubPill({ date: rawDate }: { date?: string }) {
  const date = resolveDate(rawDate);

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const queryClient = makeServerQueryClient();
  await Promise.all([
    queryClient.prefetchQuery({
      queryKey: queryKeys.dailyLogs.range(user.id, date, date),
      queryFn: () => fetchDailyLogsServer(supabase, user.id, date, date),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.checkin.one(user.id, date),
      queryFn: () => fetchCheckinServer(supabase, user.id, date),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.foodEntries.range(user.id, date, date),
      queryFn: () => fetchFoodEntriesServer(supabase, user.id, date, date),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <LogClient userId={user.id} date={date} />
    </HydrationBoundary>
  );
}
