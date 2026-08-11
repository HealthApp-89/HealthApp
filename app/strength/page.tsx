import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SubPillNav } from "@/components/layout/SubPillNav";
import { StrengthCoachClient } from "@/components/strength/StrengthCoachClient";
import { StrengthScheduleClient } from "@/components/strength/StrengthScheduleClient";
import { StrengthByDateClient } from "@/components/strength/StrengthByDateClient";
import { StrengthByMuscleClient } from "@/components/strength/StrengthByMuscleClient";
import { StrengthLogClient } from "@/components/strength/StrengthLogClient";
import { StrengthBlocksClient } from "@/components/strength/StrengthBlocksClient";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { fetchBlockSummaryServer } from "@/lib/query/fetchers/blockSummary";
import { fetchBlocksRepoServer } from "@/lib/query/fetchers/blocksRepo";
import { fetchProfileServer } from "@/lib/query/fetchers/profile";
import { fetchTodaySessionServer } from "@/lib/query/fetchers/todaySession";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { todayInUserTz } from "@/lib/time";
import { queryKeys } from "@/lib/query/keys";
import { COLOR } from "@/lib/ui/theme";
import type { SupabaseClient } from "@supabase/supabase-js";

const SUB_TABS = [
  { key: "coach", label: "Coach" },
  { key: "blocks", label: "Blocks" },
  { key: "schedule", label: "Schedule" },
  { key: "date", label: "By date" },
  { key: "by_muscle", label: "By muscle" },
  { key: "log", label: "Log" },
];

type Tab = "coach" | "blocks" | "schedule" | "date" | "by_muscle" | "log";

function parseTab(value: string | undefined): Tab {
  if (
    value === "blocks" ||
    value === "schedule" ||
    value === "date" ||
    value === "by_muscle" ||
    value === "log"
  )
    return value;
  return "coach";
}

export default async function StrengthPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { tab: tabParam } = await searchParams;
  const tab = parseTab(tabParam);

  const queryClient = makeServerQueryClient();

  // The profile is prefetched for EVERY tab, not just blocks. `useUserToday`
  // returns undefined until the profile query resolves, and ChatPanel — which
  // the default `coach` tab renders — coerces that to "" and feeds it to a
  // date helper, producing an Invalid Date whose toISOString() throws during
  // render. A cold load of /strength therefore used to fail into the error
  // boundary; it only appeared intermittent because arriving from another
  // route (the dashboard prefetches the profile) leaves the cache warm.
  // Same shape as app/page.tsx: one query client, one boundary, profile always.
  await queryClient.prefetchQuery({
    queryKey: queryKeys.profile.one(user.id),
    queryFn: () => fetchProfileServer(supabase, user.id),
  });

  // Block data stays conditional — it is only read by the blocks tab, and the
  // blockSummary key is derived from the profile timezone prefetched above.
  if (tab === "blocks") {
    const tz = await getUserTimezone(user.id);
    const todayIso = todayInUserTz(new Date(), tz);
    await Promise.all([
      queryClient.prefetchQuery({
        queryKey: queryKeys.blockSummary.today(user.id, todayIso),
        queryFn: () =>
          fetchBlockSummaryServer(supabase as unknown as SupabaseClient, user.id, todayIso),
      }),
      queryClient.prefetchQuery({
        queryKey: queryKeys.blocksRepo.all(user.id),
        queryFn: () =>
          fetchBlocksRepoServer(supabase as unknown as SupabaseClient, user.id),
      }),
    ]);
  }

  // TodayPlanCard (coach tab) reads useTodaySessionStatus, which without a
  // server prefetch has a cold-load window where `logged` is null and the
  // full "Start session" CTA renders tappable before the truth is known —
  // tapping it inside that window double-commits the day (see
  // useTodaySessionStatus.ts). Gated to the coach tab only, same convention
  // as the blocks-tab prefetch above.
  if (tab === "coach") {
    const tz = await getUserTimezone(user.id);
    const todayIso = todayInUserTz(new Date(), tz);
    await queryClient.prefetchQuery({
      queryKey: queryKeys.todaySession.one(user.id, todayIso),
      queryFn: () => fetchTodaySessionServer(supabase, user.id, todayIso),
    });
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <div style={{ minHeight: "100dvh", paddingBottom: 100 }}>
        <header style={{ padding: "16px 16px 4px 16px" }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Strength</h1>
          <p style={{ fontSize: 12, color: COLOR.textMuted, margin: "2px 0 0 0" }}>
            Coach Carter
          </p>
        </header>
        <SubPillNav pills={SUB_TABS} paramName="tab" defaultKey="coach" />
        {tab === "coach" && <StrengthCoachClient userId={user.id} />}
        {tab === "blocks" && <StrengthBlocksClient userId={user.id} />}
        {tab === "schedule" && <StrengthScheduleClient userId={user.id} />}
        {tab === "date" && <StrengthByDateClient userId={user.id} />}
        {tab === "by_muscle" && <StrengthByMuscleClient userId={user.id} />}
        {tab === "log" && <StrengthLogClient userId={user.id} />}
      </div>
    </HydrationBoundary>
  );
}
