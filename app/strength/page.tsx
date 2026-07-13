import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SubPillNav } from "@/components/layout/SubPillNav";
import { StrengthCoachClient } from "@/components/strength/StrengthCoachClient";
import { StrengthScheduleClient } from "@/components/strength/StrengthScheduleClient";
import { StrengthByDateClient } from "@/components/strength/StrengthByDateClient";
import { StrengthByMuscleClient } from "@/components/strength/StrengthByMuscleClient";
import { StrengthLogClient } from "@/components/strength/StrengthLogClient";
import { StrengthBlocksClient } from "@/components/strength/StrengthBlocksClient";
import { HydrationBoundary, dehydrate, type DehydratedState } from "@tanstack/react-query";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { fetchBlockSummaryServer } from "@/lib/query/fetchers/blockSummary";
import { fetchBlocksRepoServer } from "@/lib/query/fetchers/blocksRepo";
import { fetchProfileServer } from "@/lib/query/fetchers/profile";
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

  // Prefetch block data server-side only when the blocks tab is requested.
  let blocksBoundary: DehydratedState | null = null;
  if (tab === "blocks") {
    const queryClient = makeServerQueryClient();
    const tz = await getUserTimezone(user.id);
    const todayIso = todayInUserTz(new Date(), tz);
    await Promise.all([
      // Profile prefetch lets useUserToday resolve on the first client render,
      // so the hydrated blockSummary key (keyed by todayIso) matches instantly.
      queryClient.prefetchQuery({
        queryKey: queryKeys.profile.one(user.id),
        queryFn: () => fetchProfileServer(supabase, user.id),
      }),
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
    blocksBoundary = dehydrate(queryClient);
  }

  return (
    <div style={{ minHeight: "100dvh", paddingBottom: 100 }}>
      <header style={{ padding: "16px 16px 4px 16px" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Strength</h1>
        <p style={{ fontSize: 12, color: COLOR.textMuted, margin: "2px 0 0 0" }}>
          Coach Carter
        </p>
      </header>
      <SubPillNav pills={SUB_TABS} paramName="tab" defaultKey="coach" />
      {tab === "coach" && <StrengthCoachClient userId={user.id} />}
      {tab === "blocks" && (
        <HydrationBoundary state={blocksBoundary}>
          <StrengthBlocksClient userId={user.id} />
        </HydrationBoundary>
      )}
      {tab === "schedule" && <StrengthScheduleClient userId={user.id} />}
      {tab === "date" && <StrengthByDateClient userId={user.id} />}
      {tab === "by_muscle" && <StrengthByMuscleClient userId={user.id} />}
      {tab === "log" && <StrengthLogClient userId={user.id} />}
    </div>
  );
}
