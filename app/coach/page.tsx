import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { queryKeys } from "@/lib/query/keys";
import { computeBlockProgress } from "@/lib/query/fetchers/blockProgress";
import { fetchTrainingWeekServer } from "@/lib/query/fetchers/trainingWeek";
import { CoachClient } from "@/components/coach/CoachClient";
import { type CoachView } from "@/components/coach/CoachNav";
import { planningTargetMonday } from "@/lib/coach/week";
import { todayInUserTz } from "@/lib/time";

function userTzNoon(): Date {
  return new Date(`${todayInUserTz()}T12:00:00Z`);
}

export const revalidate = 60;

export default async function CoachPage(props: {
  searchParams: Promise<{ view?: string }>;
}) {
  const sp = await props.searchParams;
  const viewParam = sp.view;
  const initialView: CoachView =
    viewParam === "today" || viewParam === "recent" || viewParam === "tools"
      ? viewParam
      : "today";

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const todayDate = todayInUserTz();
  const noon = userTzNoon();
  const targetMonday = planningTargetMonday(noon);

  // Prefetch the two banner queries shown above the chat feed. Recent-view
  // history is loaded by the chat surface itself (no prefetch needed).
  const queryClient = makeServerQueryClient();
  await Promise.all([
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
        targetMonday={targetMonday}
        initialView={initialView}
      />
    </HydrationBoundary>
  );
}
