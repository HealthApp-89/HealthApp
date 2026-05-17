import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { queryKeys } from "@/lib/query/keys";
import { fetchCoachTrendsServer } from "@/lib/query/fetchers/coachTrends";
import { CoachTrendsView } from "@/components/coach/trends/CoachTrendsView";
import { todayInUserTz } from "@/lib/time";

export const revalidate = 60;

export default async function CoachTrendsRoute(props: {
  searchParams: Promise<{ section?: string }>;
}) {
  const sp = await props.searchParams;
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const today = todayInUserTz();
  const serviceSupabase = createSupabaseServiceRoleClient();

  const queryClient = makeServerQueryClient();
  await queryClient.prefetchQuery({
    queryKey: queryKeys.coachTrends.one(user.id),
    queryFn: () => fetchCoachTrendsServer(serviceSupabase, user.id, today),
  });

  const initialSection: "performance" | "composition" | "cross" =
    sp.section === "composition" || sp.section === "cross" ? sp.section : "performance";

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <CoachTrendsView userId={user.id} initialSection={initialSection} />
    </HydrationBoundary>
  );
}
