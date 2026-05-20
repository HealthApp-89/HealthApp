import { notFound, redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { queryKeys } from "@/lib/query/keys";
import { fetchWeeklyReviewServer } from "@/lib/query/fetchers/weeklyReview";
import { WeeklyReviewPage } from "@/components/coach/WeeklyReviewPage";

export const revalidate = 60;

export default async function WeeklyReviewRoute(props: {
  params: Promise<{ week_start: string }>;
}) {
  const { week_start } = await props.params;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const queryClient = makeServerQueryClient();
  const row = await queryClient.fetchQuery({
    queryKey: queryKeys.weeklyReviews.one(user.id, week_start),
    queryFn: () => fetchWeeklyReviewServer(supabase, user.id, week_start),
  });
  if (!row) notFound();

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <WeeklyReviewPage userId={user.id} weekStart={week_start} />
    </HydrationBoundary>
  );
}
