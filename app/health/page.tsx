import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { queryKeys } from "@/lib/query/keys";
import { fetchDailyLogsServer } from "@/lib/query/fetchers/dailyLogs";
import { fetchCheckinServer } from "@/lib/query/fetchers/checkin";
import { fetchRecoveryIntelligenceServer } from "@/lib/query/fetchers/recoveryIntelligence";
import { HealthTrendsClient } from "@/components/health/HealthTrendsClient";
import { SubPillNav } from "@/components/layout/SubPillNav";
import { HealthCoachClient } from "@/components/health/HealthCoachClient";
import { HealthLogClient } from "@/components/health/HealthLogClient";
import { todayInUserTz } from "@/lib/time";
import { COLOR } from "@/lib/ui/theme";

const SUB_TABS = [
  { key: "coach",  label: "Coach"  },
  { key: "trends", label: "Trends" },
  { key: "log",    label: "Log"    },
];

export default async function HealthPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; date?: string }>;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { tab: tabParam, date: dateParam } = await searchParams;
  const tab =
  tabParam === "log"    ? "log"    :
  tabParam === "trends" ? "trends" : "coach";

  const today = todayInUserTz();

  const yesterday = new Date(`${today}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yIso = yesterday.toISOString().slice(0, 10);

  const sevenDaysAgo = new Date(`${today}T00:00:00Z`);
  sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
  const sevenIso = sevenDaysAgo.toISOString().slice(0, 10);

  // HRV baseline — single profile read; passed as prop to HealthCoachClient.
  const { data: profile } = await supabase
    .from("profiles")
    .select("whoop_baselines")
    .eq("user_id", user.id)
    .maybeSingle();
  type WB = { hrv_mean?: number | null } & Record<string, unknown>;
  const baselines = (profile?.whoop_baselines as WB | null) ?? null;
  const hrvBaseline =
    typeof baselines?.hrv_mean === "number" ? baselines.hrv_mean : null;

  const queryClient = makeServerQueryClient();
  const logDate = dateParam ?? today;

  await Promise.all([
    // Coach-tab data: today, yesterday, 7d window, and today's checkin.
    queryClient.prefetchQuery({
      queryKey: queryKeys.dailyLogs.range(user.id, today, today),
      queryFn: () => fetchDailyLogsServer(supabase, user.id, today, today),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.dailyLogs.range(user.id, yIso, yIso),
      queryFn: () => fetchDailyLogsServer(supabase, user.id, yIso, yIso),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.dailyLogs.range(user.id, sevenIso, yIso),
      queryFn: () => fetchDailyLogsServer(supabase, user.id, sevenIso, yIso),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.checkin.one(user.id, today),
      queryFn: () => fetchCheckinServer(supabase, user.id, today),
    }),
    // Log-tab data: selected date may differ from today.
    queryClient.prefetchQuery({
      queryKey: queryKeys.dailyLogs.range(user.id, logDate, logDate),
      queryFn: () => fetchDailyLogsServer(supabase, user.id, logDate, logDate),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.checkin.one(user.id, logDate),
      queryFn: () => fetchCheckinServer(supabase, user.id, logDate),
    }),
    // Trends-tab data: recovery intelligence
    queryClient.prefetchQuery({
      queryKey: queryKeys.recoveryIntelligence.one(user.id),
      queryFn: () =>
        fetchRecoveryIntelligenceServer(supabase, user.id, today),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <div style={{ minHeight: "100dvh", paddingBottom: 100 }}>
        <header style={{ padding: "16px 16px 4px 16px" }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Health</h1>
          <p
            style={{ fontSize: 12, color: COLOR.textMuted, margin: "2px 0 0 0" }}
          >
            Remi
          </p>
        </header>
        <SubPillNav pills={SUB_TABS} paramName="tab" defaultKey="coach" />
        {tab === "coach"  && <HealthCoachClient userId={user.id} hrvBaseline={hrvBaseline} />}
        {tab === "trends" && <HealthTrendsClient userId={user.id} />}
        {tab === "log"    && <HealthLogClient userId={user.id} initialDate={dateParam} />}
      </div>
    </HydrationBoundary>
  );
}
