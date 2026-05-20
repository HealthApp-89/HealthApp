import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { queryKeys } from "@/lib/query/keys";
import { fetchFoodEntriesServer } from "@/lib/query/fetchers/foodEntries";
import { fetchTodayTargetsServer } from "@/lib/query/fetchers/todayTargets";
import { todayInUserTz } from "@/lib/time";
import { MealJournalClient } from "@/components/meal/MealJournalClient";

export const dynamic = "force-dynamic";

export default async function MealPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const sp = await searchParams;
  const date = sp.date ?? todayInUserTz();

  const qc = makeServerQueryClient();
  await Promise.all([
    qc.prefetchQuery({
      queryKey: queryKeys.foodEntries.range(user.id, date, date),
      queryFn: () => fetchFoodEntriesServer(supabase, user.id, date, date),
    }),
    qc.prefetchQuery({
      queryKey: queryKeys.todayTargets.byDate(user.id, date),
      queryFn: () => fetchTodayTargetsServer(supabase, user.id),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <MealJournalClient userId={user.id} date={date} />
    </HydrationBoundary>
  );
}
