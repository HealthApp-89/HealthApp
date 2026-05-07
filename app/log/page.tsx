import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { queryKeys } from "@/lib/query/keys";
import { fetchDailyLogsServer } from "@/lib/query/fetchers/dailyLogs";
import { fetchCheckinServer } from "@/lib/query/fetchers/checkin";
import { LogClient } from "@/components/log/LogClient";
import { todayInUserTz } from "@/lib/time";

export const dynamic = "force-dynamic";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function resolveDate(raw: string | string[] | undefined): string {
  const today = todayInUserTz();
  if (typeof raw !== "string" || !ISO_DATE.test(raw)) return today;
  // Disallow future dates — Garmin can't tell us what hasn't happened yet.
  return raw > today ? today : raw;
}

export default async function LogPage(props: {
  searchParams: Promise<{ date?: string | string[] }>;
}) {
  const sp = await props.searchParams;
  const date = resolveDate(sp.date);

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
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <LogClient userId={user.id} date={date} />
    </HydrationBoundary>
  );
}
